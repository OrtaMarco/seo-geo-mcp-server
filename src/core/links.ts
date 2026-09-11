/**
 * Link auditing: internal/external split, rel attributes, anchor-text quality
 * and optional broken-link sampling.
 */

import { LINK_CHECK_CONCURRENCY, LINK_CHECK_SAMPLE } from "../constants.js";
import { clampScore, scoreToGrade, type Finding } from "../format.js";
import { safeFetch } from "./fetch.js";
import { pageOrigin, resolveUrl, type PageDoc } from "./page.js";
import { validateUrl } from "./validate.js";

export interface LinkInfo {
  href: string;
  text: string;
  internal: boolean;
  rel: string | null;
  nofollow: boolean;
  /** HTTP status, when broken-link checking ran. */
  status: number | null;
  error: string | null;
}

export interface LinkReport {
  url: string;
  final_url: string;
  total_links: number;
  internal_links: number;
  external_links: number;
  nofollow_links: number;
  sponsored_links: number;
  ugc_links: number;
  empty_anchor_text: number;
  generic_anchor_text: string[];
  external_domains: Array<{ domain: string; count: number }>;
  checked_count: number;
  broken: LinkInfo[];
  score: number;
  grade: string;
  findings: Finding[];
}

/**
 * Anchor phrases that carry no topical signal. Kept short and unambiguous so a
 * legitimate anchor is not flagged.
 */
const GENERIC_ANCHORS = new Set([
  "click here", "here", "read more", "more", "link", "this", "this link",
  "learn more", "see more", "details", "download", "go", "continue",
  "aquí", "aqui", "leer más", "leer mas", "ver más", "ver mas", "más",
  "mas", "más información", "mas informacion", "clic aquí", "clic aqui",
  "seguir leyendo", "detalles", "enlace",
]);

export async function analyzeLinks(
  page: PageDoc,
  checkBroken = false,
  sampleSize = LINK_CHECK_SAMPLE,
): Promise<LinkReport> {
  const $ = page.$;
  const findings: Finding[] = [];
  const origin = pageOrigin(page);
  const originHost = new URL(origin).host;

  const links: LinkInfo[] = [];
  const genericAnchors: string[] = [];
  let emptyAnchors = 0;

  $("a[href]").each((_, el) => {
    const node = $(el);
    const raw = node.attr("href")?.trim() ?? "";

    // Skip in-page and non-navigational schemes.
    if (!raw || raw.startsWith("#") || /^(mailto|tel|javascript|data):/i.test(raw)) {
      return;
    }

    const absolute = resolveUrl(page, raw);
    if (!absolute) return;

    const text = node.text().replace(/\s+/g, " ").trim();
    const rel = node.attr("rel")?.toLowerCase() ?? null;
    const internal = absolute.host === originHost;

    if (!text) {
      // An image link with alt text is not really an empty anchor.
      const imageAlt = node.find("img[alt]").attr("alt")?.trim();
      if (!imageAlt && !node.attr("aria-label")) emptyAnchors++;
    } else if (GENERIC_ANCHORS.has(text.toLowerCase())) {
      genericAnchors.push(text);
    }

    links.push({
      href: absolute.toString(),
      text,
      internal,
      rel,
      nofollow: rel ? /\bnofollow\b/.test(rel) : false,
      status: null,
      error: null,
    });
  });

  const internalLinks = links.filter((l) => l.internal);
  const externalLinks = links.filter((l) => !l.internal);

  // --- external domain distribution
  const domainCounts = new Map<string, number>();
  for (const link of externalLinks) {
    try {
      const host = new URL(link.href).host;
      domainCounts.set(host, (domainCounts.get(host) ?? 0) + 1);
    } catch {
      /* unparseable — already filtered above, but stay defensive */
    }
  }
  const externalDomains = [...domainCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([domain, count]) => ({ domain, count }));

  // --- broken-link sampling
  const broken: LinkInfo[] = [];
  let checkedCount = 0;

  if (checkBroken && links.length) {
    // Deduplicate, then prefer internal links — those are the ones you control.
    const unique = [...new Map(links.map((l) => [l.href, l])).values()];
    const sample = [
      ...unique.filter((l) => l.internal),
      ...unique.filter((l) => !l.internal),
    ].slice(0, sampleSize);

    // A small worker pool, not one request per link at once: the audited site
    // should see a handful of concurrent requests, never a burst of 200.
    const queue = [...sample];
    const checkOne = async (link: LinkInfo) => {
      const parsed = validateUrl(link.href);
      if (!parsed) {
        link.error = "not a valid public URL";
        broken.push(link);
        return;
      }
      try {
        let res = await safeFetch(parsed, { method: "HEAD", timeoutMs: 8000 });
        // Many servers reject HEAD outright; retry once with GET before
        // calling a link broken.
        if (res.status === 405 || res.status === 501) {
          res = await safeFetch(parsed, { method: "GET", timeoutMs: 8000, maxBytes: 2048 });
        }
        link.status = res.status;
        if (res.status >= 400) broken.push(link);
      } catch (err) {
        link.error = err instanceof Error ? err.message : String(err);
        broken.push(link);
      } finally {
        checkedCount++;
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(LINK_CHECK_CONCURRENCY, queue.length) }, async () => {
        for (let link = queue.shift(); link; link = queue.shift()) await checkOne(link);
      }),
    );
  }

  // --- scoring
  let score = 0;

  if (internalLinks.length === 0) {
    findings.push({ severity: "fail", message: "No internal links. Internal linking is how crawlers discover the rest of your site and how authority flows through it." });
  } else if (internalLinks.length < 3) {
    score += 15;
    findings.push({ severity: "warn", message: `Only ${internalLinks.length} internal link(s). Add contextual links to related pages.` });
  } else {
    score += 35;
    findings.push({ severity: "pass", message: `${internalLinks.length} internal links provide solid crawl paths.` });
  }

  if (externalLinks.length === 0) {
    findings.push({ severity: "info", message: "No external links. Citing authoritative sources is a credibility signal for both readers and AI evaluators." });
    score += 10;
  } else {
    score += 20;
    findings.push({ severity: "pass", message: `${externalLinks.length} external link(s) across ${domainCounts.size} domain(s).` });
  }

  if (emptyAnchors === 0) {
    score += 15;
  } else {
    findings.push({ severity: "warn", message: `${emptyAnchors} link(s) have no anchor text, alt text or aria-label — they convey nothing to crawlers or screen readers.` });
  }

  if (genericAnchors.length === 0) {
    score += 20;
    findings.push({ severity: "pass", message: "No generic anchor text found." });
  } else {
    score += Math.max(0, 20 - genericAnchors.length * 2);
    findings.push({
      severity: "warn",
      message: `${genericAnchors.length} link(s) use generic anchor text (${[...new Set(genericAnchors)].slice(0, 5).join(", ")}). Descriptive anchors tell engines what the target page is about.`,
    });
  }

  if (checkBroken) {
    if (broken.length === 0 && checkedCount > 0) {
      score += 10;
      findings.push({ severity: "pass", message: `All ${checkedCount} sampled links resolve successfully.` });
    } else if (broken.length) {
      findings.push({
        severity: "fail",
        message: `${broken.length} of ${checkedCount} sampled links are broken: ${broken
          .slice(0, 5)
          .map((l) => `${l.href} (${l.status ?? l.error})`)
          .join(", ")}.`,
      });
    }
  } else {
    score += 10;
    findings.push({ severity: "info", message: "Broken-link checking was skipped. Pass check_broken=true to sample-verify that links resolve." });
  }

  return {
    url: page.url,
    final_url: page.finalUrl,
    total_links: links.length,
    internal_links: internalLinks.length,
    external_links: externalLinks.length,
    nofollow_links: links.filter((l) => l.nofollow).length,
    sponsored_links: links.filter((l) => l.rel && /\bsponsored\b/.test(l.rel)).length,
    ugc_links: links.filter((l) => l.rel && /\bugc\b/.test(l.rel)).length,
    empty_anchor_text: emptyAnchors,
    generic_anchor_text: [...new Set(genericAnchors)],
    external_domains: externalDomains,
    checked_count: checkedCount,
    broken,
    score: clampScore(score),
    grade: scoreToGrade(clampScore(score)),
    findings,
  };
}
