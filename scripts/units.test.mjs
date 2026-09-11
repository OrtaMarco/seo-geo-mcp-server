/**
 * Deterministic unit tests for the logic that real-site smoke tests cannot
 * reliably exercise: the RFC 9309 rule matcher, SPA-shell detection, hreflang
 * validation and JSON-LD extraction.
 *
 *   npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import * as cheerio from "cheerio";
import { Agent } from "undici";

import { parseRobots, isAllowed, analyzeAiCrawlerAccess, robotsPatternMatches } from "../dist/core/robots.js";
import { isPrivateHost, validateUrl } from "../dist/core/validate.js";
import { createGuardedLookup } from "../dist/core/netguard.js";
import { safeFetch } from "../dist/core/fetch.js";
import { exceedsNestingDepth } from "../dist/core/page.js";
import { sitemapText } from "../dist/core/sitemap.js";
import { capLists } from "../dist/format.js";
import { MAX_HTML_DEPTH, MAX_STRUCTURED_ITEMS, SITEMAP_READ_BYTES } from "../dist/constants.js";
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


// --- SSRF guard ---------------------------------------------------------------

test("isPrivateHost blocks every internal spelling, including IPv4 inside IPv6", () => {
  for (const host of [
    "127.0.0.1", "10.0.0.1", "172.20.0.1", "192.168.0.1", "169.254.169.254", "100.100.100.200",
    "198.18.0.1", "224.0.0.1", "255.255.255.255", "::1", "fd00:ec2::254", "fec0::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "[::ffff:a9fe:a9fe]", "64:ff9b::a9fe:a9fe",
    "localhost", "localhost.", "x.internal.", "app.localhost",
  ]) {
    assert.equal(isPrivateHost(host), true, `let through ${host}`);
  }
  for (const host of ["8.8.8.8", "::ffff:8.8.8.8", "2606:4700:4700::1111", "example.com"]) {
    assert.equal(isPrivateHost(host), false, `blocked ${host}`);
  }
});

test("validateUrl refuses internal targets and explicit non-http schemes", () => {
  for (const bad of ["http://[::ffff:127.0.0.1]:47811/", "http://2130706433/", "http://localhost./", "ftp://example.com", "file:///etc/passwd"]) {
    assert.equal(validateUrl(bad), null, `accepted ${bad}`);
  }
  assert.equal(validateUrl("example.com/page")?.href, "https://example.com/page");
});

function fakeResolve(addresses) {
  return (_host, _opts, cb) => cb(null, addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
}

async function localServer(routes) {
  const server = http.createServer((req, res) => (routes[req.url] ?? ((_q, r) => r.writeHead(404).end()))(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("safeFetch refuses to connect when a public-looking name resolves to loopback", async () => {
  const srv = await localServer({ "/": (_q, r) => r.end("AWS_SECRET_ACCESS_KEY=…") });
  const toLoopback = fakeResolve(["127.0.0.1"]);
  const guarded = new Agent({ connect: { lookup: createGuardedLookup(toLoopback) } });
  const open = new Agent({ connect: { lookup: toLoopback } });
  try {
    const control = await safeFetch(new URL(`http://site.example.test:${srv.port}/`), { dispatcher: open });
    assert.equal(control.status, 200, "control: the unguarded dispatcher does reach the server");
    await assert.rejects(
      safeFetch(new URL(`http://site.example.test:${srv.port}/`), { dispatcher: guarded }),
      (err) => (err.cause ?? err).code === "ESSRF",
    );
  } finally {
    await Promise.all([guarded.close(), open.close(), srv.close()]);
  }
});

test("safeFetch rejects a redirect into an internal literal and reports loops instead of walking them", async () => {
  const srv = await localServer({
    "/to-internal": (_q, r) => r.writeHead(302, { location: "http://[::ffff:127.0.0.1]/admin" }).end(),
    "/a": (_q, r) => r.writeHead(301, { location: "/b" }).end(),
    "/b": (_q, r) => r.writeHead(301, { location: "/a#again" }).end(),
  });
  const open = new Agent({ connect: { lookup: fakeResolve(["127.0.0.1"]) } });
  const base = `http://site.example.test:${srv.port}`;
  try {
    await assert.rejects(safeFetch(new URL(`${base}/to-internal`), { dispatcher: open }), /private or reserved/);
    const loop = await safeFetch(new URL(`${base}/a`), { dispatcher: open });
    assert.equal(loop.redirectLoop, true);
    assert.equal(loop.redirects.length, 2);
  } finally {
    await Promise.all([open.close(), srv.close()]);
  }
});

// --- robots matching ------------------------------------------------------------

test("robots patterns: prefix, wildcard and end anchor behave per RFC 9309", () => {
  const cases = [
    ["/fish", "/fish.html", true],
    ["/fish", "/Fish", false],
    ["/fish$", "/fish", true],
    ["/fish$", "/fish/", false],
    ["/*.php", "/index.php?x=1", true],
    ["/*.php$", "/index.php?x=1", false],
    ["/a*b*c", "/aXbYc/z", true],
    ["/*", "/", true],
    ["*$", "/anything", true],
  ];
  for (const [pattern, path, expected] of cases) {
    assert.equal(robotsPatternMatches(pattern, path), expected, `${pattern} vs ${path}`);
  }
});

test("a backtracking-bomb robots pattern is decided in milliseconds, not seconds", () => {
  const began = performance.now();
  const matched = robotsPatternMatches("/*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b", "/" + "a".repeat(2000));
  assert.equal(matched, false);
  assert.ok(performance.now() - began < 200, `took ${Math.round(performance.now() - began)} ms`);
});

// --- HTML nesting --------------------------------------------------------------

test("exceedsNestingDepth flags a pathologically deep tree and nothing a real page does", () => {
  assert.equal(exceedsNestingDepth("<div>".repeat(MAX_HTML_DEPTH + 1)), true);
  assert.equal(exceedsNestingDepth("<div>".repeat(MAX_HTML_DEPTH)), false);
  // Omitted end tags, void elements and markup inside scripts or comments do not stack.
  assert.equal(exceedsNestingDepth("<ul>" + "<li><p>item<br><img src=x>".repeat(5000) + "</ul>"), false);
  assert.equal(exceedsNestingDepth(`<script>${"<div>".repeat(5000)}</script><!-- ${"<div>".repeat(5000)} -->`), false);
  assert.equal(exceedsNestingDepth("<section><div></div></section>".repeat(10000)), false);
});

// --- sitemaps --------------------------------------------------------------------

const SITEMAP = '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/</loc></url></urlset>';

test("a gzipped sitemap is decompressed from its raw bytes", () => {
  const gz = gzipSync(SITEMAP);
  const res = { rawBody: new Uint8Array(gz), body: new TextDecoder().decode(gz) };
  assert.equal(sitemapText(res, "https://example.com/sitemap.xml.gz").xml, SITEMAP);
  // Control: a plain sitemap passes through untouched.
  assert.equal(sitemapText({ rawBody: new TextEncoder().encode(SITEMAP), body: SITEMAP }, "x").xml, SITEMAP);
});

test("a gzip bomb stops at the read cap instead of expanding in memory", () => {
  const bomb = gzipSync(Buffer.alloc(SITEMAP_READ_BYTES + 1024, 0x20));
  const out = sitemapText({ rawBody: new Uint8Array(bomb), body: "" }, "https://example.com/bomb.xml.gz");
  assert.equal(out.decompressedTooLarge, true);
  assert.equal(out.xml, "");
});

// --- structured result caps --------------------------------------------------------

test("capLists cuts oversized lists at any depth and says so in the findings", () => {
  const data = { warnings: Array.from({ length: 1000 }, (_, i) => `w${i}`), nested: { entries: Array(500).fill({ a: 1 }) }, small: [1, 2], findings: [] };
  const capped = capLists(data);
  assert.equal(capped.warnings.length, MAX_STRUCTURED_ITEMS);
  assert.equal(capped.nested.entries.length, MAX_STRUCTURED_ITEMS);
  assert.deepEqual(capped.small, [1, 2]);
  assert.equal(capped.findings.length, 1);
  assert.match(capped.findings[0].message, /2 list\(s\)/);
  assert.equal(data.warnings.length, 1000, "the input is not mutated");
  assert.equal(capLists({ small: [1], findings: [] }).findings.length, 0);
});

// --- HTTP transport defaults ----------------------------------------------------

async function freePort() {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startHttpServer(env) {
  const port = await freePort();
  const base = { ...process.env };
  for (const key of ["HOST", "ALLOWED_HOSTS", "ALLOWED_ORIGINS", "MCP_AUTH_TOKEN"]) delete base[key];
  const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url))], {
    env: { ...base, TRANSPORT: "http", PORT: String(port), ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  child.stderr.on("data", (c) => (log += c));
  for (let i = 0; i < 100 && !/running on http/.test(log); i++) await new Promise((r) => setTimeout(r, 50));
  return { port, log: () => log, stop: () => new Promise((r) => (child.once("exit", r), child.kill("SIGTERM"))) };
}

function post(port, headers = {}, body = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("HTTP transport binds to loopback and rejects a foreign Host or Origin by default", async () => {
  const srv = await startHttpServer({});
  try {
    assert.match(srv.log(), /http:\/\/127\.0\.0\.1:/);
    assert.equal((await post(srv.port)).status, 200);
    assert.equal((await post(srv.port, { host: "attacker.rbndr.example" })).status, 403);
    assert.equal((await post(srv.port, { origin: "http://attacker.example" })).status, 403);
  } finally {
    await srv.stop();
  }
});

test("HTTP transport enforces MCP_AUTH_TOKEN and answers parse errors in JSON-RPC", async () => {
  const srv = await startHttpServer({ MCP_AUTH_TOKEN: "s3cret-token" });
  try {
    assert.equal((await post(srv.port)).status, 401);
    assert.equal((await post(srv.port, { authorization: "Bearer s3cret-token" })).status, 200);
    const broken = await post(srv.port, { authorization: "Bearer s3cret-token" }, "{not json");
    assert.equal(broken.status, 400);
    assert.equal(JSON.parse(broken.body).error.code, -32700);
  } finally {
    await srv.stop();
  }
});

test("HTTP transport on a public bind warns when it has no Host allowlist or token", async () => {
  const srv = await startHttpServer({ HOST: "0.0.0.0" });
  try {
    assert.match(srv.log(), /without ALLOWED_HOSTS/);
    assert.match(srv.log(), /without MCP_AUTH_TOKEN/);
  } finally {
    await srv.stop();
  }
});
