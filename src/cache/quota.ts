/**
 * Quota budgeting and rate limiting.
 *
 * Measured on this host:
 *   core          5 000 / hour
 *   search           30 / minute
 *   code search      10 / minute
 *
 * Code search at 10/min is the scarcest resource in the system and also the highest-signal
 * one, so it is treated as a budget to be *allocated*, not a limit to be hit. Three
 * mechanisms, in order of importance:
 *
 *   1. **Per-call budgets.** A single tool call reserves a slice of the quota up front and
 *      cannot exceed it. One greedy discovery must not starve the next.
 *   2. **Token-bucket pacing.** Requests self-space to stay under the per-minute rate,
 *      rather than firing and handling 403s.
 *   3. **Server-truth reconciliation.** Every response carries `x-ratelimit-remaining`;
 *      we trust that over our own count, because other tools on this machine share the
 *      same token.
 *
 * The third point is why this is not just a rate limiter: our local accounting is only a
 * prediction, and the server's number is the fact.
 */

import { IntelligenceError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";

export type QuotaClass = "core" | "search" | "code-search";

interface BucketState {
  /** Requests permitted per window. */
  capacity: number;
  windowMs: number;
  /** Timestamps of recent requests, oldest first. */
  recent: number[];
  /** Server-reported remaining, when known. Overrides local accounting. */
  serverRemaining?: number;
  /** Epoch ms when the server quota resets. */
  serverResetAt?: number;
}

const DEFAULTS: Record<QuotaClass, { capacity: number; windowMs: number }> = {
  core: { capacity: 5_000, windowMs: 3_600_000 },
  search: { capacity: 30, windowMs: 60_000 },
  "code-search": { capacity: 10, windowMs: 60_000 },
};

/**
 * A slice of quota reserved for one tool call.
 *
 * Handed to a pipeline so it can ask "can I afford another search?" without knowing about
 * global state. When the slice is exhausted the pipeline degrades gracefully (fewer
 * queries, shallower analysis) rather than failing.
 */
export class QuotaBudget {
  private readonly spent: Record<QuotaClass, number> = { core: 0, search: 0, "code-search": 0 };

  constructor(
    private readonly limits: Record<QuotaClass, number>,
    private readonly limiter: RateLimiter,
  ) {}

  /** Whether one more request of this class is affordable within this call's slice. */
  canAfford(cls: QuotaClass, n = 1): boolean {
    return this.spent[cls] + n <= this.limits[cls];
  }

  remaining(cls: QuotaClass): number {
    return Math.max(0, this.limits[cls] - this.spent[cls]);
  }

  /**
   * Acquire permission to make a request: checks the call slice, then waits for the
   * global rate limiter. Throws `budget-exhausted` (non-retryable) when the slice is
   * spent — callers catch this and degrade.
   */
  async acquire(cls: QuotaClass): Promise<void> {
    if (!this.canAfford(cls)) {
      throw new IntelligenceError(
        `Per-call ${cls} budget exhausted (${this.limits[cls]} used); degrading rather than starving other calls`,
        { kind: "budget-exhausted", stage: `quota.${cls}`, retryable: false },
      );
    }
    await this.limiter.acquire(cls);
    this.spent[cls] += 1;
  }

  spentSummary(): Record<QuotaClass, number> {
    return { ...this.spent };
  }
}

export class RateLimiter {
  private readonly buckets: Record<QuotaClass, BucketState>;

  constructor(private readonly logger?: Logger, overrides?: Partial<Record<QuotaClass, { capacity: number; windowMs: number }>>) {
    const mk = (k: QuotaClass): BucketState => {
      const d = overrides?.[k] ?? DEFAULTS[k];
      return { capacity: d.capacity, windowMs: d.windowMs, recent: [] };
    };
    this.buckets = { core: mk("core"), search: mk("search"), "code-search": mk("code-search") };
  }

  /** Reserve a slice of the remaining quota for one tool call. */
  createBudget(limits: Partial<Record<QuotaClass, number>>): QuotaBudget {
    return new QuotaBudget(
      {
        core: limits.core ?? 200,
        search: limits.search ?? 8,
        "code-search": limits["code-search"] ?? 3,
      },
      this,
    );
  }

  /** Block until a request of this class may proceed. */
  async acquire(cls: QuotaClass): Promise<void> {
    const b = this.buckets[cls];
    const now = Date.now();

    // Server said we are out. Refuse until reset rather than burning a 403.
    if (b.serverRemaining !== undefined && b.serverRemaining <= 0) {
      const resetIn = (b.serverResetAt ?? now) - now;
      if (resetIn > 0) {
        throw new IntelligenceError(
          `GitHub ${cls} quota exhausted; resets in ${Math.ceil(resetIn / 1000)}s`,
          { kind: "rate-limit", stage: `quota.${cls}`, retryable: true, retryAfterMs: resetIn },
        );
      }
      b.serverRemaining = undefined;
    }

    this.prune(b, now);
    if (b.recent.length >= b.capacity) {
      const oldest = b.recent[0] ?? now;
      const waitMs = Math.max(0, oldest + b.windowMs - now) + 50;
      this.logger?.debug("rate limit pacing", { class: cls, waitMs });
      await sleep(waitMs);
      this.prune(b, Date.now());
    }
    b.recent.push(Date.now());
    if (b.serverRemaining !== undefined) b.serverRemaining -= 1;
  }

  /**
   * Reconcile with the server's own accounting.
   *
   * The server's number is authoritative: other processes on this machine share the token,
   * so our local window count is only ever an optimistic prediction.
   */
  observeHeaders(cls: QuotaClass, headers: Headers): void {
    const remaining = num(headers.get("x-ratelimit-remaining"));
    const reset = num(headers.get("x-ratelimit-reset"));
    const b = this.buckets[cls];
    if (remaining !== undefined) b.serverRemaining = remaining;
    if (reset !== undefined) b.serverResetAt = reset * 1000;
    if (remaining !== undefined && remaining <= 2) {
      this.logger?.warn("GitHub quota nearly exhausted", {
        class: cls, remaining, resetAt: b.serverResetAt ? new Date(b.serverResetAt).toISOString() : undefined,
      });
    }
  }

  /** Current view of quota, for diagnostics. */
  snapshot(): Record<QuotaClass, { usedInWindow: number; capacity: number; serverRemaining?: number }> {
    const now = Date.now();
    return Object.fromEntries(
      (Object.keys(this.buckets) as QuotaClass[]).map((k) => {
        const b = this.buckets[k];
        this.prune(b, now);
        return [k, { usedInWindow: b.recent.length, capacity: b.capacity, serverRemaining: b.serverRemaining }];
      }),
    ) as never;
  }

  private prune(b: BucketState, now: number): void {
    const cutoff = now - b.windowMs;
    while (b.recent.length && (b.recent[0] as number) <= cutoff) b.recent.shift();
  }
}

function num(v: string | null): number | undefined {
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
