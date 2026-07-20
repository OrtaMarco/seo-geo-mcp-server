/**
 * Head-tag analysis: title/description/canonical/robots, social preview cards
 * (Open Graph + Twitter) and hreflang internationalisation.
 */

import {
  DESCRIPTION_MAX_LENGTH,
  DESCRIPTION_MIN_LENGTH,
  TITLE_MAX_LENGTH,
  TITLE_MIN_LENGTH,
} from "../constants.js";
import { clampScore, scoreToGrade, type Finding } from "../format.js";
import { safeFetch } from "./fetch.js";
import { resolveUrl, type PageDoc } from "./page.js";
import { validateUrl } from "./validate.js";

// --- shared helpers --------------------------------------------------------

/**
 * Normalise a URL for equality comparison: drop the fragment, the default port
 * and any trailing slash on the path, and lowercase the host. Query strings are
 * preserved — `?page=2` is a genuinely different canonical target.
 */
export function normalizeForCompare(input: string): string {
  try {
    const u = new URL(input);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.replace(/\/+$/, "");
    }
    return u.toString();
  } catch {
    return input;
  }
}

/** Read the first `content` attribute of a `<meta name=…>` tag, case-insensitively. */
function metaByName(page: PageDoc, name: string): string | null {
  const value = page
    .$(`meta[name="${name}" i]`)
    .first()
    .attr("content");
  return value?.trim() || null;
}

/** Read the first `content` attribute of a `<meta property=…>` tag. */
function metaByProperty(page: PageDoc, property: string): string | null {
  const value = page
    .$(`meta[property="${property}" i]`)
    .first()
    .attr("content");
  return value?.trim() || null;
}

/**
 * Parse robots directives from both the `robots` meta tag and the
 * `X-Robots-Tag` HTTP header. Google honours whichever is most restrictive.
 */
function parseRobotsDirectives(
  metaRobots: string | null,
  xRobotsTag: string | null,
): { directives: string[]; indexable: boolean; followable: boolean } {
  const raw = [metaRobots, xRobotsTag].filter(Boolean).join(",").toLowerCase();
  const directives = raw
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);

  const has = (d: string) => directives.includes(d);
  return {
    directives,
    indexable: !(has("noindex") || has("none")),
    followable: !(has("nofollow") || has("none")),
  };
}

// --- meta tags -------------------------------------------------------------

export interface MetaTagsReport {
  url: string;
  final_url: string;
  title: string | null;
  title_length: number;
  description: string | null;
  description_length: number;
  canonical: string | null;
  canonical_is_self: boolean;
  meta_robots: string | null;
  x_robots_tag: string | null;
  robots_directives: string[];
  indexable: boolean;
  followable: boolean;
  lang: string | null;
  charset: string | null;
  viewport: string | null;
  favicon: string | null;
  score: number;
  grade: string;
  findings: Finding[];
}

export function analyzeMetaTags(page: PageDoc): MetaTagsReport {
  const $ = page.$;
  const findings: Finding[] = [];

  const title = $("title").first().text().trim() || null;
  const description = metaByName(page, "description");
  const canonicalRaw = $('link[rel="canonical" i]').first().attr("href")?.trim() ?? null;
  const canonical = canonicalRaw
    ? (resolveUrl(page, canonicalRaw)?.toString() ?? canonicalRaw)
    : null;
  const metaRobots = metaByName(page, "robots");
  const xRobotsTag = page.headers["x-robots-tag"] ?? null;
  const lang = $("html").attr("lang")?.trim() || null;
  const charset =
    $("meta[charset]").first().attr("charset")?.trim() ||
    /charset=([\w-]+)/i.exec(page.contentType)?.[1] ||
    null;
  const viewport = metaByName(page, "viewport");
  const faviconRaw = $('link[rel~="icon" i]').first().attr("href")?.trim() ?? null;
  const favicon = faviconRaw
    ? (resolveUrl(page, faviconRaw)?.toString() ?? faviconRaw)
    : null;

  const { directives, indexable, followable } = parseRobotsDirectives(
    metaRobots,
    xRobotsTag,
  );

  // --- title
  let score = 0;
  const titleLength = title?.length ?? 0;
  if (!title) {
    findings.push({ severity: "fail", message: "No <title> tag. This is the single strongest on-page signal — add one." });
  } else if ($("title").length > 1) {
    score += 15;
    findings.push({ severity: "warn", message: `${$("title").length} <title> tags found. Only the first is used — remove the rest.` });
  } else if (titleLength < TITLE_MIN_LENGTH) {
    score += 15;
    findings.push({ severity: "warn", message: `Title is short (${titleLength} chars). Aim for ${TITLE_MIN_LENGTH}–${TITLE_MAX_LENGTH} to use the full SERP width.` });
  } else if (titleLength > TITLE_MAX_LENGTH) {
    score += 18;
    findings.push({ severity: "warn", message: `Title is ${titleLength} chars and will likely be truncated in search results (~${TITLE_MAX_LENGTH}).` });
  } else {
    score += 25;
    findings.push({ severity: "pass", message: `Title is ${titleLength} chars — within the ${TITLE_MIN_LENGTH}–${TITLE_MAX_LENGTH} sweet spot.` });
  }

  // --- description
  const descriptionLength = description?.length ?? 0;
  if (!description) {
    findings.push({ severity: "fail", message: "No meta description. Search engines will synthesise one, costing you control of the snippet." });
  } else if (descriptionLength < DESCRIPTION_MIN_LENGTH) {
    score += 10;
    findings.push({ severity: "warn", message: `Meta description is short (${descriptionLength} chars). Aim for ${DESCRIPTION_MIN_LENGTH}–${DESCRIPTION_MAX_LENGTH}.` });
  } else if (descriptionLength > DESCRIPTION_MAX_LENGTH) {
    score += 13;
    findings.push({ severity: "warn", message: `Meta description is ${descriptionLength} chars and will likely be truncated (~${DESCRIPTION_MAX_LENGTH}).` });
  } else {
    score += 20;
    findings.push({ severity: "pass", message: `Meta description is ${descriptionLength} chars — a good length.` });
  }

  // --- canonical
  const canonicalIsSelf =
    canonical !== null &&
    normalizeForCompare(canonical) === normalizeForCompare(page.finalUrl);
  if (!canonical) {
    findings.push({ severity: "warn", message: "No canonical link. Add one to consolidate duplicate URLs (tracking params, trailing slashes)." });
  } else if ($('link[rel="canonical" i]').length > 1) {
    score += 8;
    findings.push({ severity: "fail", message: "Multiple canonical tags — search engines may ignore all of them. Keep exactly one." });
  } else if (canonicalIsSelf) {
    score += 15;
    findings.push({ severity: "pass", message: "Canonical is self-referencing." });
  } else {
    score += 12;
    findings.push({ severity: "info", message: `Canonical points elsewhere: ${canonical}. Intentional only if this page is a duplicate.` });
  }

  // --- indexability
  if (!indexable) {
    findings.push({ severity: "fail", message: `Page is set to noindex (${directives.join(", ")}). It will be dropped from search results.` });
  } else {
    score += 15;
    findings.push({ severity: "pass", message: "Page is indexable (no noindex directive)." });
  }
  if (!followable) {
    findings.push({ severity: "warn", message: "Page is set to nofollow — its outgoing links pass no signals." });
  }

  // --- technical basics
  if (lang) {
    score += 8;
    findings.push({ severity: "pass", message: `Document language declared: lang="${lang}".` });
  } else {
    findings.push({ severity: "warn", message: 'No lang attribute on <html>. Add e.g. lang="es" — it aids i18n targeting and screen readers.' });
  }

  if (charset) {
    score += 7;
  } else {
    findings.push({ severity: "warn", message: "No character encoding declared. Add <meta charset=\"utf-8\">." });
  }

  if (viewport) {
    score += 10;
    findings.push({ severity: "pass", message: "Viewport meta tag present (mobile-ready)." });
  } else {
    findings.push({ severity: "fail", message: "No viewport meta tag. Mobile rendering will break and mobile-first indexing will suffer." });
  }

  return {
    url: page.url,
    final_url: page.finalUrl,
    title,
    title_length: titleLength,
    description,
    description_length: descriptionLength,
    canonical,
    canonical_is_self: canonicalIsSelf,
    meta_robots: metaRobots,
    x_robots_tag: xRobotsTag,
    robots_directives: directives,
    indexable,
    followable,
    lang,
    charset,
    viewport,
    favicon,
    score: clampScore(score),
    grade: scoreToGrade(clampScore(score)),
    findings,
  };
}

// --- social preview --------------------------------------------------------

export interface SocialReport {
  url: string;
  final_url: string;
  open_graph: Record<string, string>;
  twitter: Record<string, string>;
  og_image_url: string | null;
  og_image_reachable: boolean | null;
  og_image_status: number | null;
  og_image_content_type: string | null;
  score: number;
  grade: string;
  findings: Finding[];
}

/** Required-ish Open Graph properties, with the weight each carries. */
const OG_REQUIRED: Array<{ key: string; weight: number; why: string }> = [
  { key: "og:title", weight: 20, why: "the headline shown in the share card" },
  { key: "og:description", weight: 15, why: "the body text of the share card" },
  { key: "og:image", weight: 25, why: "the preview image — by far the biggest driver of click-through" },
  { key: "og:url", weight: 10, why: "the canonical URL the share resolves to" },
  { key: "og:type", weight: 10, why: "the content type (website, article, …)" },
];

export async function analyzeSocial(
  page: PageDoc,
  checkImage = true,
): Promise<SocialReport> {
  const $ = page.$;
  const findings: Finding[] = [];

  const openGraph: Record<string, string> = {};
  $('meta[property^="og:" i], meta[property^="article:" i]').each((_, el) => {
    const key = $(el).attr("property")?.toLowerCase();
    const content = $(el).attr("content")?.trim();
    if (key && content && !(key in openGraph)) openGraph[key] = content;
  });

  const twitter: Record<string, string> = {};
  $('meta[name^="twitter:" i]').each((_, el) => {
    const key = $(el).attr("name")?.toLowerCase();
    const content = $(el).attr("content")?.trim();
    if (key && content && !(key in twitter)) twitter[key] = content;
  });

  let score = 0;
  for (const { key, weight, why } of OG_REQUIRED) {
    if (openGraph[key]) {
      score += weight;
      findings.push({ severity: "pass", message: `${key} is set.` });
    } else {
      findings.push({ severity: key === "og:image" ? "fail" : "warn", message: `Missing ${key} — ${why}.` });
    }
  }

  // Twitter falls back to Open Graph, so a missing card type is only a warning.
  if (twitter["twitter:card"]) {
    score += 10;
    findings.push({ severity: "pass", message: `twitter:card is '${twitter["twitter:card"]}'.` });
  } else {
    findings.push({ severity: "warn", message: "No twitter:card. X falls back to Open Graph, but 'summary_large_image' gives a much larger preview." });
  }

  if (openGraph["og:site_name"]) score += 5;

  // --- verify the preview image actually loads
  const ogImageRaw = openGraph["og:image"] ?? twitter["twitter:image"] ?? null;
  const ogImageUrl = ogImageRaw
    ? (resolveUrl(page, ogImageRaw)?.toString() ?? ogImageRaw)
    : null;

  let reachable: boolean | null = null;
  let imageStatus: number | null = null;
  let imageContentType: string | null = null;

  if (ogImageUrl && checkImage) {
    const parsed = validateUrl(ogImageUrl);
    if (!parsed) {
      reachable = false;
      findings.push({ severity: "fail", message: `og:image '${ogImageRaw}' is not a valid public URL.` });
    } else {
      try {
        const res = await safeFetch(parsed, { method: "HEAD", timeoutMs: 8000 });
        imageStatus = res.status;
        imageContentType = res.headers["content-type"] ?? null;
        reachable = res.status >= 200 && res.status < 300;
        if (reachable) {
          score += 5;
          findings.push({ severity: "pass", message: `og:image is reachable (HTTP ${res.status}, ${imageContentType ?? "unknown type"}).` });
        } else {
          findings.push({ severity: "fail", message: `og:image returned HTTP ${res.status} — the share card will render blank.` });
        }
      } catch (err) {
        reachable = false;
        findings.push({ severity: "warn", message: `Could not verify og:image (${err instanceof Error ? err.message : String(err)}). Some CDNs reject HEAD requests.` });
      }
    }
  }

  // Relative og:image URLs are a classic bug — scrapers require absolute URLs.
  if (ogImageRaw && !/^https?:\/\//i.test(ogImageRaw)) {
    findings.push({ severity: "fail", message: `og:image is relative ('${ogImageRaw}'). Social scrapers require an absolute URL.` });
  }

  return {
    url: page.url,
    final_url: page.finalUrl,
    open_graph: openGraph,
    twitter,
    og_image_url: ogImageUrl,
    og_image_reachable: reachable,
    og_image_status: imageStatus,
    og_image_content_type: imageContentType,
    score: clampScore(score),
    grade: scoreToGrade(clampScore(score)),
    findings,
  };
}

// --- hreflang --------------------------------------------------------------

export interface HreflangEntry {
  hreflang: string;
  href: string;
  valid_code: boolean;
  is_self: boolean;
  reciprocates: boolean | null;
  error: string | null;
}

export interface HreflangReport {
  url: string;
  final_url: string;
  declared_lang: string | null;
  entries: HreflangEntry[];
  has_x_default: boolean;
  self_referencing: boolean;
  duplicate_codes: string[];
  invalid_codes: string[];
  reciprocity_checked: boolean;
  findings: Finding[];
}

/** BCP-47 shape used by hreflang: language[-Script][-REGION], or `x-default`. */
const HREFLANG_RE = /^([a-z]{2,3})(-[a-z]{4})?(-([a-z]{2}|\d{3}))?$/i;

function isValidHreflang(code: string): boolean {
  return code.toLowerCase() === "x-default" || HREFLANG_RE.test(code);
}

/**
 * Analyse `<link rel="alternate" hreflang>` annotations.
 *
 * When `checkReciprocity` is set, each alternate is fetched to confirm it points
 * back at this page — the most common hreflang bug, and one you cannot catch by
 * looking at a single page in isolation.
 */
export async function analyzeHreflang(
  page: PageDoc,
  checkReciprocity = false,
  maxReciprocityChecks = 10,
): Promise<HreflangReport> {
  const $ = page.$;
  const findings: Finding[] = [];
  const entries: HreflangEntry[] = [];
  const seen = new Map<string, number>();

  $('link[rel="alternate" i][hreflang]').each((_, el) => {
    const code = $(el).attr("hreflang")?.trim() ?? "";
    const hrefRaw = $(el).attr("href")?.trim() ?? "";
    if (!code || !hrefRaw) return;
    const href = resolveUrl(page, hrefRaw)?.toString() ?? hrefRaw;
    seen.set(code.toLowerCase(), (seen.get(code.toLowerCase()) ?? 0) + 1);
    entries.push({
      hreflang: code,
      href,
      valid_code: isValidHreflang(code),
      is_self: normalizeForCompare(href) === normalizeForCompare(page.finalUrl),
      reciprocates: null,
      error: null,
    });
  });

  const declaredLang = $("html").attr("lang")?.trim() || null;
  const hasXDefault = entries.some((e) => e.hreflang.toLowerCase() === "x-default");
  const selfReferencing = entries.some((e) => e.is_self);
  const duplicateCodes = [...seen.entries()].filter(([, n]) => n > 1).map(([c]) => c);
  const invalidCodes = entries.filter((e) => !e.valid_code).map((e) => e.hreflang);

  if (entries.length === 0) {
    findings.push({ severity: "info", message: "No hreflang annotations. Only needed if this page has translated or region-specific equivalents." });
    return {
      url: page.url,
      final_url: page.finalUrl,
      declared_lang: declaredLang,
      entries,
      has_x_default: false,
      self_referencing: false,
      duplicate_codes: [],
      invalid_codes: [],
      reciprocity_checked: false,
      findings,
    };
  }

  findings.push({ severity: "pass", message: `${entries.length} hreflang annotation(s) found.` });

  if (!selfReferencing) {
    findings.push({ severity: "fail", message: "The hreflang cluster does not include a self-referencing entry. Google requires each page to list itself." });
  } else {
    findings.push({ severity: "pass", message: "Self-referencing hreflang entry present." });
  }

  if (!hasXDefault) {
    findings.push({ severity: "warn", message: "No x-default entry. Add one to tell search engines which version to show unmatched locales." });
  } else {
    findings.push({ severity: "pass", message: "x-default entry present." });
  }

  if (duplicateCodes.length) {
    findings.push({ severity: "fail", message: `Duplicate hreflang code(s): ${duplicateCodes.join(", ")}. Each code must appear exactly once.` });
  }
  if (invalidCodes.length) {
    findings.push({ severity: "fail", message: `Invalid hreflang code(s): ${invalidCodes.join(", ")}. Use ISO 639-1 language plus optional ISO 3166-1 region, e.g. 'es-MX'.` });
  }

  // --- reciprocity: fetch each alternate and confirm it links back
  if (checkReciprocity) {
    const targets = entries
      .filter((e) => !e.is_self && e.hreflang.toLowerCase() !== "x-default")
      .slice(0, maxReciprocityChecks);

    await Promise.all(
      targets.map(async (entry) => {
        const parsed = validateUrl(entry.href);
        if (!parsed) {
          entry.error = "not a valid public URL";
          entry.reciprocates = false;
          return;
        }
        try {
          const { loadPage } = await import("./page.js");
          const alt = await loadPage(parsed);
          const backLinks = alt
            .$('link[rel="alternate" i][hreflang]')
            .toArray()
            .map((el) => alt.$(el).attr("href")?.trim() ?? "")
            .filter(Boolean)
            .map((h) => normalizeForCompare(new URL(h, alt.finalUrl).toString()));
          entry.reciprocates = backLinks.includes(normalizeForCompare(page.finalUrl));
        } catch (err) {
          entry.error = err instanceof Error ? err.message : String(err);
          entry.reciprocates = null;
        }
      }),
    );

    const broken = targets.filter((e) => e.reciprocates === false);
    if (broken.length) {
      findings.push({ severity: "fail", message: `${broken.length} alternate(s) do not link back to this page: ${broken.map((e) => e.hreflang).join(", ")}. Non-reciprocal hreflang is ignored by Google.` });
    } else if (targets.length) {
      findings.push({ severity: "pass", message: `All ${targets.length} checked alternate(s) reciprocate correctly.` });
    }
  }

  return {
    url: page.url,
    final_url: page.finalUrl,
    declared_lang: declaredLang,
    entries,
    has_x_default: hasXDefault,
    self_referencing: selfReferencing,
    duplicate_codes: duplicateCodes,
    invalid_codes: invalidCodes,
    reciprocity_checked: checkReciprocity,
    findings,
  };
}
