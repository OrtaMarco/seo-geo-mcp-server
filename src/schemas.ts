/**
 * Zod output schemas for every tool. Each schema here is a tool's
 * `outputSchema` verbatim — v2 takes the schema object, not its raw shape —
 * and `respond()` attaches the data object as `structuredContent` (validated
 * by the SDK against that schema).
 *
 * Authored with Zod 4 via the `zod/v4` subpath: the v2 SDK requires >=4.2 and
 * fails quietly on the first `tools/list` with Zod 3.
 *
 * Kept in sync with the interfaces in `core/*`.
 */

import * as z from "zod/v4";

const Finding = z.object({ severity: z.string(), message: z.string() });
const Findings = z.array(Finding);

// --- meta ------------------------------------------------------------------

export const MetaTagsSchema = z.object({
  url: z.string(),
  final_url: z.string(),
  title: z.string().nullable(),
  title_length: z.number(),
  description: z.string().nullable(),
  description_length: z.number(),
  canonical: z.string().nullable(),
  canonical_is_self: z.boolean(),
  meta_robots: z.string().nullable(),
  x_robots_tag: z.string().nullable(),
  robots_directives: z.array(z.string()),
  indexable: z.boolean(),
  followable: z.boolean(),
  lang: z.string().nullable(),
  charset: z.string().nullable(),
  viewport: z.string().nullable(),
  favicon: z.string().nullable(),
  score: z.number(),
  grade: z.string(),
  findings: Findings,
});

export const SocialSchema = z.object({
  url: z.string(),
  final_url: z.string(),
  open_graph: z.record(z.string(), z.string()),
  twitter: z.record(z.string(), z.string()),
  og_image_url: z.string().nullable(),
  og_image_reachable: z.boolean().nullable(),
  og_image_status: z.number().nullable(),
  og_image_content_type: z.string().nullable(),
  score: z.number(),
  grade: z.string(),
  findings: Findings,
});

const HreflangEntry = z.object({
  hreflang: z.string(),
  href: z.string(),
  valid_code: z.boolean(),
  is_self: z.boolean(),
  reciprocates: z.boolean().nullable(),
  error: z.string().nullable(),
});

export const HreflangSchema = z.object({
  url: z.string(),
  final_url: z.string(),
  declared_lang: z.string().nullable(),
  entries: z.array(HreflangEntry),
  has_x_default: z.boolean(),
  self_referencing: z.boolean(),
  duplicate_codes: z.array(z.string()),
  invalid_codes: z.array(z.string()),
  reciprocity_checked: z.boolean(),
  findings: Findings,
});

// --- content ---------------------------------------------------------------

const Heading = z.object({
  level: z.number(),
  text: z.string(),
  skips_level: z.boolean(),
});

export const HeadingSchema = z.object({
  url: z.string(),
  final_url: z.string(),
  headings: z.array(Heading),
  h1_count: z.number(),
  h1_text: z.array(z.string()),
  level_skips: z.number(),
  empty_headings: z.number(),
  question_headings: z.array(z.string()),
  outline: z.string(),
  score: z.number(),
  grade: z.string(),
  findings: Findings,
});

export const ContentSchema = z.object({
  url: z.string(),
  final_url: z.string(),
  word_count: z.number(),
  sentence_count: z.number(),
  paragraph_count: z.number(),
  avg_words_per_sentence: z.number(),
  reading_ease: z.number(),
  reading_level: z.string(),
  reading_time_minutes: z.number(),
  thin_content: z.boolean(),
  text_to_html_ratio: z.number(),
  html_bytes: z.number(),
  used_content_landmark: z.boolean(),
  top_terms: z.array(
    z.object({ term: z.string(), count: z.number(), density: z.number() }),
  ),
  score: z.number(),
  grade: z.string(),
  findings: Findings,
});

const ImageIssue = z.object({
  src: z.string(),
  missing_alt: z.boolean(),
  empty_alt: z.boolean(),
  missing_dimensions: z.boolean(),
  lazy_loaded: z.boolean(),
  modern_format: z.boolean(),
});

export const ImageSchema = z.object({
  url: z.string(),
  final_url: z.string(),
  total_images: z.number(),
  missing_alt: z.number(),
  decorative_alt: z.number(),
  missing_dimensions: z.number(),
  lazy_loaded: z.number(),
  modern_format: z.number(),
  legacy_format: z.number(),
  images: z.array(ImageIssue),
  score: z.number(),
  grade: z.string(),
  findings: Findings,
});

// --- structured data -------------------------------------------------------

const StructuredDataItem = z.object({
  format: z.string(),
  type: z.string(),
  all_types: z.array(z.string()),
  properties: z.array(z.string()),
  missing_required: z.array(z.string()),
  missing_recommended: z.array(z.string()),
  valid: z.boolean(),
  note: z.string().nullable(),
});

export const StructuredDataSchema = z.object({
  url: z.string(),
  final_url: z.string(),
  json_ld_blocks: z.number(),
  microdata_items: z.number(),
  rdfa_items: z.number(),
  parse_errors: z.array(z.string()),
  items: z.array(StructuredDataItem),
  types_found: z.array(z.string()),
  has_organization: z.boolean(),
  has_person: z.boolean(),
  has_website: z.boolean(),
  has_breadcrumb: z.boolean(),
  has_article: z.boolean(),
  has_faq: z.boolean(),
  score: z.number(),
  grade: z.string(),
  findings: Findings,
});

// --- robots & AI crawlers --------------------------------------------------

const RobotsRule = z.object({ type: z.string(), path: z.string() });
const RobotsGroup = z.object({
  agents: z.array(z.string()),
  rules: z.array(RobotsRule),
  crawl_delay: z.number().nullable(),
});

export const RobotsSchema = z.object({
  url: z.string(),
  found: z.boolean(),
  status: z.number().nullable(),
  group_count: z.number(),
  sitemaps: z.array(z.string()),
  blocks_everything: z.boolean(),
  groups: z.array(RobotsGroup),
  parse_warnings: z.array(z.string()),
  findings: Findings,
});

const CrawlerAccess = z.object({
  token: z.string(),
  vendor: z.string(),
  purpose: z.string(),
  allowed: z.boolean(),
  via_wildcard: z.boolean(),
  matched_rule: z.string().nullable(),
  respects_robots_txt: z.string(),
  compliance_note: z.string().nullable(),
  provenance: z.string(),
  deprecated: z.boolean(),
  quirk: z.string().nullable(),
});

export const AiCrawlerSchema = z.object({
  url: z.string(),
  path: z.string(),
  robots_found: z.boolean(),
  crawlers: z.array(CrawlerAccess),
  allowed_count: z.number(),
  blocked_count: z.number(),
  blocked_citation_critical: z.array(z.string()),
  unenforceable_blocks: z.array(z.string()),
  undocumented_vendors: z.array(
    z.object({ vendor: z.string(), note: z.string() }),
  ),
  findings: Findings,
});

// --- sitemap ---------------------------------------------------------------

const SitemapEntry = z.object({
  loc: z.string(),
  lastmod: z.string().nullable(),
  changefreq: z.string().nullable(),
  priority: z.string().nullable(),
});

export const SitemapSchema = z.object({
  url: z.string(),
  found: z.boolean(),
  status: z.number().nullable(),
  type: z.string(),
  url_count: z.number(),
  child_sitemaps: z.array(z.string()),
  child_sitemaps_followed: z.number(),
  entries: z.array(SitemapEntry),
  with_lastmod: z.number(),
  invalid_lastmod: z.array(z.string()),
  newest_lastmod: z.string().nullable(),
  oldest_lastmod: z.string().nullable(),
  off_origin_urls: z.array(z.string()),
  non_https_urls: z.array(z.string()),
  duplicate_urls: z.array(z.string()),
  exceeds_url_limit: z.boolean(),
  exceeds_size_limit: z.boolean(),
  bytes: z.number(),
  discovered_via: z.string(),
  score: z.number(),
  grade: z.string(),
  findings: Findings,
});

// --- links -----------------------------------------------------------------

const LinkInfo = z.object({
  href: z.string(),
  text: z.string(),
  internal: z.boolean(),
  rel: z.string().nullable(),
  nofollow: z.boolean(),
  status: z.number().nullable(),
  error: z.string().nullable(),
});

export const LinkSchema = z.object({
  url: z.string(),
  final_url: z.string(),
  total_links: z.number(),
  internal_links: z.number(),
  external_links: z.number(),
  nofollow_links: z.number(),
  sponsored_links: z.number(),
  ugc_links: z.number(),
  empty_anchor_text: z.number(),
  generic_anchor_text: z.array(z.string()),
  external_domains: z.array(z.object({ domain: z.string(), count: z.number() })),
  checked_count: z.number(),
  broken: z.array(LinkInfo),
  score: z.number(),
  grade: z.string(),
  findings: Findings,
});

// --- redirects -------------------------------------------------------------

const RedirectHop = z.object({
  url: z.string(),
  status: z.number(),
  location: z.string(),
});

export const RedirectSchema = z.object({
  url: z.string(),
  final_url: z.string(),
  final_status: z.number(),
  hops: z.array(RedirectHop),
  hop_count: z.number(),
  https_upgrade: z.boolean(),
  ends_https: z.boolean(),
  has_loop: z.boolean(),
  has_temporary_redirect: z.boolean(),
  elapsed_ms: z.number(),
  findings: Findings,
});

const VariantResult = z.object({
  variant: z.string(),
  reachable: z.boolean(),
  status: z.number().nullable(),
  final_url: z.string().nullable(),
  hop_count: z.number(),
  redirect_statuses: z.array(z.number()),
  error: z.string().nullable(),
});

export const CanonicalHostSchema = z.object({
  domain: z.string(),
  variants: z.array(VariantResult),
  canonical_url: z.string().nullable(),
  converges: z.boolean(),
  distinct_endpoints: z.array(z.string()),
  forces_https: z.boolean(),
  score: z.number(),
  grade: z.string(),
  findings: Findings,
});

// --- GEO -------------------------------------------------------------------

export const LlmsTxtSchema = z.object({
  url: z.string(),
  found: z.boolean(),
  status: z.number().nullable(),
  full_variant_found: z.boolean(),
  bytes: z.number(),
  title: z.string().nullable(),
  has_summary_blockquote: z.boolean(),
  sections: z.array(z.string()),
  link_count: z.number(),
  has_optional_section: z.boolean(),
  spec_compliant: z.boolean(),
  adoption_status: z.string(),
  findings: Findings,
});

export const RenderingSchema = z.object({
  renders_without_js: z.boolean(),
  server_text_words: z.number(),
  script_bytes: z.number(),
  html_bytes: z.number(),
  spa_shell_detected: z.boolean(),
  framework_hint: z.string().nullable(),
  findings: Findings,
});

const GeoSignal = z.object({
  id: z.string(),
  label: z.string(),
  weight: z.number(),
  earned: z.number(),
  status: z.string(),
  detail: z.string(),
});

export const GeoSchema = z.object({
  url: z.string(),
  final_url: z.string(),
  score: z.number(),
  grade: z.string(),
  signals: z.array(GeoSignal),
  renders_without_js: z.boolean(),
  ai_search_bots_blocked: z.array(z.string()),
  has_structured_data: z.boolean(),
  has_author_signals: z.boolean(),
  has_freshness_signals: z.boolean(),
  question_headings: z.number(),
  extractable_blocks: z.number(),
  top_recommendations: z.array(z.string()),
  findings: Findings,
});

export const GeoAuditSchema = z.object({
  geo: GeoSchema,
  rendering: RenderingSchema,
  crawler_access: AiCrawlerSchema.nullable(),
  llms_txt: LlmsTxtSchema.nullable(),
  robots: RobotsSchema.nullable(),
});

// --- composite audit -------------------------------------------------------

const AuditSection = z.object({
  id: z.string(),
  label: z.string(),
  score: z.number(),
  grade: z.string(),
  weight: z.number(),
  issues: z.array(z.string()),
});

export const SeoAuditSchema = z.object({
  url: z.string(),
  final_url: z.string(),
  status: z.number(),
  redirect_hops: z.number(),
  fetch_ms: z.number(),
  score: z.number(),
  grade: z.string(),
  indexable: z.boolean(),
  sections: z.array(AuditSection),
  top_recommendations: z.array(z.string()),
  geo: GeoSchema.nullable(),
  findings: Findings,
});
