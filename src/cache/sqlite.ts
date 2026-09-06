/**
 * SQLite-backed cache and knowledge store (spec §18, §27).
 *
 * Two tables, on purpose:
 *
 *   entries      — the generic KV cache
 *   fingerprints — capability observations per repo@commit, queryable by capability
 *
 * The fingerprint table is *not* just cache. It is the first increment of the
 * Implementation Knowledge Base: a query for "download queue
 * implementations" can be answered from it without spending any GitHub search quota. It is
 * stored relationally (one row per repo × capability) rather than as an opaque JSON blob
 * precisely so that capability lookup is an index scan rather than a full table decode.
 *
 * `better-sqlite3` is synchronous. That is a feature here — cache reads happen inside hot
 * loops, and an async cache would force every call site to be async for no benefit, since
 * a local SQLite read is faster than the promise machinery around it.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { FeatureFingerprint } from "../types/index.js";
import type { CacheEntry, CacheProvider, CacheStats } from "./provider.js";
import { parseKey, type CacheNamespace } from "./keys.js";

const SCHEMA_VERSION = 1;

export interface SqliteCacheOptions {
  path: string;
  maxEntries: number;
  /** Injected in tests so expiry can be exercised without waiting. */
  now?: () => number;
}

export class SqliteCache implements CacheProvider {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private hits = 0;
  private misses = 0;
  private writes = 0;
  private evictions = 0;

  private readonly stmts: {
    get: Database.Statement;
    set: Database.Statement;
    del: Database.Statement;
    count: Database.Statement;
    byNs: Database.Statement;
    purgeExpired: Database.Statement;
    evictOldest: Database.Statement;
    putFp: Database.Statement;
    delFpCaps: Database.Statement;
    putFpCap: Database.Statement;
    getFp: Database.Statement;
    getFpCaps: Database.Statement;
    countFp: Database.Statement;
  };

  constructor(opts: SqliteCacheOptions) {
    this.now = opts.now ?? Date.now;
    this.maxEntries = opts.maxEntries;

    if (opts.path !== ":memory:") mkdirSync(dirname(opts.path), { recursive: true });
    this.db = new Database(opts.path);

    // WAL: concurrent readers while a long analysis writes. journal_mode is persistent,
    // so this is a no-op on reopen. synchronous=NORMAL is safe for a cache — the worst
    // case on power loss is a lost cache entry, which we simply recompute.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");

    this.migrate();

    this.stmts = {
      get: this.db.prepare("SELECT value, stored_at, expires_at, namespace FROM entries WHERE key = ?"),
      set: this.db.prepare(
        `INSERT INTO entries (key, value, stored_at, expires_at, namespace)
         VALUES (@key, @value, @storedAt, @expiresAt, @namespace)
         ON CONFLICT(key) DO UPDATE SET
           value=excluded.value, stored_at=excluded.stored_at,
           expires_at=excluded.expires_at, namespace=excluded.namespace`,
      ),
      del: this.db.prepare("DELETE FROM entries WHERE key = ?"),
      count: this.db.prepare("SELECT COUNT(*) AS n FROM entries"),
      byNs: this.db.prepare("SELECT namespace, COUNT(*) AS n FROM entries GROUP BY namespace"),
      purgeExpired: this.db.prepare("DELETE FROM entries WHERE expires_at IS NOT NULL AND expires_at <= ?"),
      // Eviction prefers expiring entries over immutable ones: an entry with no expiry is
      // commit-pinned analysis that was expensive to compute and can never go stale, so it
      // is the last thing we want to throw away.
      evictOldest: this.db.prepare(
        `DELETE FROM entries WHERE key IN (
           SELECT key FROM entries
           ORDER BY (expires_at IS NULL) ASC, stored_at ASC
           LIMIT ?)`,
      ),
      putFp: this.db.prepare(
        `INSERT INTO fingerprints (repository, commit_sha, language, frameworks, license_spdx, vocabulary_version, computed_at)
         VALUES (@repository, @commit, @language, @frameworks, @license, @vocab, @computedAt)
         ON CONFLICT(repository, commit_sha) DO UPDATE SET
           language=excluded.language, frameworks=excluded.frameworks,
           license_spdx=excluded.license_spdx, vocabulary_version=excluded.vocabulary_version,
           computed_at=excluded.computed_at`,
      ),
      delFpCaps: this.db.prepare("DELETE FROM fingerprint_capabilities WHERE repository = ? AND commit_sha = ?"),
      putFpCap: this.db.prepare(
        `INSERT INTO fingerprint_capabilities (repository, commit_sha, capability, strength)
         VALUES (?, ?, ?, ?)`,
      ),
      getFp: this.db.prepare("SELECT * FROM fingerprints WHERE repository = ? AND commit_sha = ?"),
      getFpCaps: this.db.prepare(
        "SELECT capability, strength FROM fingerprint_capabilities WHERE repository = ? AND commit_sha = ?",
      ),
      countFp: this.db.prepare("SELECT COUNT(*) AS n FROM fingerprints"),
    };

    this.stmts.purgeExpired.run(this.now());
  }

  private migrate(): void {
    const current = (this.db.pragma("user_version", { simple: true }) as number) ?? 0;
    if (current >= SCHEMA_VERSION) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        stored_at  INTEGER NOT NULL,
        expires_at INTEGER,
        namespace  TEXT NOT NULL DEFAULT 'unknown'
      );
      CREATE INDEX IF NOT EXISTS idx_entries_expires   ON entries(expires_at);
      CREATE INDEX IF NOT EXISTS idx_entries_namespace ON entries(namespace);

      CREATE TABLE IF NOT EXISTS fingerprints (
        repository         TEXT NOT NULL,
        commit_sha         TEXT NOT NULL,
        language           TEXT,
        frameworks         TEXT NOT NULL DEFAULT '[]',
        license_spdx       TEXT,
        vocabulary_version TEXT NOT NULL,
        computed_at        TEXT NOT NULL,
        PRIMARY KEY (repository, commit_sha)
      );

      CREATE TABLE IF NOT EXISTS fingerprint_capabilities (
        repository TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        capability TEXT NOT NULL,
        strength   REAL NOT NULL,
        PRIMARY KEY (repository, commit_sha, capability)
      );
      CREATE INDEX IF NOT EXISTS idx_fpcap_capability ON fingerprint_capabilities(capability, strength DESC);
    `);
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  get<T>(key: string): CacheEntry<T> | undefined {
    const row = this.stmts.get.get(key) as
      | { value: string; stored_at: number; expires_at: number | null; namespace: string }
      | undefined;
    if (!row) { this.misses++; return undefined; }

    if (row.expires_at !== null && row.expires_at <= this.now()) {
      this.stmts.del.run(key);
      this.misses++;
      return undefined;
    }

    try {
      return {
        value: JSON.parse(row.value) as T,
        storedAt: row.stored_at,
        expiresAt: row.expires_at,
        namespace: row.namespace,
      };
    } catch {
      // A corrupt row is a cache problem, never a caller problem: drop it and miss.
      this.stmts.del.run(key);
      this.misses++;
      return undefined;
    } finally {
      if (row.expires_at === null || row.expires_at > this.now()) this.hits++;
    }
  }

  set<T>(key: string, value: T, opts?: { ttlMs?: number | null; namespace?: CacheNamespace }): void {
    let serialised: string;
    try {
      serialised = JSON.stringify(value);
    } catch {
      return; // Unserialisable value: skip silently rather than break the caller.
    }
    if (serialised === undefined) return;

    const now = this.now();
    const ttl = opts?.ttlMs;
    this.stmts.set.run({
      key,
      value: serialised,
      storedAt: now,
      expiresAt: ttl === null || ttl === undefined ? null : now + ttl,
      namespace: opts?.namespace ?? parseKey(key)?.ns ?? "unknown",
    });
    this.writes++;
    this.enforceLimit();
  }

  private enforceLimit(): void {
    // Amortised: only check periodically, since COUNT(*) on every write is wasteful.
    if (this.writes % 64 !== 0) return;
    const n = (this.stmts.count.get() as { n: number }).n;
    if (n <= this.maxEntries) return;
    this.stmts.purgeExpired.run(this.now());
    const after = (this.stmts.count.get() as { n: number }).n;
    if (after > this.maxEntries) {
      const excess = after - this.maxEntries;
      this.stmts.evictOldest.run(excess);
      this.evictions += excess;
    }
  }

  has(key: string): boolean { return this.get(key) !== undefined; }
  delete(key: string): void { this.stmts.del.run(key); }

  clear(namespace?: CacheNamespace): void {
    if (namespace) this.db.prepare("DELETE FROM entries WHERE namespace = ?").run(namespace);
    else this.db.exec("DELETE FROM entries");
  }

  stats(): CacheStats {
    const byNamespace: Record<string, number> = {};
    for (const r of this.stmts.byNs.all() as { namespace: string; n: number }[]) {
      byNamespace[r.namespace] = r.n;
    }
    return {
      entries: (this.stmts.count.get() as { n: number }).n,
      hits: this.hits,
      misses: this.misses,
      writes: this.writes,
      evictions: this.evictions,
      fingerprints: (this.stmts.countFp.get() as { n: number }).n,
      byNamespace,
    };
  }

  close(): void { this.db.close(); }

  // --- knowledge base -------------------------------------------------------

  putFingerprint(fp: FeatureFingerprint): void {
    const tx = this.db.transaction((f: FeatureFingerprint) => {
      this.stmts.putFp.run({
        repository: f.repository.toLowerCase(),
        commit: f.commit,
        language: f.language ?? null,
        frameworks: JSON.stringify(f.frameworks ?? []),
        license: f.licenseSpdx ?? null,
        vocab: f.vocabularyVersion,
        computedAt: f.computedAt,
      });
      this.stmts.delFpCaps.run(f.repository.toLowerCase(), f.commit);
      for (const [cap, strength] of Object.entries(f.capabilities)) {
        // Absent means "never looked"; a zero-strength row means "looked, found nothing".
        // Both are useful, so we store zeros rather than filtering them out.
        this.stmts.putFpCap.run(f.repository.toLowerCase(), f.commit, cap, strength);
      }
    });
    tx(fp);
  }

  getFingerprint(repository: string, commit: string): FeatureFingerprint | undefined {
    const row = this.stmts.getFp.get(repository.toLowerCase(), commit) as
      | {
          repository: string; commit_sha: string; language: string | null;
          frameworks: string; license_spdx: string | null;
          vocabulary_version: string; computed_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return this.hydrate(row);
  }

  /**
   * Repositories evidencing ALL requested capabilities at >= minStrength.
   *
   * ALL rather than ANY: a caller asking for ["download","resume","queue"] wants
   * implementations that do all three, and returning repos matching only "queue" would
   * reintroduce exactly the low-precision result set we are trying to avoid. Ordering is
   * by summed strength, so the most complete implementations surface first.
   */
  findByCapabilities(
    capabilities: string[],
    opts?: { minStrength?: number; language?: string; limit?: number },
  ): FeatureFingerprint[] {
    if (capabilities.length === 0) return [];
    const minStrength = opts?.minStrength ?? 0.4;
    const limit = opts?.limit ?? 25;
    const placeholders = capabilities.map(() => "?").join(",");

    const sql = `
      SELECT f.*, SUM(c.strength) AS total_strength
      FROM fingerprint_capabilities c
      JOIN fingerprints f
        ON f.repository = c.repository AND f.commit_sha = c.commit_sha
      WHERE c.capability IN (${placeholders})
        AND c.strength >= ?
        ${opts?.language ? "AND LOWER(f.language) = ?" : ""}
      GROUP BY c.repository, c.commit_sha
      HAVING COUNT(DISTINCT c.capability) = ?
      ORDER BY total_strength DESC
      LIMIT ?`;

    const params: unknown[] = [...capabilities.map((c) => c.toLowerCase()), minStrength];
    if (opts?.language) params.push(opts.language.toLowerCase());
    params.push(capabilities.length, limit);

    const rows = this.db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
    return rows.map((r) => this.hydrate(r as never));
  }

  private hydrate(row: {
    repository: string; commit_sha: string; language: string | null;
    frameworks: string; license_spdx: string | null;
    vocabulary_version: string; computed_at: string;
  }): FeatureFingerprint {
    const caps: Record<string, number> = {};
    for (const c of this.stmts.getFpCaps.all(row.repository, row.commit_sha) as
      { capability: string; strength: number }[]) {
      caps[c.capability] = c.strength;
    }
    let frameworks: string[] = [];
    try { frameworks = JSON.parse(row.frameworks) as string[]; } catch { /* tolerate */ }
    return {
      repository: row.repository,
      commit: row.commit_sha,
      capabilities: caps,
      language: row.language ?? undefined,
      frameworks,
      licenseSpdx: row.license_spdx ?? undefined,
      vocabularyVersion: row.vocabulary_version,
      computedAt: row.computed_at,
    };
  }
}
