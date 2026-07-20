/**
 * The composite audits.
 *
 * `runSeoAudit` and `runGeoAudit` fetch the page **once** and run every analyser
 * over the same parsed DOM, so a full report costs one page request plus a
 * robots.txt lookup — not a dozen round trips.
 */

import { clampScore, scoreToGrade, type Finding } from "../format.js";
import { analyzeContent, analyzeHeadings, analyzeImages } from "./content.js";
import {
  analyzeGeoReadiness,
  analyzeRendering,
  checkLlmsTxt,
  type GeoReport,
  type LlmsTxtReport,
  type RenderingReport,
} from "./geo.js";
import { analyzeHreflang, analyzeMetaTags, analyzeSocial } from "./meta.js";
import { loadPage, pageOrigin, type PageDoc } from "./page.js";
import {
  analyzeAiCrawlerAccess,
  analyzeRobots,
  fetchRobots,
  type AiCrawlerReport,
  type RobotsReport,
} from "./robots.js";
import { analyzeStructuredData } from "./structured-data.js";
import { analyzeLinks } from "./links.js";

/** A scored section of the overall audit. */
export interface AuditSection {
  id: string;
  label: string;
  score: number;
  grade: string;
  weight: number;
  /** The worst findings from this section, for the headline summary. */
  issues: string[];
}

export interface SeoAuditReport {
  url: string;
  final_url: string;
  status: number;
  redirect_hops: number;
  fetch_ms: number;
  score: number;
  grade: string;
  indexable: boolean;
  sections: AuditSection[];
  /** Highest-impact fixes, ordered. */
  top_recommendations: string[];
  /** Present when the caller asked for the GEO dimension too. */
  geo: GeoReport | null;
  findings: Finding[];
}

/** Relative weight of each section in the overall SEO score. */
const SECTION_WEIGHTS = {
  meta: 25,
  headings: 15,
  content: 15,
  structured_data: 15,
  images: 10,
  links: 10,
  robots: 10,
} as const;

/** Pull the failures and warnings out of a findings list, worst first. */
function issuesFrom(findings: Finding[], limit = 3): string[] {
  return findings
    .filter((f) => f.severity === "fail" || f.severity === "warn")
    .sort((a, b) => (a.severity === "fail" ? -1 : 1) - (b.severity === "fail" ? -1 : 1))
    .slice(0, limit)
    .map((f) => f.message);
}

export interface SeoAuditOptions {
  /** Also compute the GEO readiness dimension. Costs one extra request. */
  includeGeo?: boolean;
  /** Sample-verify that links resolve. Costs up to LINK_CHECK_SAMPLE requests. */
  checkBrokenLinks?: boolean;
  /** Verify the og:image actually loads. */
  checkSocialImage?: boolean;
}

/**
 * Run a full on-page SEO audit, optionally including the GEO dimension.
 */
export async function runSeoAudit(
  url: URL,
  options: SeoAuditOptions = {},
): Promise<SeoAuditReport> {
  const { includeGeo = false, checkBrokenLinks = false, checkSocialImage = true } = options;

  const page = await loadPage(url);
  const origin = pageOrigin(page);

  // robots.txt is fetched once and reused by both the robots section and the
  // GEO crawler-access signal.
  const robotsTxt = await fetchRobots(origin).catch(() => null);

  const [social, links, geoBundle] = await Promise.all([
    analyzeSocial(page, checkSocialImage),
    analyzeLinks(page, checkBrokenLinks),
    includeGeo ? buildGeoBundle(page, origin, robotsTxt) : Promise.resolve(null),
  ]);

  const meta = analyzeMetaTags(page);
  const headings = analyzeHeadings(page);
  const content = analyzeContent(page);
  const structuredData = analyzeStructuredData(page);
  const images = analyzeImages(page);
  const robotsReport = robotsTxt ? analyzeRobots(robotsTxt) : null;

  // The meta section blends page meta with social-card completeness.
  const metaScore = Math.round(meta.score * 0.75 + social.score * 0.25);
  const robotsScore = robotsReport
    ? robotsReport.blocks_everything
      ? 0
      : robotsReport.found
        ? robotsReport.sitemaps.length
          ? 100
          : 70
        : 40
    : 50;

  const sections: AuditSection[] = [
    { id: "meta", label: "Meta tags & social preview", score: metaScore, grade: scoreToGrade(metaScore), weight: SECTION_WEIGHTS.meta, issues: issuesFrom([...meta.findings, ...social.findings]) },
    { id: "headings", label: "Heading structure", score: headings.score, grade: headings.grade, weight: SECTION_WEIGHTS.headings, issues: issuesFrom(headings.findings) },
    { id: "content", label: "Content quality", score: content.score, grade: content.grade, weight: SECTION_WEIGHTS.content, issues: issuesFrom(content.findings) },
    { id: "structured_data", label: "Structured data", score: structuredData.score, grade: structuredData.grade, weight: SECTION_WEIGHTS.structured_data, issues: issuesFrom(structuredData.findings) },
    { id: "images", label: "Image SEO", score: images.score, grade: images.grade, weight: SECTION_WEIGHTS.images, issues: issuesFrom(images.findings) },
    { id: "links", label: "Links", score: links.score, grade: links.grade, weight: SECTION_WEIGHTS.links, issues: issuesFrom(links.findings) },
    { id: "robots", label: "Crawlability", score: robotsScore, grade: scoreToGrade(robotsScore), weight: SECTION_WEIGHTS.robots, issues: robotsReport ? issuesFrom(robotsReport.findings) : ["robots.txt could not be fetched."] },
  ];

  const totalWeight = sections.reduce((sum, s) => sum + s.weight, 0);
  const weighted = sections.reduce((sum, s) => sum + s.score * s.weight, 0);
  let score = clampScore(weighted / totalWeight);

  const findings: Finding[] = [];

  // A noindex page cannot rank at all — that dominates every other score.
  if (!meta.indexable) {
    score = Math.min(score, 35);
    findings.push({
      severity: "fail",
      message: "This page is set to noindex, so it cannot appear in search results at all. Everything below is moot until that is removed.",
    });
  }
  if (robotsReport?.blocks_everything) {
    score = Math.min(score, 25);
    findings.push({
      severity: "fail",
      message: "robots.txt disallows all crawlers from the site root. Nothing can be indexed.",
    });
  }

  // --- prioritised recommendations
  const recommendations: string[] = [];
  if (!meta.indexable) recommendations.push("Remove the noindex directive — the page is currently excluded from search entirely.");
  if (robotsReport?.blocks_everything) recommendations.push("Remove `Disallow: /` from the User-agent: * group in robots.txt.");
  if (!meta.title) recommendations.push("Add a <title> tag — it is the strongest single on-page signal.");
  if (!meta.description) recommendations.push("Add a meta description to control your search snippet.");
  if (headings.h1_count === 0) recommendations.push("Add exactly one <h1> stating the page topic.");
  if (structuredData.items.length === 0) recommendations.push("Add JSON-LD structured data for the page's primary entity.");
  if (images.missing_alt > 0) recommendations.push(`Add alt text to ${images.missing_alt} image(s).`);
  if (content.thin_content) recommendations.push(`Expand the content — ${content.word_count} words is usually too thin to rank.`);
  if (!meta.canonical) recommendations.push("Add a self-referencing canonical link.");
  if (robotsReport && robotsReport.sitemaps.length === 0) recommendations.push("Declare your sitemap in robots.txt.");
  if (geoBundle?.geo.top_recommendations.length) {
    recommendations.push(...geoBundle.geo.top_recommendations);
  }

  findings.push(
    { severity: score >= 80 ? "pass" : "info", message: `Overall SEO score ${score}/100 (${scoreToGrade(score)}) across ${sections.length} sections.` },
    ...sections.map((s): Finding => ({
      severity: s.score >= 80 ? "pass" : s.score >= 60 ? "warn" : "fail",
      message: `${s.label}: ${s.score}/100 (${s.grade}).`,
    })),
  );

  return {
    url: page.url,
    final_url: page.finalUrl,
    status: page.status,
    redirect_hops: page.redirects.length,
    fetch_ms: page.elapsedMs,
    score,
    grade: scoreToGrade(score),
    indexable: meta.indexable,
    sections,
    top_recommendations: [...new Set(recommendations)].slice(0, 8),
    geo: geoBundle?.geo ?? null,
    findings,
  };
}

// --- GEO composite ---------------------------------------------------------

export interface GeoAuditBundle {
  geo: GeoReport;
  rendering: RenderingReport;
  crawler_access: AiCrawlerReport | null;
  llms_txt: LlmsTxtReport | null;
  robots: RobotsReport | null;
}

/** Build the GEO dimension from an already-loaded page. */
async function buildGeoBundle(
  page: PageDoc,
  origin: string,
  robotsTxt: Awaited<ReturnType<typeof fetchRobots>> | null,
): Promise<GeoAuditBundle> {
  const path = new URL(page.finalUrl).pathname;

  const [llmsTxt] = await Promise.all([
    checkLlmsTxt(origin).catch(() => null),
  ]);

  const crawlerAccess = robotsTxt ? analyzeAiCrawlerAccess(robotsTxt, path) : null;
  const rendering = analyzeRendering(page);
  const headings = analyzeHeadings(page);
  const content = analyzeContent(page);
  const structuredData = analyzeStructuredData(page);

  const geo = analyzeGeoReadiness({
    page,
    headings,
    content,
    structuredData,
    rendering,
    crawlerAccess: crawlerAccess ?? undefined,
    llmsTxt: llmsTxt ?? undefined,
  });

  return {
    geo,
    rendering,
    crawler_access: crawlerAccess,
    llms_txt: llmsTxt,
    robots: robotsTxt ? analyzeRobots(robotsTxt) : null,
  };
}

/**
 * Run a standalone GEO audit: how ready is this page to be cited by an AI
 * answer engine?
 */
export async function runGeoAudit(url: URL): Promise<GeoAuditBundle> {
  const page = await loadPage(url);
  const origin = pageOrigin(page);
  const robotsTxt = await fetchRobots(origin).catch(() => null);
  return buildGeoBundle(page, origin, robotsTxt);
}

/** Re-exported so tools can compose the same analysers individually. */
export {
  analyzeContent,
  analyzeHeadings,
  analyzeImages,
  analyzeHreflang,
  analyzeMetaTags,
  analyzeSocial,
  analyzeStructuredData,
  analyzeLinks,
  analyzeRendering,
};
