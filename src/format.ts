/**
 * Shared response-formatting helpers for MCP tool handlers.
 *
 * Every data-returning tool supports two output formats:
 *   - "markdown" (default): human-readable, summarised.
 *   - "json": complete structured data for programmatic use.
 */

import * as z from "zod/v4";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { CHARACTER_LIMIT, MAX_STRUCTURED_ITEMS } from "./constants.js";

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

/** Reusable Zod field so every tool exposes the same `response_format` option. */
export const responseFormatField = z
  .enum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe(
    "Output format: 'markdown' for a human-readable summary (default) or 'json' for the full structured payload.",
  );

/** Truncate oversized text so a single tool call never floods the context window. */
export function truncate(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    `\n\n…[truncated ${text.length - CHARACTER_LIMIT} characters — the result is also in the tool's structuredContent; narrow the query to see it here]`
  );
}

/** A successful tool result carrying a single text block. */
export function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text: truncate(text) }] };
}

/** An error tool result. Messages should be actionable (what went wrong + next step). */
export function fail(text: string): CallToolResult {
  return { content: [{ type: "text", text: truncate(text) }], isError: true };
}

/**
 * Render `data` as the tool's text content (pretty JSON or the markdown renderer)
 * AND attach it as `structuredContent` for clients that consume the tool's
 * `outputSchema`. `data` must be a plain object (the SDK validates it against the
 * declared outputSchema).
 */
export function respond(
  data: unknown,
  format: ResponseFormat,
  toMarkdown: () => string,
): CallToolResult {
  const structured = capLists(data);
  const text =
    format === ResponseFormat.JSON ? JSON.stringify(structured, null, 2) : toMarkdown();
  return {
    content: [{ type: "text", text: truncate(text) }],
    structuredContent: structured as Record<string, unknown>,
  };
}

/**
 * Cap every list in a result at MAX_STRUCTURED_ITEMS. The lists come from the
 * audited site (robots warnings, hreflang entries, sitemap children…), so a
 * hostile or merely enormous site could otherwise make one result megabytes
 * long. When anything is cut, a finding says so.
 */
export function capLists<T>(data: T): T {
  let cut = 0;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      if (value.length > MAX_STRUCTURED_ITEMS) cut++;
      return value.slice(0, MAX_STRUCTURED_ITEMS).map(walk);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  const capped = walk(data) as T;
  const findings = (capped as { findings?: unknown }).findings;
  if (cut > 0 && Array.isArray(findings)) {
    findings.push({
      severity: "info",
      message: `${cut} list(s) in this result were longer than ${MAX_STRUCTURED_ITEMS} items and were cut to that; counts and scores cover everything.`,
    } satisfies Finding);
  }
  return capped;
}

/** Small helper: render a checklist line with a status glyph. */
export function statusLine(passed: boolean, label: string): string {
  return `${passed ? "✅" : "❌"} ${label}`;
}

/** Three-state variant for checks that can be "present but imperfect". */
export function severityGlyph(severity: Severity): string {
  if (severity === "pass") return "✅";
  if (severity === "warn") return "⚠️";
  return "❌";
}

export type Severity = "pass" | "warn" | "fail" | "info";

/** A single audit observation. Shared across every core module. */
export interface Finding {
  severity: Severity;
  message: string;
}

/** Map a 0–100 score to a letter grade. */
export function scoreToGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

/** Render a list of findings as markdown bullet lines, worst first. */
export function renderFindings(findings: Finding[]): string {
  const order: Record<Severity, number> = { fail: 0, warn: 1, pass: 2, info: 3 };
  return [...findings]
    .sort((a, b) => order[a.severity] - order[b.severity])
    .map((f) => `${severityGlyph(f.severity)} ${f.message}`)
    .join("\n");
}

/** Clamp a number into the 0–100 range and round it. */
export function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
