import { describe, it, expect } from "vitest";
import { estimateTokens, estimateJsonTokens, TokenBudget, contextReduction } from "../../src/core/tokens.js";
import { MetricsCollector } from "../../src/core/metrics.js";
import { loadConfig, normaliseWeights, DEFAULT_WEIGHTS, redactedConfig } from "../../src/core/config.js";
import { IntelligenceError, degradeOnError } from "../../src/core/errors.js";
import type { Degradation } from "../../src/types/index.js";

describe("token estimation", () => {
  it("returns 0 only for empty input", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBeGreaterThan(0);
  });

  it("charges code more per character than prose", () => {
    const s = "const downloadManager = new DownloadManager({ retry: true });";
    expect(estimateTokens(s, "code")).toBeGreaterThan(estimateTokens(s, "prose"));
  });

  it("scales roughly linearly with length", () => {
    const one = estimateTokens("x".repeat(400));
    const two = estimateTokens("x".repeat(800));
    expect(two / one).toBeGreaterThan(1.8);
    expect(two / one).toBeLessThan(2.2);
  });

  it("survives unserialisable values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(estimateJsonTokens(cyclic)).toBe(0);
  });
});

describe("TokenBudget", () => {
  it("refuses reservations that do not fit and leaves state untouched", () => {
    const b = new TokenBudget(100);
    expect(b.tryReserve("a", 60)).toBe(true);
    expect(b.tryReserve("b", 60)).toBe(false);
    expect(b.used).toBe(60);
    expect(b.remaining).toBe(40);
  });

  it("forceReserve can exceed the limit for must-have content", () => {
    const b = new TokenBudget(10);
    b.forceReserve("license", 50);
    expect(b.used).toBe(50);
    expect(b.remaining).toBe(0);
  });

  it("reports breakdown largest-first", () => {
    const b = new TokenBudget(1000);
    b.tryReserve("small", 10);
    b.tryReserve("big", 500);
    expect(b.breakdown()[0]?.label).toBe("big");
  });

  it("slices a child budget from what remains", () => {
    const b = new TokenBudget(1000);
    b.tryReserve("x", 500);
    expect(b.slice(0.5).limit).toBe(250);
  });
});

describe("contextReduction", () => {
  it("computes the headline metric", () => {
    expect(contextReduction(74_000, 6_200)).toBeCloseTo(91.6, 1);
  });
  it("clamps rather than reporting negative reduction", () => {
    expect(contextReduction(100, 500)).toBe(0);
    expect(contextReduction(0, 500)).toBe(0);
  });
});

describe("MetricsCollector", () => {
  it("accumulates and snapshots", () => {
    const m = new MetricsCollector();
    m.add("repositoriesConsidered", 37);
    m.add("repositoriesSelected", 5);
    m.add("estimatedRawTokens", 74_000);
    m.add("contextTokensReturned", 6_200);
    m.markDegraded("code-index:unavailable");
    const s = m.snapshot();
    expect(s.repositoriesConsidered).toBe(37);
    expect(s.contextReductionPercent).toBeCloseTo(91.6, 1);
    expect(s.degradedPaths).toEqual(["code-index:unavailable"]);
    expect(m.renderDiagnostics()).toContain("Context reduction");
  });

  it("times stages without altering their result", async () => {
    const m = new MetricsCollector();
    const out = await m.time("stage", async () => 42);
    expect(out).toBe(42);
    expect(m.stageTimings().stage).toBeGreaterThanOrEqual(0);
  });
});

describe("errors", () => {
  it("converts to a non-fatal degradation", () => {
    const e = new IntelligenceError("boom", { kind: "not-found", stage: "github.getRepo", subject: "a/b" });
    const d = e.toDegradation("skipped candidate");
    expect(d.severity).toBe("info");
    expect(d.subject).toBe("a/b");
    expect(d.fallback).toBe("skipped candidate");
  });

  it("marks transient kinds retryable by default", () => {
    expect(new IntelligenceError("x", { kind: "rate-limit", stage: "s" }).retryable).toBe(true);
    expect(new IntelligenceError("x", { kind: "auth", stage: "s" }).retryable).toBe(false);
  });

  it("degradeOnError keeps the pipeline running", async () => {
    const sink: Degradation[] = [];
    const v = await degradeOnError(async () => { throw new Error("nope"); }, { stage: "s", subject: "a/b" }, "fallback", sink);
    expect(v).toBe("fallback");
    expect(sink).toHaveLength(1);
    expect(sink[0]?.reason).toContain("nope");
  });
});

describe("config", () => {
  it("loads with an empty environment and never throws", () => {
    const c = loadConfig({ GITHUB_USE_GH_CLI: "false" } as NodeJS.ProcessEnv);
    expect(c.discovery.maxRepositories).toBeGreaterThan(0);
    expect(c.github.tokenSource).toBe("none");
  });

  it("rejects a nonsensical numeric value loudly", () => {
    expect(() => loadConfig({ MAX_REPOSITORIES: "-5", GITHUB_USE_GH_CLI: "false" } as NodeJS.ProcessEnv)).toThrow(/MAX_REPOSITORIES/);
  });

  it("rejects malformed ranking weights", () => {
    expect(() => loadConfig({ RANKING_WEIGHTS: "{", GITHUB_USE_GH_CLI: "false" } as NodeJS.ProcessEnv)).toThrow(/RANKING_WEIGHTS/);
    expect(() => loadConfig({ RANKING_WEIGHTS: '{"popularity":-1}', GITHUB_USE_GH_CLI: "false" } as NodeJS.ProcessEnv)).toThrow(/non-negative/);
  });

  it("normalises weights to sum to 1", () => {
    const w = normaliseWeights({ ...DEFAULT_WEIGHTS });
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it("lets an explicit environment override the ambient one", () => {
    // Regression: the merge order was `{ ...env, ...process.env }`, so process.env (and
    // anything a stray .env put there) silently shadowed the caller's explicit values.
    const previous = process.env.MAX_REPOSITORIES;
    process.env.MAX_REPOSITORIES = "999";
    try {
      const c = loadConfig({ MAX_REPOSITORIES: "7", GITHUB_USE_GH_CLI: "false" } as NodeJS.ProcessEnv);
      expect(c.discovery.maxRepositories).toBe(7);
    } finally {
      if (previous === undefined) delete process.env.MAX_REPOSITORIES;
      else process.env.MAX_REPOSITORIES = previous;
    }
  });

  it("still reads the ambient environment when no override is given", () => {
    const previous = process.env.MAX_REPOSITORIES;
    process.env.MAX_REPOSITORIES = "11";
    try {
      expect(loadConfig({ GITHUB_USE_GH_CLI: "false" } as NodeJS.ProcessEnv).discovery.maxRepositories).toBe(11);
    } finally {
      if (previous === undefined) delete process.env.MAX_REPOSITORIES;
      else process.env.MAX_REPOSITORIES = previous;
    }
  });

  it("never leaks the token in the redacted view", () => {
    const token = "gh" + "p_SECRETVALUE";
    const c = loadConfig({ GITHUB_TOKEN: token, GITHUB_USE_GH_CLI: "false" } as NodeJS.ProcessEnv);
    expect(c.github.token).toBe(token);
    expect(JSON.stringify(redactedConfig(c))).not.toContain("SECRETVALUE");
  });
});
