/**
 * GEO-specific tools: AI crawler access, llms.txt and the JavaScript-rendering
 * check that decides whether AI crawlers can see the content at all.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { fail, renderFindings, respond, responseFormatField } from "../format.js";
import { analyzeAiCrawlerAccess, fetchRobots } from "../core/robots.js";
import { analyzeRendering, checkLlmsTxt } from "../core/geo.js";
import { loadPage } from "../core/page.js";
import { validateUrl } from "../core/validate.js";
import { AiCrawlerSchema, LlmsTxtSchema, RenderingSchema } from "../schemas.js";
import { READ_ONLY, SiteInput, toFailure, urlField } from "./_shared.js";

export function registerGeoTools(server: McpServer): void {
  // --- ai_crawler_access ---------------------------------------------------

  const AiCrawlerInput = z.object({
    site: z.string().min(1).describe("Domain or any URL on it, e.g. 'example.com'."),
    path: z
      .string()
      .max(2048)
      .default("/")
      .describe("Path to test the rules against, e.g. '/blog/post'. Defaults to '/'."),
    include_deprecated: z
      .boolean()
      .default(false)
      .describe("Also resolve retired tokens (anthropic-ai, claude-web) for historical coverage."),
    response_format: responseFormatField,
  });

  server.registerTool(
    "ai_crawler_access",
    {
      title: "AI Crawler Access Check",
      description: `Resolve every known AI/LLM crawler against a site's robots.txt and report which may fetch a given path. Covers OpenAI (GPTBot, OAI-SearchBot, ChatGPT-User, OAI-AdsBot), Anthropic (ClaudeBot, Claude-User, Claude-SearchBot), Google (Google-Extended, Googlebot, Google-CloudVertexBot), Perplexity, Apple, Meta, Amazon, Mistral, Common Crawl, ByteDance and others.

Three things this gets right that a naive robots.txt reader does not:

  1. **Training vs citation.** Blocking GPTBot stops training; blocking OAI-SearchBot stops you being *cited* in ChatGPT search. Most people want the first, not the second. Blocked citation-critical bots are called out separately.
  2. **Which blocks are actually enforceable.** Perplexity-User, ChatGPT-User and meta-externalfetcher are documented by their own vendors as ignoring or possibly ignoring robots.txt. A "blocked" verdict for those is advisory, and is reported as such rather than as a clean block.
  3. **Vendor quirks.** Apple documents that when robots.txt has no Applebot group but does have a Googlebot group, Applebot follows the Googlebot rules — so the effective verdict differs from the literal one.

Each crawler also carries its provenance: whether the token comes from first-party vendor documentation or only from community aggregators. Vendors that publish no crawler token at all (xAI/Grok, Microsoft Copilot) are listed separately, because absence of a rule cannot be read as allowed or blocked.

Args:
  - site (string): domain or any URL on it.
  - path (string): path to test (default '/').
  - include_deprecated (boolean): include retired tokens (default false).
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns: { crawlers[{token, vendor, purpose, allowed, via_wildcard, matched_rule, respects_robots_txt, compliance_note, provenance, quirk}], allowed_count, blocked_count, blocked_citation_critical[], unenforceable_blocks[], undocumented_vendors[], findings[] }.

Example: "Can ChatGPT and Perplexity crawl example.com?" -> ai_crawler_access(site="example.com").`,
      inputSchema: AiCrawlerInput,
      outputSchema: AiCrawlerSchema,
      annotations: READ_ONLY,
    },
    async ({ site, path, include_deprecated, response_format }) => {
      const parsed = validateUrl(site);
      if (!parsed) return fail(`Error: '${site}' is not a valid domain or URL.`);
      try {
        const robots = await fetchRobots(parsed.origin);
        // Robots rules are root-relative; 'blog/post' would otherwise match nothing and read as allowed.
        const testPath = path.startsWith("/") ? path : `/${path}`;
        const report = analyzeAiCrawlerAccess(robots, testPath, include_deprecated);

        return respond(report, response_format, () => {
          const byVendor = new Map<string, typeof report.crawlers>();
          for (const crawler of report.crawlers) {
            const list = byVendor.get(crawler.vendor) ?? [];
            list.push(crawler);
            byVendor.set(crawler.vendor, list);
          }

          return [
            `# AI crawler access — ${parsed.origin}${path}`,
            "",
            `robots.txt: ${report.robots_found ? "found" : "not found"} · **${report.allowed_count} allowed · ${report.blocked_count} blocked**`,
            "",
            ...[...byVendor.entries()].flatMap(([vendor, crawlers]) => [
              `**${vendor}**`,
              ...crawlers.map(
                (c) =>
                  `  ${c.allowed ? "✅" : "❌"} \`${c.token}\` (${c.purpose})` +
                  (c.matched_rule ? ` — ${c.matched_rule}${c.via_wildcard ? " via *" : ""}` : " — no matching rule") +
                  (c.respects_robots_txt !== "yes" ? ` ⚠️ ${c.compliance_note}` : "") +
                  (c.quirk ? ` ℹ️ ${c.quirk}` : "") +
                  (c.provenance === "community" ? " *(community-sourced token)*" : ""),
              ),
            ]),
            "",
            "## Not documented by their vendor",
            ...report.undocumented_vendors.map((v) => `- **${v.vendor}**: ${v.note}`),
            "",
            renderFindings(report.findings),
          ].join("\n");
        });
      } catch (err) {
        return toFailure(`AI crawler check of ${site}`, err);
      }
    },
  );

  // --- llms_txt_check ------------------------------------------------------

  server.registerTool(
    "llms_txt_check",
    {
      title: "llms.txt Check",
      description: `Check whether a site publishes /llms.txt and validate it against the llmstxt.org proposal: a required H1 title, an optional blockquote summary, and H2-delimited lists of \`- [name](url): notes\` links. Also detects /llms-full.txt.

**Important context this tool always reports:** llms.txt is a community proposal from September 2024, not an adopted standard. No major AI vendor has documented that its crawlers read llms.txt from third-party sites, and Google has publicly stated it does not support it. Publishing one is cheap and may help human readers and some documentation tooling, but it does not earn AI visibility on its own — robots.txt access, structured data and server-rendered content do. Note also that \`llms-full.txt\` is a de-facto convention popularised by docs tooling, not part of the proposal.

Use this tool to answer "do they publish one, and is it well-formed?" — not as evidence that a site is or is not AI-optimised.

Args:
  - site (string): domain or any URL on it.
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns: { found, status, full_variant_found, bytes, title, has_summary_blockquote, sections[], link_count, spec_compliant, adoption_status, findings[] }.

Example: "Does example.com publish an llms.txt?" -> llms_txt_check(site="example.com").`,
      inputSchema: SiteInput,
      outputSchema: LlmsTxtSchema,
      annotations: READ_ONLY,
    },
    async ({ site, response_format }) => {
      const parsed = validateUrl(site);
      if (!parsed) return fail(`Error: '${site}' is not a valid domain or URL.`);
      try {
        const report = await checkLlmsTxt(parsed.origin);
        return respond(report, response_format, () =>
          [
            `# llms.txt — ${report.url}`,
            "",
            `${report.found ? "✅ Published" : "❌ Not published"}${report.found ? ` · ${report.bytes} bytes · ${report.link_count} link(s) · ${report.sections.length} section(s)` : ""}`,
            report.found ? `Title: ${report.title ?? "— missing H1 —"}` : "",
            report.full_variant_found ? "/llms-full.txt is also published." : "",
            "",
            ...(report.sections.length ? ["## Sections", ...report.sections.map((s) => `- ${s}`), ""] : []),
            "## Adoption status",
            report.adoption_status,
            "",
            renderFindings(report.findings),
          ]
            .filter(Boolean)
            .join("\n"),
        );
      } catch (err) {
        return toFailure(`llms.txt check of ${site}`, err);
      }
    },
  );

  // --- render_check --------------------------------------------------------

  server.registerTool(
    "render_check",
    {
      title: "JavaScript Rendering Check",
      description: `Determine whether a page's content exists in the server HTML, or only appears after JavaScript runs.

This matters more for AI visibility than for classic SEO: Googlebot renders JavaScript, but GPTBot, ClaudeBot, PerplexityBot and CCBot largely do not. A client-rendered page can rank perfectly well in Google and still be completely invisible to every AI assistant — this tool is how you catch that.

Detects unhydrated SPA shells (empty #root / #app / #__next containers), reports how many words survive without JS, and flags documents dominated by inline script bytes.

Args:
  - url (string): the page to check.
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns: { renders_without_js, server_text_words, script_bytes, html_bytes, spa_shell_detected, framework_hint, findings[] }.

Example: "Can ChatGPT actually read https://example.com/app?" -> render_check(url="https://example.com/app").`,
      inputSchema: z.object({ url: urlField, response_format: responseFormatField }),
      outputSchema: RenderingSchema,
      annotations: READ_ONLY,
    },
    async ({ url, response_format }) => {
      const parsed = validateUrl(url);
      if (!parsed) return fail(`Error: '${url}' is not a valid public http(s) URL.`);
      try {
        const report = analyzeRendering(await loadPage(parsed));
        return respond(report, response_format, () =>
          [
            `# Rendering check — ${parsed.toString()}`,
            "",
            `${report.renders_without_js ? "✅ Content is server-rendered" : "❌ Content depends on JavaScript"}`,
            `${report.server_text_words} words without JS · ${Math.round(report.script_bytes / 1024)} KB inline script of ${Math.round(report.html_bytes / 1024)} KB document`,
            report.spa_shell_detected ? `SPA shell detected: ${report.framework_hint ?? "unknown framework"}` : "",
            "",
            renderFindings(report.findings),
          ]
            .filter(Boolean)
            .join("\n"),
        );
      } catch (err) {
        return toFailure(`Rendering check of ${parsed.toString()}`, err);
      }
    },
  );
}
