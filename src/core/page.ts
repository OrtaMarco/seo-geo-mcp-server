/**
 * Page loading and the shared parsed-document model.
 *
 * Every on-page analyser takes a `PageDoc` rather than a URL, so a composite
 * tool like `seo_audit` fetches the page **once** and runs a dozen checks over
 * the same DOM instead of hammering the site.
 */

import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
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
  const $ = cheerio.load(page.html); // a private copy: we mutate it
  $("script, style, noscript, template, svg, iframe").remove();
  return $("body").text().replace(/\s+/g, " ").trim();
}

/**
 * Extract the text of the page's **main content**, falling back to the whole
 * body when the page has no semantic main/article landmark. Chrome (header,
 * nav, footer, aside) is dropped so word counts reflect actual content.
 */
export function mainText(page: PageDoc): { text: string; usedLandmark: boolean } {
  const $ = cheerio.load(page.html);
  $("script, style, noscript, template, svg, iframe").remove();

  for (const selector of ["main", "article", '[role="main"]']) {
    const node = $(selector).first();
    if (node.length && node.text().trim().length > 200) {
      return {
        text: node.text().replace(/\s+/g, " ").trim(),
        usedLandmark: true,
      };
    }
  }

  $("header, nav, footer, aside").remove();
  return { text: $("body").text().replace(/\s+/g, " ").trim(), usedLandmark: false };
}
