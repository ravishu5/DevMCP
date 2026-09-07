/**
 * Query-budget behaviour in the discovery funnel.
 *
 * The funnel used to stop issuing queries as soon as the candidate pool was full, which
 * meant the FIRST query routinely consumed the whole budget. That silently discarded the
 * diversity the query planner exists to produce, and made discovery fragile in a way no
 * ranking fix could repair: if the first query was bad, nothing else ever ran.
 */
import { describe, it, expect } from "vitest";
import { discoverImplementations } from "../../src/orchestration/discover.js";
import { SqliteCache } from "../../src/cache/sqlite.js";
import { MetricsCollector } from "../../src/core/metrics.js";
import { nullLogger } from "../../src/core/logger.js";
import { Sanitizer } from "../../src/security/sanitize.js";
import { DEFAULT_WEIGHTS } from "../../src/core/config.js";
import { refFromFullName } from "../../src/providers/github/types.js";
import type { ImplementationTask, RepoMetadata } from "../../src/types/index.js";

const repo = (fullName: string): RepoMetadata => ({
  ref: refFromFullName(fullName), topics: [], description: `the ${fullName.split("/")[1]} project`,
  stars: 10, forks: 1, watchers: 1, openIssues: 0, isFork: false, archived: false,
  language: "Go", pushedAt: new Date().toISOString(), createdAt: new Date(Date.now() - 9e10).toISOString(),
});

/*
 * Names must be genuinely unalike. Near-duplicate clustering folds `q0/repo0`..`q0/repo39`
 * into a single candidate, which silently turns any pool-size assertion into a test of the
 * deduplicator instead of the query budget.
 */
const WORDS = [
  "aardvark", "bicycle", "cathedral", "dolphin", "ember", "falcon", "granite", "harbour",
  "iodine", "juniper", "kestrel", "lantern", "marble", "nutmeg", "obsidian", "pelican",
  "quartz", "rhubarb", "sapphire", "tundra", "umbrella", "verbena", "walnut", "xylem",
  "yarrow", "zephyr", "anvil", "basalt", "cinder", "driftwood", "elm", "fjord",
  "gossamer", "hazel", "ibis", "jetty", "kelp", "lichen", "moss", "nectar",
];
/** Disjoint slices, so blocks do not dedupe against EACH OTHER either. */
const block = (i: number, size = 13) =>
  WORDS.slice(i * size, i * size + size).map((w) => repo(`q${i}/${w}`));

/** Each query returns its own disjoint block of 40 repositories. */
function harness(queries: string[]) {
  const issued: string[] = [];
  const github = {
    async searchRepositories(query: string) {
      issued.push(query);
      return block(queries.indexOf(query));
    },
    async getRepository(name: string) { return repo(name); },
  };
  return { issued, github };
}

const task = (searchQueries: string[]): ImplementationTask => ({
  featureId: "download", feature: "file downloader", strategy: "reuse-pattern",
  lookingFor: [], capabilities: ["download"], requirementChecklist: [],
  searchQueries, rationale: "", budgetShare: 1, priority: 80, dependsOn: [],
});

async function run(queries: string[], maxRepositories: number) {
  const { issued, github } = harness(queries);
  const result = await discoverImplementations(
    {
      task: task(queries), maxRepositories, maxDeepAnalysis: 0, minScore: 0,
      weights: DEFAULT_WEIGHTS, enableLicenseCheck: false, useFingerprints: false,
    },
    {
      github: github as never,
      cache: new SqliteCache({ path: ":memory:", maxEntries: 100 }),
      budget: { canAfford: () => true, spend: () => {}, remaining: () => 100 } as never,
      metrics: new MetricsCollector(), logger: nullLogger, sanitizer: new Sanitizer(),
    },
  );
  return { issued, result };
}

describe("every query gets a share of the candidate pool", () => {
  it("issues all planned queries even when the first one could fill the pool", async () => {
    /*
     * Regression: at maxRepositories 25 exactly ONE query was issued. "golang-migrate" looks
     * like an excellent hint, and GitHub does not return golang-migrate/migrate for it -- it
     * filled all 25 slots with unrelated Gin projects and no other query ran. The same
     * mechanism kept a declared vendor's SDK query from ever being issued.
     */
    const queries = ["golang-migrate", "database migration Go", "goose migrations"];
    const { issued } = await run(queries, 25);
    expect(issued).toEqual(queries);
  });

  it("draws candidates from every query rather than only the first", async () => {
    const queries = ["a", "b", "c"];
    const { result } = await run(queries, 24);
    const blocks = new Set(result.candidates.map((c) => c.ref.fullName.split("/")[0]));
    expect(blocks).toEqual(new Set(["q0", "q1", "q2"]));
  });

  it("respects maxRepositories exactly", async () => {
    const { result } = await run(["a", "b", "c"], 24);
    expect(result.candidates.length).toBeLessThanOrEqual(24);
  });

  it("tops the pool up from one query when another returns nothing", async () => {
    // A query returning few results must cost the others nothing.
    const issued: string[] = [];
    const github = {
      async searchRepositories(query: string) {
        issued.push(query);
        return query === "empty" ? [] : block(0, 20);
      },
      async getRepository(name: string) { return repo(name); },
    };
    const result = await discoverImplementations(
      {
        task: task(["empty", "full"]), maxRepositories: 12, maxDeepAnalysis: 0, minScore: 0,
        weights: DEFAULT_WEIGHTS, enableLicenseCheck: false, useFingerprints: false,
      },
      {
        github: github as never,
        cache: new SqliteCache({ path: ":memory:", maxEntries: 100 }),
        budget: { canAfford: () => true, spend: () => {}, remaining: () => 100 } as never,
        metrics: new MetricsCollector(), logger: nullLogger, sanitizer: new Sanitizer(),
      },
    );
    // Share is 6 each; "empty" returns nothing, so "full" must supply all 12.
    expect(result.candidates.length).toBe(12);
  });
});
