# Evaluations

`evaluation.xml` holds 10 question/answer pairs that test whether an LLM, given
**only** this MCP server's tools (no other context), can answer realistic SEO and
GEO questions. They follow the MCP evaluation format: read-only, independent,
verifiable by direct string comparison, and **stable** (answers don't drift).

## Why these answers are stable

Live websites change constantly — a question like "what score does example.com
get?" would be worthless within a month. So these questions target the parts of
the server's output that are **structural** rather than site-dependent: the AI
crawler registry (token names, vendors, purposes, compliance and provenance
flags), the GEO scoring weights, and the documented adoption status of `llms.txt`.

The one site-dependent question (#10) counts registry entries rather than
measuring the site, so its answer changes only when this repo adds a crawler
token — not when the site changes.

Each answer was verified by calling the server's tools directly before being
recorded here.

| # | Tool exercised | Answer |
|---|---|---|
| 1 | `ai_crawler_access` (purpose field) | Claude-SearchBot |
| 2 | `ai_crawler_access` (opt-out control token) | Google-Extended |
| 3 | `ai_crawler_access` (`include_deprecated=true`) | Anthropic |
| 4 | `ai_crawler_access` (`respects_robots_txt`) | Perplexity-User |
| 5 | `ai_crawler_access` (Meta preview token) | facebookexternalhit |
| 6 | `ai_crawler_access` (OpenAI ads token) | OAI-AdsBot |
| 7 | `ai_crawler_access` (`undocumented_vendors`) | xAI |
| 8 | `llms_txt_check` (`adoption_status`) | Google |
| 9 | `geo_audit` (signal weights) | 25 |
| 10 | `ai_crawler_access` (allowed + blocked) | 35 |

**Maintenance note:** questions 9 and 10 encode current implementation values.
If you change the GEO signal weights or add crawler tokens to
`src/core/ai-crawlers.ts`, update those answers.

## Deterministic checks (no API key)

Two gates run without any LLM:

```bash
npm test    # 32 unit tests: RFC 9309 matcher, SPA detection, JSON-LD, hreflang
npm run smoke   # calls all 17 tools over stdio, asserting each returns
                # structuredContent that validates against its outputSchema
```

## Full LLM evaluation (needs an Anthropic API key)

Use the evaluation harness from the `mcp-builder` skill
(`reference/scripts/evaluation.py`). It launches this server over stdio, lets a
Claude agent answer each question using only the tools, and scores the answers:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# from the mcp-builder skill's scripts/ directory:
python evaluation.py \
  -t stdio \
  -c node \
  -a /absolute/path/to/seo-geo-mcp-server/dist/index.js \
  -o report.md \
  /absolute/path/to/seo-geo-mcp-server/evals/evaluation.xml
```

The report shows per-question pass/fail, tool-call counts, and the agent's
feedback on the tools — useful for spotting unclear descriptions or schemas.

Build first: `npm run build`.
