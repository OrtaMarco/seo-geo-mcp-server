/**
 * Deterministic unit tests for the logic that real-site smoke tests cannot
 * reliably exercise: the RFC 9309 rule matcher, SPA-shell detection, hreflang
 * validation and JSON-LD extraction.
 *
 *   npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";

import { parseRobots, isAllowed, analyzeAiCrawlerAccess } from "../dist/core/robots.js";
import { analyzeRendering, analyzeGeoReadiness } from "../dist/core/geo.js";
import { analyzeHreflang, normalizeForCompare } from "../dist/core/meta.js";
import { analyzeStructuredData } from "../dist/core/structured-data.js";
import { analyzeHeadings, analyzeContent } from "../dist/core/content.js";

/** Build a RobotsTxt object from raw text, as fetchRobots would. */
function robots(text, status = 200) {
  return {
    url: "https://example.com/robots.txt",
    found: status >= 200 && status < 300,
    status,
    raw: text,
    ...parseRobots(text),
  };
}

/** Build a minimal PageDoc around an HTML string. */
function page(html, finalUrl = "https://example.com/") {
  return {
    url: finalUrl,
    finalUrl,
    status: 200,
    headers: {},
    contentType: "text/html",
    html,
    bytes: Buffer.byteLength(html, "utf8"),
    truncated: false,
    elapsedMs: 1,
    redirects: [],
    $: cheerio.load(html),
  };
}

// --- robots.txt matcher ----------------------------------------------------

test("empty Disallow means allow everything", () => {
  const r = robots("User-agent: *\nDisallow:");
  assert.equal(isAllowed(r, "GPTBot", "/anything").allowed, true);
});

test("Disallow: / blocks the whole site", () => {
  const r = robots("User-agent: *\nDisallow: /");
  assert.equal(isAllowed(r, "GPTBot", "/").allowed, false);
  assert.equal(isAllowed(r, "GPTBot", "/deep/path").allowed, false);
});

test("longest matching pattern wins over a shorter one", () => {
  const r = robots("User-agent: *\nDisallow: /admin\nAllow: /admin/public");
  assert.equal(isAllowed(r, "GPTBot", "/admin/secret").allowed, false);
  assert.equal(isAllowed(r, "GPTBot", "/admin/public/x").allowed, true);
});

test("Allow wins when patterns tie in length", () => {
  const r = robots("User-agent: *\nDisallow: /x\nAllow: /x");
  assert.equal(isAllowed(r, "GPTBot", "/x").allowed, true);
});

test("user-agent tokens match case-insensitively (RFC 9309 §2.2.1)", () => {
  const r = robots("User-agent: gptbot\nDisallow: /");
  assert.equal(isAllowed(r, "GPTBot", "/").allowed, false);
  assert.equal(isAllowed(r, "GPTBOT", "/").allowed, false);
});

test("a named group overrides the wildcard group", () => {
  const r = robots("User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nDisallow:");
  assert.equal(isAllowed(r, "GPTBot", "/page").allowed, true);
  assert.equal(isAllowed(r, "ClaudeBot", "/page").allowed, false);
});

test("groups sharing a user-agent are merged", () => {
  const r = robots("User-agent: GPTBot\nDisallow: /a\n\nUser-agent: GPTBot\nDisallow: /b");
  assert.equal(isAllowed(r, "GPTBot", "/a").allowed, false);
  assert.equal(isAllowed(r, "GPTBot", "/b").allowed, false);
});

test("consecutive User-agent lines share one rule block", () => {
  const r = robots("User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /private");
  assert.equal(isAllowed(r, "GPTBot", "/private").allowed, false);
  assert.equal(isAllowed(r, "ClaudeBot", "/private").allowed, false);
});

test("wildcard * inside a path pattern", () => {
  const r = robots("User-agent: *\nDisallow: /*.pdf");
  assert.equal(isAllowed(r, "GPTBot", "/docs/file.pdf").allowed, false);
  assert.equal(isAllowed(r, "GPTBot", "/docs/file.html").allowed, true);
});

test("$ anchors the end of the path", () => {
  const r = robots("User-agent: *\nDisallow: /page$");
  assert.equal(isAllowed(r, "GPTBot", "/page").allowed, false);
  assert.equal(isAllowed(r, "GPTBot", "/page/sub").allowed, true);
});

test("no matching group at all means allowed", () => {
  const r = robots("User-agent: Googlebot\nDisallow: /");
  assert.equal(isAllowed(r, "GPTBot", "/").allowed, true);
});

test("a 5xx robots.txt is treated as disallow-all", () => {
  const r = robots("", 503);
  assert.equal(isAllowed(r, "GPTBot", "/").allowed, false);
});

test("comments and blank lines are ignored", () => {
  const r = robots("# comment\n\nUser-agent: *  # trailing\nDisallow: /x\n");
  assert.equal(isAllowed(r, "GPTBot", "/x").allowed, false);
});

test("Sitemap directives are collected independently of groups", () => {
  const r = robots("Sitemap: https://example.com/sitemap.xml\nUser-agent: *\nDisallow:");
  assert.deepEqual(r.sitemaps, ["https://example.com/sitemap.xml"]);
});

// --- AI crawler analysis ---------------------------------------------------

test("blocking training bots but not search bots is reported correctly", () => {
  const r = robots(
    "User-agent: GPTBot\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nDisallow:",
  );
  const report = analyzeAiCrawlerAccess(r, "/");
  assert.equal(report.blocked_citation_critical.length, 0, "no search bots should be blocked");
  const gptbot = report.crawlers.find((c) => c.token === "GPTBot");
  assert.equal(gptbot.allowed, false);
  const searchbot = report.crawlers.find((c) => c.token === "OAI-SearchBot");
  assert.equal(searchbot.allowed, true);
});

test("blocking search bots is flagged as citation-critical", () => {
  const r = robots("User-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: *\nDisallow:");
  const report = analyzeAiCrawlerAccess(r, "/");
  assert.ok(report.blocked_citation_critical.includes("OAI-SearchBot"));
});

test("blocks on bots that ignore robots.txt are marked unenforceable", () => {
  const r = robots("User-agent: *\nDisallow: /");
  const report = analyzeAiCrawlerAccess(r, "/");
  assert.ok(
    report.unenforceable_blocks.includes("Perplexity-User"),
    "Perplexity-User is documented as ignoring robots.txt",
  );
});

test("Applebot falls back to Googlebot rules when it has no group", () => {
  const r = robots("User-agent: Googlebot\nDisallow: /no-apple");
  const report = analyzeAiCrawlerAccess(r, "/no-apple");
  const applebot = report.crawlers.find((c) => c.token === "Applebot");
  assert.equal(applebot.allowed, false, "should inherit the Googlebot disallow");
  assert.ok(applebot.quirk, "the fallback should be explained in `quirk`");
});

test("deprecated tokens are excluded unless requested", () => {
  const r = robots("User-agent: *\nDisallow:");
  assert.equal(analyzeAiCrawlerAccess(r, "/").crawlers.some((c) => c.token === "claude-web"), false);
  assert.equal(
    analyzeAiCrawlerAccess(r, "/", true).crawlers.some((c) => c.token === "claude-web"),
    true,
  );
});

// --- rendering detection ---------------------------------------------------

test("an unhydrated SPA shell is detected", () => {
  const html = `<html><body><div id="root"></div><script>window.__DATA__={}</script></body></html>`;
  const report = analyzeRendering(page(html));
  assert.equal(report.spa_shell_detected, true);
  assert.equal(report.renders_without_js, false);
  assert.equal(report.framework_hint, "#root");
});

test("a server-rendered page is not flagged as a SPA shell", () => {
  const body = "Lorem ipsum dolor sit amet. ".repeat(40);
  const html = `<html><body><main><h1>Title</h1><p>${body}</p></main></body></html>`;
  const report = analyzeRendering(page(html));
  assert.equal(report.spa_shell_detected, false);
  assert.equal(report.renders_without_js, true);
  assert.ok(report.server_text_words > 100);
});

test("a populated #root is not a shell", () => {
  const body = "Real server rendered content here. ".repeat(30);
  const html = `<html><body><div id="root"><h1>Hi</h1><p>${body}</p></div></body></html>`;
  const report = analyzeRendering(page(html));
  assert.equal(report.spa_shell_detected, false);
});

// --- hreflang --------------------------------------------------------------

test("hreflang codes are validated and x-default detected", async () => {
  const html = `<html lang="es"><head>
    <link rel="alternate" hreflang="es" href="https://example.com/">
    <link rel="alternate" hreflang="en-US" href="https://example.com/en/">
    <link rel="alternate" hreflang="x-default" href="https://example.com/">
    <link rel="alternate" hreflang="english" href="https://example.com/bad/">
  </head><body></body></html>`;
  const report = await analyzeHreflang(page(html));
  assert.equal(report.entries.length, 4);
  assert.equal(report.has_x_default, true);
  assert.equal(report.self_referencing, true);
  assert.deepEqual(report.invalid_codes, ["english"]);
});

test("duplicate hreflang codes are reported", async () => {
  const html = `<html><head>
    <link rel="alternate" hreflang="en" href="https://example.com/a">
    <link rel="alternate" hreflang="en" href="https://example.com/b">
  </head><body></body></html>`;
  const report = await analyzeHreflang(page(html));
  assert.deepEqual(report.duplicate_codes, ["en"]);
});

test("URL comparison ignores trailing slash and fragment", () => {
  assert.equal(
    normalizeForCompare("https://example.com/path/"),
    normalizeForCompare("https://example.com/path#section"),
  );
});

// --- structured data -------------------------------------------------------

test("JSON-LD inside @graph is flattened", () => {
  const html = `<html><head><script type="application/ld+json">
    {"@context":"https://schema.org","@graph":[
      {"@type":"Organization","name":"Acme","url":"https://acme.com"},
      {"@type":"WebSite","name":"Acme","url":"https://acme.com"}
    ]}
  </script></head><body></body></html>`;
  const report = analyzeStructuredData(page(html));
  assert.equal(report.items.length, 2);
  assert.ok(report.has_organization);
  assert.ok(report.has_website);
});

test("missing required properties invalidate an item", () => {
  const html = `<html><head><script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Event","name":"Launch"}
  </script></head><body></body></html>`;
  const report = analyzeStructuredData(page(html));
  const event = report.items.find((i) => i.type === "Event");
  assert.equal(event.valid, false);
  assert.deepEqual(event.missing_required.sort(), ["location", "startDate"]);
});

test("malformed JSON-LD is reported rather than silently dropped", () => {
  const html = `<html><head><script type="application/ld+json">{ not valid json }</script></head><body></body></html>`;
  const report = analyzeStructuredData(page(html));
  assert.equal(report.parse_errors.length, 1);
  assert.match(report.parse_errors[0], /not valid JSON/);
});

test("LocalBusiness subtypes count as a publisher entity", () => {
  // AccountingService → FinancialService → LocalBusiness → Organization.
  // Matching only the literal "Organization" string would be a false negative.
  const html = `<html><head><script type="application/ld+json">
    {"@context":"https://schema.org","@type":"AccountingService","name":"Acme","sameAs":["https://facebook.com/acme"]}
  </script></head><body></body></html>`;
  const report = analyzeStructuredData(page(html));
  assert.equal(report.has_organization, true);
});

test("a Person entity is recognised as publisher markup for a personal brand", () => {
  const html = `<html><head><script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Person","name":"Marco","sameAs":["https://github.com/x"]}
  </script></head><body></body></html>`;
  const report = analyzeStructuredData(page(html));
  assert.equal(report.has_person, true);
  assert.equal(report.has_organization, false);
});

test("a non-article page is not penalised for lacking an author", () => {
  const html = `<html><head><script type="application/ld+json">
    {"@context":"https://schema.org","@type":"AccountingService","name":"Acme","sameAs":["https://facebook.com/acme"]}
  </script></head><body><main><h1>Services</h1><p>${"Content. ".repeat(60)}</p></main></body></html>`;
  const doc = page(html);
  const sd = analyzeStructuredData(doc);
  const report = analyzeGeoReadiness({
    page: doc,
    headings: analyzeHeadings(doc),
    content: analyzeContent(doc),
    structuredData: sd,
    rendering: analyzeRendering(doc),
  });
  const attribution = report.signals.find((s) => s.id === "attribution");
  assert.equal(attribution.earned, 10, "entity + sameAs should be full marks without an author");
});

test("an article page IS expected to carry an author", () => {
  const html = `<html><head><script type="application/ld+json">
    {"@context":"https://schema.org","@type":"BlogPosting","headline":"X","sameAs":["https://x.com/y"]}
  </script></head><body><main><h1>Post</h1><p>${"Content. ".repeat(60)}</p></main></body></html>`;
  const doc = page(html);
  const report = analyzeGeoReadiness({
    page: doc,
    headings: analyzeHeadings(doc),
    content: analyzeContent(doc),
    structuredData: analyzeStructuredData(doc),
    rendering: analyzeRendering(doc),
  });
  const attribution = report.signals.find((s) => s.id === "attribution");
  assert.ok(attribution.earned < 10, "a missing author should cost marks on an article");
});

test("an array of JSON-LD objects is handled", () => {
  const html = `<html><head><script type="application/ld+json">
    [{"@type":"Person","name":"A"},{"@type":"Person","name":"B"}]
  </script></head><body></body></html>`;
  const report = analyzeStructuredData(page(html));
  assert.equal(report.items.length, 2);
});

// --- headings --------------------------------------------------------------

test("skipped heading levels are counted", () => {
  const html = `<html><body><h1>A</h1><h2>B</h2><h4>C</h4></body></html>`;
  const report = analyzeHeadings(page(html));
  assert.equal(report.level_skips, 1);
  assert.equal(report.h1_count, 1);
});

test("question-shaped headings are detected in English and Spanish", () => {
  const html = `<html><body><h1>Guide</h1><h2>How do I install it?</h2><h2>¿Cómo funciona?</h2><h2>Pricing</h2></body></html>`;
  const report = analyzeHeadings(page(html));
  assert.equal(report.question_headings.length, 2);
});

test("empty headings are counted but excluded from the outline", () => {
  const html = `<html><body><h1>A</h1><h2></h2></body></html>`;
  const report = analyzeHeadings(page(html));
  assert.equal(report.empty_headings, 1);
  assert.equal(report.headings.length, 1);
});
