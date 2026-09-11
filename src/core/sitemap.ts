/**
 * XML sitemap discovery, parsing and validation (sitemaps.org protocol).
 *
 * Handles both `<urlset>` documents and `<sitemapindex>` containers, follows
 * index children up to a bounded depth, and transparently decompresses `.gz`
 * sitemaps.
 */

import { gunzipSync } from "node:zlib";
import * as cheerio from "cheerio";
import { SITEMAP_MAX_BYTES, SITEMAP_MAX_URLS, SITEMAP_READ_BYTES } from "../constants.js";
import { clampScore, scoreToGrade, type Finding } from "../format.js";
import { safeFetch, type FetchResult } from "./fetch.js";
import { fetchRobots } from "./robots.js";
import { validateUrl } from "./validate.js";

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
  changefreq: string | null;
  priority: string | null;
}

export interface SitemapReport {
  url: string;
  found: boolean;
  status: number | null;
  type: "urlset" | "sitemapindex" | "unknown";
  /** Total URLs across this sitemap and any children that were followed. */
  url_count: number;
  child_sitemaps: string[];
  child_sitemaps_followed: number;
  entries: SitemapEntry[];
  with_lastmod: number;
  invalid_lastmod: string[];
  newest_lastmod: string | null;
  oldest_lastmod: string | null;
  off_origin_urls: string[];
  non_https_urls: string[];
  duplicate_urls: string[];
  exceeds_url_limit: boolean;
  exceeds_size_limit: boolean;
  bytes: number;
  discovered_via: "robots.txt" | "conventional-path" | "explicit";
  score: number;
  grade: string;
  findings: Finding[];
}

/** W3C datetime as required by sitemaps.org: YYYY-MM-DD with optional time. */
const LASTMOD_RE =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** The conventional locations to probe when robots.txt declares no sitemap. */
const CONVENTIONAL_PATHS = [
  "/sitemap.xml",
  "/sitemap_index.xml",
  "/sitemap-index.xml",
  "/sitemap.xml.gz",
];

interface ParsedSitemap {
  type: "urlset" | "sitemapindex" | "unknown";
  entries: SitemapEntry[];
  children: string[];
}

/**
 * The sitemap's XML text. A `.gz` sitemap served as a file (not as
 * Content-Encoding, which the transport already undoes) is gunzipped from the
 * raw bytes — decoding them as UTF-8 first destroys the gzip stream — with the
 * output capped, so a compression bomb cannot expand past the read limit.
 */
export function sitemapText(res: FetchResult, url: string): { xml: string; decompressedTooLarge: boolean } {
  const bytes = res.rawBody;
  const isGzip = bytes !== null && bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!isGzip) return { xml: res.body, decompressedTooLarge: false };
  try {
    return { xml: gunzipSync(bytes, { maxOutputLength: SITEMAP_READ_BYTES }).toString("utf8"), decompressedTooLarge: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      return { xml: "", decompressedTooLarge: true };
    }
    throw new Error(`${url} looks gzipped but could not be decompressed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const SITEMAP_FETCH = {
  accept: "application/xml,text/xml,application/gzip,*/*;q=0.8",
  maxBytes: SITEMAP_READ_BYTES,
  raw: true,
} as const;

function parseSitemapXml(xml: string): ParsedSitemap {
  const $ = cheerio.load(xml, { xmlMode: true });

  const children = $("sitemapindex > sitemap > loc")
    .toArray()
    .map((el) => $(el).text().trim())
    .filter(Boolean);

  if (children.length) {
    return { type: "sitemapindex", entries: [], children };
  }

  const entries: SitemapEntry[] = $("urlset > url")
    .toArray()
    .map((el) => {
      const node = $(el);
      return {
        loc: node.find("loc").first().text().trim(),
        lastmod: node.find("lastmod").first().text().trim() || null,
        changefreq: node.find("changefreq").first().text().trim() || null,
        priority: node.find("priority").first().text().trim() || null,
      };
    })
    .filter((e) => e.loc);

  if (entries.length) return { type: "urlset", entries, children: [] };

  // An empty <sitemapindex> is still an index.
  if ($("sitemapindex").length) return { type: "sitemapindex", entries: [], children: [] };
  return { type: "unknown", entries: [], children: [] };
}

/**
 * Locate a site's sitemap: an explicit URL if given, otherwise the first
 * `Sitemap:` directive in robots.txt, otherwise the conventional paths.
 */
export async function discoverSitemap(
  origin: string,
  explicit?: string,
): Promise<{ url: URL; via: SitemapReport["discovered_via"] } | null> {
  if (explicit) {
    const parsed = validateUrl(explicit);
    if (parsed) return { url: parsed, via: "explicit" };
    throw new Error(`sitemap_url '${explicit}' is not a valid public http(s) URL.`);
  }

  try {
    const robots = await fetchRobots(origin);
    const declared = robots.sitemaps[0];
    if (declared) {
      const parsed = validateUrl(declared);
      if (parsed) return { url: parsed, via: "robots.txt" };
    }
  } catch {
    /* robots.txt unreachable — fall through to conventional paths */
  }

  for (const path of CONVENTIONAL_PATHS) {
    const candidate = new URL(path, origin);
    try {
      let res = await safeFetch(candidate, { method: "HEAD", timeoutMs: 8000 });
      // Plenty of servers refuse HEAD; ask again with a tiny GET before moving on.
      if (res.status === 405 || res.status === 501) {
        res = await safeFetch(candidate, { method: "GET", timeoutMs: 8000, maxBytes: 1024 });
      }
      if (res.status >= 200 && res.status < 300) {
        return { url: candidate, via: "conventional-path" };
      }
    } catch {
      /* try the next candidate */
    }
  }

  return null;
}

/**
 * Fetch, parse and validate a sitemap.
 *
 * @param followChildren how many child sitemaps of an index to follow (0 = none).
 * @param maxEntries how many URL entries to retain in the report.
 */
export async function analyzeSitemap(
  origin: string,
  explicit?: string,
  followChildren = 3,
  maxEntries = 100,
): Promise<SitemapReport> {
  const findings: Finding[] = [];
  const discovered = await discoverSitemap(origin, explicit);

  if (!discovered) {
    return {
      url: new URL("/sitemap.xml", origin).toString(),
      found: false,
      status: 404,
      type: "unknown",
      url_count: 0,
      child_sitemaps: [],
      child_sitemaps_followed: 0,
      entries: [],
      with_lastmod: 0,
      invalid_lastmod: [],
      newest_lastmod: null,
      oldest_lastmod: null,
      off_origin_urls: [],
      non_https_urls: [],
      duplicate_urls: [],
      exceeds_url_limit: false,
      exceeds_size_limit: false,
      bytes: 0,
      discovered_via: "conventional-path",
      score: 0,
      grade: "F",
      findings: [
        {
          severity: "fail",
          message:
            "No sitemap found — robots.txt declares none and the conventional paths (/sitemap.xml, /sitemap_index.xml) 404. Crawlers must then rely entirely on link discovery.",
        },
      ],
    };
  }

  const res = await safeFetch(discovered.url, SITEMAP_FETCH);

  if (res.status < 200 || res.status >= 300) {
    return {
      url: discovered.url.toString(),
      found: false,
      status: res.status,
      type: "unknown",
      url_count: 0,
      child_sitemaps: [],
      child_sitemaps_followed: 0,
      entries: [],
      with_lastmod: 0,
      invalid_lastmod: [],
      newest_lastmod: null,
      oldest_lastmod: null,
      off_origin_urls: [],
      non_https_urls: [],
      duplicate_urls: [],
      exceeds_url_limit: false,
      exceeds_size_limit: false,
      bytes: res.bytes,
      discovered_via: discovered.via,
      score: 0,
      grade: "F",
      findings: [
        { severity: "fail", message: `Sitemap at ${discovered.url} returned HTTP ${res.status}.` },
      ],
    };
  }

  const main = sitemapText(res, discovered.url.toString());
  const parsed = parseSitemapXml(main.xml);

  // Loops and push-per-item, never spread: a 50 000-URL child spread into
  // push() or Math.max() blows the call stack.
  const allEntries: SitemapEntry[] = [];
  for (const entry of parsed.entries) allEntries.push(entry);
  let followed = 0;
  let readCapHit = res.truncated || main.decompressedTooLarge;

  // Walk index children so URL counts reflect the whole site, not just the index.
  if (parsed.type === "sitemapindex" && followChildren > 0) {
    for (const child of parsed.children.slice(0, followChildren)) {
      const childUrl = validateUrl(child);
      if (!childUrl) continue;
      try {
        const childRes = await safeFetch(childUrl, SITEMAP_FETCH);
        if (childRes.status >= 200 && childRes.status < 300) {
          const childText = sitemapText(childRes, childUrl.toString());
          if (childRes.truncated || childText.decompressedTooLarge) readCapHit = true;
          for (const entry of parseSitemapXml(childText.xml).entries) allEntries.push(entry);
          followed++;
        } else {
          findings.push({ severity: "warn", message: `Child sitemap ${child} returned HTTP ${childRes.status}.` });
        }
      } catch (err) {
        findings.push({
          severity: "warn",
          message: `Child sitemap ${child} could not be read: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  // --- validation
  const originHost = new URL(origin).host;
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const offOrigin: string[] = [];
  const nonHttps: string[] = [];
  const invalidLastmod: string[] = [];
  const lastmodDates: number[] = [];

  for (const entry of allEntries) {
    if (seen.has(entry.loc)) duplicates.add(entry.loc);
    seen.add(entry.loc);

    try {
      const parsedLoc = new URL(entry.loc);
      if (parsedLoc.host !== originHost && offOrigin.length < 20) offOrigin.push(entry.loc);
      if (parsedLoc.protocol !== "https:" && nonHttps.length < 20) nonHttps.push(entry.loc);
    } catch {
      if (offOrigin.length < 20) offOrigin.push(entry.loc);
    }

    if (entry.lastmod) {
      if (!LASTMOD_RE.test(entry.lastmod)) {
        if (invalidLastmod.length < 20) invalidLastmod.push(entry.lastmod);
      } else {
        const time = Date.parse(entry.lastmod);
        if (Number.isFinite(time)) lastmodDates.push(time);
      }
    }
  }

  const withLastmod = allEntries.filter((e) => e.lastmod).length;
  let newestTime = -Infinity;
  let oldestTime = Infinity;
  for (const time of lastmodDates) {
    if (time > newestTime) newestTime = time;
    if (time < oldestTime) oldestTime = time;
  }
  const newest = lastmodDates.length ? new Date(newestTime).toISOString() : null;
  const oldest = lastmodDates.length ? new Date(oldestTime).toISOString() : null;

  const exceedsUrlLimit = allEntries.length > SITEMAP_MAX_URLS;
  const exceedsSizeLimit = res.bytes > SITEMAP_MAX_BYTES;

  // --- scoring
  let score = 40;
  findings.push({
    severity: "pass",
    message: `Sitemap found at ${discovered.url} (via ${discovered.via}) — ${parsed.type}, ${allEntries.length} URL(s).`,
  });

  if (parsed.type === "unknown") {
    score -= 25;
    findings.push({ severity: "fail", message: "The document is neither a <urlset> nor a <sitemapindex>. Check it is valid sitemaps.org XML." });
  }

  if (discovered.via !== "robots.txt") {
    findings.push({ severity: "warn", message: "The sitemap is not declared in robots.txt. Add a `Sitemap:` line so crawlers find it without guessing." });
  } else {
    score += 10;
  }

  if (allEntries.length === 0 && parsed.type !== "sitemapindex") {
    findings.push({ severity: "fail", message: "The sitemap contains no URLs." });
  } else if (allEntries.length > 0) {
    score += 15;
  }

  if (withLastmod === 0 && allEntries.length > 0) {
    findings.push({ severity: "warn", message: "No <lastmod> dates. Google uses lastmod to prioritise recrawling — omitting it slows how fast your updates are noticed." });
  } else if (allEntries.length > 0) {
    const coverage = Math.round((withLastmod / allEntries.length) * 100);
    score += Math.round(20 * (withLastmod / allEntries.length));
    findings.push({
      severity: coverage >= 90 ? "pass" : "warn",
      message: `${coverage}% of URLs carry a <lastmod> date${newest ? ` (most recent: ${newest.slice(0, 10)})` : ""}.`,
    });
  }

  if (invalidLastmod.length) {
    findings.push({ severity: "fail", message: `${invalidLastmod.length} invalid <lastmod> value(s) (e.g. '${invalidLastmod[0]}'). Use W3C datetime, e.g. 2026-07-19 or 2026-07-19T10:30:00Z.` });
  }

  if (offOrigin.length) {
    findings.push({ severity: "fail", message: `${offOrigin.length} URL(s) point outside ${originHost} (e.g. ${offOrigin[0]}). Cross-domain URLs are ignored unless the sitemap is cross-submitted.` });
  } else if (allEntries.length) {
    score += 5;
  }

  if (nonHttps.length) {
    findings.push({ severity: "warn", message: `${nonHttps.length} URL(s) use http:// rather than https://.` });
  }

  if (duplicates.size) {
    findings.push({ severity: "warn", message: `${duplicates.size} duplicate URL(s) in the sitemap.` });
  }

  if (exceedsUrlLimit) {
    findings.push({ severity: "fail", message: `${allEntries.length} URLs exceeds the ${SITEMAP_MAX_URLS.toLocaleString()} limit. Split it and use a sitemap index.` });
  }
  if (readCapHit) {
    findings.push({
      severity: "warn",
      message: `At least one sitemap is larger than the ${Math.round(SITEMAP_READ_BYTES / 1_048_576)} MiB this server reads, so it was only partly analysed and the counts are a lower bound. Split large sitemaps behind an index.`,
    });
  }
  if (exceedsSizeLimit) {
    findings.push({ severity: "fail", message: `The sitemap exceeds the 50 MiB uncompressed limit. Split it into several files.` });
  }

  if (parsed.type === "sitemapindex") {
    findings.push({
      severity: "info",
      message: `Sitemap index with ${parsed.children.length} child sitemap(s); ${followed} followed for this report.`,
    });
  }

  return {
    url: discovered.url.toString(),
    found: true,
    status: res.status,
    type: parsed.type,
    url_count: allEntries.length,
    child_sitemaps: parsed.children,
    child_sitemaps_followed: followed,
    entries: allEntries.slice(0, maxEntries),
    with_lastmod: withLastmod,
    invalid_lastmod: invalidLastmod,
    newest_lastmod: newest,
    oldest_lastmod: oldest,
    off_origin_urls: offOrigin,
    non_https_urls: nonHttps,
    duplicate_urls: [...duplicates].slice(0, 20),
    exceeds_url_limit: exceedsUrlLimit,
    exceeds_size_limit: exceedsSizeLimit,
    bytes: res.bytes,
    discovered_via: discovered.via,
    score: clampScore(score),
    grade: scoreToGrade(clampScore(score)),
    findings,
  };
}
