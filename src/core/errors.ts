/**
 * Error taxonomy.
 *
 * Spec §21: the pipeline must never crash because one repository failed. So errors are
 * split into two kinds:
 *
 *   - `IntelligenceError` and friends — thrown, but expected to be *caught at a stage
 *     boundary* and converted into a `Degradation` so the run continues with other
 *     candidates.
 *   - `FatalConfigError` — the process genuinely cannot proceed (bad config). Rare.
 *
 * Every error carries enough structure for the stage boundary to decide whether to retry,
 * skip the candidate, or degrade the whole stage.
 */

import type { Degradation } from "../types/index.js";

export type ErrorKind =
  | "rate-limit"
  | "auth"
  | "not-found"
  | "forbidden"
  | "network"
  | "timeout"
  | "upstream-malformed"
  | "unsupported"
  | "too-large"
  | "budget-exhausted"
  | "config"
  | "internal";

export interface ErrorOptions {
  kind: ErrorKind;
  /** What the pipeline was doing, e.g. "github.searchRepositories". */
  stage: string;
  /** What it was doing it to, e.g. "owner/repo". */
  subject?: string;
  /** Whether retrying the same call could plausibly succeed. */
  retryable?: boolean;
  /** For rate limits: epoch millis when the quota resets. */
  retryAfterMs?: number;
  cause?: unknown;
  /** Extra context for logs. Must not contain secrets. */
  detail?: Record<string, unknown>;
}

export class IntelligenceError extends Error {
  readonly kind: ErrorKind;
  readonly stage: string;
  readonly subject?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly detail?: Record<string, unknown>;

  constructor(message: string, opts: ErrorOptions) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "IntelligenceError";
    this.kind = opts.kind;
    this.stage = opts.stage;
    this.subject = opts.subject;
    this.retryable = opts.retryable ?? defaultRetryable(opts.kind);
    this.retryAfterMs = opts.retryAfterMs;
    this.detail = opts.detail;
  }

  /** Convert to the non-fatal record the pipeline reports to the agent. */
  toDegradation(fallback?: string): Degradation {
    return {
      stage: this.stage,
      subject: this.subject,
      reason: `${this.kind}: ${this.message}`,
      fallback,
      severity: this.kind === "not-found" || this.kind === "unsupported" ? "info" : "warning",
    };
  }
}

/** Unrecoverable configuration problem. The only error that should stop the process. */
export class FatalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalConfigError";
  }
}

function defaultRetryable(kind: ErrorKind): boolean {
  switch (kind) {
    case "rate-limit":
    case "network":
    case "timeout":
      return true;
    default:
      return false;
  }
}

/**
 * Run `fn`, converting any failure into a Degradation and returning `fallbackValue`.
 *
 * This is the stage-boundary helper that implements "never crash because one repository
 * failed". Callers push the returned degradations into their report.
 */
export async function degradeOnError<T>(
  fn: () => Promise<T>,
  ctx: { stage: string; subject?: string; fallback?: string },
  fallbackValue: T,
  sink: Degradation[],
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    sink.push(toDegradation(err, ctx));
    return fallbackValue;
  }
}

export function toDegradation(
  err: unknown,
  ctx: { stage: string; subject?: string; fallback?: string },
): Degradation {
  if (err instanceof IntelligenceError) return err.toDegradation(ctx.fallback);
  return {
    stage: ctx.stage,
    subject: ctx.subject,
    reason: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    fallback: ctx.fallback,
    severity: "warning",
  };
}

/** Type guard used by retry logic. */
export function isRetryable(err: unknown): err is IntelligenceError {
  return err instanceof IntelligenceError && err.retryable;
}
