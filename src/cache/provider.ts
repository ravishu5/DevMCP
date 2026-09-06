/**
 * CacheProvider — the pluggable storage boundary (spec §27).
 *
 * Deliberately narrow. Everything above this interface treats the cache as a plain
 * key/value store with TTLs; only the SQLite implementation knows about tables. That keeps
 * a future Redis / shared-team cache a drop-in replacement.
 *
 * The one non-obvious method is `getOrCompute`, which exists so callers cannot forget to
 * record a hit/miss metric — the accounting is inside the helper rather than at ~40 call
 * sites.
 */

import type { FeatureFingerprint } from "../types/index.js";
import type { MetricsCollector } from "../core/metrics.js";
import { isImmutableNamespace, type CacheNamespace } from "./keys.js";

export interface CacheEntry<T> {
  value: T;
  storedAt: number;
  expiresAt: number | null;
  /** Namespace the entry was written under, for stats and selective clearing. */
  namespace: string;
}

export interface CacheProvider {
  get<T>(key: string): CacheEntry<T> | undefined;
  set<T>(key: string, value: T, opts?: { ttlMs?: number | null; namespace?: CacheNamespace }): void;
  has(key: string): boolean;
  delete(key: string): void;
  /** Drop everything, or one namespace. */
  clear(namespace?: CacheNamespace): void;
  stats(): CacheStats;
  close(): void;

  // --- knowledge base -------------------------------------------------------
  /**
   * Feature fingerprints — the seed of the Implementation Knowledge
   * Base. Kept on the interface rather than bolted on later, because the ability to
   * shortlist repositories *without* GitHub search is a first-class capability, not a
   * caching detail.
   */
  putFingerprint(fp: FeatureFingerprint): void;
  getFingerprint(repository: string, commit: string): FeatureFingerprint | undefined;
  /** Repositories known to evidence ALL of `capabilities` at `minStrength` or better. */
  findByCapabilities(
    capabilities: string[],
    opts?: { minStrength?: number; language?: string; limit?: number },
  ): FeatureFingerprint[];
}

export interface CacheStats {
  entries: number;
  hits: number;
  misses: number;
  writes: number;
  evictions: number;
  bytes?: number;
  fingerprints: number;
  byNamespace: Record<string, number>;
}

/**
 * Read-through helper.
 *
 * Immutable namespaces (commit-pinned) get `ttl = null` automatically — the caller cannot
 * accidentally put an expiry on analysis that can never go stale.
 */
export async function getOrCompute<T>(
  cache: CacheProvider,
  cacheKey: string,
  namespace: CacheNamespace,
  ttlMs: number | null,
  metrics: MetricsCollector | undefined,
  compute: () => Promise<T>,
): Promise<T> {
  const hit = cache.get<T>(cacheKey);
  if (hit !== undefined) {
    metrics?.add("cacheHits");
    return hit.value;
  }
  metrics?.add("cacheMisses");
  const value = await compute();
  cache.set(cacheKey, value, {
    ttlMs: isImmutableNamespace(namespace) ? null : ttlMs,
    namespace,
  });
  return value;
}

/** No-op cache. Used when ENABLE_CACHE=false and in tests that must hit real code paths. */
export class NullCache implements CacheProvider {
  private s: CacheStats = {
    entries: 0, hits: 0, misses: 0, writes: 0, evictions: 0, fingerprints: 0, byNamespace: {},
  };
  get<T>(): CacheEntry<T> | undefined { this.s.misses++; return undefined; }
  set<T>(): void { this.s.writes++; }
  has(): boolean { return false; }
  delete(): void {}
  clear(): void {}
  stats(): CacheStats { return { ...this.s }; }
  close(): void {}
  putFingerprint(): void {}
  getFingerprint(): FeatureFingerprint | undefined { return undefined; }
  findByCapabilities(): FeatureFingerprint[] { return []; }
}
