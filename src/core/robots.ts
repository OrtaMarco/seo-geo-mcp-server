/**
 * robots.txt fetching, parsing and rule matching, per RFC 9309.
 *
 * The matcher implements the parts of the spec that actually decide access:
 *   - product tokens match case-insensitively (§2.2.1);
 *   - groups sharing a user-agent are merged (§2.2.1);
 *   - the most specific group wins, falling back to the `*` group;
 *   - between Allow and Disallow the **longest matching pattern** wins, and on a
 *     tie Allow wins (§2.2.2);
 *   - `*` matches any sequence and `$` anchors the end of the path.
 */

import { ROBOTS_MAX_PATTERN_CHARS } from "../constants.js";
import { fetchTextResource } from "./fetch.js";
import type { Finding } from "../format.js";
import {
  AI_CRAWLERS,
  UNDOCUMENTED_VENDORS,
  type AiCrawler,
  type RobotsCompliance,
} from "./ai-crawlers.js";

export interface RobotsRule {
  type: "allow" | "disallow";
  path: string;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawl_delay: number | null;
}

export interface RobotsTxt {
  url: string;
  found: boolean;
  status: number | null;
  raw: string;
  groups: RobotsGroup[];
  sitemaps: string[];
  /** Lines we could not interpret — usually typos worth reporting. */
  warnings: string[];
}

// --- fetching --------------------------------------------------------------

/** Fetch and parse `/robots.txt` for an origin. */
export async function fetchRobots(origin: string): Promise<RobotsTxt> {
  const url = new URL("/robots.txt", origin);
  const res = await fetchTextResource(url, { maxBytes: 512_000 });

  if (!res) {
    return {
      url: url.toString(),
      found: false,
      status: 404,
      raw: "",
      groups: [],
      sitemaps: [],
      warnings: [],
    };
  }

  // A robots.txt that answers 5xx means "disallow everything" to Google, but a
  // 4xx (other than 404) still means "no restrictions". Record the status and
  // let callers interpret it.
  const parsed = parseRobots(res.body);
  return {
    url: url.toString(),
    found: res.status >= 200 && res.status < 300,
    status: res.status,
    raw: res.body,
    ...parsed,
  };
}

// --- parsing ---------------------------------------------------------------

/** Parse robots.txt text into groups, sitemaps and warnings. */
export function parseRobots(text: string): Pick<RobotsTxt, "groups" | "sitemaps" | "warnings"> {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  const warnings: string[] = [];

  let current: RobotsGroup | null = null;
  // Consecutive User-agent lines accumulate into one group; the first rule line
  // after them closes the agent list.
  let acceptingAgents = false;

  const lines = text.split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    const separator = line.indexOf(":");
    if (separator === -1) {
      warnings.push(`Line ${index + 1}: '${rawLine.trim()}' has no ':' separator and was ignored.`);
      continue;
    }

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    switch (field) {
      case "user-agent": {
        if (!value) {
          warnings.push(`Line ${index + 1}: empty User-agent value.`);
          break;
        }
        if (!current || !acceptingAgents) {
          current = { agents: [], rules: [], crawl_delay: null };
          groups.push(current);
          acceptingAgents = true;
        }
        current.agents.push(value.toLowerCase());
        break;
      }

      case "allow":
      case "disallow": {
        if (!current) {
          warnings.push(`Line ${index + 1}: '${field}' appears before any User-agent line and applies to nothing.`);
          break;
        }
        acceptingAgents = false;
        // An empty Disallow means "allow everything" — represent it by simply
        // recording no restriction, which the matcher treats as a no-op.
        if (field === "disallow" && value === "") {
          current.rules.push({ type: "allow", path: "/" });
        } else {
          current.rules.push({ type: field, path: value });
        }
        break;
      }

      case "sitemap": {
        // Sitemap is group-independent (§2.2.3).
        if (value) sitemaps.push(value);
        break;
      }

      case "crawl-delay": {
        if (!current) break;
        acceptingAgents = false;
        const delay = Number.parseFloat(value);
        current.crawl_delay = Number.isFinite(delay) ? delay : null;
        break;
      }

      case "host":
      case "clean-param":
      case "noindex":
        // Non-standard extensions. Recognised so they do not produce warnings,
        // but they carry no weight with Google.
        acceptingAgents = false;
        break;

      default:
        warnings.push(`Line ${index + 1}: unknown directive '${field}'.`);
    }
  }

  // A robots.txt of junk would otherwise produce one warning per line.
  if (warnings.length > 100) {
    const extra = warnings.length - 100;
    warnings.length = 100;
    warnings.push(`…and ${extra} more warning(s).`);
  }
  return { groups, sitemaps, warnings };
}

// --- matching --------------------------------------------------------------

/**
 * Whether a robots path pattern matches `path` (RFC 9309 §2.2.2): `*` matches
 * any sequence, a trailing `$` anchors the end, and otherwise the pattern only
 * has to match a prefix. Deliberately not a regex: `/*a*a*a…` compiled to
 * `.*a.*a.*…` backtracks exponentially, and both the pattern (the audited site)
 * and the path (the caller) are untrusted. This two-pointer wildcard match is
 * O(pattern × path) at worst, and both are length-capped.
 */
export function robotsPatternMatches(pattern: string, path: string): boolean {
  let p = pattern;
  let anchored = false;
  if (p.endsWith("$")) {
    p = p.slice(0, -1);
    anchored = true;
  }
  p = p.replace(/\*{2,}/g, "*");
  if (p.length > ROBOTS_MAX_PATTERN_CHARS || path.length > ROBOTS_MAX_PATTERN_CHARS) return false;

  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  for (;;) {
    if (pi === p.length) {
      if (!anchored || si === path.length) return true;
    } else if (p[pi] === "*") {
      star = pi++;
      mark = si;
      continue;
    } else if (si < path.length && p[pi] === path[si]) {
      pi++;
      si++;
      continue;
    }
    // Mismatch (or pattern used up while an anchored match still has path left):
    // let the last `*` swallow one more character, or give up.
    if (star === -1 || mark >= path.length) return false;
    pi = star + 1;
    si = ++mark;
  }
}

/**
 * Select the group that applies to `userAgent`.
 *
 * Groups whose agent list contains the token are merged (RFC 9309 §2.2.1); if
 * none match, the `*` group is used; if there is no `*` group either, the
 * crawler is unrestricted.
 */
export function selectGroup(
  robots: RobotsTxt,
  userAgent: string,
): { group: RobotsGroup | null; matchedAgent: string | null } {
  const needle = userAgent.toLowerCase();

  const exact = robots.groups.filter((g) => g.agents.includes(needle));
  if (exact.length) {
    return {
      group: {
        agents: [needle],
        rules: exact.flatMap((g) => g.rules),
        crawl_delay: exact.find((g) => g.crawl_delay !== null)?.crawl_delay ?? null,
      },
      matchedAgent: needle,
    };
  }

  const wildcard = robots.groups.filter((g) => g.agents.includes("*"));
  if (wildcard.length) {
    return {
      group: {
        agents: ["*"],
        rules: wildcard.flatMap((g) => g.rules),
        crawl_delay: wildcard.find((g) => g.crawl_delay !== null)?.crawl_delay ?? null,
      },
      matchedAgent: "*",
    };
  }

  return { group: null, matchedAgent: null };
}

export interface AccessVerdict {
  allowed: boolean;
  /** The user-agent group that decided it (`*` when falling back). */
  matched_agent: string | null;
  /** The winning rule, or null when nothing matched (default allow). */
  matched_rule: RobotsRule | null;
}

/** Decide whether `userAgent` may fetch `path` under these robots rules. */
export function isAllowed(
  robots: RobotsTxt,
  userAgent: string,
  path: string,
): AccessVerdict {
  // A robots.txt that 5xx'd is treated by Google as a full disallow.
  if (robots.status !== null && robots.status >= 500) {
    return { allowed: false, matched_agent: null, matched_rule: null };
  }

  const { group, matchedAgent } = selectGroup(robots, userAgent);
  if (!group) return { allowed: true, matched_agent: null, matched_rule: null };

  let best: { rule: RobotsRule; length: number } | null = null;
  for (const rule of group.rules) {
    if (!rule.path) continue;
    if (!robotsPatternMatches(rule.path, path)) continue;
    const length = rule.path.length;
    // Longest pattern wins; on a tie, Allow beats Disallow (§2.2.2).
    if (
      !best ||
      length > best.length ||
      (length === best.length && rule.type === "allow")
    ) {
      best = { rule, length };
    }
  }

  return {
    allowed: best ? best.rule.type === "allow" : true,
    matched_agent: matchedAgent,
    matched_rule: best?.rule ?? null,
  };
}

// --- robots.txt health report ---------------------------------------------

export interface RobotsReport {
  url: string;
  found: boolean;
  status: number | null;
  group_count: number;
  sitemaps: string[];
  blocks_everything: boolean;
  groups: RobotsGroup[];
  parse_warnings: string[];
  findings: Finding[];
}

export function analyzeRobots(robots: RobotsTxt): RobotsReport {
  const findings: Finding[] = [];

  if (!robots.found) {
    findings.push({
      severity: robots.status === 404 ? "warn" : "fail",
      message:
        robots.status === 404
          ? "No robots.txt (HTTP 404). Everything is crawlable by default, but you lose the ability to point crawlers at your sitemap or to opt out of AI training."
          : `robots.txt returned HTTP ${robots.status}. A 5xx here makes Google treat the whole site as disallowed — fix this urgently.`,
    });
  } else {
    findings.push({ severity: "pass", message: "robots.txt is published and reachable." });
  }

  // Does the wildcard group block the whole site?
  const wildcardVerdict = isAllowed(robots, "*", "/");
  const blocksEverything = robots.found && !wildcardVerdict.allowed;
  if (blocksEverything) {
    findings.push({
      severity: "fail",
      message: "robots.txt blocks all crawlers from '/' (Disallow: / for User-agent: *). The site cannot be indexed.",
    });
  }

  if (robots.sitemaps.length === 0) {
    findings.push({
      severity: "warn",
      message: "No Sitemap directive. Add `Sitemap: https://example.com/sitemap.xml` so crawlers discover your URLs without relying on link-following.",
    });
  } else {
    findings.push({
      severity: "pass",
      message: `${robots.sitemaps.length} sitemap(s) declared: ${robots.sitemaps.join(", ")}.`,
    });
  }

  for (const warning of robots.warnings) {
    findings.push({ severity: "warn", message: warning });
  }

  // Crawl-delay is widely misunderstood: Google ignores it entirely.
  const withDelay = robots.groups.filter((g) => g.crawl_delay !== null);
  if (withDelay.length) {
    findings.push({
      severity: "info",
      message: `Crawl-delay is set for ${withDelay.map((g) => g.agents.join("/")).join(", ")}. Google ignores Crawl-delay — use Search Console's crawl-rate setting instead. Bing and Anthropic do honour it.`,
    });
  }

  return {
    url: robots.url,
    found: robots.found,
    status: robots.status,
    group_count: robots.groups.length,
    sitemaps: robots.sitemaps,
    blocks_everything: blocksEverything,
    groups: robots.groups,
    parse_warnings: robots.warnings,
    findings,
  };
}

// --- AI crawler access -----------------------------------------------------

export interface CrawlerAccess {
  token: string;
  vendor: string;
  purpose: string;
  allowed: boolean;
  /** True when the verdict came from the `*` group rather than a rule naming this bot. */
  via_wildcard: boolean;
  matched_rule: string | null;
  respects_robots_txt: RobotsCompliance;
  compliance_note: string | null;
  provenance: string;
  deprecated: boolean;
  /** Set when a vendor-specific quirk changed the verdict. */
  quirk: string | null;
}

export interface AiCrawlerReport {
  url: string;
  path: string;
  robots_found: boolean;
  crawlers: CrawlerAccess[];
  allowed_count: number;
  blocked_count: number;
  /** Blocked bots that would otherwise make you *visible* in AI answers. */
  blocked_citation_critical: string[];
  /** Bots blocked in robots.txt that are documented not to fully honour it. */
  unenforceable_blocks: string[];
  undocumented_vendors: Array<{ vendor: string; note: string }>;
  findings: Finding[];
}

/**
 * Resolve every known AI crawler against a site's robots.txt.
 *
 * Handles Apple's documented quirk: when robots.txt has no Applebot group but
 * does have a Googlebot group, Applebot follows the Googlebot rules.
 */
export function analyzeAiCrawlerAccess(
  robots: RobotsTxt,
  path = "/",
  includeDeprecated = false,
): AiCrawlerReport {
  const findings: Finding[] = [];
  const pool = AI_CRAWLERS.filter((c) => includeDeprecated || !c.deprecated);

  const crawlers: CrawlerAccess[] = pool.map((crawler) => {
    let verdict = isAllowed(robots, crawler.token, path);
    let quirk: string | null = null;

    if (isApplebotFallback(robots, crawler)) {
      const googlebot = isAllowed(robots, "Googlebot", path);
      quirk =
        "robots.txt has no Applebot group but does have a Googlebot group — Apple documents that Applebot then follows the Googlebot rules.";
      verdict = googlebot;
    }

    return {
      token: crawler.token,
      vendor: crawler.vendor,
      purpose: crawler.purpose,
      allowed: verdict.allowed,
      via_wildcard: verdict.matched_agent === "*" || verdict.matched_agent === null,
      matched_rule: verdict.matched_rule
        ? `${verdict.matched_rule.type === "allow" ? "Allow" : "Disallow"}: ${verdict.matched_rule.path}`
        : null,
      respects_robots_txt: crawler.respects_robots_txt,
      compliance_note: crawler.compliance_note ?? null,
      provenance: crawler.provenance,
      deprecated: crawler.deprecated ?? false,
      quirk,
    };
  });

  const blocked = crawlers.filter((c) => !c.allowed);
  const allowed = crawlers.filter((c) => c.allowed);

  const blockedCitationCritical = blocked
    .filter((c) => c.purpose === "search")
    .map((c) => c.token);

  const unenforceable = blocked
    .filter((c) => c.respects_robots_txt !== "yes")
    .map((c) => c.token);

  if (blocked.length === 0) {
    findings.push({
      severity: "info",
      message: `All ${crawlers.length} known AI crawlers may fetch ${path}. That maximises AI visibility; block the training-only bots if you would rather not feed model training.`,
    });
  } else {
    findings.push({
      severity: "info",
      message: `${blocked.length} of ${crawlers.length} AI crawlers are blocked from ${path}.`,
    });
  }

  if (blockedCitationCritical.length) {
    findings.push({
      severity: "warn",
      message: `Blocking ${blockedCitationCritical.join(", ")} removes you from AI *search* results — these bots build the indexes that cite you, and are separate from the training crawlers. Block them only if you intend to be invisible in AI answers.`,
    });
  }

  if (unenforceable.length) {
    findings.push({
      severity: "warn",
      message: `${unenforceable.join(", ")} are disallowed in robots.txt, but their vendors document that they may ignore it. Treat these blocks as advisory — enforce at the WAF/edge if it matters.`,
    });
  }

  const trainingAllowed = allowed.filter((c) => c.purpose === "training");
  if (trainingAllowed.length) {
    findings.push({
      severity: "info",
      message: `${trainingAllowed.length} training crawler(s) are allowed (${trainingAllowed.map((c) => c.token).join(", ")}). Disallow these if you want your content excluded from model training while staying visible in AI search.`,
    });
  }

  return {
    url: robots.url,
    path,
    robots_found: robots.found,
    crawlers,
    allowed_count: allowed.length,
    blocked_count: blocked.length,
    blocked_citation_critical: blockedCitationCritical,
    unenforceable_blocks: unenforceable,
    undocumented_vendors: UNDOCUMENTED_VENDORS,
    findings,
  };
}

/** Apple's documented fallback: no Applebot group + a Googlebot group exists. */
function isApplebotFallback(robots: RobotsTxt, crawler: AiCrawler): boolean {
  if (crawler.token !== "Applebot") return false;
  const hasApplebot = robots.groups.some((g) => g.agents.includes("applebot"));
  const hasGooglebot = robots.groups.some((g) => g.agents.includes("googlebot"));
  return !hasApplebot && hasGooglebot;
}
