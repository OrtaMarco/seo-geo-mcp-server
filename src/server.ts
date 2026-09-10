/**
 * Builds the MCP server instance and registers every tool.
 *
 * This is a **factory**, not a singleton: both v2 entry points (`serveStdio`
 * and `createMcpHandler`) take a factory and call it once per connection
 * (stdio) or once per request (HTTP), which is what lets one code path serve
 * both the 2026-07-28 revision and 2025-era clients.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { registerAuditTools } from "./tools/audit.js";
import { registerOnPageTools } from "./tools/onpage.js";
import { registerTechnicalTools } from "./tools/technical.js";
import { registerGeoTools } from "./tools/geo.js";

const INSTRUCTIONS = `SEO and GEO (Generative Engine Optimization) auditing toolkit. Every tool is read-only and works over public HTTP, DNS and robots.txt — no API keys, no side effects.

Guidance:
- For "how is this page doing?" start with \`seo_audit\` (one fetch, seven weighted sections, prioritised fixes). Pass include_geo=true to add AI answer-engine readiness in the same call.
- For "will ChatGPT/Claude/Perplexity cite this?" use \`geo_audit\`, or the narrower \`ai_crawler_access\` and \`render_check\`.
- Drill into detail with \`meta_tags_check\`, \`social_preview_check\`, \`heading_structure\`, \`structured_data_check\`, \`content_analysis\` and \`image_seo_check\`.
- Site-level technical checks: \`robots_txt_check\`, \`sitemap_check\`, \`canonical_host_check\`, \`redirect_trace\`, \`link_audit\`, \`hreflang_check\`.

Two distinctions worth carrying into your answers:
- Blocking a *training* crawler (GPTBot, ClaudeBot, CCBot) is different from blocking a *citation* crawler (OAI-SearchBot, Claude-SearchBot, PerplexityBot). People usually intend the former; blocking the latter makes them invisible in AI answers. \`ai_crawler_access\` separates the two.
- Most AI crawlers do not execute JavaScript. A page can rank in Google and still be unreadable to every AI assistant — \`render_check\` is what detects this.

Report honestly: llms.txt is a community proposal with no committed vendor support (Google has said it does not use it), and several user-initiated fetchers are documented as ignoring robots.txt, so a "blocked" verdict for those is advisory. The tools surface both caveats — carry them through rather than overstating.

All tools accept response_format='json' for structured output instead of the default markdown.`;

/**
 * Create a fully-registered server instance.
 *
 * Tool registration order is deliberate and stable: `tools/list` returns them
 * in this order on every connection, so a client that caches the list (see the
 * `cacheHints` below) never sees it shuffle.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: { tools: {} },
      instructions: INSTRUCTIONS,
      // The tool list is a compile-time constant here — no dynamic
      // registration, no feature flags — so on the 2026-07-28 revision we can
      // advertise a real TTL instead of the SDK's conservative `ttlMs: 0`.
      // `public` is safe because the advertisement carries nothing
      // user-specific. 2025-era responses never carry these fields.
      cacheHints: {
        "tools/list": { ttlMs: 3_600_000, cacheScope: "public" },
        "server/discover": { ttlMs: 3_600_000, cacheScope: "public" },
      },
    },
  );

  registerAuditTools(server); // flagship composite audits
  registerGeoTools(server); // AI crawlers / llms.txt / rendering
  registerOnPageTools(server); // meta / social / headings / schema / content / images
  registerTechnicalTools(server); // robots / sitemap / links / hreflang / redirects

  return server;
}
