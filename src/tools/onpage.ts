/**
 * Single-purpose on-page tools: meta tags, social cards, headings, structured
 * data, content quality and image SEO.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, renderFindings, respond, responseFormatField } from "../format.js";
import {
  analyzeContent,
  analyzeHeadings,
  analyzeImages,
  analyzeMetaTags,
  analyzeSocial,
  analyzeStructuredData,
} from "../core/seo-audit.js";
import { loadPage } from "../core/page.js";
import { validateUrl } from "../core/validate.js";
import {
  ContentSchema,
  HeadingSchema,
  ImageSchema,
  MetaTagsSchema,
  SocialSchema,
  StructuredDataSchema,
} from "../schemas.js";
import { READ_ONLY, UrlInput, scoreHeadline, toFailure, urlField } from "./_shared.js";

export function registerOnPageTools(server: McpServer): void {
  // --- meta_tags_check -----------------------------------------------------

  server.registerTool(
    "meta_tags_check",
    {
      title: "Meta Tags Check",
      description: `Inspect a page's head tags: title, meta description, canonical, robots directives (meta AND the X-Robots-Tag header), html lang, charset, viewport and favicon. Flags length problems, missing or duplicated tags, and anything that makes the page non-indexable.

Args:
  - url (string): the page to check.
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns: { title, title_length, description, description_length, canonical, canonical_is_self, meta_robots, x_robots_tag, indexable, followable, lang, charset, viewport, score, grade, findings[] }.

Example: "Are the meta tags on https://example.com correct?" -> meta_tags_check(url="https://example.com").`,
      inputSchema: UrlInput.shape,
      outputSchema: MetaTagsSchema.shape,
      annotations: READ_ONLY,
    },
    async ({ url, response_format }) => {
      const parsed = validateUrl(url);
      if (!parsed) return fail(`Error: '${url}' is not a valid public http(s) URL.`);
      try {
        const report = analyzeMetaTags(await loadPage(parsed));
        return respond(report, response_format, () =>
          [
            `# Meta tags — ${report.final_url}`,
            "",
            scoreHeadline("Score", report.score, report.grade),
            "",
            `**Title** (${report.title_length}): ${report.title ?? "— missing —"}`,
            `**Description** (${report.description_length}): ${report.description ?? "— missing —"}`,
            `**Canonical**: ${report.canonical ?? "— missing —"}${report.canonical_is_self ? " (self)" : ""}`,
            `**Indexable**: ${report.indexable ? "yes" : "NO"} · **Followable**: ${report.followable ? "yes" : "no"}`,
            `**lang**: ${report.lang ?? "—"} · **charset**: ${report.charset ?? "—"} · **viewport**: ${report.viewport ? "set" : "—"}`,
            "",
            renderFindings(report.findings),
          ].join("\n"),
        );
      } catch (err) {
        return toFailure(`Meta tag check of ${parsed.toString()}`, err);
      }
    },
  );

  // --- social_preview_check ------------------------------------------------

  const SocialInput = z.object({
    url: urlField,
    check_image: z
      .boolean()
      .default(true)
      .describe("Issue a HEAD request to confirm the og:image actually loads."),
    response_format: responseFormatField,
  });

  server.registerTool(
    "social_preview_check",
    {
      title: "Social Preview (Open Graph & Twitter Card) Check",
      description: `Validate the tags that build link-preview cards on X, LinkedIn, Facebook, Slack, WhatsApp and Discord: og:title, og:description, og:image, og:url, og:type, og:site_name and the twitter:* family. Optionally verifies the preview image actually loads, and flags the classic bug of a relative og:image URL (social scrapers require absolute URLs).

Args:
  - url (string): the page to check.
  - check_image (boolean): verify the og:image resolves (default true).
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns: { open_graph{}, twitter{}, og_image_url, og_image_reachable, og_image_status, score, grade, findings[] }.

Example: "Why does my link preview look broken on LinkedIn?" -> social_preview_check(url="https://example.com/post").`,
      inputSchema: SocialInput.shape,
      outputSchema: SocialSchema.shape,
      annotations: READ_ONLY,
    },
    async ({ url, check_image, response_format }) => {
      const parsed = validateUrl(url);
      if (!parsed) return fail(`Error: '${url}' is not a valid public http(s) URL.`);
      try {
        const report = await analyzeSocial(await loadPage(parsed), check_image);
        return respond(report, response_format, () =>
          [
            `# Social preview — ${report.final_url}`,
            "",
            scoreHeadline("Score", report.score, report.grade),
            "",
            "## Open Graph",
            ...(Object.keys(report.open_graph).length
              ? Object.entries(report.open_graph).map(([k, v]) => `- \`${k}\`: ${v}`)
              : ["— none —"]),
            "",
            "## Twitter",
            ...(Object.keys(report.twitter).length
              ? Object.entries(report.twitter).map(([k, v]) => `- \`${k}\`: ${v}`)
              : ["— none —"]),
            "",
            renderFindings(report.findings),
          ].join("\n"),
        );
      } catch (err) {
        return toFailure(`Social preview check of ${parsed.toString()}`, err);
      }
    },
  );

  // --- heading_structure ---------------------------------------------------

  server.registerTool(
    "heading_structure",
    {
      title: "Heading Structure",
      description: `Extract the full h1–h6 outline and evaluate it: how many h1s, whether levels are skipped (h2 followed by h4), empty heading tags, and how many headings are phrased as questions — the last being a strong signal for featured snippets and AI citations.

Args:
  - url (string): the page to check.
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns: { headings[{level, text, skips_level}], h1_count, h1_text[], level_skips, empty_headings, question_headings[], outline, score, grade, findings[] }.

Example: "Show me the heading outline of https://example.com/guide" -> heading_structure(url="https://example.com/guide").`,
      inputSchema: UrlInput.shape,
      outputSchema: HeadingSchema.shape,
      annotations: READ_ONLY,
    },
    async ({ url, response_format }) => {
      const parsed = validateUrl(url);
      if (!parsed) return fail(`Error: '${url}' is not a valid public http(s) URL.`);
      try {
        const report = analyzeHeadings(await loadPage(parsed));
        return respond(report, response_format, () =>
          [
            `# Heading structure — ${report.final_url}`,
            "",
            scoreHeadline("Score", report.score, report.grade),
            `${report.headings.length} headings · ${report.h1_count} h1 · ${report.level_skips} level skip(s)`,
            "",
            "## Outline",
            "```",
            report.outline || "(no headings)",
            "```",
            "",
            renderFindings(report.findings),
          ].join("\n"),
        );
      } catch (err) {
        return toFailure(`Heading check of ${parsed.toString()}`, err);
      }
    },
  );

  // --- structured_data_check -----------------------------------------------

  server.registerTool(
    "structured_data_check",
    {
      title: "Structured Data (Schema.org) Check",
      description: `Extract and validate JSON-LD, microdata and RDFa. Reports every @type found, flags JSON-LD blocks that fail to parse (those are invisible to search engines), and checks recognised types against Google's rich-result requirements — required properties that are missing, plus recommended ones worth adding.

Covers Article/BlogPosting/NewsArticle, Product, FAQPage, HowTo, Recipe, Event, Organization, LocalBusiness, Person, WebSite, BreadcrumbList, VideoObject, JobPosting, Course, Review and AggregateRating.

Args:
  - url (string): the page to check.
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns: { json_ld_blocks, microdata_items, parse_errors[], items[{type, properties[], missing_required[], missing_recommended[], valid}], types_found[], has_organization, has_breadcrumb, score, grade, findings[] }.

Example: "Does https://example.com/product have valid Product schema?" -> structured_data_check(url="https://example.com/product").`,
      inputSchema: UrlInput.shape,
      outputSchema: StructuredDataSchema.shape,
      annotations: READ_ONLY,
    },
    async ({ url, response_format }) => {
      const parsed = validateUrl(url);
      if (!parsed) return fail(`Error: '${url}' is not a valid public http(s) URL.`);
      try {
        const report = analyzeStructuredData(await loadPage(parsed));
        return respond(report, response_format, () =>
          [
            `# Structured data — ${report.final_url}`,
            "",
            scoreHeadline("Score", report.score, report.grade),
            `${report.json_ld_blocks} JSON-LD block(s) · ${report.microdata_items} microdata item(s) · types: ${report.types_found.join(", ") || "none"}`,
            "",
            ...(report.items.length
              ? [
                  "## Items",
                  ...report.items.map(
                    (i) =>
                      `- ${i.valid ? "✅" : "❌"} **${i.type}** (${i.format})` +
                      (i.missing_required.length ? ` — missing required: ${i.missing_required.join(", ")}` : "") +
                      (i.missing_recommended.length ? ` · recommended: ${i.missing_recommended.join(", ")}` : ""),
                  ),
                  "",
                ]
              : []),
            renderFindings(report.findings),
          ].join("\n"),
        );
      } catch (err) {
        return toFailure(`Structured data check of ${parsed.toString()}`, err);
      }
    },
  );

  // --- content_analysis ----------------------------------------------------

  server.registerTool(
    "content_analysis",
    {
      title: "Content Quality Analysis",
      description: `Measure the page's main content: word count, sentence and paragraph counts, Flesch reading ease with a plain-language reading level, estimated reading time, text-to-HTML ratio, thin-content detection, and the top non-stopword terms with their density (English and Spanish stopwords are both filtered).

Content is read from the <main>/<article> landmark when present, so navigation and footer chrome do not inflate the counts.

Args:
  - url (string): the page to check.
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns: { word_count, sentence_count, paragraph_count, avg_words_per_sentence, reading_ease, reading_level, reading_time_minutes, thin_content, text_to_html_ratio, used_content_landmark, top_terms[{term, count, density}], score, grade, findings[] }.

Example: "Is the content on https://example.com/post too thin?" -> content_analysis(url="https://example.com/post").`,
      inputSchema: UrlInput.shape,
      outputSchema: ContentSchema.shape,
      annotations: READ_ONLY,
    },
    async ({ url, response_format }) => {
      const parsed = validateUrl(url);
      if (!parsed) return fail(`Error: '${url}' is not a valid public http(s) URL.`);
      try {
        const report = analyzeContent(await loadPage(parsed));
        return respond(report, response_format, () =>
          [
            `# Content analysis — ${report.final_url}`,
            "",
            scoreHeadline("Score", report.score, report.grade),
            `${report.word_count} words · ~${report.reading_time_minutes} min read · Flesch ${report.reading_ease} (${report.reading_level})`,
            `${report.avg_words_per_sentence} words/sentence · ${report.paragraph_count} paragraphs · text/HTML ${report.text_to_html_ratio}%`,
            "",
            "## Top terms",
            ...(report.top_terms.length
              ? report.top_terms.slice(0, 10).map((t) => `- ${t.term}: ${t.count}× (${t.density}%)`)
              : ["— none —"]),
            "",
            renderFindings(report.findings),
          ].join("\n"),
        );
      } catch (err) {
        return toFailure(`Content analysis of ${parsed.toString()}`, err);
      }
    },
  );

  // --- image_seo_check -----------------------------------------------------

  server.registerTool(
    "image_seo_check",
    {
      title: "Image SEO Check",
      description: `Audit every <img> on the page: missing alt attributes (an accessibility failure and a lost image-search signal), decorative alt="" usage, missing width/height (which causes layout shift, a Core Web Vitals factor), lazy-loading adoption, and how many images use modern formats (WebP/AVIF) versus legacy JPEG/PNG. <picture> sources are counted as modern delivery.

Args:
  - url (string): the page to check.
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns: { total_images, missing_alt, decorative_alt, missing_dimensions, lazy_loaded, modern_format, legacy_format, images[], score, grade, findings[] }.

Example: "Which images on https://example.com are missing alt text?" -> image_seo_check(url="https://example.com").`,
      inputSchema: UrlInput.shape,
      outputSchema: ImageSchema.shape,
      annotations: READ_ONLY,
    },
    async ({ url, response_format }) => {
      const parsed = validateUrl(url);
      if (!parsed) return fail(`Error: '${url}' is not a valid public http(s) URL.`);
      try {
        const report = analyzeImages(await loadPage(parsed));
        return respond(report, response_format, () =>
          [
            `# Image SEO — ${report.final_url}`,
            "",
            scoreHeadline("Score", report.score, report.grade),
            `${report.total_images} images · ${report.missing_alt} missing alt · ${report.missing_dimensions} missing dimensions · ${report.modern_format} modern format`,
            "",
            ...(report.missing_alt
              ? [
                  "## Missing alt text",
                  ...report.images
                    .filter((i) => i.missing_alt)
                    .slice(0, 15)
                    .map((i) => `- ${i.src}`),
                  "",
                ]
              : []),
            renderFindings(report.findings),
          ].join("\n"),
        );
      } catch (err) {
        return toFailure(`Image check of ${parsed.toString()}`, err);
      }
    },
  );
}
