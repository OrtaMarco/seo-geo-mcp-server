/**
 * SSRF-safe HTTP client shared by every tool.
 *
 * Redirects are followed *manually* so each hop is re-checked by the SSRF guard
 * — otherwise a public URL could 30x-redirect into an internal address. Response
 * bodies are read through a byte cap so a hostile or accidental multi-gigabyte
 * page cannot exhaust memory.
 */

import {
  DEFAULT_TIMEOUT_MS,
  MAX_HTML_BYTES,
  MAX_REDIRECTS,
  USER_AGENT,
} from "../constants.js";
import { resolvesToPrivate } from "./validate.js";

/** One hop in a redirect chain. */
export interface RedirectHop {
  url: string;
  status: number;
  location: string;
}

export interface FetchResult {
  /** The URL originally requested. */
  url: string;
  /** The URL that finally answered, after redirects. */
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Bytes actually read (after the cap). */
  bytes: number;
  /** True when the body was cut short by the byte cap. */
  truncated: boolean;
  /** Wall-clock time for the whole chain, in milliseconds. */
  elapsedMs: number;
  redirects: RedirectHop[];
}

export interface FetchOptions {
  /** HTTP method. Defaults to GET. */
  method?: "GET" | "HEAD";
  /** Override the User-Agent — used to probe how a site treats AI crawlers. */
  userAgent?: string;
  /** Maximum bytes to read from the body. Defaults to MAX_HTML_BYTES. */
  maxBytes?: number;
  /** Maximum redirect hops. Defaults to MAX_REDIRECTS. */
  maxRedirects?: number;
  /** Per-request timeout in ms. Defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Accept header. Defaults to a browser-like HTML accept string. */
  accept?: string;
}

const DEFAULT_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

/** Read a response body up to `maxBytes`, decoding as UTF-8. */
async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!res.body) return { text: "", bytes: 0, truncated: false };

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (bytes + value.length > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - bytes));
        bytes = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      bytes += value.length;
    }
  } finally {
    // Releasing the lock lets the connection be reused or torn down cleanly
    // even when we bailed out early on the byte cap.
    await reader.cancel().catch(() => {});
  }

  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(merged),
    bytes,
    truncated,
  };
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * Fetch a URL, following redirects one hop at a time and re-running the SSRF
 * guard on every hop.
 *
 * @throws if any hop resolves to a private address, a redirect target is not
 * http(s), or the chain exceeds `maxRedirects`.
 */
export async function safeFetch(
  start: URL,
  options: FetchOptions = {},
): Promise<FetchResult> {
  const {
    method = "GET",
    userAgent = USER_AGENT,
    maxBytes = MAX_HTML_BYTES,
    maxRedirects = MAX_REDIRECTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    accept = DEFAULT_ACCEPT,
  } = options;

  const began = Date.now();
  const redirects: RedirectHop[] = [];
  let current = start;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (await resolvesToPrivate(current.hostname)) {
      throw new Error(
        `Refusing to fetch ${current.hostname}: it resolves to a private or reserved address.`,
      );
    }

    const res = await fetch(current.toString(), {
      method,
      redirect: "manual",
      headers: {
        "user-agent": userAgent,
        accept,
        "accept-language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      redirects.push({ url: current.toString(), status: res.status, location });
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new Error(`Redirect to an unparseable location: '${location}'.`);
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw new Error("Refusing to follow a redirect to a non-HTTP(S) URL.");
      }
      // Drain the redirect response so the socket is not left dangling.
      await res.body?.cancel().catch(() => {});
      current = next;
      continue;
    }

    const { text, bytes, truncated } =
      method === "HEAD"
        ? { text: "", bytes: 0, truncated: false }
        : await readCapped(res, maxBytes);

    return {
      url: start.toString(),
      finalUrl: current.toString(),
      status: res.status,
      headers: headersToObject(res.headers),
      body: text,
      bytes,
      truncated,
      elapsedMs: Date.now() - began,
      redirects,
    };
  }

  throw new Error(
    `Too many redirects (more than ${maxRedirects}) starting from ${start.toString()}.`,
  );
}

/**
 * Fetch a URL that is expected to be small and plain-text (robots.txt,
 * llms.txt, a sitemap). Returns null when the resource is absent (404/410)
 * rather than throwing, so callers can treat "not published" as a normal state.
 */
export async function fetchTextResource(
  url: URL,
  options: FetchOptions = {},
): Promise<FetchResult | null> {
  const res = await safeFetch(url, {
    accept: "text/plain,application/xml,text/xml,*/*;q=0.8",
    ...options,
  });
  if (res.status === 404 || res.status === 410) return null;
  return res;
}
