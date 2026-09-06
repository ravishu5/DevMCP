import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteCache } from "../../src/cache/sqlite.js";
import { NullCache, getOrCompute } from "../../src/cache/provider.js";
import {
  key, repoKey, searchKey, normaliseQuery, isCommitPinned, parseKey, isImmutableNamespace,
} from "../../src/cache/keys.js";
import { RateLimiter } from "../../src/cache/quota.js";
import { MetricsCollector } from "../../src/core/metrics.js";
import { nullLogger } from "../../src/core/logger.js";
import type { FeatureFingerprint } from "../../src/types/index.js";

describe("cache keys", () => {
  it("builds namespaced versioned keys", () => {
    expect(key("repo", "owner/name")).toBe("repo:v1:owner/name");
    expect(parseKey("repo:v1:owner/name")).toEqual({ ns: "repo", version: "v1", subject: "owner/name" });
  });

  it("pins analysis keys to a commit (spec §18 worked example)", () => {
    const k = repoKey("analysis", "owner/project", "8a72c91");
    expect(k).toBe("analysis:v1:owner/project@8a72c91");
    expect(isCommitPinned(k)).toBe(true);
  });

  it("marks unpinned keys visibly and does not claim immutability", () => {
    const k = repoKey("analysis", "owner/project");
    expect(k).toContain("@unpinned");
    expect(isCommitPinned(k)).toBe(false);
  });

  it("treats source-derived namespaces as immutable and search as not", () => {
    expect(isImmutableNamespace("analysis")).toBe(true);
    expect(isImmutableNamespace("symbols")).toBe(true);
    expect(isImmutableNamespace("search")).toBe(false);
    expect(isImmutableNamespace("repo")).toBe(false);
  });

  it("collapses near-duplicate queries onto one key (quota relief)", () => {
    const a = searchKey("search", "kotlin android downloader");
    const b = searchKey("search", "Android  Downloader   kotlin");
    expect(a).toBe(b);
  });

  it("does not collapse genuinely different queries", () => {
    expect(searchKey("search", "kotlin downloader")).not.toBe(searchKey("search", "swift downloader"));
  });

  it("is insensitive to filter key order but sensitive to filter values", () => {
    const a = searchKey("search", "q", { language: "Kotlin", stars: ">100" });
    const b = searchKey("search", "q", { stars: ">100", language: "kotlin" });
    const c = searchKey("search", "q", { language: "Swift", stars: ">100" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("ignores empty filters so absent and blank agree", () => {
    expect(searchKey("search", "q", { language: undefined })).toBe(searchKey("search", "q", {}));
  });

  it("normalises queries deterministically", () => {
    expect(normaliseQuery("  Foo   BAR foo ")).toBe("bar foo");
  });
});

describe("SqliteCache", () => {
  let cache: SqliteCache;
  let now = 1_000_000;

  beforeEach(() => {
    now = 1_000_000;
    cache = new SqliteCache({ path: ":memory:", maxEntries: 1000, now: () => now });
  });
  afterEach(() => cache.close());

  it("round-trips structured values", () => {
    cache.set("k", { a: 1, b: ["x"] }, { namespace: "repo", ttlMs: 1000 });
    expect(cache.get<{ a: number }>("k")?.value).toEqual({ a: 1, b: ["x"] });
  });

  it("expires TTL entries", () => {
    cache.set("k", "v", { ttlMs: 100, namespace: "search" });
    expect(cache.has("k")).toBe(true);
    now += 101;
    expect(cache.has("k")).toBe(false);
  });

  it("never expires commit-pinned entries", () => {
    cache.set(repoKey("analysis", "a/b", "deadbee"), { deep: true }, { ttlMs: null, namespace: "analysis" });
    now += 365 * 24 * 3_600_000;
    expect(cache.get(repoKey("analysis", "a/b", "deadbee"))).toBeDefined();
  });

  it("drops a corrupt row instead of throwing at the caller", () => {
    cache.set("k", { ok: true }, { namespace: "repo" });
    // Simulate corruption by writing invalid JSON directly.
    (cache as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } })
      .db.prepare("UPDATE entries SET value = ? WHERE key = ?").run("{not json", "k");
    expect(cache.get("k")).toBeUndefined();
    expect(cache.has("k")).toBe(false);
  });

  it("skips unserialisable values without breaking the caller", () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => cache.set("c", cyclic, { namespace: "repo" })).not.toThrow();
    expect(cache.get("c")).toBeUndefined();
  });

  it("clears a single namespace", () => {
    cache.set("search:v1:a", 1, { namespace: "search" });
    cache.set("repo:v1:b", 2, { namespace: "repo" });
    cache.clear("search");
    expect(cache.has("search:v1:a")).toBe(false);
    expect(cache.has("repo:v1:b")).toBe(true);
  });

  it("evicts expiring entries before immutable ones", () => {
    const c = new SqliteCache({ path: ":memory:", maxEntries: 10, now: () => now });
    c.set("analysis:v1:keep@abc123", "precious", { ttlMs: null, namespace: "analysis" });
    for (let i = 0; i < 200; i++) c.set(`search:v1:${i}`, i, { ttlMs: 10_000, namespace: "search" });
    expect(c.get("analysis:v1:keep@abc123")).toBeDefined();
    expect(c.stats().evictions).toBeGreaterThan(0);
    c.close();
  });

  it("reports stats by namespace", () => {
    cache.set("repo:v1:a", 1, { namespace: "repo" });
    cache.get("repo:v1:a");
    cache.get("missing");
    const s = cache.stats();
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(1);
    expect(s.byNamespace.repo).toBe(1);
  });
});

describe("feature fingerprints (knowledge base)", () => {
  let cache: SqliteCache;
  beforeEach(() => { cache = new SqliteCache({ path: ":memory:", maxEntries: 1000 }); });
  afterEach(() => cache.close());

  const fp = (repo: string, caps: Record<string, number>, language = "Kotlin"): FeatureFingerprint => ({
    repository: repo, commit: "abc1234", capabilities: caps, language,
    frameworks: ["Android"], licenseSpdx: "Apache-2.0",
    vocabularyVersion: "1", computedAt: new Date().toISOString(),
  });

  it("round-trips a fingerprint", () => {
    cache.putFingerprint(fp("owner/dl", { download: 0.94, queue: 0.81, oauth: 0.0 }));
    const got = cache.getFingerprint("owner/dl", "abc1234");
    expect(got?.capabilities.download).toBeCloseTo(0.94);
    expect(got?.capabilities.oauth).toBe(0);
    expect(got?.frameworks).toEqual(["Android"]);
  });

  it("requires ALL capabilities, not any", () => {
    cache.putFingerprint(fp("owner/full", { download: 0.9, queue: 0.8, resume: 0.85 }));
    cache.putFingerprint(fp("owner/partial", { queue: 0.9 }));
    const hits = cache.findByCapabilities(["download", "queue", "resume"]);
    expect(hits.map((h) => h.repository)).toEqual(["owner/full"]);
  });

  it("respects the strength floor", () => {
    cache.putFingerprint(fp("owner/weak", { download: 0.2, queue: 0.2 }));
    expect(cache.findByCapabilities(["download", "queue"], { minStrength: 0.5 })).toHaveLength(0);
    expect(cache.findByCapabilities(["download", "queue"], { minStrength: 0.1 })).toHaveLength(1);
  });

  it("orders by summed strength so the most complete implementation leads", () => {
    cache.putFingerprint(fp("owner/better", { download: 0.95, queue: 0.95 }));
    cache.putFingerprint(fp("owner/ok", { download: 0.6, queue: 0.6 }));
    const hits = cache.findByCapabilities(["download", "queue"]);
    expect(hits[0]?.repository).toBe("owner/better");
  });

  it("filters by language", () => {
    cache.putFingerprint(fp("owner/kt", { download: 0.9 }, "Kotlin"));
    cache.putFingerprint(fp("owner/py", { download: 0.9 }, "Python"));
    const hits = cache.findByCapabilities(["download"], { language: "kotlin" });
    expect(hits.map((h) => h.repository)).toEqual(["owner/kt"]);
  });

  it("replaces capabilities on re-fingerprint rather than accumulating", () => {
    cache.putFingerprint(fp("owner/x", { download: 0.9, stale: 0.9 }));
    cache.putFingerprint(fp("owner/x", { download: 0.5 }));
    const got = cache.getFingerprint("owner/x", "abc1234");
    expect(Object.keys(got!.capabilities).sort()).toEqual(["download"]);
  });

  it("returns nothing for an empty capability list", () => {
    expect(cache.findByCapabilities([])).toEqual([]);
  });
});

describe("getOrCompute", () => {
  it("records hits and misses and forces null TTL on immutable namespaces", async () => {
    const cache = new SqliteCache({ path: ":memory:", maxEntries: 100 });
    const m = new MetricsCollector();
    let calls = 0;
    const compute = async () => { calls++; return { v: 1 }; };

    await getOrCompute(cache, "analysis:v1:a/b@sha1", "analysis", 1000, m, compute);
    await getOrCompute(cache, "analysis:v1:a/b@sha1", "analysis", 1000, m, compute);

    expect(calls).toBe(1);
    expect(m.get("cacheHits")).toBe(1);
    expect(m.get("cacheMisses")).toBe(1);
    expect(cache.get("analysis:v1:a/b@sha1")?.expiresAt).toBeNull();
    cache.close();
  });

  it("always recomputes with NullCache", async () => {
    const cache = new NullCache();
    let calls = 0;
    await getOrCompute(cache, "k", "repo", 1000, undefined, async () => { calls++; return 1; });
    await getOrCompute(cache, "k", "repo", 1000, undefined, async () => { calls++; return 1; });
    expect(calls).toBe(2);
  });
});

describe("quota budgeting", () => {
  it("paces requests to stay under the per-minute rate", async () => {
    const rl = new RateLimiter(nullLogger, { search: { capacity: 2, windowMs: 200 } });
    const budget = rl.createBudget({ search: 10 });
    const t0 = Date.now();
    await budget.acquire("search");
    await budget.acquire("search");
    await budget.acquire("search"); // must wait for the window to roll
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
  });

  it("exhausts a per-call slice without starving the global limiter", async () => {
    const rl = new RateLimiter(nullLogger);
    const budget = rl.createBudget({ "code-search": 2 });
    await budget.acquire("code-search");
    await budget.acquire("code-search");
    expect(budget.canAfford("code-search")).toBe(false);
    await expect(budget.acquire("code-search")).rejects.toThrow(/budget exhausted/i);
    // A different call still gets its own slice.
    expect(rl.createBudget({ "code-search": 2 }).canAfford("code-search")).toBe(true);
  });

  it("trusts server headers over local accounting", async () => {
    const rl = new RateLimiter(nullLogger);
    const budget = rl.createBudget({ search: 100 });
    rl.observeHeaders("search", new Headers({
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 30),
    }));
    await expect(budget.acquire("search")).rejects.toThrow(/quota exhausted/i);
    expect(rl.snapshot().search.serverRemaining).toBe(0);
  });

  it("reports a retryAfterMs the caller can act on", async () => {
    const rl = new RateLimiter(nullLogger);
    rl.observeHeaders("core", new Headers({
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 10),
    }));
    await rl.createBudget({ core: 5 }).acquire("core").catch((e: { retryAfterMs?: number }) => {
      expect(e.retryAfterMs).toBeGreaterThan(0);
    });
  });
});
