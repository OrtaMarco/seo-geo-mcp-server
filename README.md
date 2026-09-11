# seo-geo-mcp-server

> An [MCP](https://modelcontextprotocol.io) server that lets an AI agent audit a page for **SEO** *and* **GEO** (Generative Engine Optimization) — on-page tags, structured data, robots.txt, sitemaps, hreflang, and whether ChatGPT, Claude, Perplexity and Gemini can actually crawl and cite you. **No API keys required.**

[![ci](https://github.com/OrtaMarco/seo-geo-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/OrtaMarco/seo-geo-mcp-server/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/seo-geo-mcp-server)](https://www.npmjs.com/package/seo-geo-mcp-server)
[![MCP](https://img.shields.io/badge/MCP-server-blue)](https://modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

Built on the **v2 MCP SDK**: the server speaks the **2026-07-28** protocol revision
and still accepts 2025-era clients (Claude Desktop, Claude Code, Cursor) from the
same factory — one build, both eras, nothing to configure.

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
and shares its core (the connect-time SSRF guard and host validation)
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
| `structured_data_check` | JSON-LD/microdata/RDFa extraction, parse errors, and Google rich-result requirements for 21 schema types |
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

Requires **Node.js 20.18+**. Nothing to clone — every MCP client can run it with `npx`.

## Use it with Claude Code

```bash
claude mcp add seo-geo -- npx -y seo-geo-mcp-server
```

## Use it with Claude Desktop or Cursor

Add to `claude_desktop_config.json` (or `~/.cursor/mcp.json`) — see [`examples/`](./examples/claude_desktop_config.json):

```json
{
  "mcpServers": {
    "seo-geo": {
      "command": "npx",
      "args": ["-y", "seo-geo-mcp-server"]
    }
  }
}
```

On Windows use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "seo-geo-mcp-server"]`.
Restart the client, then ask: *"Audit the SEO and GEO of example.com."*

## Self-host (HTTP transport)

The same server speaks stateless **Streamable HTTP** for remote or multi-client
use. One endpoint serves both protocol eras; there is no session state and no
`Mcp-Session-Id` to carry.

```bash
TRANSPORT=http npx -y seo-geo-mcp-server
# POST JSON-RPC to http://127.0.0.1:3000/mcp   ·   health at /healthz
```

It is **safe by default**: it binds to `127.0.0.1` and only accepts `localhost`
`Host` and `Origin` headers, which blocks DNS-rebinding attacks from a web page.
To expose it — for example behind Coolify or Traefik — opt in explicitly:

| Variable | Default | Purpose |
|---|---|---|
| `TRANSPORT` | `stdio` | `http` to serve Streamable HTTP |
| `PORT` | `3000` | Listening port |
| `HOST` | `127.0.0.1` | Bind address; `0.0.0.0` to accept remote connections |
| `ALLOWED_HOSTS` | — | Comma-separated hostnames the `Host` header may carry (e.g. `mcp.example.com`) |
| `ALLOWED_ORIGINS` | — | Comma-separated origins allowed to call from a browser |
| `MCP_AUTH_TOKEN` | — | If set, every request needs `Authorization: Bearer <token>` |

Binding to a non-loopback address without `ALLOWED_HOSTS` or `MCP_AUTH_TOKEN`
works, but the server says so on stderr. With Docker (the image sets `HOST=0.0.0.0`):

```bash
docker build -t seo-geo-mcp .
docker run -p 3000:3000 -e ALLOWED_HOSTS=mcp.example.com -e MCP_AUTH_TOKEN=change-me seo-geo-mcp
```

## Develop

```bash
npm run dev      # tsx watch (stdio)
npm test         # deterministic unit tests: SSRF guard, robots matcher, nesting guard,
                 # gzip sitemaps, SPA detection, JSON-LD, HTTP transport defaults
npm run smoke    # call all 17 tools over MCP, in BOTH protocol eras, and validate
                 # structuredContent vs outputSchema
npm run inspect  # open the MCP Inspector against the built server
npm run build    # type-check + emit dist/
```

[`evals/`](./evals/) holds a 10-question LLM evaluation set (stable, verifiable)
and instructions for running it — see [`evals/README.md`](./evals/README.md).

## How it works

```
src/
├── index.ts        # transport selection: serveStdio | createMcpHandler + Express
├── server.ts       # the factory: registers every tool on one McpServer
├── schemas.ts      # Zod 4 outputSchema for each tool
├── core/           # pure logic, no MCP coupling — reusable & testable
│   ├── validate.ts     # host/URL validation and the address classifier
│   ├── netguard.ts     # connect-time SSRF guard (every socket's address is checked)
│   ├── fetch.ts        # fetch: guarded dispatcher, manual redirects, loop detection, byte caps
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

## Security

The tools fetch URLs the caller names *and* URLs the audited site names (links,
`og:image`, hreflang alternates, sitemap children, redirects), so every outbound
connection is screened against server-side request forgery:

- Private, loopback, link-local (cloud metadata), shared (CGNAT), multicast and
  reserved addresses are refused in every spelling, including IPv4 embedded in
  IPv6 (`[::ffff:127.0.0.1]`).
- The check runs **at connect time**, on the address the socket is about to use,
  so DNS rebinding and names only an internal resolver knows are refused too.
  Redirects are followed by hand, every hop is screened, and loops are reported.
- Untrusted input is bounded: 2 MB of HTML, 512 levels of nesting (what browsers
  keep), a backtracking-free robots.txt matcher, 10 MiB per sitemap (gzip output
  included), six link checks at a time, and at most 200 items per list in a result.

Found a problem? Please open a [private security advisory](https://github.com/OrtaMarco/seo-geo-mcp-server/security/advisories/new).

## License

MIT © [Marco Orta](https://ortamarco.me)
