/**
 * Redirect tracing and host canonicalisation.
 *
 * Two related checks live here: following a single URL's redirect chain, and
 * confirming that the four host/scheme variants of a domain (http/https ×
 * apex/www) all converge on one canonical URL — the classic cause of a homepage
 * competing with itself in the index.
 */

import { clampScore, scoreToGrade, type Finding } from "../format.js";
import { safeFetch, type RedirectHop } from "./fetch.js";
import { normalizeForCompare } from "./meta.js";
import { validateUrl } from "./validate.js";

export interface RedirectReport {
  url: string;
  final_url: string;
  final_status: number;
  hops: RedirectHop[];
  hop_count: number;
  /** True when the chain moves from http:// to https://. */
  https_upgrade: boolean;
  ends_https: boolean;
  /** True when a URL repeats in the chain. */
  has_loop: boolean;
  /** True when any hop is a temporary (302/307) redirect. */
  has_temporary_redirect: boolean;
  elapsed_ms: number;
  findings: Finding[];
}

export async function traceRedirects(url: URL): Promise<RedirectReport> {
  const findings: Finding[] = [];
  const res = await safeFetch(url, { method: "GET", maxBytes: 4096 });

  const hops = res.redirects;
  const seen = new Set<string>();
  // safeFetch stops as soon as a hop returns to a visited URL; the set below
  // still catches loops that only differ by normalisation (trailing slash, case).
  let hasLoop = res.redirectLoop;
  for (const hop of hops) {
    const key = normalizeForCompare(hop.url);
    if (seen.has(key)) hasLoop = true;
    seen.add(key);
  }

  const startedHttp = url.protocol === "http:";
  const endsHttps = new URL(res.finalUrl).protocol === "https:";
  const hasTemporary = hops.some((h) => h.status === 302 || h.status === 307);

  if (hops.length === 0) {
    findings.push({ severity: "pass", message: `No redirects — ${url.toString()} answers directly with HTTP ${res.status}.` });
  } else if (hops.length === 1) {
    findings.push({ severity: "pass", message: `One redirect hop (${hops[0]!.status}) to ${res.finalUrl}.` });
  } else if (hops.length <= 3) {
    findings.push({ severity: "warn", message: `${hops.length} redirect hops. Each hop adds latency and dilutes link signals — collapse them into one.` });
  } else {
    findings.push({ severity: "fail", message: `${hops.length} redirect hops. Long chains waste crawl budget and Google may stop following after ~5.` });
  }

  if (hasLoop) {
    findings.push({ severity: "fail", message: "The redirect chain revisits a URL — this is a loop and the page will never be indexed." });
  }

  if (startedHttp && endsHttps) {
    findings.push({ severity: "pass", message: "HTTP is upgraded to HTTPS." });
  } else if (!endsHttps) {
    findings.push({ severity: "fail", message: "The final URL is not HTTPS. Serve everything over TLS — it is a ranking signal and a browser trust requirement." });
  }

  if (hasTemporary) {
    findings.push({
      severity: "warn",
      message: "The chain uses a temporary redirect (302/307). Use 301/308 for permanent moves so signals consolidate onto the target.",
    });
  }

  if (res.status >= 400) {
    findings.push({ severity: "fail", message: `The chain ends at HTTP ${res.status}.` });
  }

  return {
    url: url.toString(),
    final_url: res.finalUrl,
    final_status: res.status,
    hops,
    hop_count: hops.length,
    https_upgrade: startedHttp && endsHttps,
    ends_https: endsHttps,
    has_loop: hasLoop,
    has_temporary_redirect: hasTemporary,
    elapsed_ms: res.elapsedMs,
    findings,
  };
}

// --- host canonicalisation -------------------------------------------------

export interface VariantResult {
  variant: string;
  reachable: boolean;
  status: number | null;
  final_url: string | null;
  hop_count: number;
  /** Status code of each redirect hop, so 302-vs-301 can be judged. */
  redirect_statuses: number[];
  error: string | null;
}

export interface CanonicalHostReport {
  domain: string;
  variants: VariantResult[];
  /** The URL all reachable variants converge on, when they agree. */
  canonical_url: string | null;
  converges: boolean;
  distinct_endpoints: string[];
  forces_https: boolean;
  score: number;
  grade: string;
  findings: Finding[];
}

/**
 * Fetch all four host/scheme variants of a domain and check they converge.
 *
 * @param apexDomain a bare domain such as `example.com` (no scheme, no www).
 */
export async function checkCanonicalVariants(
  apexDomain: string,
): Promise<CanonicalHostReport> {
  const findings: Finding[] = [];
  const bare = apexDomain.replace(/^www\./i, "");
  const variantUrls = [
    `http://${bare}/`,
    `https://${bare}/`,
    `http://www.${bare}/`,
    `https://www.${bare}/`,
  ];

  const variants: VariantResult[] = await Promise.all(
    variantUrls.map(async (variant): Promise<VariantResult> => {
      const parsed = validateUrl(variant);
      if (!parsed) {
        return { variant, reachable: false, status: null, final_url: null, hop_count: 0, redirect_statuses: [], error: "invalid URL" };
      }
      try {
        const res = await safeFetch(parsed, { method: "GET", maxBytes: 4096, timeoutMs: 10_000 });
        return {
          variant,
          reachable: res.status < 400,
          status: res.status,
          final_url: res.finalUrl,
          hop_count: res.redirects.length,
          redirect_statuses: res.redirects.map((r) => r.status),
          error: null,
        };
      } catch (err) {
        return {
          variant,
          reachable: false,
          status: null,
          final_url: null,
          hop_count: 0,
          redirect_statuses: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  const reachable = variants.filter((v) => v.reachable && v.final_url);
  const endpoints = [...new Set(reachable.map((v) => normalizeForCompare(v.final_url!)))];
  const converges = endpoints.length === 1;
  const canonicalUrl = converges ? reachable[0]!.final_url : null;

  // Do the http:// variants end up on https://? Only *reachable* variants count:
  // a host that 404s or does not resolve says nothing about HTTPS enforcement,
  // and counting it would report a false negative on sites that simply do not
  // serve a www (or apex) hostname.
  const httpVariants = variants.filter(
    (v) => v.variant.startsWith("http://") && v.reachable && v.final_url,
  );
  const forcesHttps =
    httpVariants.length > 0 &&
    httpVariants.every((v) => v.final_url!.startsWith("https://"));

  let score = 0;

  if (reachable.length === 0) {
    findings.push({ severity: "fail", message: `None of the four host variants of ${bare} responded.` });
  } else if (converges) {
    score += 60;
    findings.push({ severity: "pass", message: `All ${reachable.length} reachable variants converge on ${canonicalUrl}.` });
  } else {
    findings.push({
      severity: "fail",
      message: `Host variants resolve to ${endpoints.length} different URLs: ${endpoints.join(", ")}. Pick one canonical host and 301 the rest to it, or search engines will treat them as duplicate sites.`,
    });
  }

  if (forcesHttps) {
    score += 30;
    findings.push({ severity: "pass", message: "Plain-HTTP requests are redirected to HTTPS." });
  } else if (httpVariants.some((v) => v.final_url?.startsWith("http://"))) {
    findings.push({ severity: "fail", message: "HTTP is served without upgrading to HTTPS. Add a permanent redirect to the https:// origin." });
  }

  const slowVariants = variants.filter((v) => v.hop_count > 2);
  if (slowVariants.length) {
    findings.push({
      severity: "warn",
      message: `${slowVariants.length} variant(s) take more than two hops to land (e.g. ${slowVariants[0]!.variant}). Redirect straight to the final URL in one hop.`,
    });
  } else if (reachable.length) {
    score += 10;
  }

  // Permanent vs temporary matters: only 301/308 consolidate ranking signals
  // onto the canonical host.
  const temporaryVariants = variants.filter((v) =>
    v.redirect_statuses.some((s) => s === 302 || s === 307),
  );
  if (temporaryVariants.length) {
    findings.push({
      severity: "warn",
      message: `${temporaryVariants.length} variant(s) use a temporary redirect (302/307), e.g. ${temporaryVariants[0]!.variant}. Host canonicalisation should use 301 or 308 so signals consolidate permanently.`,
    });
  }

  // A variant that does not answer is usually intentional, but silently omitting
  // it would hide a genuinely broken www/apex configuration.
  const unreachable = variants.filter((v) => !v.reachable);
  if (unreachable.length && reachable.length) {
    findings.push({
      severity: "info",
      message: `${unreachable.length} variant(s) do not serve content: ${unreachable
        .map((v) => `${v.variant} (${v.error ?? `HTTP ${v.status}`})`)
        .join(", ")}. Fine if deliberate — but visitors typing that hostname will hit an error rather than being redirected.`,
    });
  }

  return {
    domain: bare,
    variants,
    canonical_url: canonicalUrl,
    converges,
    distinct_endpoints: endpoints,
    forces_https: forcesHttps,
    score: clampScore(score),
    grade: scoreToGrade(clampScore(score)),
    findings,
  };
}
