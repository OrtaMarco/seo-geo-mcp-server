/**
 * Shared constants for the SEO & GEO MCP server.
 */

import { createRequire } from "node:module";

export const SERVER_NAME = "seo-geo-mcp-server";

/** Read from package.json (always shipped) so the two can never disagree. */
export const SERVER_VERSION: string = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

/** Maximum size of any tool response, in characters, before truncation. */
export const CHARACTER_LIMIT = 25_000;

/** Default per-operation network timeout, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 12_000;

/**
 * Maximum HTML payload we will parse, in bytes. Parsing is synchronous, so this
 * bounds how long one page can hold the event loop and how much memory its DOM
 * takes; real pages are well under it.
 */
export const MAX_HTML_BYTES = 2_000_000;

/**
 * Deepest element nesting a page may have before it is refused unparsed.
 * Chromium's HTML parser flattens anything deeper than 512, so nothing a
 * browser shows needs more, and a pathological tree makes the parser quadratic.
 */
export const MAX_HTML_DEPTH = 512;

/** Maximum redirect hops followed when tracing a URL. */
export const MAX_REDIRECTS = 10;

/**
 * User agent used for every outbound request. Identifies the tool honestly and
 * points at a page explaining it, per robots.txt etiquette.
 */
export const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION} (+https://github.com/OrtaMarco/seo-geo-mcp-server; MCP SEO/GEO auditor)`;

// --- SEO thresholds --------------------------------------------------------
//
// These are the widely used rendering limits for Google's desktop SERP. They
// are guidance, not hard rules — Google truncates on pixel width, not
// character count, so treat them as a "likely truncated" signal.

export const TITLE_MIN_LENGTH = 30;
export const TITLE_MAX_LENGTH = 60;
export const DESCRIPTION_MIN_LENGTH = 70;
export const DESCRIPTION_MAX_LENGTH = 160;

/** Below this word count a page is usually too thin to rank or be cited. */
export const THIN_CONTENT_WORDS = 300;

/** Page weight (HTML only) above which we warn, in bytes. */
export const HEAVY_HTML_BYTES = 150_000;

/** Sitemaps may not exceed these limits (sitemaps.org protocol). */
export const SITEMAP_MAX_URLS = 50_000;
export const SITEMAP_MAX_BYTES = 52_428_800; // 50 MiB uncompressed

/**
 * How much of one sitemap this server reads (compressed or not). The protocol
 * allows 50 MiB, but parsing that much takes over a gigabyte of memory; the
 * report flags a sitemap that reaches this cap instead of reading all of it.
 */
export const SITEMAP_READ_BYTES = 10_485_760;

/** How many links `link_audit` will actually request when checking for breakage. */
export const LINK_CHECK_SAMPLE = 25;

/** How many of those link checks run at once, so an audit never floods the site. */
export const LINK_CHECK_CONCURRENCY = 6;

/** Longest robots.txt path pattern or tested path that is matched. */
export const ROBOTS_MAX_PATTERN_CHARS = 2048;

/** Items kept in any list of a tool's structured result. */
export const MAX_STRUCTURED_ITEMS = 200;
