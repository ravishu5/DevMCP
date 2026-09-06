/**
 * Token-efficiency and cost instrumentation (spec §25).
 *
 * Token reduction is one of the main purposes of this MCP, so it is measured rather than
 * asserted. One `MetricsCollector` is created per top-level tool call and threaded through
 * every stage; nothing else may mutate counters.
 */

import type { BundleMetrics } from "../types/bundle.js";
import { contextReduction } from "./tokens.js";

export class MetricsCollector {
  private readonly startedAt = Date.now();
  private readonly counters = new Map<string, number>();
  private readonly degradedPaths = new Set<string>();
  /** Per-stage wall clock, for the perf tests and diagnostic mode. */
  private readonly timings = new Map<string, number>();

  add(counter: MetricName, n = 1): void {
    this.counters.set(counter, (this.counters.get(counter) ?? 0) + n);
  }

  get(counter: MetricName): number {
    return this.counters.get(counter) ?? 0;
  }

  /** Record that a stage had to use a degraded path (e.g. GitHub fallback). */
  markDegraded(path: string): void {
    this.degradedPaths.add(path);
  }

  /** Time an async stage. Returns the stage's own result untouched. */
  async time<T>(stage: string, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      this.timings.set(stage, (this.timings.get(stage) ?? 0) + (Date.now() - t0));
    }
  }

  stageTimings(): Record<string, number> {
    return Object.fromEntries(this.timings);
  }

  get elapsedMs(): number { return Date.now() - this.startedAt; }

  /**
   * Snapshot in the shape the bundle carries.
   *
   * `estimatedRawTokens` is the honest counterfactual: the tokens the agent would have
   * spent reading the material we examined on its behalf. We only count material we
   * actually retrieved, so the reduction figure cannot be inflated by imagining reads that
   * never happened.
   */
  snapshot(): BundleMetrics {
    const returned = this.get("contextTokensReturned");
    const raw = this.get("estimatedRawTokens");
    return {
      githubSearchCalls: this.get("githubSearchCalls"),
      githubFilesExamined: this.get("githubFilesExamined"),
      repositoriesConsidered: this.get("repositoriesConsidered"),
      repositoriesSelected: this.get("repositoriesSelected"),
      codeIndexCalls: this.get("codeIndexCalls"),
      symbolsExamined: this.get("symbolsExamined"),
      symbolsReturned: this.get("symbolsReturned"),
      sourceTokensRetrieved: this.get("sourceTokensRetrieved"),
      contextTokensReturned: returned,
      cacheHits: this.get("cacheHits"),
      cacheMisses: this.get("cacheMisses"),
      estimatedRawTokens: raw,
      contextReductionPercent: contextReduction(raw, returned),
      wallClockMs: this.elapsedMs,
      degradedPaths: [...this.degradedPaths],
    };
  }

  /** Human-readable diagnostic block (spec §25 example output). */
  renderDiagnostics(): string {
    const m = this.snapshot();
    const lines = [
      "Implementation discovery:",
      "",
      `Repositories searched:        ${m.repositoriesConsidered}`,
      `Repositories deeply analyzed: ${m.repositoriesSelected}`,
      `Symbols examined:             ${m.symbolsExamined}`,
      `Symbols returned:             ${m.symbolsReturned}`,
      "",
      `GitHub search calls:          ${m.githubSearchCalls}`,
      `Code index calls:             ${m.codeIndexCalls}`,
      `Cache hits / misses:          ${m.cacheHits} / ${m.cacheMisses}`,
      "",
      `Estimated raw context:        ~${m.estimatedRawTokens.toLocaleString()} tokens`,
      `Returned context:             ~${m.contextTokensReturned.toLocaleString()} tokens`,
      "",
      `Context reduction:            ~${m.contextReductionPercent}%`,
      `Elapsed:                      ${m.wallClockMs} ms`,
    ];
    if (m.degradedPaths.length) {
      lines.push("", `Degraded paths:               ${m.degradedPaths.join(", ")}`);
    }
    return lines.join("\n");
  }
}

export type MetricName =
  | "githubSearchCalls"
  | "githubCodeSearchCalls"
  | "githubApiCalls"
  | "githubFilesExamined"
  | "repositoriesConsidered"
  | "repositoriesSelected"
  | "codeIndexCalls"
  | "symbolsExamined"
  | "symbolsReturned"
  | "sourceTokensRetrieved"
  | "contextTokensReturned"
  | "estimatedRawTokens"
  | "cacheHits"
  | "cacheMisses"
  | "fingerprintHits";
