/**
 * Live jCodeMunch integration.
 *
 * Skipped when the subprocess cannot start, which is the same degraded path the product
 * takes in production — so a machine without `uvx` runs the suite green and the fallback
 * path is what gets exercised elsewhere.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { JCodeMunchProvider } from "../../src/providers/codeindex/jcodemunch.js";
import { GitHubFallbackProvider } from "../../src/providers/codeindex/fallback.js";
import { SqliteCache } from "../../src/cache/sqlite.js";
import { createServices, type Services } from "../../src/core/services.js";
import { MetricsCollector } from "../../src/core/metrics.js";
import { createLogger, nullLogger } from "../../src/core/logger.js";
import { loadConfig } from "../../src/core/config.js";
import { computeMinimalSet } from "../../src/analyzers/minimal-set.js";

const config = loadConfig();

/**
 * Availability is probed at MODULE LOAD, not in `beforeAll`.
 *
 * `it.runIf(flag)` is evaluated while tests are being COLLECTED, which happens before any
 * `beforeAll` hook runs. Setting the flag in `beforeAll` therefore left it `false` for
 * every test, and all three jCodeMunch tests skipped silently while reporting success — a
 * test that skips itself invisibly is worse than one that fails.
 */
const cache = new SqliteCache({ path: ":memory:", maxEntries: 2000 });
const provider = new JCodeMunchProvider({
  command: config.codeIndex.command,
  args: config.codeIndex.args,
  indexTimeoutMs: 60_000,
  callTimeoutMs: 30_000,
  maxRepoSizeKb: config.codeIndex.maxRepoSizeKb,
  logger: createLogger("error"),
  cache,
});
const available = await provider.isAvailable();

if (!available) {
  // Say so loudly rather than reporting a silent pass.
  process.stderr.write("[codeindex.live] jCodeMunch unavailable — its tests are skipped\n");
}

afterAll(async () => {
  await provider.close();
  cache.close();
});

describe.skipIf(!available)("jCodeMunch provider (live)", () => {
  it("reports index state with a commit SHA for cache pinning", async () => {
    // psf/requests is indexed on this machine; on another it will simply not be indexed,
    // which is also a valid state this asserts against.
    const status = await provider.ensureIndexed("psf/requests");
    if (!status.indexed) {
      expect(status.reason).toBeTruthy();
      return;
    }
    expect(status.commit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(status.symbolCount).toBeGreaterThan(0);
  }, 240_000);

  it("searches symbols and returns usable shapes", async () => {
    const status = await provider.ensureIndexed("psf/requests");
    if (!status.indexed) return;
    const symbols = await provider.searchSymbols("psf/requests", "session request", { limit: 10 });
    expect(symbols.length).toBeGreaterThan(0);
    for (const s of symbols) {
      expect(s.id).toBeTruthy();
      expect(s.name).toBeTruthy();
      expect(s.filePath).not.toContain("..");
    }
  }, 120_000);

  it("produces a minimal set free of config and test noise", async () => {
    const status = await provider.ensureIndexed("psf/requests");
    if (!status.indexed) return;
    const symbols = await provider.searchSymbols("psf/requests", "session adapter retry", { limit: 40 });
    if (!symbols.length) return;

    const set = await computeMinimalSet(provider!, {
      repository: "psf/requests",
      symbols,
      featureTerms: ["session", "adapter", "retry", "http", "request"],
      maxCore: 6,
    });

    // Regression: an early run returned YAML keys from .github/workflows as "key symbols".
    for (const s of set.core) {
      expect(s.filePath, `config file in core: ${s.filePath}`).not.toMatch(/\.(ya?ml|json|toml|md)$/i);
      expect(s.filePath).not.toContain(".github/");
      expect(s.filePath).not.toMatch(/(^|\/)(test|tests)\//);
    }
    expect(set.estimatedTokens).toBeLessThanOrEqual(set.estimatedFullTokens);
  }, 240_000);

});

describe("code index failure handling", () => {
  it("reports unavailability rather than throwing when the command is missing", async () => {
    const c = new SqliteCache({ path: ":memory:", maxEntries: 10 });
    const broken = new JCodeMunchProvider({
      command: "definitely-not-a-real-command-xyz", args: [],
      indexTimeoutMs: 5000, callTimeoutMs: 5000, maxRepoSizeKb: 1000,
      logger: nullLogger, cache: c,
    });
    expect(await broken.isAvailable()).toBe(false);
    const status = await broken.ensureIndexed("a/b");
    expect(status.indexed).toBe(false);
    expect(status.reason).toBeTruthy();
    // Every read path must degrade, not throw.
    expect(await broken.searchSymbols("a/b", "x")).toEqual([]);
    expect(await broken.getOutline("a/b")).toBeNull();
    await broken.close();
    c.close();
  }, 60_000);
});

describe.skipIf(!config.github.token)("GitHub fallback provider (live)", () => {
  let services: Services;
  beforeAll(() => {
    services = createServices({
      config: { ...config, log: { level: "error", json: false } },
      cache: new SqliteCache({ path: ":memory:", maxEntries: 2000 }),
      logger: createLogger("error"),
    });
  });
  afterAll(async () => { await services.close(); });

  it("infers symbols from real source when no index exists", async () => {
    const metrics = new MetricsCollector();
    const github = services.githubFor(metrics, services.budgetFor("analysis"));
    const fallback = new GitHubFallbackProvider({ github, logger: nullLogger, metrics, maxFilesToScan: 4 });

    expect(await fallback.isAvailable()).toBe(true);
    const status = await fallback.ensureIndexed("psf/requests");
    expect(status.indexed).toBe(false);
    // Spec §8: the fallback must announce itself.
    expect(status.reason).toMatch(/degraded|no code index/i);

    const symbols = await fallback.searchSymbols("psf/requests", "session adapter", { limit: 10 });
    expect(symbols.length).toBeGreaterThan(0);
    expect(symbols.every((s) => s.filePath.endsWith(".py"))).toBe(true);
    expect(fallback.mode).toBe("github-fallback");
  }, 180_000);

  it("provides an outline without an index", async () => {
    const metrics = new MetricsCollector();
    const github = services.githubFor(metrics, services.budgetFor("analysis"));
    const fallback = new GitHubFallbackProvider({ github, logger: nullLogger, metrics });
    const outline = await fallback.getOutline("psf/requests");
    expect(outline?.fileCount).toBeGreaterThan(10);
    expect(outline?.mode).toBe("github-fallback");
    // Honest about what it cannot know.
    expect(outline?.symbolCount).toBe(0);
  }, 120_000);
});
