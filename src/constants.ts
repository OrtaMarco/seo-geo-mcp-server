/**
 * Shared constants for the SEO & GEO MCP server.
 */

export const SERVER_NAME = "seo-geo-mcp-server";
export const SERVER_VERSION = "1.0.0";

/**
 * Public DNS resolvers (Cloudflare, Google, Quad9). Used instead of the host's
 * /etc/resolv.conf so the SSRF guard behaves identically in any environment
 * (containers, WSL, CI) where the system resolver may be missing or local-only.
 */
export const PUBLIC_DNS_SERVERS = ["1.1.1.1", "8.8.8.8", "9.9.9.9"];

/** Maximum size of any tool response, in characters, before truncation. */
export const CHARACTER_LIMIT = 25_000;

/** Default per-operation network timeout, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 12_000;

/** Maximum HTML payload we will parse, in bytes. Guards against huge pages. */
export const MAX_HTML_BYTES = 5_000_000;

/** Maximum redirect hops followed when tracing a URL. */
export const MAX_REDIRECTS = 10;

/**
 * User agent used for every outbound request. Identifies the tool honestly and
 * points at a page explaining it, per robots.txt etiquette.
 */
export const USER_AGENT =
  "seo-geo-mcp-server/1.0 (+https://ortamarco.me; MCP SEO/GEO auditor)";

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

/** How many links `link_audit` will actually request when checking for breakage. */
export const LINK_CHECK_SAMPLE = 25;
