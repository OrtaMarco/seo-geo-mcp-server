/**
 * GEO — Generative Engine Optimization.
 *
 * Scores how readily an AI answer engine (ChatGPT, Claude, Perplexity, Gemini,
 * Copilot) can *fetch*, *parse* and *cite* a page.
 *
 * Two honesty constraints are baked into this module:
 *
 *  1. `llms.txt` is a community proposal, NOT an adopted standard. No major AI
 *     vendor has committed to reading it and Google has explicitly said it does
 *     not. We report its presence and validate its shape, but never imply that
 *     publishing one earns visibility.
 *
 *  2. Most AI crawlers do not execute JavaScript. A page whose content only
 *     appears after hydration is effectively invisible to them, which is why the
 *     server-rendered-content check carries real weight here.
 */

import { clampScore, scoreToGrade, type Finding } from "../format.js";
import { fetchTextResource } from "./fetch.js";
import { mainText, type PageDoc } from "./page.js";
import type { AiCrawlerReport } from "./robots.js";
import type { StructuredDataReport } from "./structured-data.js";
import type { ContentReport, HeadingReport } from "./content.js";

// --- llms.txt --------------------------------------------------------------

export interface LlmsTxtReport {
  url: string;
  found: boolean;
  status: number | null;
  /** `/llms-full.txt` — a community convention, not part of the proposal. */
  full_variant_found: boolean;
  bytes: number;
  /** The H1 title, which the proposal requires. */
  title: string | null;
  has_summary_blockquote: boolean;
  sections: string[];
  link_count: number;
  has_optional_section: boolean;
  spec_compliant: boolean;
  /** Plain-language statement of what publishing this actually buys you. */
  adoption_status: string;
  findings: Finding[];
}

const LLMS_TXT_ADOPTION =
  "llms.txt is a community proposal (llmstxt.org, Sept 2024), not an adopted standard. " +
  "No major AI vendor has documented that its crawlers read llms.txt from third-party sites, " +
  "and Google has publicly stated it does not support it. Publishing one is low-cost and may " +
  "help humans and some doc tooling, but it does not earn AI visibility on its own — robots.txt " +
  "access, structured data and server-rendered content do.";

/**
 * Check whether a site publishes `/llms.txt`, and validate it against the
 * llmstxt.org proposal: a required H1, an optional blockquote summary, and
 * H2-delimited lists of `- [name](url): notes` links.
 */
export async function checkLlmsTxt(origin: string): Promise<LlmsTxtReport> {
  const findings: Finding[] = [];
  const url = new URL("/llms.txt", origin);

  const [main, full] = await Promise.all([
    fetchTextResource(url, { maxBytes: 512_000 }).catch(() => null),
    fetchTextResource(new URL("/llms-full.txt", origin), { maxBytes: 4096, method: "HEAD" }).catch(
      () => null,
    ),
  ]);

  const fullFound = full !== null && full.status >= 200 && full.status < 300;

  if (!main || main.status < 200 || main.status >= 300) {
    findings.push({
      severity: "info",
      message: `No /llms.txt published. ${LLMS_TXT_ADOPTION}`,
    });
    return {
      url: url.toString(),
      found: false,
      status: main?.status ?? 404,
      full_variant_found: fullFound,
      bytes: 0,
      title: null,
      has_summary_blockquote: false,
      sections: [],
      link_count: 0,
      has_optional_section: false,
      spec_compliant: false,
      adoption_status: LLMS_TXT_ADOPTION,
      findings,
    };
  }

  const text = main.body;
  const lines = text.split(/\r?\n/);

  const h1Line = lines.find((l) => /^#\s+\S/.test(l));
  const title = h1Line ? h1Line.replace(/^#\s+/, "").trim() : null;
  const hasSummary = lines.some((l) => /^>\s*\S/.test(l));
  const sections = lines
    .filter((l) => /^##\s+\S/.test(l))
    .map((l) => l.replace(/^##\s+/, "").trim());
  const linkCount = (text.match(/^\s*-\s*\[[^\]]+\]\([^)]+\)/gm) ?? []).length;
  const hasOptional = sections.some((s) => s.toLowerCase() === "optional");

  const specCompliant = title !== null;

  findings.push({
    severity: "pass",
    message: `/llms.txt is published (${main.bytes} bytes, ${linkCount} link(s) across ${sections.length} section(s)).`,
  });

  if (!title) {
    findings.push({
      severity: "warn",
      message: "No H1 heading. The proposal requires a single `# Project Name` line as the first element.",
    });
  }
  if (!hasSummary) {
    findings.push({
      severity: "info",
      message: "No `>` blockquote summary. The proposal suggests one directly after the H1 to state what the project is.",
    });
  }
  if (linkCount === 0) {
    findings.push({
      severity: "warn",
      message: "No `- [name](url): notes` link entries. Those lists are the substance of the file — without them it conveys little.",
    });
  }

  findings.push({ severity: "info", message: LLMS_TXT_ADOPTION });

  if (fullFound) {
    findings.push({
      severity: "info",
      message: "/llms-full.txt is also published. Note this filename is a de-facto community convention (popularised by docs tooling), not part of the llmstxt.org proposal.",
    });
  }

  return {
    url: url.toString(),
    found: true,
    status: main.status,
    full_variant_found: fullFound,
    bytes: main.bytes,
    title,
    has_summary_blockquote: hasSummary,
    sections,
    link_count: linkCount,
    has_optional_section: hasOptional,
    spec_compliant: specCompliant,
    adoption_status: LLMS_TXT_ADOPTION,
    findings,
  };
}

// --- server-rendered content ----------------------------------------------

export interface RenderingReport {
  /** True when meaningful content is present in the server HTML. */
  renders_without_js: boolean;
  server_text_words: number;
  script_bytes: number;
  html_bytes: number;
  /** True when the page looks like an unhydrated SPA shell. */
  spa_shell_detected: boolean;
  framework_hint: string | null;
  findings: Finding[];
}

/** Root containers that frameworks hydrate into. */
const SPA_ROOTS = ["#root", "#app", "#__next", "#__nuxt", "[data-reactroot]", "#svelte"];

/**
 * Decide whether the page's content survives without JavaScript.
 *
 * This matters more for GEO than for classic SEO: Googlebot renders JS, but
 * GPTBot, ClaudeBot, PerplexityBot and CCBot largely do not. A client-rendered
 * page can rank in Google and still be invisible to every AI assistant.
 */
export function analyzeRendering(page: PageDoc): RenderingReport {
  const $ = page.$;
  const findings: Finding[] = [];

  const { text } = mainText(page);
  const words = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

  const scriptBytes = $("script")
    .toArray()
    .reduce((sum, el) => sum + Buffer.byteLength($(el).html() ?? "", "utf8"), 0);

  let spaShell = false;
  let frameworkHint: string | null = null;

  for (const selector of SPA_ROOTS) {
    const node = $(selector).first();
    if (node.length) {
      const innerWords = node.text().split(/\s+/).filter(Boolean).length;
      if (innerWords < 50) {
        spaShell = true;
        frameworkHint = selector;
      }
      break;
    }
  }

  if ($('script[id="__NEXT_DATA__"]').length) frameworkHint ??= "Next.js";
  if ($("[data-reactroot]").length) frameworkHint ??= "React";
  if ($("[data-v-app]").length) frameworkHint ??= "Vue";

  const rendersWithoutJs = words >= 100 && !spaShell;

  if (rendersWithoutJs) {
    findings.push({
      severity: "pass",
      message: `${words} words of content are present in the server HTML — AI crawlers that do not execute JavaScript can still read this page.`,
    });
  } else if (spaShell) {
    findings.push({
      severity: "fail",
      message: `The page looks like an unhydrated SPA shell (${frameworkHint ?? "empty root container"}, ${words} words in the server HTML). GPTBot, ClaudeBot, PerplexityBot and CCBot generally do not run JavaScript, so they would see an empty page. Server-render or pre-render this route.`,
    });
  } else {
    findings.push({
      severity: "warn",
      message: `Only ${words} words are present before JavaScript runs. Most AI crawlers do not render JS — move the primary content into the server response.`,
    });
  }

  if (scriptBytes > page.bytes * 0.5 && page.bytes > 50_000) {
    findings.push({
      severity: "warn",
      message: `Inline scripts are ${Math.round((scriptBytes / page.bytes) * 100)}% of the document. Heavy inline JS delays parsing and crowds out content.`,
    });
  }

  return {
    renders_without_js: rendersWithoutJs,
    server_text_words: words,
    script_bytes: scriptBytes,
    html_bytes: page.bytes,
    spa_shell_detected: spaShell,
    framework_hint: frameworkHint,
    findings,
  };
}

// --- GEO readiness ---------------------------------------------------------

export interface GeoSignal {
  id: string;
  label: string;
  weight: number;
  earned: number;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface GeoReport {
  url: string;
  final_url: string;
  score: number;
  grade: string;
  signals: GeoSignal[];
  renders_without_js: boolean;
  ai_search_bots_blocked: string[];
  has_structured_data: boolean;
  has_author_signals: boolean;
  has_freshness_signals: boolean;
  question_headings: number;
  extractable_blocks: number;
  top_recommendations: string[];
  findings: Finding[];
}

interface GeoInputs {
  page: PageDoc;
  headings: HeadingReport;
  content: ContentReport;
  structuredData: StructuredDataReport;
  rendering: RenderingReport;
  /** Optional: when supplied, crawler access is scored. */
  crawlerAccess?: AiCrawlerReport;
  /** Optional: presence of llms.txt (reported, deliberately unscored). */
  llmsTxt?: LlmsTxtReport;
}

/**
 * Score a page's readiness to be cited by AI answer engines.
 *
 * Weights reflect what actually gates a citation, in order: the bot must be able
 * to fetch the page, then read it without JavaScript, then find explicit facts
 * and attributable structure. `llms.txt` is deliberately NOT scored — see the
 * module header.
 */
export function analyzeGeoReadiness(inputs: GeoInputs): GeoReport {
  const { page, headings, content, structuredData, rendering, crawlerAccess, llmsTxt } = inputs;
  const $ = page.$;
  const findings: Finding[] = [];
  const signals: GeoSignal[] = [];
  const recommendations: string[] = [];

  const add = (
    id: string,
    label: string,
    weight: number,
    earned: number,
    detail: string,
    recommendation?: string,
  ) => {
    const ratio = weight === 0 ? 1 : earned / weight;
    const status: GeoSignal["status"] = ratio >= 0.85 ? "pass" : ratio >= 0.4 ? "warn" : "fail";
    signals.push({ id, label, weight, earned: Math.round(earned), status, detail });
    if (status !== "pass" && recommendation) recommendations.push(recommendation);
  };

  // --- 1. Can AI search crawlers fetch it at all? (weight 25)
  const blockedSearchBots = crawlerAccess?.blocked_citation_critical ?? [];
  if (!crawlerAccess) {
    add("crawler_access", "AI crawler access", 25, 25, "Not checked — robots.txt was not supplied to this analysis.");
  } else if (blockedSearchBots.length === 0) {
    add("crawler_access", "AI crawler access", 25, 25, "All AI search crawlers (OAI-SearchBot, Claude-SearchBot, PerplexityBot, Googlebot) may fetch this page.");
  } else {
    add(
      "crawler_access",
      "AI crawler access",
      25,
      0,
      `Blocked in robots.txt: ${blockedSearchBots.join(", ")}. These are the crawlers that build the indexes AI assistants cite from.`,
      `Unblock ${blockedSearchBots.join(", ")} in robots.txt — they index for citation, not model training.`,
    );
  }

  // --- 2. Does the content exist without JavaScript? (weight 20)
  if (rendering.renders_without_js) {
    add("server_rendering", "Server-rendered content", 20, 20, `${rendering.server_text_words} words are in the server HTML.`);
  } else {
    add(
      "server_rendering",
      "Server-rendered content",
      20,
      rendering.spa_shell_detected ? 0 : 8,
      rendering.spa_shell_detected
        ? "The page is an unhydrated SPA shell — JS-blind AI crawlers see nothing."
        : `Only ${rendering.server_text_words} words render without JavaScript.`,
      "Server-render or pre-render this route so crawlers that do not execute JavaScript can read the content.",
    );
  }

  // --- 3. Explicit machine-readable facts (weight 15)
  const validItems = structuredData.items.filter((i) => i.valid).length;
  const sdScore = structuredData.items.length ? validItems / structuredData.items.length : 0;
  if (structuredData.items.length && structuredData.parse_errors.length === 0) {
    add("structured_data", "Structured data", 15, 15 * Math.max(0.6, sdScore), `${structuredData.items.length} item(s): ${structuredData.types_found.join(", ")}.`);
  } else if (structuredData.items.length) {
    add("structured_data", "Structured data", 15, 7, `${structuredData.items.length} item(s) present but ${structuredData.parse_errors.length} block(s) failed to parse.`, "Fix the invalid JSON-LD blocks — malformed markup is ignored entirely.");
  } else {
    add("structured_data", "Structured data", 15, 0, "No schema.org markup. AI models must then infer every fact from prose.", "Add JSON-LD for the page's primary entity (Article, Product, FAQPage, Organization).");
  }

  // --- 4. Extractable structure: headings, lists, tables (weight 15)
  const lists = $("ul, ol").length;
  const tables = $("table").length;
  const definitionLists = $("dl").length;
  const extractableBlocks = lists + tables + definitionLists;
  const questionHeadings = headings.question_headings.length;

  let structureEarned = 0;
  if (headings.h1_count === 1) structureEarned += 4;
  if (headings.headings.length >= 3) structureEarned += 4;
  if (extractableBlocks > 0) structureEarned += 4;
  if (questionHeadings > 0) structureEarned += 3;

  add(
    "extractable_structure",
    "Extractable structure",
    15,
    structureEarned,
    `${headings.headings.length} heading(s), ${questionHeadings} phrased as questions, ${extractableBlocks} list/table block(s).`,
    structureEarned < 12
      ? "Break content into subheadings phrased as real user questions, and use lists or tables for enumerable facts — these are the units AI assistants lift verbatim."
      : undefined,
  );

  // --- 5. Attribution & trust signals (weight 10)
  const hasAuthorMarkup = structuredData.items.some((i) => i.properties.includes("author"));
  const hasAuthorVisible = $('[rel="author"], [itemprop="author"], .author, .byline').length > 0;
  const hasOrganization = structuredData.has_organization;
  const hasSameAs = structuredData.items.some((i) => i.properties.includes("sameAs"));

  let trustEarned = 0;
  if (hasAuthorMarkup || hasAuthorVisible) trustEarned += 4;
  if (hasOrganization) trustEarned += 4;
  if (hasSameAs) trustEarned += 2;

  add(
    "attribution",
    "Authorship & entity signals",
    10,
    trustEarned,
    `Author: ${hasAuthorMarkup ? "in schema" : hasAuthorVisible ? "visible only" : "absent"}; Organization: ${hasOrganization ? "present" : "absent"}; sameAs: ${hasSameAs ? "present" : "absent"}.`,
    trustEarned < 8
      ? "Add author and Organization markup with `sameAs` links to official profiles — AI systems weight attributable sources more heavily."
      : undefined,
  );

  // --- 6. Freshness (weight 8)
  const hasDateModified = structuredData.items.some((i) => i.properties.includes("dateModified"));
  const hasDatePublished = structuredData.items.some((i) => i.properties.includes("datePublished"));
  const hasTimeElement = $("time[datetime]").length > 0;

  let freshnessEarned = 0;
  if (hasDateModified) freshnessEarned += 5;
  else if (hasDatePublished) freshnessEarned += 3;
  if (hasTimeElement) freshnessEarned += 3;

  add(
    "freshness",
    "Freshness signals",
    8,
    freshnessEarned,
    `datePublished: ${hasDatePublished ? "yes" : "no"}, dateModified: ${hasDateModified ? "yes" : "no"}, <time datetime>: ${hasTimeElement ? "yes" : "no"}.`,
    freshnessEarned < 6
      ? "Publish `datePublished` and `dateModified` in schema. Answer engines strongly prefer content they can date."
      : undefined,
  );

  // --- 7. Depth & answerability (weight 7)
  let depthEarned = 0;
  if (!content.thin_content) depthEarned += 4;
  if (content.reading_ease >= 45) depthEarned += 2;
  if (content.avg_words_per_sentence <= 25) depthEarned += 1;

  add(
    "depth",
    "Content depth & clarity",
    7,
    depthEarned,
    `${content.word_count} words, reading ease ${content.reading_ease}, ${content.avg_words_per_sentence} words/sentence.`,
    depthEarned < 5
      ? "Expand thin sections and shorten sentences — self-contained, plainly worded statements are the ones models quote."
      : undefined,
  );

  const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);
  const earned = signals.reduce((sum, s) => sum + s.earned, 0);
  const score = clampScore((earned / totalWeight) * 100);

  // --- narrative findings
  for (const signal of signals) {
    findings.push({
      severity: signal.status === "pass" ? "pass" : signal.status === "warn" ? "warn" : "fail",
      message: `${signal.label} (${signal.earned}/${signal.weight}) — ${signal.detail}`,
    });
  }

  if (llmsTxt) {
    findings.push({
      severity: "info",
      message: llmsTxt.found
        ? `/llms.txt is published. Reported for completeness and deliberately not scored: ${llmsTxt.adoption_status}`
        : `No /llms.txt. Deliberately not scored: ${llmsTxt.adoption_status}`,
    });
  }

  return {
    url: page.url,
    final_url: page.finalUrl,
    score,
    grade: scoreToGrade(score),
    signals,
    renders_without_js: rendering.renders_without_js,
    ai_search_bots_blocked: blockedSearchBots,
    has_structured_data: structuredData.items.length > 0,
    has_author_signals: hasAuthorMarkup || hasAuthorVisible,
    has_freshness_signals: hasDateModified || hasDatePublished,
    question_headings: questionHeadings,
    extractable_blocks: extractableBlocks,
    top_recommendations: recommendations.slice(0, 5),
    findings,
  };
}
