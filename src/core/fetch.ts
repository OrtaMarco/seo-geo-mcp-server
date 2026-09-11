/**
 * SSRF-safe HTTP client shared by every tool.
 *
 * Every connection goes through the guarded dispatcher, which checks the
 * address a socket is about to use (see netguard.ts). Redirects are followed
 * *manually* so each hop's URL is screened too, and a chain that revisits a URL
 * is reported as a loop instead of being walked until the hop limit. Response
 * bodies are read through a byte cap so a hostile or accidental multi-gigabyte
 * page cannot exhaust memory.
 */

import { fetch as undiciFetch, type Agent, type Response } from "undici";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_HTML_BYTES,
  MAX_REDIRECTS,
  USER_AGENT,
} from "../constants.js";
import { assertPublicTarget, guardedDispatcher } from "./netguard.js";

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
  /** The body as bytes, only when `raw` was requested. */
  rawBody: Uint8Array | null;
  /** Bytes actually read (after the cap). */
  bytes: number;
  /** True when the body was cut short by the byte cap. */
  truncated: boolean;
  /** Wall-clock time for the whole chain, in milliseconds. */
  elapsedMs: number;
  redirects: RedirectHop[];
  /** True when the chain redirected back to a URL it had already visited. */
  redirectLoop: boolean;
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
  /** Also return the body as bytes (for gzip payloads). */
  raw?: boolean;
  /** Override the guarded dispatcher (tests). */
  dispatcher?: Agent;
}

const DEFAULT_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

/** Read a response body up to `maxBytes`. */
async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ data: Uint8Array; bytes: number; truncated: boolean }> {
  if (!res.body) return { data: new Uint8Array(0), bytes: 0, truncated: false };

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
  return { data: merged, bytes, truncated };
}

function headersToObject(headers: Response["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/** A URL's identity for loop detection: the fragment never reaches the server. */
function visitKey(url: URL): string {
  const copy = new URL(url);
  copy.hash = "";
  return copy.toString();
}

/**
 * Fetch a URL, following redirects one hop at a time and screening every hop.
 *
 * @throws if any hop targets a private address, a redirect target is not
 * http(s), or the chain exceeds `maxRedirects` without looping.
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
    raw = false,
    dispatcher = guardedDispatcher,
  } = options;

  const began = Date.now();
  const redirects: RedirectHop[] = [];
  const visited = new Set<string>();
  let current = start;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    assertPublicTarget(current.hostname);
    visited.add(visitKey(current));

    const res = await undiciFetch(current, {
      method,
      redirect: "manual",
      headers: {
        "user-agent": userAgent,
        accept,
        "accept-language": "en-US,en;q=0.9",
      },
      dispatcher,
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
      if (visited.has(visitKey(next))) {
        return {
          url: start.toString(),
          finalUrl: current.toString(),
          status: res.status,
          headers: headersToObject(res.headers),
          body: "",
          rawBody: null,
          bytes: 0,
          truncated: false,
          elapsedMs: Date.now() - began,
          redirects,
          redirectLoop: true,
        };
      }
      current = next;
      continue;
    }

    const { data, bytes, truncated } =
      method === "HEAD"
        ? { data: new Uint8Array(0), bytes: 0, truncated: false }
        : await readCapped(res, maxBytes);

    return {
      url: start.toString(),
      finalUrl: current.toString(),
      status: res.status,
      headers: headersToObject(res.headers),
      body: new TextDecoder("utf-8", { fatal: false }).decode(data),
      rawBody: raw ? data : null,
      bytes,
      truncated,
      elapsedMs: Date.now() - began,
      redirects,
      redirectLoop: false,
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
