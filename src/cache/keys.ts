/**
 * Cache key construction (spec §18).
 *
 * Keys are `namespace:version:subject`. The namespace determines expiry semantics, and
 * that is the whole point of the design:
 *
 *   search:v1:<hash>            short TTL   — quota relief, results legitimately change
 *   repo:v1:owner/name          TTL         — stars/pushes move
 *   analysis:v1:owner/name@sha  IMMUTABLE   — same commit ⇒ same source ⇒ same analysis
 *   fingerprint:v1:owner/name@sha IMMUTABLE — capability observations for that source
 *
 * The immutable tier is where the savings come from: once a repository has been deeply
 * analysed at a commit, every later request for that commit is free and instant. If the
 * repository moves on, the SHA changes and we simply miss — no invalidation logic, no
 * stale-data class of bug.
 */

import { createHash } from "node:crypto";

export const CACHE_VERSION = "v1";

export type CacheNamespace =
  | "search"        // GitHub search results
  | "code-search"   // GitHub code search results
  | "repo"          // repository metadata
  | "content"       // a file's contents at a ref
  | "analysis"      // anything derived from source at a commit
  | "symbols"       // symbol maps from the code index
  | "license"       // licence determination
  | "deps"          // dependency extraction
  | "tests"         // test discovery
  | "bundle"        // assembled implementation bundles
  | "fingerprint"   // capability fingerprints
  | "index-state";  // whether/where a repo is indexed in the code index

/** Namespaces whose entries are pinned to immutable source and must never expire. */
const IMMUTABLE: ReadonlySet<CacheNamespace> = new Set<CacheNamespace>([
  "analysis", "symbols", "license", "deps", "tests", "fingerprint", "content",
]);

export function isImmutableNamespace(ns: CacheNamespace): boolean {
  return IMMUTABLE.has(ns);
}

export function key(ns: CacheNamespace, subject: string): string {
  return `${ns}:${CACHE_VERSION}:${subject}`;
}

/**
 * Commit-pinned key. Falls back to a ref, then to `@unpinned`.
 *
 * `@unpinned` is deliberately ugly: it is visible in cache dumps, and it means the entry
 * cannot be trusted as immutable. Callers that end up here should be treated as TTL-bound.
 */
export function repoKey(ns: CacheNamespace, fullName: string, commit?: string, ref?: string): string {
  const pin = commit ? `@${commit}` : ref ? `@ref:${ref}` : "@unpinned";
  return key(ns, `${fullName.toLowerCase()}${pin}`);
}

/** True when a key is safely commit-pinned (and therefore genuinely immutable). */
export function isCommitPinned(k: string): boolean {
  return /@[0-9a-f]{7,40}(?::|$)/.test(k);
}

/**
 * Key for a search.
 *
 * The query is **normalised before hashing** — lowercased, whitespace collapsed, terms
 * sorted — so that "kotlin android downloader" and "Android  Downloader kotlin" share one
 * cache entry. Given a 30/min search quota, that near-duplicate collapsing is worth real
 * money. Filters are sorted and serialised so key order in the caller cannot cause a miss.
 */
export function searchKey(
  ns: "search" | "code-search",
  query: string,
  filters: Record<string, unknown> = {},
): string {
  const normQuery = normaliseQuery(query);
  const normFilters = Object.entries(filters)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => [k.toLowerCase(), String(v).toLowerCase()] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  const payload = JSON.stringify({ q: normQuery, f: normFilters });
  return key(ns, sha256(payload).slice(0, 32));
}

/** Lowercase, collapse whitespace, dedupe and sort terms. Qualifiers are kept intact. */
export function normaliseQuery(q: string): string {
  return q
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .sort()
    .filter((t, i, a) => t !== a[i - 1])
    .join(" ");
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Parse a key back into parts. Used by cache inspection tooling and tests. */
export function parseKey(k: string): { ns: string; version: string; subject: string } | null {
  const i = k.indexOf(":");
  if (i < 0) return null;
  const j = k.indexOf(":", i + 1);
  if (j < 0) return null;
  return { ns: k.slice(0, i), version: k.slice(i + 1, j), subject: k.slice(j + 1) };
}
