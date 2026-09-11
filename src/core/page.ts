/**
 * Page loading and the shared parsed-document model.
 *
 * Every on-page analyser takes a `PageDoc` rather than a URL, so a composite
 * tool like `seo_audit` fetches the page **once** and runs a dozen checks over
 * the same DOM instead of hammering the site.
 */

import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { MAX_HTML_DEPTH } from "../constants.js";
import { safeFetch, type FetchOptions, type RedirectHop } from "./fetch.js";

export interface PageDoc {
  /** The URL originally requested. */
  url: string;
  /** The URL that finally answered, after redirects. */
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  contentType: string;
  html: string;
  /** Size of the HTML document in bytes. */
  bytes: number;
  /** True when the HTML was cut short by the byte cap. */
  truncated: boolean;
  /** Time to fetch the document (not its sub-resources), in milliseconds. */
  elapsedMs: number;
  redirects: RedirectHop[];
  /** The parsed DOM. */
  $: CheerioAPI;
}

/** Thrown when a URL answers with something that is not an HTML document. */
export class NotHtmlError extends Error {
  constructor(
    readonly finalUrl: string,
    readonly contentType: string,
  ) {
    super(
      `${finalUrl} returned Content-Type '${contentType || "unknown"}', not HTML. ` +
        `On-page SEO tools need an HTML document — check the URL points at a page, not a file or API endpoint.`,
    );
    this.name = "NotHtmlError";
  }
}

/** Thrown when a page answers with an HTTP error status. */
export class HttpStatusError extends Error {
  constructor(
    readonly finalUrl: string,
    readonly status: number,
  ) {
    super(
      `${finalUrl} returned HTTP ${status}. ` +
        (status === 403 || status === 401
          ? "The site is blocking this crawler — its WAF or bot protection may need an allowlist entry."
          : status >= 500
            ? "The server is erroring; retry later."
            : "Check the URL is correct and publicly reachable."),
    );
    this.name = "HttpStatusError";
  }
}

/** Thrown when a document nests so deeply that parsing it would stall the server. */
export class TooDeepError extends Error {
  constructor(readonly finalUrl: string) {
    super(
      `${finalUrl} nests elements more than ${MAX_HTML_DEPTH} levels deep. Browsers flatten a tree that deep, and parsing it would stall this server, so the page was not analysed.`,
    );
    this.name = "TooDeepError";
  }
}

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr",
]);
/** Elements whose end tag HTML lets authors omit; counting them would inflate depth on valid pages. */
const OPTIONAL_END = new Set([
  "p", "li", "dt", "dd", "tr", "td", "th", "thead", "tbody", "tfoot", "option", "optgroup", "colgroup", "rb", "rt", "rtc", "rp", "html", "head", "body",
]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "noscript", "template"]);

/**
 * Whether `html` nests deeper than `limit`, measured with one linear scan (no
 * regex backtracking, no DOM). Comments and raw-text elements are skipped;
 * void and optional-end elements do not count toward depth.
 */
export function exceedsNestingDepth(html: string, limit = MAX_HTML_DEPTH): boolean {
  const lower = html.toLowerCase();
  let depth = 0;
  let i = 0;
  while ((i = lower.indexOf("<", i)) !== -1) {
    if (lower.startsWith("<!--", i)) {
      const end = lower.indexOf("-->", i + 4);
      if (end === -1) return false;
      i = end + 3;
      continue;
    }
    const close = lower.indexOf(">", i);
    if (close === -1) return false;
    const m = /^<(\/?)([a-z][a-z0-9:-]*)/.exec(lower.slice(i, Math.min(close + 1, i + 64)));
    if (!m) {
      i++;
      continue;
    }
    const [, slash, name] = m as unknown as [string, string, string];
    if (!slash && RAW_TEXT.has(name)) {
      const end = lower.indexOf(`</${name}`, close);
      if (end === -1) return false;
      i = end;
      continue;
    }
    if (!VOID_ELEMENTS.has(name) && !OPTIONAL_END.has(name)) {
      if (slash) depth = Math.max(0, depth - 1);
      else if (lower[close - 1] !== "/" && ++depth > limit) return true;
    }
    i = close + 1;
  }
  return false;
}

function looksLikeHtml(contentType: string, body: string): boolean {
  if (/text\/html|application\/xhtml\+xml/i.test(contentType)) return true;
  // Some servers send text/plain or no type at all for real HTML documents.
  if (contentType && !/text\/plain|^$/i.test(contentType)) return false;
  return /<html[\s>]|<!doctype\s+html/i.test(body.slice(0, 2000));
}

/**
 * Fetch a URL and parse it as HTML.
 *
 * @throws {HttpStatusError} on a non-2xx response.
 * @throws {NotHtmlError} when the response is not an HTML document.
 */
export async function loadPage(
  url: URL,
  options: FetchOptions = {},
): Promise<PageDoc> {
  const res = await safeFetch(url, options);
  const contentType = res.headers["content-type"] ?? "";

  if (res.status < 200 || res.status >= 300) {
    throw new HttpStatusError(res.finalUrl, res.status);
  }
  if (!looksLikeHtml(contentType, res.body)) {
    throw new NotHtmlError(res.finalUrl, contentType);
  }
  if (exceedsNestingDepth(res.body)) {
    throw new TooDeepError(res.finalUrl);
  }

  return {
    url: res.url,
    finalUrl: res.finalUrl,
    status: res.status,
    headers: res.headers,
    contentType,
    html: res.body,
    bytes: res.bytes,
    truncated: res.truncated,
    elapsedMs: res.elapsedMs,
    redirects: res.redirects,
    $: cheerio.load(res.body),
  };
}

/**
 * Resolve a possibly-relative URL against the page's final URL.
 * @returns the absolute URL, or null if it cannot be parsed.
 */
export function resolveUrl(page: PageDoc, href: string): URL | null {
  try {
    return new URL(href, page.finalUrl);
  } catch {
    return null;
  }
}

/** The page's origin, e.g. `https://example.com`. */
export function pageOrigin(page: PageDoc): string {
  return new URL(page.finalUrl).origin;
}

/**
 * Extract the page's visible text, with script/style/nav chrome removed.
 * Used for word counts, readability and GEO extractability checks.
 */
export function visibleText(page: PageDoc): string {
  // A clone of the already-parsed tree, not a second parse: we mutate it.
  const root = page.$.root().clone();
  root.find("script, style, noscript, template, svg, iframe").remove();
  const body = root.find("body");
  return (body.length ? body.text() : root.text()).replace(/\s+/g, " ").trim();
}

/**
 * Extract the text of the page's **main content**, falling back to the whole
 * body when the page has no semantic main/article landmark. Chrome (header,
 * nav, footer, aside) is dropped so word counts reflect actual content.
 */
export function mainText(page: PageDoc): { text: string; usedLandmark: boolean } {
  const root = page.$.root().clone();
  root.find("script, style, noscript, template, svg, iframe").remove();

  for (const selector of ["main", "article", '[role="main"]']) {
    const node = root.find(selector).first();
    if (node.length && node.text().trim().length > 200) {
      return {
        text: node.text().replace(/\s+/g, " ").trim(),
        usedLandmark: true,
      };
    }
  }

  root.find("header, nav, footer, aside").remove();
  const body = root.find("body");
  return { text: (body.length ? body.text() : root.text()).replace(/\s+/g, " ").trim(), usedLandmark: false };
}
