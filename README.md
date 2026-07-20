# seo-geo-mcp-server

> An [MCP](https://modelcontextprotocol.io) server that lets an AI agent audit a page for **SEO** *and* **GEO** (Generative Engine Optimization) — on-page tags, structured data, robots.txt, sitemaps, hreflang, and whether ChatGPT, Claude, Perplexity and Gemini can actually crawl and cite you. **No API keys required.**

[![MCP](https://img.shields.io/badge/MCP-server-blue)](https://modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

Ask Claude *"how is this page doing, and will AI assistants cite it?"* and it runs a
full audit and hands you a graded report with prioritised fixes — instead of you
pasting a URL into six different web tools.

```
> Audit https://example.com/guide and tell me if ChatGPT can cite it

  seo_audit(url="https://example.com/guide", include_geo=true)

  Overall: A (92/100) · indexable: yes
    Meta tags & social preview   95 (A)
    Heading structure           100 (A)
    Structured data              75 (C)

  GEO readiness: B (85/100)
    ✅ AI crawler access        25/25
    ✅ Server-rendered content  20/20
    ❌ Authorship & entity       2/10
  1. Add author and Organization markup with `sameAs` links to official profiles.
```

---

## Why this exists

Two gaps, one server.

**The SEO gap:** the on-page checkers are all web UIs. None of them let an agent
run the audit, read the result and fix the code in the same loop.

**The GEO gap:** "generative engine optimization" tooling is mostly rank-tracking
dashboards behind a subscription. The mechanics that actually decide whether an
AI assistant can cite you are cheap to check and almost never checked:

- **Can the AI search crawlers reach you?** Blocking `GPTBot` stops *training*.
  Blocking `OAI-SearchBot` stops you being *cited*. Most sites that meant to do
  the first have accidentally done the second. This server separates them.
- **Does your content exist without JavaScript?** Googlebot renders JS. `GPTBot`,
  `ClaudeBot`, `PerplexityBot` and `CCBot` largely do not. A client-rendered page
  can rank fine in Google and be invisible to every AI assistant.

It is the agent-facing companion to the tools at [ortamarco.me](https://ortamarco.me),
and shares its core (SSRF-guarded fetching, public-resolver DNS, host validation)
with [`domain-security-mcp-server`](https://github.com/OrtaMarco/domain-security-mcp-server).

## Tools

### Audits

| Tool | What it does |
|---|---|
| **`seo_audit`** ⭐ | One fetch → seven weighted sections (meta, headings, content, schema, images, links, crawlability) → 0–100 score, A–F grade, prioritised fixes. `include_geo=true` adds the GEO dimension |
| **`geo_audit`** ⭐ | AI answer-engine readiness: crawler access (25), server-rendered content (20), structured data (15), extractable structure (15), authorship (10), freshness (8), depth (7) |

### GEO

| Tool | What it does |
|---|---|
| `ai_crawler_access` | Resolves ~35 AI crawler tokens against robots.txt. Separates training from citation bots, flags blocks that vendors document as unenforceable, handles the Applebot→Googlebot fallback |
| `render_check` | Whether content survives without JavaScript — detects unhydrated SPA shells that AI crawlers cannot read |
| `llms_txt_check` | Detects and validates `/llms.txt` against the llmstxt.org proposal — and reports its real adoption status rather than implying it earns visibility |

### On-page

| Tool | What it does |
|---|---|
| `meta_tags_check` | Title, description, canonical, robots (meta **and** `X-Robots-Tag`), lang, charset, viewport |
| `social_preview_check` | Open Graph + Twitter Card, and verifies the `og:image` actually loads |
| `heading_structure` | Full h1–h6 outline, multiple h1s, skipped levels, question-shaped headings |
| `structured_data_check` | JSON-LD/microdata/RDFa extraction, parse errors, and Google rich-result requirements for 17 schema types |
| `content_analysis` | Word count, Flesch reading ease, thin-content detection, text-to-HTML ratio, term density (EN + ES stopwords) |
| `image_seo_check` | Missing alt text, missing dimensions (layout shift), lazy loading, WebP/AVIF adoption |

### Technical

| Tool | What it does |
|---|---|
| `robots_txt_check` | RFC 9309 parse; flags wildcard `Disallow: /` and 5xx responses (which Google reads as disallow-all) |
| `sitemap_check` | Discovery via robots.txt → conventional paths; index following, gzip, 50k/50MiB limits, `lastmod` validity |
| `canonical_host_check` | All four http/https × apex/www variants — do they converge on one canonical URL, and via 301 or 302? |
| `redirect_trace` | Hop-by-hop chain with loop and temporary-redirect detection |
| `link_audit` | Internal/external split, rel attributes, generic anchor text, optional broken-link sampling |
| `hreflang_check` | BCP-47 validity, self-reference, x-default, duplicates — plus optional **reciprocity** verification |

Every tool is **read-only**, declares an `outputSchema` and returns
`structuredContent` (validated by the SDK) alongside human-readable Markdown
(default) or JSON (`response_format="json"`), plus actionable error messages.

## Honesty notes

This server deliberately refuses to overstate two things that most GEO content
gets wrong. Both are surfaced in tool output, not buried here:

- **`llms.txt` is not an adopted standard.** It is a community proposal from
  September 2024. No major AI vendor has documented that its crawlers read it
  from third-party sites, and Google has publicly said it does not. The tool
  reports presence and validates shape — and `geo_audit` deliberately does **not**
  score it. (`llms-full.txt` is a docs-tooling convention, not part of the proposal.)
- **Some robots.txt blocks are advisory.** `Perplexity-User`, `ChatGPT-User` and
  `meta-externalfetcher` are documented *by their own vendors* as ignoring or
  possibly ignoring robots.txt. Reporting those as cleanly "blocked" would be
  misleading, so they are listed separately as unenforceable.

Crawler tokens carry a `provenance` field distinguishing first-party vendor
documentation from community aggregators, and vendors that publish no token at
all (xAI/Grok, Microsoft Copilot) are named explicitly — because a missing rule
cannot be read as either allowed or blocked.

## Install

```bash
git clone https://github.com/OrtaMarco/seo-geo-mcp-server.git
cd seo-geo-mcp-server
npm install
npm run build
```

## Use it with Claude Code

```bash
claude mcp add seo-geo -- node /absolute/path/to/seo-geo-mcp-server/dist/index.js
```

## Use it with Claude Desktop

Add to `claude_desktop_config.json` (see [`examples/`](./examples/claude_desktop_config.json)):

```json
{
  "mcpServers": {
    "seo-geo": {
      "command": "node",
      "args": ["/absolute/path/to/seo-geo-mcp-server/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop, then ask: *"Audit the SEO and GEO of example.com."*

## Self-host (HTTP transport)

The same server speaks stateless **Streamable HTTP** for remote/multi-client use
— handy behind a reverse proxy such as Coolify or Traefik.

```bash
TRANSPORT=http PORT=3000 npm start
# POST JSON-RPC to http://localhost:3000/mcp   ·   health at /healthz
```

Or with Docker:

```bash
docker build -t seo-geo-mcp .
docker run -p 3000:3000 -e TRANSPORT=http seo-geo-mcp
```

Set `ALLOWED_ORIGINS=https://your.app` to enable Origin-based DNS-rebinding
protection (leave empty when a trusted proxy already restricts access).

## Develop

```bash
npm run dev      # tsx watch (stdio)
npm test         # 32 deterministic unit tests (robots matcher, SPA detection, JSON-LD…)
npm run smoke    # call all 17 tools over MCP and validate structuredContent vs outputSchema
npm run inspect  # open the MCP Inspector against the built server
npm run build    # type-check + emit dist/
```

[`evals/`](./evals/) holds a 10-question LLM evaluation set (stable, verifiable)
and instructions for running it — see [`evals/README.md`](./evals/README.md).

## How it works

```
src/
├── index.ts        # transport selection (stdio | http)
├── server.ts       # registers every tool on one McpServer
├── schemas.ts      # Zod outputSchema for each tool
├── core/           # pure logic, no MCP coupling — reusable & testable
│   ├── fetch.ts        # SSRF-safe fetch: per-hop guard, byte caps, manual redirects
│   ├── page.ts         # HTML loading + the shared parsed-document model
│   ├── meta.ts         # title/description/canonical/robots, Open Graph, hreflang
│   ├── content.ts      # headings, readability, word counts, image SEO
│   ├── structured-data.ts # JSON-LD/microdata + Google rich-result requirements
│   ├── robots.ts       # RFC 9309 parser and rule matcher
│   ├── ai-crawlers.ts  # the AI crawler registry (token, purpose, compliance, provenance)
│   ├── sitemap.ts      # discovery, index following, gzip, protocol limits
│   ├── links.ts        # link classification + broken-link sampling
│   ├── redirects.ts    # chain tracing + host canonicalisation
│   ├── geo.ts          # llms.txt, JS-rendering detection, GEO scoring
│   └── seo-audit.ts    # the composite audits (one fetch, every analyser)
└── tools/          # thin MCP wrappers (Zod schemas, descriptions, formatting)
```

The `core/` layer is deliberately free of any MCP types, so the same logic can
power both this server and a web UI.

**Security:** every user-supplied URL is validated and re-checked on each
redirect hop against loopback, private, link-local and cloud-metadata ranges, so
the server cannot be used to probe internal networks. Response bodies are read
through a byte cap.

## License

MIT © [Marco Orta](https://ortamarco.me)
