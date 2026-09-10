/**
 * Shared plumbing for the MCP tool wrappers: annotations, common input fields
 * and error mapping.
 */

import * as z from "zod/v4";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { fail, responseFormatField } from "../format.js";
import { errMessage } from "../core/validate.js";
import { HttpStatusError, NotHtmlError } from "../core/page.js";

/** Every tool in this server is a read-only network probe. */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const urlField = z
  .string()
  .min(1)
  .describe("Page URL to analyse, e.g. 'https://example.com/blog/post'. The scheme defaults to https://.");

export const siteField = z
  .string()
  .min(1)
  .describe("Site domain or any URL on it, e.g. 'example.com'. Only the origin is used.");

/** Standard single-URL input shape. */
export const UrlInput = z.object({
  url: urlField,
  response_format: responseFormatField,
});

/** Standard single-site input shape. */
export const SiteInput = z.object({
  site: siteField,
  response_format: responseFormatField,
});

/**
 * Flatten an error and its `cause` chain into one searchable string.
 *
 * Node's `fetch` reports every network failure as a bare `TypeError: fetch
 * failed` and hides the real reason (ENOTFOUND, ECONNREFUSED, certificate
 * errors) in `cause`. Without unwrapping, every one of those would produce the
 * same useless message.
 */
function flattenError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    parts.push(errMessage(current));
    current = current instanceof Error ? (current.cause ?? null) : null;
  }
  return parts.join(" | ");
}

/**
 * Convert a thrown error into an actionable tool failure.
 *
 * The page-loading errors already carry a next step; anything else gets a
 * generic prefix so the caller still knows which operation failed.
 */
export function toFailure(context: string, err: unknown): CallToolResult {
  if (err instanceof HttpStatusError || err instanceof NotHtmlError) {
    return fail(err.message);
  }
  const message = flattenError(err);
  if (/refusing to fetch/i.test(message)) {
    return fail(`${message} This server only analyses publicly reachable sites.`);
  }
  if (/timeout|aborted|ETIMEDOUT/i.test(message)) {
    return fail(`${context} timed out. The site may be slow, rate-limiting, or blocking automated requests — retry, or check it loads in a browser.`);
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    return fail(`${context} failed: the hostname could not be resolved. Check the domain is spelled correctly and is publicly registered.`);
  }
  if (/ECONNREFUSED/i.test(message)) {
    return fail(`${context} failed: the connection was refused. The host resolves but is not serving on that port.`);
  }
  if (/ECONNRESET|EPIPE|socket hang up/i.test(message)) {
    return fail(`${context} failed: the connection was reset by the server, which often means bot protection rejected the request.`);
  }
  if (/certificate|SSL|TLS|ERR_TLS|self.signed/i.test(message)) {
    return fail(`${context} failed due to a TLS error: ${message}. The site's certificate may be expired, self-signed, or issued for a different hostname.`);
  }
  return fail(`${context} failed: ${message}`);
}

/** Render a score headline used across most markdown outputs. */
export function scoreHeadline(label: string, score: number, grade: string): string {
  return `**${label}: ${grade} (${score}/100)**`;
}
