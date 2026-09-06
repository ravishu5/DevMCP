/**
 * Live GitHub integration tests.
 *
 * These hit the real API. They are skipped automatically when no token is available, so
 * `npm test` stays green on a machine without credentials — a test suite that fails for
 * environmental reasons trains people to ignore failures.
 *
 * Deliberately frugal: search quota is 30/min shared with everything else on the machine,
 * so this file makes a handful of calls against one stable, well-known repository.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GitHubClient } from "../../src/providers/github/client.js";
import { RestGitHubProvider } from "../../src/providers/github/provider.js";
import { SqliteCache } from "../../src/cache/sqlite.js";
import { RateLimiter } from "../../src/cache/quota.js";
import { Sanitizer } from "../../src/security/sanitize.js";
import { createLogger, nullLogger } from "../../src/core/logger.js";
import { MetricsCollector } from "../../src/core/metrics.js";
import { loadConfig } from "../../src/core/config.js";

const config = loadConfig();
const hasToken = Boolean(config.github.token);

describe.skipIf(!hasToken)("GitHub provider (live)", () => {
  let provider: RestGitHubProvider;
  let cache: SqliteCache;
  let metrics: MetricsCollector;

  beforeAll(() => {
    cache = new SqliteCache({ path: ":memory:", maxEntries: 1000 });
    const sanitizer = new Sanitizer();
    const limiter = new RateLimiter(nullLogger);
    metrics = new MetricsCollector();
    const client = new GitHubClient({
      apiBase: config.github.apiBase,
      token: config.github.token,
      userAgent: config.github.userAgent,
      timeoutMs: config.github.timeoutMs,
      logger: createLogger("warn"),
      limiter, sanitizer,
    });
    provider = new RestGitHubProvider({
      client, cache, sanitizer, logger: nullLogger, metrics,
      budget: limiter.createBudget({ core: 40, search: 4, "code-search": 1 }),
      searchTtlMs: 3_600_000, metadataTtlMs: 3_600_000,
    });
  });

  afterAll(() => cache.close());

  it("searches repositories and returns usable metadata", async () => {
    const results = await provider.searchRepositories("resumable download", {
      language: "Kotlin", perPage: 10,
    });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.ref.fullName).toMatch(/^[\w.-]+\/[\w.-]+$/);
      expect(r.isFork).toBe(false);       // fork:false was applied server-side
      expect(r.archived).toBe(false);
      expect(typeof r.stars).toBe("number");
    }
  }, 60_000);

  it("fetches metadata, licence and languages for a known repository", async () => {
    const md = await provider.getRepository("square/okhttp");
    expect(md.language).toBe("Kotlin");
    expect(md.stars).toBeGreaterThan(10_000);
    expect(md.licenseSpdx).toBe("Apache-2.0");

    const lic = await provider.getLicense("square/okhttp");
    expect(lic?.spdx).toBe("Apache-2.0");
    expect(lic?.text).toContain("Apache License");

    const langs = await provider.getLanguages("square/okhttp");
    expect(Object.keys(langs).length).toBeGreaterThan(0);
  }, 60_000);

  it("resolves a real commit SHA for cache pinning", async () => {
    const sha = await provider.resolveCommit("square/okhttp");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    // Second call must be served from cache, not the network.
    const before = metrics.get("githubApiCalls");
    await provider.resolveCommit("square/okhttp");
    expect(metrics.get("githubApiCalls")).toBe(before);
  }, 60_000);

  it("reads the tree and extracts real dependencies", async () => {
    const tree = await provider.getTree("square/okhttp");
    expect(tree.length).toBeGreaterThan(50);
    expect(tree.every((e) => !e.path.startsWith("/") && !e.path.includes(".."))).toBe(true);

    const { deps, manifests } = await provider.getManifestDependencies("square/okhttp");
    expect(manifests.length).toBeGreaterThan(0);
    expect(deps.length).toBeGreaterThan(0);
  }, 120_000);

  it("reads a README and returns it sanitised", async () => {
    const readme = await provider.getReadme("square/okhttp");
    expect(readme).not.toBeNull();
    expect(readme!.content.length).toBeGreaterThan(100);
  }, 60_000);

  it("reports commit activity and releases", async () => {
    const act = await provider.getCommitActivity("square/okhttp");
    expect(act.lastCommitAt).toBeTruthy();
    // okhttp publishes git TAGS but no GitHub Release objects — the fallback must find
    // them, or we would score one of the most mature Android libraries as "never released".
    const rel = await provider.getReleases("square/okhttp");
    expect(rel.count).toBeGreaterThan(0);
    expect(rel.source).toBe("tags");
    expect(rel.latestTag).toBeTruthy();
  }, 60_000);

  it("returns a typed not-found error for a nonexistent repository", async () => {
    await expect(
      provider.getRepository("this-owner-does-not-exist-xyz/nor-does-this-repo-xyz"),
    ).rejects.toMatchObject({ kind: "not-found" });
  }, 30_000);
});

describe.skipIf(hasToken)("GitHub provider (live) — skipped", () => {
  it("has no token available, so live tests did not run", () => {
    expect(hasToken).toBe(false);
  });
});
