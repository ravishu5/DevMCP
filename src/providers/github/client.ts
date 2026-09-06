/**
 * Low-level GitHub REST client.
 *
 * Responsibilities kept deliberately narrow — HTTP, auth, quota, retry, error mapping.
 * Everything semantic (what a repository *means*) lives in the provider above it.
 *
 * Three things this does that a naive fetch wrapper would not:
 *
 *   1. **Classifies every request** into a quota class (core / search / code-search) so
 *      the budgeter can pace them separately. GitHub's search limits are 50-500x tighter
 *      than core, so treating them as one pool would either waste core quota or exhaust
 *      search quota instantly.
 *   2. **Reconciles with server headers** on every response, including error responses —
 *      a 403 for rate limiting still carries the reset time we need.
 *   3. **Distinguishes the two 403s.** GitHub returns 403 both for "rate limited" and for
 *      "forbidden". Conflating them means either retrying a permission error forever, or
 *      giving up on a limit that resets in 20 seconds.
 */

import { IntelligenceError } from "../../core/errors.js";
import type { Logger } from "../../core/logger.js";
import type { QuotaBudget, QuotaClass, RateLimiter } from "../../cache/quota.js";
import { sleep } from "../../cache/quota.js";
import type { Sanitizer } from "../../security/sanitize.js";

export interface GitHubClientOptions {
  apiBase: string;
  token?: string;
  userAgent: string;
  timeoutMs: number;
  logger: Logger;
  limiter: RateLimiter;
  sanitizer: Sanitizer;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  maxRetries?: number;
}

export interface RequestOptions {
  quotaClass?: QuotaClass;
  budget?: QuotaBudget;
  /** Accept header override — needed for raw content and preview APIs. */
  accept?: string;
  /** Treat 404 as a normal empty result rather than an error. */
  allow404?: boolean;
  query?: Record<string, string | number | boolean | undefined>;
}

export interface GitHubResponse<T> {
  data: T;
  status: number;
  headers: Headers;
  /** Present when the endpoint is paginated. */
  nextPage?: number;
}

export class GitHubClient {
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GitHubClientOptions) {
    this.maxRetries = opts.maxRetries ?? 3;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    // Register our own token so it can never appear in a log line or error message.
    this.opts.sanitizer.registerSecret(opts.token);
  }

  get authenticated(): boolean { return Boolean(this.opts.token); }

  async request<T>(path: string, options: RequestOptions = {}): Promise<GitHubResponse<T> | null> {
    const quotaClass = options.quotaClass ?? "core";
    const url = this.buildUrl(path, options.query);

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Budget/pacing is acquired per ATTEMPT: a retry is a real request and must be
      // counted, or a retry storm would silently blow through the quota we just budgeted.
      if (options.budget) await options.budget.acquire(quotaClass);
      else await this.opts.limiter.acquire(quotaClass);

      try {
        return await this.attempt<T>(url, quotaClass, options);
      } catch (err) {
        lastError = err;
        if (!(err instanceof IntelligenceError) || !err.retryable || attempt === this.maxRetries) throw err;

        // Honour the server's reset time when it gave us one; otherwise exponential
        // backoff with jitter (jitter matters: several candidates failing at once would
        // otherwise retry in lockstep and re-trigger the same limit).
        const wait = err.retryAfterMs !== undefined
          ? Math.min(err.retryAfterMs + 250, 60_000)
          : Math.min(500 * 2 ** attempt, 8_000) + Math.random() * 250;
        this.opts.logger.debug("retrying github request", { path, attempt: attempt + 1, waitMs: Math.round(wait) });
        await sleep(wait);
      }
    }
    throw lastError;
  }

  private async attempt<T>(
    url: string,
    quotaClass: QuotaClass,
    options: RequestOptions,
  ): Promise<GitHubResponse<T> | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: this.headers(options.accept),
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = (err as { name?: string })?.name === "AbortError";
      throw new IntelligenceError(
        aborted ? `Request timed out after ${this.opts.timeoutMs}ms` : `Network error contacting GitHub`,
        {
          kind: aborted ? "timeout" : "network",
          stage: "github.request",
          subject: this.redactUrl(url),
          retryable: true,
          cause: err,
        },
      );
    } finally {
      clearTimeout(timer);
    }

    // Reconcile with the server's own accounting on EVERY response, errors included —
    // a rate-limit 403 carries the reset time we need most.
    this.opts.limiter.observeHeaders(quotaClass, res.headers);

    if (res.status === 404) {
      if (options.allow404) return null;
      throw new IntelligenceError("Not found (deleted, renamed, or private)", {
        kind: "not-found", stage: "github.request", subject: this.redactUrl(url), retryable: false,
      });
    }

    if (!res.ok) throw await this.mapError(res, url);

    const data = (await this.parseBody(res, options.accept)) as T;
    return { data, status: res.status, headers: res.headers, nextPage: parseNextPage(res.headers.get("link")) };
  }

  /**
   * Map an error response to a typed error.
   *
   * The important case is 403: GitHub uses it for BOTH rate limiting and genuine
   * permission denial. `x-ratelimit-remaining: 0` (or a `retry-after`) distinguishes them.
   * Getting this wrong means either retrying a permission error until the budget dies, or
   * abandoning a candidate over a limit that resets in twenty seconds.
   */
  private async mapError(res: Response, url: string): Promise<IntelligenceError> {
    const subject = this.redactUrl(url);
    const body = await this.safeBodyText(res);
    const message = this.opts.sanitizer.scrubForLog(extractMessage(body) ?? res.statusText);

    const remaining = Number(res.headers.get("x-ratelimit-remaining") ?? "-1");
    const retryAfterHeader = Number(res.headers.get("retry-after") ?? "0");
    const resetAt = Number(res.headers.get("x-ratelimit-reset") ?? "0") * 1000;

    if (res.status === 429 || (res.status === 403 && (remaining === 0 || retryAfterHeader > 0))) {
      const retryAfterMs = retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : Math.max(0, resetAt - Date.now());
      return new IntelligenceError(`GitHub rate limit hit: ${message}`, {
        kind: "rate-limit", stage: "github.request", subject, retryable: true, retryAfterMs,
      });
    }
    if (res.status === 401) {
      return new IntelligenceError(
        "GitHub authentication failed. Check GITHUB_TOKEN, or run `gh auth login`.",
        { kind: "auth", stage: "github.request", subject, retryable: false },
      );
    }
    if (res.status === 403) {
      return new IntelligenceError(`GitHub forbade this request: ${message}`, {
        kind: "forbidden", stage: "github.request", subject, retryable: false,
      });
    }
    if (res.status === 422) {
      // Almost always a malformed search query — retrying is pointless.
      return new IntelligenceError(`GitHub rejected the query: ${message}`, {
        kind: "unsupported", stage: "github.request", subject, retryable: false,
      });
    }
    if (res.status >= 500) {
      return new IntelligenceError(`GitHub server error (${res.status})`, {
        kind: "network", stage: "github.request", subject, retryable: true,
      });
    }
    return new IntelligenceError(`GitHub request failed (${res.status}): ${message}`, {
      kind: "internal", stage: "github.request", subject, retryable: false,
    });
  }

  private async parseBody(res: Response, accept?: string): Promise<unknown> {
    if (res.status === 204) return null;
    const isJson = (res.headers.get("content-type") ?? "").includes("json");
    if (accept?.includes("raw") || !isJson) return await res.text();
    try {
      return await res.json();
    } catch (err) {
      throw new IntelligenceError("GitHub returned malformed JSON", {
        kind: "upstream-malformed", stage: "github.parse", retryable: false, cause: err,
      });
    }
  }

  private async safeBodyText(res: Response): Promise<string> {
    try { return (await res.text()).slice(0, 2000); } catch { return ""; }
  }

  private headers(accept?: string): Record<string, string> {
    const h: Record<string, string> = {
      Accept: accept ?? "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": this.opts.userAgent,
    };
    if (this.opts.token) h.Authorization = `Bearer ${this.opts.token}`;
    return h;
  }

  private buildUrl(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(path.startsWith("http") ? path : `${this.opts.apiBase}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  /** URLs appear in error messages; make sure a token in a query string cannot ride along. */
  private redactUrl(url: string): string {
    return this.opts.sanitizer.scrubForLog(url.replace(/([?&](access_token|token)=)[^&]*/gi, "$1REDACTED"));
  }
}

/** GitHub paginates via the Link header. */
function parseNextPage(link: string | null): number | undefined {
  if (!link) return undefined;
  const m = /<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="next"/.exec(link);
  return m?.[1] ? Number(m[1]) : undefined;
}

function extractMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { message?: string; errors?: { message?: string }[] };
    const detail = parsed.errors?.map((e) => e.message).filter(Boolean).join("; ");
    return [parsed.message, detail].filter(Boolean).join(" — ") || undefined;
  } catch {
    return body.slice(0, 200) || undefined;
  }
}
