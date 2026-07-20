/**
 * Smoke test: start the built server over stdio, call every registered tool
 * against real sites, and verify each one returns without error AND emits
 * `structuredContent` (which the SDK validates against the tool's outputSchema —
 * a mismatch surfaces here as an error rather than silently in a client).
 *
 *   npm run smoke                 # default targets
 *   npm run smoke -- example.com  # override the site under test
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SITE = process.argv[2] ?? "ortamarco.me";
const PAGE = process.argv[3] ?? `https://${SITE}/`;

/** Arguments per tool. Anything not listed is called with its defaults. */
const CALLS = [
  ["seo_audit", { url: PAGE, include_geo: true }],
  ["geo_audit", { url: PAGE }],
  ["ai_crawler_access", { site: SITE }],
  ["llms_txt_check", { site: SITE }],
  ["render_check", { url: PAGE }],
  ["meta_tags_check", { url: PAGE }],
  ["social_preview_check", { url: PAGE }],
  ["heading_structure", { url: PAGE }],
  ["structured_data_check", { url: PAGE }],
  ["content_analysis", { url: PAGE }],
  ["image_seo_check", { url: PAGE }],
  ["robots_txt_check", { site: SITE }],
  ["sitemap_check", { site: SITE }],
  ["link_audit", { url: PAGE, check_broken: true, sample_size: 5 }],
  ["hreflang_check", { url: PAGE, check_reciprocity: true }],
  ["redirect_trace", { url: `http://${SITE}/` }],
  ["canonical_host_check", { site: SITE }],
];

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
});
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
const registered = new Set(tools.map((t) => t.name));
console.log(`Registered tools: ${tools.length}`);

const planned = new Set(CALLS.map(([name]) => name));
for (const name of registered) {
  if (!planned.has(name)) console.log(`  ⚠️  ${name} is registered but not covered by this smoke test`);
}
for (const name of planned) {
  if (!registered.has(name)) console.log(`  ⚠️  ${name} is in the smoke test but NOT registered`);
}

let passed = 0;
let failed = 0;

for (const [name, args] of CALLS) {
  const began = Date.now();
  try {
    const result = await client.callTool({ name, arguments: args });
    const ms = Date.now() - began;

    if (result.isError) {
      const text = result.content?.[0]?.text ?? "(no message)";
      console.log(`  ❌ ${name.padEnd(24)} ${String(ms).padStart(5)}ms  error: ${text.slice(0, 120)}`);
      failed++;
      continue;
    }
    if (!result.structuredContent) {
      console.log(`  ❌ ${name.padEnd(24)} ${String(ms).padStart(5)}ms  no structuredContent returned`);
      failed++;
      continue;
    }

    // A quick sanity signal per tool, where one exists.
    const s = result.structuredContent;
    const hint =
      s.score !== undefined
        ? `score ${s.score}`
        : s.geo?.score !== undefined
          ? `geo ${s.geo.score}`
          : s.allowed_count !== undefined
            ? `${s.allowed_count} allowed / ${s.blocked_count} blocked`
            : s.found !== undefined
              ? `found=${s.found}`
              : s.renders_without_js !== undefined
                ? `ssr=${s.renders_without_js}`
                : s.hop_count !== undefined
                  ? `${s.hop_count} hop(s)`
                  : "ok";

    console.log(`  ✅ ${name.padEnd(24)} ${String(ms).padStart(5)}ms  ${hint}`);
    passed++;
  } catch (err) {
    const ms = Date.now() - began;
    console.log(`  ❌ ${name.padEnd(24)} ${String(ms).padStart(5)}ms  threw: ${err.message.slice(0, 160)}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed (of ${CALLS.length})`);
await client.close();
process.exit(failed > 0 ? 1 : 0);
