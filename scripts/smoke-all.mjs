/**
 * Smoke test: start the built server over stdio, call EVERY registered tool
 * through the real MCP protocol, and validate each answer's
 * `structuredContent` against that tool's own Zod output schema.
 *
 * It runs the whole battery **twice**, once per protocol era, because this
 * server is built on the v2 SDK and serves both from one factory:
 *
 *   1. `versionNegotiation: { mode: 'auto' }` → the 2026-07-28 revision
 *      (`getProtocolEra() === 'modern'`).
 *   2. no options at all → the 2025 `initialize` handshake (`'legacy'`),
 *      which is what Claude Desktop, Claude Code and Cursor speak today.
 *
 * A regression that only shows up on one era (a schema the modern codec
 * rejects, a tool that leans on session state) fails here rather than in
 * somebody's client.
 *
 *   npm run smoke                 # default targets
 *   npm run smoke -- example.com  # override the site under test
 *
 * Every call in this file leaves the machine: the tools are live HTTP/DNS
 * probes, so the run needs network access and the site under test to be up.
 */

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  AiCrawlerSchema,
  CanonicalHostSchema,
  ContentSchema,
  GeoAuditSchema,
  HeadingSchema,
  HreflangSchema,
  ImageSchema,
  LinkSchema,
  LlmsTxtSchema,
  MetaTagsSchema,
  RedirectSchema,
  RenderingSchema,
  RobotsSchema,
  SeoAuditSchema,
  SitemapSchema,
  SocialSchema,
  StructuredDataSchema,
} from "../dist/schemas.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = process.argv[2] ?? "ortamarco.me";
const PAGE = process.argv[3] ?? `https://${SITE}/`;

/**
 * One entry per call: the tool, its arguments, the schema its
 * `structuredContent` must satisfy, and a one-line signal to print.
 */
const CALLS = [
  {
    tool: "seo_audit",
    args: { url: PAGE, include_geo: true },
    schema: SeoAuditSchema,
    signal: (s) => `score ${s.score} (${s.grade}) · geo ${s.geo?.score ?? "—"}`,
  },
  {
    tool: "geo_audit",
    args: { url: PAGE },
    schema: GeoAuditSchema,
    signal: (s) => `geo ${s.geo.score} (${s.geo.grade}) · ssr=${s.rendering.renders_without_js}`,
  },
  {
    tool: "ai_crawler_access",
    args: { site: SITE },
    schema: AiCrawlerSchema,
    signal: (s) => `${s.allowed_count} allowed / ${s.blocked_count} blocked`,
  },
  {
    tool: "llms_txt_check",
    args: { site: SITE },
    schema: LlmsTxtSchema,
    signal: (s) => `found=${s.found}`,
  },
  {
    tool: "render_check",
    args: { url: PAGE },
    schema: RenderingSchema,
    signal: (s) => `ssr=${s.renders_without_js} · ${s.server_text_words} words`,
  },
  {
    tool: "meta_tags_check",
    args: { url: PAGE },
    schema: MetaTagsSchema,
    signal: (s) => `score ${s.score} · indexable=${s.indexable}`,
  },
  {
    tool: "social_preview_check",
    args: { url: PAGE },
    schema: SocialSchema,
    signal: (s) => `score ${s.score} · og_image=${s.og_image_reachable}`,
  },
  {
    tool: "heading_structure",
    args: { url: PAGE },
    schema: HeadingSchema,
    signal: (s) => `score ${s.score} · ${s.headings.length} heading(s), h1=${s.h1_count}`,
  },
  {
    tool: "structured_data_check",
    args: { url: PAGE },
    schema: StructuredDataSchema,
    signal: (s) => `score ${s.score} · ${s.json_ld_blocks} JSON-LD block(s)`,
  },
  {
    tool: "content_analysis",
    args: { url: PAGE },
    schema: ContentSchema,
    signal: (s) => `score ${s.score} · ${s.word_count} words`,
  },
  {
    tool: "image_seo_check",
    args: { url: PAGE },
    schema: ImageSchema,
    signal: (s) => `score ${s.score} · ${s.total_images} image(s), ${s.missing_alt} without alt`,
  },
  {
    tool: "robots_txt_check",
    args: { site: SITE },
    schema: RobotsSchema,
    signal: (s) => `found=${s.found} · ${s.group_count} group(s), ${s.sitemaps.length} sitemap(s)`,
  },
  {
    tool: "sitemap_check",
    args: { site: SITE },
    schema: SitemapSchema,
    signal: (s) => `found=${s.found} · ${s.url_count} URL(s)`,
  },
  {
    tool: "link_audit",
    args: { url: PAGE, check_broken: true, sample_size: 5 },
    schema: LinkSchema,
    signal: (s) => `score ${s.score} · ${s.total_links} link(s), ${s.broken.length} broken`,
  },
  {
    tool: "hreflang_check",
    args: { url: PAGE, check_reciprocity: true },
    schema: HreflangSchema,
    signal: (s) => `${s.entries.length} entry(ies) · x-default=${s.has_x_default}`,
  },
  {
    tool: "redirect_trace",
    args: { url: `http://${SITE}/` },
    schema: RedirectSchema,
    signal: (s) => `${s.hop_count} hop(s) → HTTP ${s.final_status}`,
  },
  {
    tool: "canonical_host_check",
    args: { site: SITE },
    schema: CanonicalHostSchema,
    signal: (s) => `score ${s.score} · converges=${s.converges}`,
  },
];

async function connect(options) {
  const client = new Client({ name: "seo-geo-smoke", version: "1.0.0" }, options);
  await client.connect(
    new StdioClientTransport({ command: "node", args: [join(ROOT, "dist", "index.js")], stderr: "ignore" }),
  );
  return client;
}

async function runEra(name, options) {
  console.log(`\n── ${name} era ${"─".repeat(Math.max(0, 44 - name.length))}`);
  const client = await connect(options);
  const era = client.getProtocolEra() ?? "(unreported)";
  console.log(`  negotiated era: ${era}`);

  const { tools } = await client.listTools();
  const registered = new Set(tools.map((t) => t.name));
  const planned = new Set(CALLS.map((c) => c.tool));
  console.log(`  registered tools: ${tools.length}`);

  let failed = 0;
  for (const name of registered) {
    if (!planned.has(name)) {
      console.log(`  ⚠️  ${name} is registered but not covered by this smoke test`);
      failed++;
    }
  }
  for (const name of planned) {
    if (!registered.has(name)) {
      console.log(`  ⚠️  ${name} is in the smoke test but NOT registered`);
      failed++;
    }
  }

  // Every tool must declare an outputSchema and be flagged read-only.
  for (const tool of tools) {
    if (!tool.outputSchema) {
      console.log(`  ❌ ${tool.name} declares no outputSchema`);
      failed++;
    }
    if (tool.annotations?.readOnlyHint !== true) {
      console.log(`  ❌ ${tool.name} is not annotated readOnlyHint: true`);
      failed++;
    }
  }

  let passed = 0;
  for (const call of CALLS) {
    const label = call.label ?? call.tool;
    const began = Date.now();
    try {
      const result = await client.callTool({ name: call.tool, arguments: call.args });
      const ms = Date.now() - began;

      if (result.isError) {
        console.log(`  ❌ ${label.padEnd(22)} ${String(ms).padStart(5)}ms  error: ${(result.content?.[0]?.text ?? "").slice(0, 120)}`);
        failed++;
        continue;
      }
      if (!result.structuredContent) {
        console.log(`  ❌ ${label.padEnd(22)} ${String(ms).padStart(5)}ms  no structuredContent returned`);
        failed++;
        continue;
      }

      const parsed = call.schema.safeParse(result.structuredContent);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        console.log(
          `  ❌ ${label.padEnd(22)} ${String(ms).padStart(5)}ms  schema mismatch at ${issue.path.join(".") || "(root)"}: ${issue.message}`,
        );
        failed++;
        continue;
      }

      const complaint = call.expect?.(parsed.data);
      if (complaint) {
        console.log(`  ❌ ${label.padEnd(22)} ${String(ms).padStart(5)}ms  ${complaint}`);
        failed++;
        continue;
      }

      console.log(`  ✅ ${label.padEnd(22)} ${String(ms).padStart(5)}ms  ${call.signal(parsed.data)}`);
      passed++;
    } catch (err) {
      const ms = Date.now() - began;
      console.log(`  ❌ ${label.padEnd(22)} ${String(ms).padStart(5)}ms  threw: ${String(err.message).slice(0, 160)}`);
      failed++;
    }
  }

  await client.close();
  console.log(`  ${passed} passed, ${failed} failed (of ${CALLS.length} calls)`);
  return { passed, failed, era };
}

console.log(`Site under test: ${SITE} · page: ${PAGE}`);

const modern = await runEra("modern (2026-07-28)", { versionNegotiation: { mode: "auto" } });
const legacy = await runEra("legacy (2025 initialize)", undefined);

let failures = modern.failed + legacy.failed;
if (modern.era !== "modern") {
  console.log(`\n❌ auto negotiation landed on '${modern.era}', expected 'modern'`);
  failures++;
}
if (legacy.era !== "legacy") {
  console.log(`\n❌ the default client landed on '${legacy.era}', expected 'legacy'`);
  failures++;
}

console.log(
  `\n${modern.passed + legacy.passed} passed, ${failures} failed across both eras (${CALLS.length} calls each).`,
);
process.exit(failures > 0 ? 1 : 0);
