/**
 * Technical SEO tools: robots.txt, sitemaps, links, hreflang, redirects and
 * host canonicalisation.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, renderFindings, respond, responseFormatField } from "../format.js";
import { analyzeHreflang, analyzeLinks } from "../core/seo-audit.js";
import { loadPage } from "../core/page.js";
import { analyzeRobots, fetchRobots } from "../core/robots.js";
import { analyzeSitemap } from "../core/sitemap.js";
import { checkCanonicalVariants, traceRedirects } from "../core/redirects.js";
import { validateHost, validateUrl } from "../core/validate.js";
import {
  CanonicalHostSchema,
  HreflangSchema,
  LinkSchema,
  RedirectSchema,
  RobotsSchema,
  SitemapSchema,
} from "../schemas.js";
import { READ_ONLY, SiteInput, scoreHeadline, toFailure, urlField } from "./_shared.js";

export function registerTechnicalTools(server: McpServer): void {
  // --- robots_txt_check ----------------------------------------------------

  server.registerTool(
    "robots_txt_check",
    {
      title: "robots.txt Check",
      description: `Fetch and parse a site's robots.txt per RFC 9309. Reports every user-agent group with its Allow/Disallow rules, the declared sitemaps, and any lines that could not be parsed. Flags the two failures that silently deindex a site: a wildcard \`Disallow: /\`, and a robots.txt that returns 5xx (which Google treats as "disallow everything").

Args:
  - site (string): domain or any URL on it, e.g. 'example.com'.
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns: { found, status, group_count, sitemaps[], blocks_everything, groups[{agents[], rules[], crawl_delay}], parse_warnings[], findings[] }.

Example: "What does example.com's robots.txt allow?" -> robots_txt_check(site="example.com").
For AI-crawler specifics use \`ai_crawler_access\` instead — it resolves each known AI bot against these rules.`,
      inputSchema: SiteInput.shape,
      outputSchema: RobotsSchema.shape,
      annotations: READ_ONLY,
    },
    async ({ site, response_format }) => {
      const parsed = validateUrl(site);
      if (!parsed) return fail(`Error: '${site}' is not a valid domain or URL.`);
      try {
        const report = analyzeRobots(await fetchRobots(parsed.origin));
        return respond(report, response_format, () =>
          [
            `# robots.txt — ${report.url}`,
            "",
            `${report.found ? "✅ Found" : "❌ Not found"} (HTTP ${report.status}) · ${report.group_count} group(s) · ${report.sitemaps.length} sitemap(s)`,
            "",
            ...(report.groups.length
              ? [
                  "## Groups",
                  ...report.groups.slice(0, 25).map((g) =>
                    [
                      `**User-agent: ${g.agents.join(", ")}**`,
                      ...g.rules.slice(0, 15).map((r) => `  ${r.type === "allow" ? "Allow" : "Disallow"}: ${r.path}`),
                      g.crawl_delay !== null ? `  Crawl-delay: ${g.crawl_delay}` : "",
                    ]
                      .filter(Boolean)
                      .join("\n"),
                  ),
                  "",
                ]
              : []),
            renderFindings(report.findings),
          ].join("\n"),
        );
      } catch (err) {
        return toFailure(`robots.txt check of ${site}`, err);
      }
    },
  );

  // --- sitemap_check -------------------------------------------------------

  const SitemapInput = z.object({
    site: z.string().min(1).describe("Domain or any URL on it, e.g. 'example.com'."),
    sitemap_url: z
      .string()
      .optional()
      .describe("Explicit sitemap URL. Omit to discover it via robots.txt, then the conventional paths."),
    follow_children: z
      .number()
      .int()
      .min(0)
      .max(10)
      .default(3)
      .describe("How many child sitemaps of an index to follow (default 3)."),
    response_format: responseFormatField,
  });

  server.registerTool(
    "sitemap_check",
    {
      title: "XML Sitemap Check",
      description: `Discover, fetch and validate an XML sitemap. Finds it via the robots.txt \`Sitemap:\` directive, then falls back to /sitemap.xml, /sitemap_index.xml and /sitemap-index.xml. Handles sitemap indexes (following children) and gzipped sitemaps.

Validates: URL count against the 50,000 limit, uncompressed size against 50 MiB, <lastmod> presence and W3C-datetime validity, URLs pointing off-origin, http:// URLs, and duplicates.

Args:
  - site (string): domain or any URL on it.
  - sitemap_url (string, optional): explicit sitemap URL.
  - follow_children (number): child sitemaps of an index to follow (default 3).
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns: { found, type, url_count, child_sitemaps[], with_lastmod, invalid_lastmod[], newest_lastmod, off_origin_urls[], exceeds_url_limit, discovered_via, score, grade, findings[] }.

Example: "Check the sitemap for example.com" -> sitemap_check(site="example.com").`,
      inputSchema: SitemapInput.shape,
      outputSchema: SitemapSchema.shape,
      annotations: READ_ONLY,
    },
    async ({ site, sitemap_url, follow_children, response_format }) => {
      const parsed = validateUrl(site);
      if (!parsed) return fail(`Error: '${site}' is not a valid domain or URL.`);
      try {
        const report = await analyzeSitemap(parsed.origin, sitemap_url, follow_children);
        return respond(report, response_format, () =>
          [
            `# Sitemap — ${report.url}`,
            "",
            scoreHeadline("Score", report.score, report.grade),
            `${report.found ? "✅ Found" : "❌ Not found"} · type: ${report.type} · ${report.url_count} URL(s) · discovered via ${report.discovered_via}`,
            report.with_lastmod ? `${report.with_lastmod} URL(s) carry <lastmod>${report.newest_lastmod ? ` (newest ${report.newest_lastmod.slice(0, 10)})` : ""}` : "",
            report.child_sitemaps.length ? `${report.child_sitemaps.length} child sitemap(s), ${report.child_sitemaps_followed} followed` : "",
            "",
            renderFindings(report.findings),
          ]
            .filter(Boolean)
            .join("\n"),
        );
      } catch (err) {
        return toFailure(`Sitemap check of ${site}`, err);
      }
    },
  );

  // --- link_audit ----------------------------------------------------------

  const LinkInput = z.object({
    url: urlField,
    check_broken: z
      .boolean()
      .default(false)
      .describe("Sample links and verify they resolve. Adds up to 25 requests."),
    sample_size: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe("How many links to verify when check_broken is true."),
    response_format: responseFormatField,
  });

  server.registerTool(
    "link_audit",
    {
      title: "Link Audit",
      description: `Audit a page's outbound links: the internal/external split, rel attributes (nofollow, sponsored, ugc), links with no anchor text at all, generic anchor text ("click here", "leer más") that carries no topical signal, and the distribution of external domains. Optionally sample-verifies that links actually resolve, retrying with GET when a server rejects HEAD.

Args:
  - url (string): the page to audit.
  - check_broken (boolean): verify links resolve (default false).
  - sample_size (number): how many links to verify (default 25).
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns: { total_links, internal_links, external_links, nofollow_links, empty_anchor_text, generic_anchor_text[], external_domains[{domain, count}], checked_count, broken[], score, grade, findings[] }.

Example: "Are there broken links on https://example.com/resources?" -> link_audit(url="https://example.com/resources", check_broken=true).`,
      inputSchema: LinkInput.shape,
      outputSchema: LinkSchema.shape,
      annotations: READ_ONLY,
    },
    async ({ url, check_broken, sample_size, response_format }) => {
      const parsed = validateUrl(url);
      if (!parsed) return fail(`Error: '${url}' is not a valid public http(s) URL.`);
      try {
        const report = await analyzeLinks(await loadPage(parsed), check_broken, sample_size);
        return respond(report, response_format, () =>
          [
            `# Link audit — ${report.final_url}`,
            "",
            scoreHeadline("Score", report.score, report.grade),
            `${report.total_links} links · ${report.internal_links} internal · ${report.external_links} external · ${report.nofollow_links} nofollow`,
            "",
            ...(report.broken.length
              ? ["## Broken", ...report.broken.map((b) => `- ❌ ${b.href} — ${b.status ?? b.error}`), ""]
              : []),
            ...(report.external_domains.length
              ? ["## External domains", ...report.external_domains.slice(0, 10).map((d) => `- ${d.domain}: ${d.count}`), ""]
              : []),
            renderFindings(report.findings),
          ].join("\n"),
        );
      } catch (err) {
        return toFailure(`Link audit of ${parsed.toString()}`, err);
      }
    },
  );

  // --- hreflang_check ------------------------------------------------------

  const HreflangInput = z.object({
    url: urlField,
    check_reciprocity: z
      .boolean()
      .default(false)
      .describe("Fetch each alternate to confirm it links back. Catches the most common hreflang bug."),
    response_format: responseFormatField,
  });

  server.registerTool(
    "hreflang_check",
    {
      title: "Hreflang Check",
      description: `Validate a page's \`<link rel="alternate" hreflang>\` annotations: language/region code validity (BCP-47), the required self-referencing entry, the x-default fallback, and duplicate codes.

With check_reciprocity=true it fetches each alternate and confirms it links back to this page — non-reciprocal hreflang is silently ignored by Google, and it is impossible to detect from one page in isolation.

Args:
  - url (string): the page to check.
  - check_reciprocity (boolean): verify alternates link back (default false).
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns: { declared_lang, entries[{hreflang, href, valid_code, is_self, reciprocates}], has_x_default, self_referencing, duplicate_codes[], invalid_codes[], findings[] }.

Example: "Is hreflang set up correctly on https://example.com/es/pagina?" -> hreflang_check(url="https://example.com/es/pagina", check_reciprocity=true).`,
      inputSchema: HreflangInput.shape,
      outputSchema: HreflangSchema.shape,
      annotations: READ_ONLY,
    },
    async ({ url, check_reciprocity, response_format }) => {
      const parsed = validateUrl(url);
      if (!parsed) return fail(`Error: '${url}' is not a valid public http(s) URL.`);
      try {
        const report = await analyzeHreflang(await loadPage(parsed), check_reciprocity);
        return respond(report, response_format, () =>
          [
            `# Hreflang — ${report.final_url}`,
            "",
            `html lang: ${report.declared_lang ?? "—"} · ${report.entries.length} annotation(s) · x-default: ${report.has_x_default ? "yes" : "no"} · self-referencing: ${report.self_referencing ? "yes" : "NO"}`,
            "",
            ...(report.entries.length
              ? [
                  "## Entries",
                  ...report.entries.map(
                    (e) =>
                      `- ${e.valid_code ? "✅" : "❌"} \`${e.hreflang}\` → ${e.href}` +
                      (e.is_self ? " *(self)*" : "") +
                      (e.reciprocates === false ? " ❌ does not link back" : e.reciprocates === true ? " ✅ reciprocates" : ""),
                  ),
                  "",
                ]
              : []),
            renderFindings(report.findings),
          ].join("\n"),
        );
      } catch (err) {
        return toFailure(`Hreflang check of ${parsed.toString()}`, err);
      }
    },
  );

  // --- redirect_trace ------------------------------------------------------

  server.registerTool(
    "redirect_trace",
    {
      title: "Redirect Trace",
      description: `Follow a URL's redirect chain hop by hop, reporting each status code and target. Flags long chains (which waste crawl budget), redirect loops, temporary 302/307 redirects where a permanent 301/308 belongs, and chains that do not end on HTTPS.

Args:
  - url (string): the starting URL.
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns: { final_url, final_status, hops[{url, status, location}], hop_count, https_upgrade, ends_https, has_loop, has_temporary_redirect, elapsed_ms, findings[] }.

Example: "Where does http://example.com/old-page end up?" -> redirect_trace(url="http://example.com/old-page").`,
      inputSchema: z.object({ url: urlField, response_format: responseFormatField }).shape,
      outputSchema: RedirectSchema.shape,
      annotations: READ_ONLY,
    },
    async ({ url, response_format }) => {
      const parsed = validateUrl(url);
      if (!parsed) return fail(`Error: '${url}' is not a valid public http(s) URL.`);
      try {
        const report = await traceRedirects(parsed);
        return respond(report, response_format, () =>
          [
            `# Redirect trace — ${report.url}`,
            "",
            `${report.hop_count} hop(s) → **${report.final_url}** (HTTP ${report.final_status}) in ${report.elapsed_ms}ms`,
            "",
            ...(report.hops.length
              ? ["## Chain", ...report.hops.map((h, i) => `${i + 1}. ${h.url} → ${h.status} → ${h.location}`), ""]
              : []),
            renderFindings(report.findings),
          ].join("\n"),
        );
      } catch (err) {
        return toFailure(`Redirect trace of ${parsed.toString()}`, err);
      }
    },
  );

  // --- canonical_host_check ------------------------------------------------

  server.registerTool(
    "canonical_host_check",
    {
      title: "Canonical Host Check",
      description: `Fetch all four host/scheme variants of a domain — http/https × apex/www — and confirm they converge on a single canonical URL. Divergence is the classic cause of a homepage competing with itself in the index.

Also reports whether plain HTTP is upgraded to HTTPS, whether canonicalisation uses permanent (301/308) rather than temporary (302/307) redirects, and which variants do not serve content at all.

Args:
  - site (string): a domain such as 'example.com' (www and scheme are ignored).
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns: { domain, variants[{variant, reachable, status, final_url, hop_count, redirect_statuses[]}], canonical_url, converges, distinct_endpoints[], forces_https, score, grade, findings[] }.

Example: "Do all versions of example.com redirect to one URL?" -> canonical_host_check(site="example.com").`,
      inputSchema: SiteInput.shape,
      outputSchema: CanonicalHostSchema.shape,
      annotations: READ_ONLY,
    },
    async ({ site, response_format }) => {
      const host = validateHost(site);
      if (!host) return fail(`Error: '${site}' is not a valid domain name.`);
      try {
        const report = await checkCanonicalVariants(host);
        return respond(report, response_format, () =>
          [
            `# Canonical host — ${report.domain}`,
            "",
            scoreHeadline("Score", report.score, report.grade),
            `Converges: ${report.converges ? `✅ on ${report.canonical_url}` : `❌ ${report.distinct_endpoints.length} distinct endpoints`} · forces HTTPS: ${report.forces_https ? "yes" : "no"}`,
            "",
            "## Variants",
            ...report.variants.map(
              (v) =>
                `- ${v.reachable ? "✅" : "❌"} ${v.variant} → ${v.final_url ?? v.error ?? "—"}` +
                (v.status ? ` (HTTP ${v.status}${v.redirect_statuses.length ? `, via ${v.redirect_statuses.join("→")}` : ""})` : ""),
            ),
            "",
            renderFindings(report.findings),
          ].join("\n"),
        );
      } catch (err) {
        return toFailure(`Canonical host check of ${site}`, err);
      }
    },
  );
}
