/**
 * End-to-end pipeline tests against real GitHub.
 *
 * These are the tests that prove the product works, as opposed to proving the code does
 * what it was told. They are skipped without a token so `npm test` stays green on a
 * machine without credentials.
 *
 * Assertions are deliberately about *properties* rather than exact repositories: GitHub
 * results move, and a test asserting "the top result is tonyofrancis/Fetch" would fail for
 * reasons that are not bugs. What must hold is that the recommendation is a genuine
 * downloader, in the right language, with a licence verdict and honest metrics.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServices, type Services } from "../../src/core/services.js";
import { runDiscovery, runDecomposition } from "../../src/orchestration/pipeline.js";
import { SqliteCache } from "../../src/cache/sqlite.js";
import { loadConfig } from "../../src/core/config.js";
import { createLogger } from "../../src/core/logger.js";

const config = loadConfig();
const hasToken = Boolean(config.github.token);

describe.skipIf(!hasToken)("discovery pipeline (live)", () => {
  let services: Services;

  beforeAll(() => {
    services = createServices({
      config: { ...config, log: { level: "error", json: false } },
      cache: new SqliteCache({ path: ":memory:", maxEntries: 5000 }),
      logger: createLogger("error"),
    });
  });
  afterAll(() => services.close());

  it("recommends a genuine downloader for a downloader request", async () => {
    const r = await runDiscovery(services, {
      feature: "resumable background file downloader with pause and retry",
      language: "Kotlin",
      platform: "Android",
      requirements: ["pause/resume", "background execution", "retry"],
      maxDeepAnalysis: 4,
    });

    expect(r.data.candidates.length).toBeGreaterThan(0);
    const top = r.data.candidates[0]!;

    // Regression: this once returned a Room *database* library, because the pipeline
    // pursued the highest-build-priority capability instead of the sentence's subject.
    expect(r.data.task.featureId).toBe("download");
    const identity = `${top.ref.fullName} ${top.metadata.description ?? ""} ${top.metadata.topics.join(" ")}`.toLowerCase();
    expect(identity).toMatch(/download|fetch|transfer/);

    // Every recommendation must carry a licence verdict and a reuse mode.
    expect(top.license).toBeDefined();
    expect(top.license!.disclaimer).toContain("not legal advice");
    expect(top.reuse).toBeDefined();
    expect(["DIRECT_REUSE", "ADAPT", "REFERENCE_ONLY", "DO_NOT_USE"]).toContain(top.reuse!.mode);

    // And an explanation.
    expect(top.score!.reasons.length).toBeGreaterThan(1);
  }, 180_000);

  it("does not recommend an unlicensed repository over a licensed equivalent", async () => {
    const r = await runDiscovery(services, {
      feature: "resumable background file downloader with pause and retry",
      language: "Kotlin", platform: "Android", maxDeepAnalysis: 4,
    });
    const analysed = r.data.candidates.filter((c) => c.reuse);
    const top = analysed[0];
    if (top && analysed.some((c) => c.reuse!.mode === "DIRECT_REUSE")) {
      // If any directly-reusable candidate exists, the recommendation must not be one we
      // told the agent it may not copy (spec §12).
      expect(top.reuse!.mode).not.toBe("DO_NOT_USE");
    }
    for (const c of analysed) {
      if (c.reuse!.mode !== "DIRECT_REUSE") {
        expect(c.score!.reuseAdjustment?.multiplier).toBeLessThanOrEqual(1);
      }
    }
  }, 180_000);

  it("reports honest, non-inflated metrics", async () => {
    const r = await runDiscovery(services, {
      feature: "websocket reconnection with exponential backoff",
      language: "TypeScript", maxDeepAnalysis: 3,
    });
    const m = r.metrics;
    expect(m.repositoriesConsidered).toBeGreaterThan(0);
    expect(m.repositoriesSelected).toBeLessThanOrEqual(3);
    expect(m.contextTokensReturned).toBeGreaterThan(0);
    // Raw tokens count only material actually retrieved, so reduction cannot be faked.
    expect(m.estimatedRawTokens).toBeGreaterThan(m.contextTokensReturned);
    expect(m.contextReductionPercent).toBeGreaterThan(50);
    expect(m.contextReductionPercent).toBeLessThanOrEqual(100);
  }, 180_000);

  it("serves a repeated identical query from cache with no further search quota", async () => {
    const first = await runDiscovery(services, {
      feature: "LRU cache implementation", language: "Go", maxDeepAnalysis: 2,
    });
    const second = await runDiscovery(services, {
      feature: "LRU cache implementation", language: "Go", maxDeepAnalysis: 2,
    });
    expect(second.metrics.githubSearchCalls).toBe(0);
    expect(second.metrics.cacheHits).toBeGreaterThan(0);
    expect(second.metrics.wallClockMs).toBeLessThan(first.metrics.wallClockMs);
  }, 240_000);

  it("degrades rather than failing when nothing matches", async () => {
    const r = await runDiscovery(services, {
      feature: "zzzz nonexistent frobnicator qqqq",
      language: "Kotlin", maxDeepAnalysis: 1,
    });
    // No throw; a usable answer that says so.
    expect(r.text).toContain("NO CANDIDATES FOUND");
    expect(r.text).toContain("SUGGESTION");
  }, 120_000);

  it("keeps the returned context well under the configured ceiling", async () => {
    const r = await runDiscovery(services, {
      feature: "OAuth2 PKCE client", language: "TypeScript", maxDeepAnalysis: 3,
    });
    expect(r.metrics.contextTokensReturned).toBeLessThan(config.context.maxContextTokens);
  }, 180_000);
});

describe("decomposition (offline — no network, no quota)", () => {
  it("produces reusable units without touching GitHub", () => {
    const r = runDecomposition({
      requirement: "Build a social media app with authentication, feeds, messaging, notifications and media uploads",
      language: "Kotlin", platform: "Android",
    });
    expect(r.data.tasks.length).toBeGreaterThan(4);
    expect(r.text).toContain("REUSABLE IMPLEMENTATION UNITS");
    const ids = r.data.tasks.map((t) => t.featureId);
    expect(ids).toContain("auth-session");
    expect(ids).toContain("notifications");
    // Ordering must respect dependencies.
    const index = new Map(r.data.tasks.map((t, i) => [t.featureId, i]));
    for (const t of r.data.tasks) {
      for (const dep of t.dependsOn) {
        if (index.has(dep)) expect(index.get(dep)!).toBeLessThan(index.get(t.featureId)!);
      }
    }
  });

  it("is deterministic — the same requirement yields the same plan", () => {
    const a = runDecomposition({ requirement: "chat app with push notifications", language: "Swift" });
    const b = runDecomposition({ requirement: "chat app with push notifications", language: "Swift" });
    expect(a.text).toBe(b.text);
  });
});
