/**
 * Flagship composite audits: `seo_audit` and `geo_audit`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, renderFindings, respond, responseFormatField } from "../format.js";
import { runGeoAudit, runSeoAudit } from "../core/seo-audit.js";
import { validateUrl } from "../core/validate.js";
import { GeoAuditSchema, SeoAuditSchema } from "../schemas.js";
import { READ_ONLY, scoreHeadline, toFailure, urlField } from "./_shared.js";

export function registerAuditTools(server: McpServer): void {
  // --- seo_audit -----------------------------------------------------------

  const SeoAuditInput = z.object({
    url: urlField,
    include_geo: z
      .boolean()
      .default(false)
      .describe("Also score GEO (AI answer-engine) readiness. Adds ~2 requests."),
    check_broken_links: z
      .boolean()
      .default(false)
      .describe("Sample up to 25 links and verify they resolve. Slower, but catches dead links."),
    response_format: responseFormatField,
  });

  server.registerTool(
    "seo_audit",
    {
      title: "Full On-Page SEO Audit",
      description: `Fetch a page once and audit it across seven weighted sections — meta tags & social preview, heading structure, content quality, structured data, image SEO, links and crawlability — returning a 0–100 score, an A–F grade and a prioritised fix list.

This is the tool to start with for any "how is this page doing for SEO?" question; drill into the single-purpose tools afterwards for detail.

Args:
  - url (string): the page to audit.
  - include_geo (boolean): also score AI answer-engine readiness (default false).
  - check_broken_links (boolean): sample-verify that links resolve (default false).
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns: { score, grade, indexable, sections[{id, label, score, grade, weight, issues[]}], top_recommendations[], geo, findings[] }.

Example: "Audit the SEO of https://example.com/pricing" -> seo_audit(url="https://example.com/pricing").
Note: a noindex page or a site-wide robots.txt block caps the score, because nothing else matters until that is fixed.
Errors: returns an error if the URL is unreachable, non-HTML, or returns an HTTP error.`,
      inputSchema: SeoAuditInput.shape,
      outputSchema: SeoAuditSchema.shape,
      annotations: READ_ONLY,
    },
    async ({ url, include_geo, check_broken_links, response_format }) => {
      const parsed = validateUrl(url);
      if (!parsed) return fail(`Error: '${url}' is not a valid public http(s) URL.`);

      try {
        const report = await runSeoAudit(parsed, {
          includeGeo: include_geo,
          checkBrokenLinks: check_broken_links,
        });

        return respond(report, response_format, () =>
          [
            `# SEO audit — ${report.final_url}`,
            "",
            scoreHeadline("Overall", report.score, report.grade),
            `HTTP ${report.status} · ${report.redirect_hops} redirect(s) · fetched in ${report.fetch_ms}ms · indexable: ${report.indexable ? "yes" : "NO"}`,
            "",
            "## Sections",
            ...report.sections.map(
              (s) => `- **${s.label}**: ${s.grade} (${s.score}/100, weight ${s.weight})`,
            ),
            ...(report.geo
              ? [
                  "",
                  "## GEO readiness",
                  scoreHeadline("AI answer-engine readiness", report.geo.score, report.geo.grade),
                  ...report.geo.signals.map(
                    (sig) => `- ${sig.status === "pass" ? "✅" : sig.status === "warn" ? "⚠️" : "❌"} ${sig.label}: ${sig.earned}/${sig.weight} — ${sig.detail}`,
                  ),
                ]
              : []),
            "",
            "## Top recommendations",
            ...(report.top_recommendations.length
              ? report.top_recommendations.map((r, i) => `${i + 1}. ${r}`)
              : ["Nothing critical — the page is in good shape."]),
            "",
            "## Detail",
            renderFindings(report.findings),
          ].join("\n"),
        );
      } catch (err) {
        return toFailure(`SEO audit of ${parsed.toString()}`, err);
      }
    },
  );

  // --- geo_audit -----------------------------------------------------------

  const GeoAuditInput = z.object({
    url: urlField,
    response_format: responseFormatField,
  });

  server.registerTool(
    "geo_audit",
    {
      title: "GEO / AI Answer-Engine Readiness Audit",
      description: `Score how readily an AI answer engine (ChatGPT, Claude, Perplexity, Gemini, Copilot) can fetch, parse and cite this page. Weighted across: AI crawler access (25), server-rendered content (20), structured data (15), extractable structure (15), authorship & entity signals (10), freshness (8) and content depth (7).

Two things this catches that a classic SEO tool does not:
  - Pages that rank fine in Google but are invisible to AI assistants, because most AI crawlers do not execute JavaScript and the content only appears after hydration.
  - robots.txt rules that block AI *search* crawlers (OAI-SearchBot, Claude-SearchBot, PerplexityBot) — the ones that build citation indexes — as opposed to the *training* crawlers people usually mean to block.

Args:
  - url (string): the page to audit.
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns: { geo{score, grade, signals[], top_recommendations[]}, rendering, crawler_access, llms_txt, robots }.

Example: "Is https://example.com/guide ready to be cited by ChatGPT?" -> geo_audit(url="https://example.com/guide").
Note: llms.txt presence is reported but deliberately NOT scored — it is a community proposal with no committed vendor support, and Google has stated it does not use it.`,
      inputSchema: GeoAuditInput.shape,
      outputSchema: GeoAuditSchema.shape,
      annotations: READ_ONLY,
    },
    async ({ url, response_format }) => {
      const parsed = validateUrl(url);
      if (!parsed) return fail(`Error: '${url}' is not a valid public http(s) URL.`);

      try {
        const bundle = await runGeoAudit(parsed);
        const { geo, rendering, crawler_access: access, llms_txt: llms } = bundle;

        return respond(bundle, response_format, () =>
          [
            `# GEO readiness — ${geo.final_url}`,
            "",
            scoreHeadline("AI answer-engine readiness", geo.score, geo.grade),
            "",
            "## Signals",
            ...geo.signals.map(
              (s) => `- ${s.status === "pass" ? "✅" : s.status === "warn" ? "⚠️" : "❌"} **${s.label}** ${s.earned}/${s.weight} — ${s.detail}`,
            ),
            "",
            "## Crawler access",
            access
              ? `${access.allowed_count} allowed · ${access.blocked_count} blocked` +
                (access.blocked_citation_critical.length
                  ? `\n❌ Blocked citation-critical bots: ${access.blocked_citation_critical.join(", ")}`
                  : "\n✅ No citation-critical AI crawler is blocked.") +
                (access.unenforceable_blocks.length
                  ? `\n⚠️ Blocked but documented to possibly ignore robots.txt: ${access.unenforceable_blocks.join(", ")}`
                  : "")
              : "robots.txt could not be fetched.",
            "",
            "## Rendering",
            `${rendering.renders_without_js ? "✅" : "❌"} ${rendering.server_text_words} words present without JavaScript${rendering.spa_shell_detected ? ` — unhydrated SPA shell detected (${rendering.framework_hint ?? "unknown framework"})` : ""}`,
            "",
            "## llms.txt",
            llms
              ? `${llms.found ? "Published" : "Not published"}. ${llms.adoption_status}`
              : "Not checked.",
            "",
            "## Top recommendations",
            ...(geo.top_recommendations.length
              ? geo.top_recommendations.map((r, i) => `${i + 1}. ${r}`)
              : ["Nothing critical — the page is well positioned for AI citation."]),
          ].join("\n"),
        );
      } catch (err) {
        return toFailure(`GEO audit of ${parsed.toString()}`, err);
      }
    },
  );
}
