/**
 * Registry of AI/LLM crawler user-agent tokens.
 *
 * Every entry records **where it was verified** and **whether the vendor
 * actually commits to honouring robots.txt**, because both matter for an honest
 * answer. Several user-initiated fetchers (Perplexity-User, meta-externalfetcher,
 * ChatGPT-User) are documented as ignoring or possibly ignoring robots.txt, so
 * reporting them as cleanly "blocked" would mislead the caller.
 *
 * Per RFC 9309 §2.2.1 product tokens are case-insensitive: `token` below stores
 * the vendor's canonical casing for display, and matching lowercases both sides.
 */

export type CrawlerPurpose =
  | "training"
  | "search"
  | "user-fetch"
  | "ads"
  | "opt-out-control"
  | "preview"
  | "scraping";

/**
 * How reliably the vendor honours robots.txt:
 *  - "yes"     — documented as obeying robots.txt.
 *  - "partial" — vendor says rules "may not apply" (typically user-initiated fetches).
 *  - "no"      — vendor documents that it generally ignores robots.txt.
 */
export type RobotsCompliance = "yes" | "partial" | "no";

export interface AiCrawler {
  /** Canonical casing as published by the vendor. Match case-insensitively. */
  token: string;
  vendor: string;
  purpose: CrawlerPurpose;
  description: string;
  respects_robots_txt: RobotsCompliance;
  /** Why compliance is partial/no, when it is. */
  compliance_note?: string;
  /** "official" = first-party vendor docs; "community" = third-party aggregators. */
  provenance: "official" | "community";
  source: string;
  /** Superseded tokens, kept so historical robots.txt files still resolve. */
  deprecated?: boolean;
}

export const AI_CRAWLERS: AiCrawler[] = [
  // --- OpenAI --------------------------------------------------------------
  {
    token: "GPTBot",
    vendor: "OpenAI",
    purpose: "training",
    description: "Crawls to train OpenAI foundation models.",
    respects_robots_txt: "yes",
    provenance: "official",
    source: "https://platform.openai.com/docs/bots",
  },
  {
    token: "OAI-SearchBot",
    vendor: "OpenAI",
    purpose: "search",
    description: "Builds the ChatGPT search index. This — not ChatGPT-User — is the lever for appearing in ChatGPT search.",
    respects_robots_txt: "yes",
    provenance: "official",
    source: "https://platform.openai.com/docs/bots",
  },
  {
    token: "ChatGPT-User",
    vendor: "OpenAI",
    purpose: "user-fetch",
    description: "Fetches a page because a user (or a Custom GPT action) asked for it in real time.",
    respects_robots_txt: "partial",
    compliance_note: "OpenAI states that because the fetch is user-initiated, robots.txt rules may not apply.",
    provenance: "official",
    source: "https://platform.openai.com/docs/bots",
  },
  {
    token: "OAI-AdsBot",
    vendor: "OpenAI",
    purpose: "ads",
    description: "Validates landing pages submitted as ChatGPT ads.",
    respects_robots_txt: "yes",
    provenance: "official",
    source: "https://platform.openai.com/docs/bots",
  },

  // --- Anthropic -----------------------------------------------------------
  {
    token: "ClaudeBot",
    vendor: "Anthropic",
    purpose: "training",
    description: "Crawls to train Claude models.",
    respects_robots_txt: "yes",
    provenance: "official",
    source: "https://support.anthropic.com/en/articles/8896518",
  },
  {
    token: "Claude-User",
    vendor: "Anthropic",
    purpose: "user-fetch",
    description: "Fetches a page on behalf of a Claude user in real time.",
    respects_robots_txt: "yes",
    provenance: "official",
    source: "https://support.anthropic.com/en/articles/8896518",
  },
  {
    token: "Claude-SearchBot",
    vendor: "Anthropic",
    purpose: "search",
    description: "Indexes pages so Claude can surface and cite them in search results.",
    respects_robots_txt: "yes",
    provenance: "official",
    source: "https://support.anthropic.com/en/articles/8896518",
  },
  {
    token: "anthropic-ai",
    vendor: "Anthropic",
    purpose: "training",
    description: "Legacy token. Not listed in Anthropic's current documentation — block it only for historical coverage.",
    respects_robots_txt: "yes",
    provenance: "community",
    source: "https://support.anthropic.com/en/articles/8896518",
    deprecated: true,
  },
  {
    token: "claude-web",
    vendor: "Anthropic",
    purpose: "user-fetch",
    description: "Legacy token. Not listed in Anthropic's current documentation — block it only for historical coverage.",
    respects_robots_txt: "yes",
    provenance: "community",
    source: "https://support.anthropic.com/en/articles/8896518",
    deprecated: true,
  },

  // --- Google --------------------------------------------------------------
  {
    token: "Google-Extended",
    vendor: "Google",
    purpose: "opt-out-control",
    description:
      "Control token for Gemini/Vertex training AND prompt-time grounding. Sends no requests of its own, and does not affect inclusion in Google Search or AI Overviews.",
    respects_robots_txt: "yes",
    provenance: "official",
    source: "https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers",
  },
  {
    token: "Googlebot",
    vendor: "Google",
    purpose: "search",
    description:
      "Google Search's crawler. There is no separate AI Overviews token — Googlebot access is what governs AI Overviews eligibility.",
    respects_robots_txt: "yes",
    provenance: "official",
    source: "https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers",
  },
  {
    token: "Google-CloudVertexBot",
    vendor: "Google",
    purpose: "training",
    description: "Crawls sites at the site owner's request for Vertex AI Agents.",
    respects_robots_txt: "yes",
    provenance: "official",
    source: "https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers",
  },
  {
    token: "GoogleOther",
    vendor: "Google",
    purpose: "scraping",
    description: "Generic Google crawler used for one-off fetches and internal R&D.",
    respects_robots_txt: "yes",
    provenance: "official",
    source: "https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers",
  },

  // --- Perplexity ----------------------------------------------------------
  {
    token: "PerplexityBot",
    vendor: "Perplexity",
    purpose: "search",
    description: "Indexes pages for Perplexity answers and citations. Perplexity states it is not used for training.",
    respects_robots_txt: "yes",
    provenance: "official",
    source: "https://docs.perplexity.ai/docs/resources/perplexity-crawlers",
  },
  {
    token: "Perplexity-User",
    vendor: "Perplexity",
    purpose: "user-fetch",
    description: "Fetches a page because a Perplexity user asked for it.",
    respects_robots_txt: "no",
    compliance_note: "Perplexity documents that Perplexity-User generally ignores robots.txt — a Disallow here is advisory at best.",
    provenance: "official",
    source: "https://docs.perplexity.ai/docs/resources/perplexity-crawlers",
  },

  // --- Apple ---------------------------------------------------------------
  {
    token: "Applebot",
    vendor: "Apple",
    purpose: "search",
    description:
      "Powers Spotlight, Siri and Safari suggestions. Note: if robots.txt has no Applebot group but does have a Googlebot group, Applebot follows the Googlebot rules.",
    respects_robots_txt: "yes",
    provenance: "official",
    source: "https://support.apple.com/en-us/119829",
  },
  {
    token: "Applebot-Extended",
    vendor: "Apple",
    purpose: "opt-out-control",
    description: "Control token to opt out of Apple foundation-model training. Sends no requests of its own.",
    respects_robots_txt: "yes",
    provenance: "official",
    source: "https://support.apple.com/en-us/119829",
  },

  // --- Meta ----------------------------------------------------------------
  {
    token: "meta-externalagent",
    vendor: "Meta",
    purpose: "training",
    description: "Crawls for AI training and direct indexing.",
    respects_robots_txt: "yes",
    provenance: "official",
    source: "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers/",
  },
  {
    token: "meta-externalfetcher",
    vendor: "Meta",
    purpose: "user-fetch",
    description: "User-initiated and agentic AI fetches.",
    respects_robots_txt: "partial",
    compliance_note: "Meta documents that this fetcher may skip robots.txt because the request is user-initiated.",
    provenance: "official",
    source: "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers/",
  },
  {
    token: "meta-webindexer",
    vendor: "Meta",
    purpose: "search",
    description: "Builds the Meta AI search index.",
    respects_robots_txt: "yes",
    provenance: "official",
    source: "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers/",
  },
  {
    token: "meta-externalads",
    vendor: "Meta",
    purpose: "ads",
    description: "Crawls for Meta advertising and business products.",
    respects_robots_txt: "yes",
    provenance: "official",
    source: "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers/",
  },
  {
    token: "facebookexternalhit",
    vendor: "Meta",
    purpose: "preview",
    description: "Builds link-preview cards from Open Graph tags. Replaces the retired FacebookBot token.",
    respects_robots_txt: "partial",
    compliance_note: "Meta documents that it may skip robots.txt when performing integrity/security checks.",
    provenance: "official",
    source: "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers/",
  },

  // --- Amazon --------------------------------------------------------------
  {
    token: "Amazonbot",
    vendor: "Amazon",
    purpose: "training",
    description:
      "Improves Amazon products; Amazon states it may be used to train Amazon AI models. Honours `noarchive` specifically as a no-training signal.",
    respects_robots_txt: "yes",
    provenance: "official",
    source: "https://developer.amazon.com/amazonbot",
  },
  {
    token: "Amzn-SearchBot",
    vendor: "Amazon",
    purpose: "search",
    description: "Indexes for Alexa and Amazon search. Not used for training.",
    respects_robots_txt: "yes",
    provenance: "official",
    source: "https://developer.amazon.com/amazonbot",
  },
  {
    token: "Amzn-User",
    vendor: "Amazon",
    purpose: "user-fetch",
    description: "Live fetch on a user's behalf. Not used for training.",
    respects_robots_txt: "yes",
    provenance: "official",
    source: "https://developer.amazon.com/amazonbot",
  },

  // --- Mistral -------------------------------------------------------------
  {
    token: "MistralAI-User",
    vendor: "Mistral AI",
    purpose: "user-fetch",
    description: "Fetches a page on behalf of a Mistral (Vibe) user.",
    respects_robots_txt: "yes",
    provenance: "official",
    source: "https://docs.mistral.ai/robots",
  },
  {
    token: "MistralAI-Index",
    vendor: "Mistral AI",
    purpose: "search",
    description: "Builds the Mistral search index. Not used for training.",
    respects_robots_txt: "yes",
    provenance: "official",
    source: "https://docs.mistral.ai/robots",
  },

  // --- other verified ------------------------------------------------------
  {
    token: "AI2Bot",
    vendor: "Allen Institute for AI",
    purpose: "training",
    description: "Crawls to train open language models.",
    respects_robots_txt: "yes",
    provenance: "official",
    source: "https://allenai.org/crawler",
  },
  {
    token: "DuckAssistBot",
    vendor: "DuckDuckGo",
    purpose: "user-fetch",
    description: "Real-time fetch for DuckDuckGo AI-assisted answers. Not used for training.",
    respects_robots_txt: "yes",
    provenance: "official",
    source: "https://duckduckgo.com/duckduckgo-help-pages/results/duckassistbot/",
  },
  {
    token: "FirecrawlAgent",
    vendor: "Firecrawl",
    purpose: "scraping",
    description: "Scraping-as-a-service agent used to feed LLM pipelines.",
    respects_robots_txt: "yes",
    provenance: "official",
    source: "https://docs.firecrawl.dev/",
  },
  {
    token: "CCBot",
    vendor: "Common Crawl",
    purpose: "training",
    description:
      "Builds the Common Crawl open corpus — the single most widely reused source of LLM training data.",
    respects_robots_txt: "yes",
    provenance: "official",
    source: "https://commoncrawl.org/ccbot",
  },

  // --- community-sourced (no first-party webmaster docs found) -------------
  {
    token: "Bytespider",
    vendor: "ByteDance",
    purpose: "training",
    description: "ByteDance crawler, widely reported as feeding LLM training. Frequently reported to ignore robots.txt.",
    respects_robots_txt: "no",
    compliance_note: "No first-party webmaster documentation exists; independent reports consistently find it ignores robots.txt.",
    provenance: "community",
    source: "https://github.com/ai-robots-txt/ai.robots.txt",
  },
  {
    token: "cohere-ai",
    vendor: "Cohere",
    purpose: "training",
    description: "Cohere crawler. No first-party webmaster documentation found.",
    respects_robots_txt: "yes",
    provenance: "community",
    source: "https://github.com/ai-robots-txt/ai.robots.txt",
  },
  {
    token: "Diffbot",
    vendor: "Diffbot",
    purpose: "scraping",
    description: "Structured-data extraction crawler used to build knowledge graphs.",
    respects_robots_txt: "yes",
    provenance: "community",
    source: "https://github.com/ai-robots-txt/ai.robots.txt",
  },
  {
    token: "Timpibot",
    vendor: "Timpi",
    purpose: "training",
    description: "Crawler for the Timpi decentralised index. No first-party webmaster documentation found.",
    respects_robots_txt: "yes",
    provenance: "community",
    source: "https://github.com/ai-robots-txt/ai.robots.txt",
  },
  {
    token: "Omgilibot",
    vendor: "Webz.io",
    purpose: "training",
    description: "Collects web data resold as LLM training corpora.",
    respects_robots_txt: "yes",
    provenance: "community",
    source: "https://github.com/ai-robots-txt/ai.robots.txt",
  },
  {
    token: "YouBot",
    vendor: "You.com",
    purpose: "search",
    description: "Indexes pages for You.com's AI search. No first-party webmaster documentation found.",
    respects_robots_txt: "yes",
    provenance: "community",
    source: "https://github.com/ai-robots-txt/ai.robots.txt",
  },
];

/** Crawlers that matter most for *visibility* in AI answer engines. */
export const CITATION_CRITICAL_TOKENS = [
  "OAI-SearchBot",
  "Claude-SearchBot",
  "PerplexityBot",
  "Googlebot",
  "meta-webindexer",
  "MistralAI-Index",
];

/** Crawlers whose only purpose is collecting model *training* data. */
export const TRAINING_TOKENS = AI_CRAWLERS.filter(
  (c) => c.purpose === "training" && !c.deprecated,
).map((c) => c.token);

/** Look a crawler up by token, case-insensitively. */
export function findCrawler(token: string): AiCrawler | undefined {
  const needle = token.toLowerCase();
  return AI_CRAWLERS.find((c) => c.token.toLowerCase() === needle);
}

/**
 * Vendors that are known NOT to publish a crawler token at all, so absence of a
 * rule cannot be read as "allowed" or "blocked". Surfaced in tool output so the
 * caller is not misled by a silent gap.
 */
export const UNDOCUMENTED_VENDORS = [
  {
    vendor: "xAI (Grok)",
    note: "xAI publishes no official crawler documentation and appears not to declare a stable user-agent. Third-party directories list 'GrokBot', but this is unverified — robots.txt rules for xAI cannot be relied on.",
  },
  {
    vendor: "Microsoft (Bing / Copilot)",
    note: "Microsoft publishes no AI-specific opt-out token. Copilot access follows Bingbot, and Microsoft routes AI opt-out through the `noarchive`/`nocache` meta directives instead.",
  },
];
