/**
 * Candidate deduplication and clustering (spec §19).
 *
 * GitHub is full of forks, mirrors, tutorial copies and abandoned re-uploads. Returning
 * fifteen near-identical repositories wastes the caller's attention and, worse, makes a
 * weak result set *look* like corroboration — fifteen copies of one idea read as consensus.
 *
 * Two mechanisms:
 *   1. **Fork collapse** — GitHub tells us `fork: true` and often names the parent.
 *   2. **Similarity clustering** — name and description similarity catches mirrors and
 *      renamed copies that the fork flag misses.
 *
 * The representative of a cluster is chosen on merit (activity, stars, maintenance), not
 * arbitrarily: a fork can legitimately be the living version when the original is
 * abandoned, which happens often enough that always preferring the parent would be wrong.
 */

import type { Candidate, RepoCluster } from "../types/index.js";

export interface DedupeResult {
  kept: Candidate[];
  /** Full name -> the candidate that absorbed it. For reporting and provenance. */
  folded: Map<string, string>;
  clusters: { representative: string; members: string[]; reason: RepoCluster["reason"] }[];
}

export function dedupeCandidates(candidates: Candidate[]): DedupeResult {
  const byName = new Map(candidates.map((c) => [c.ref.fullName.toLowerCase(), c]));
  const folded = new Map<string, string>();
  const clusterMap = new Map<string, { members: Set<string>; reason: RepoCluster["reason"] }>();

  const claim = (representative: string, member: string, reason: RepoCluster["reason"]) => {
    if (representative === member) return;
    const entry = clusterMap.get(representative) ?? { members: new Set<string>(), reason };
    entry.members.add(member);
    clusterMap.set(representative, entry);
    folded.set(member, representative);
  };

  // --- Pass 1: explicit forks whose parent is also a candidate ---------------
  for (const c of candidates) {
    const parent = c.metadata.parent?.toLowerCase();
    if (!c.metadata.isFork || !parent || !byName.has(parent)) continue;
    const parentCand = byName.get(parent) as Candidate;
    // A fork can be the living version when the parent is archived or long-dead.
    const [rep, member] = preferred(parentCand, c);
    claim(rep.ref.fullName.toLowerCase(), member.ref.fullName.toLowerCase(), "fork");
  }

  // --- Pass 2: similarity clustering ----------------------------------------
  const remaining = candidates.filter((c) => !folded.has(c.ref.fullName.toLowerCase()));
  for (let i = 0; i < remaining.length; i++) {
    const a = remaining[i] as Candidate;
    const aKey = a.ref.fullName.toLowerCase();
    if (folded.has(aKey)) continue;

    for (let j = i + 1; j < remaining.length; j++) {
      const b = remaining[j] as Candidate;
      const bKey = b.ref.fullName.toLowerCase();
      if (folded.has(bKey)) continue;

      const reason = similarityReason(a, b);
      if (!reason) continue;
      const [rep, member] = preferred(a, b);
      claim(rep.ref.fullName.toLowerCase(), member.ref.fullName.toLowerCase(), reason);
    }
  }

  // --- Assemble -------------------------------------------------------------
  const kept: Candidate[] = [];
  for (const c of candidates) {
    const keyName = c.ref.fullName.toLowerCase();
    if (folded.has(keyName)) continue;
    const cluster = clusterMap.get(keyName);
    kept.push(cluster
      ? { ...c, cluster: { members: [...cluster.members], reason: cluster.reason } }
      : c);
  }

  return {
    kept,
    folded,
    clusters: [...clusterMap.entries()].map(([representative, v]) => ({
      representative, members: [...v.members], reason: v.reason,
    })),
  };
}

/**
 * Choose which of two near-duplicates to keep.
 *
 * Deliberately NOT "the one with more stars". An archived 20k-star original that stopped
 * receiving fixes is worse to recommend than its actively-maintained 300-star fork; the
 * whole point of spec §7 is that popularity is not quality. Recency dominates, and stars
 * only break ties among comparably-maintained candidates.
 */
function preferred(a: Candidate, b: Candidate): [Candidate, Candidate] {
  return scoreForRepresentative(a) >= scoreForRepresentative(b) ? [a, b] : [b, a];
}

function scoreForRepresentative(c: Candidate): number {
  const md = c.metadata;
  if (md.archived) return -1000;                     // never represent a cluster with an archive
  const days = md.pushedAt ? (Date.now() - Date.parse(md.pushedAt)) / 86_400_000 : 3650;
  const recency = days <= 90 ? 100 : days <= 365 ? 60 : days <= 730 ? 25 : 0;
  const popularity = Math.log10(md.stars + 1) * 8;   // log-scaled; a tie-breaker, not a verdict
  const originality = md.isFork ? -15 : 0;           // mild: a fork can still be the live one
  return recency + popularity + originality;
}

function similarityReason(a: Candidate, b: Candidate): RepoCluster["reason"] | null {
  const an = a.ref.name.toLowerCase();
  const bn = b.ref.name.toLowerCase();

  // Identical repo name under different owners: nearly always a fork/mirror/copy.
  if (an === bn && a.ref.owner.toLowerCase() !== b.ref.owner.toLowerCase()) {
    return a.metadata.isFork || b.metadata.isFork ? "fork" : "mirror";
  }
  if (normaliseName(an) === normaliseName(bn)) return "name-similarity";

  // Same owner, near-identical names: "foo" / "foo-android" / "foo2".
  if (a.ref.owner.toLowerCase() === b.ref.owner.toLowerCase() && nameSimilarity(an, bn) > 0.85) {
    return "name-similarity";
  }

  // Identical descriptions are a strong copy signal — but only when substantial, since
  // short generic blurbs ("A Kotlin library") collide innocently.
  const ad = (a.metadata.description ?? "").trim().toLowerCase();
  const bd = (b.metadata.description ?? "").trim().toLowerCase();
  if (ad.length > 40 && ad === bd) return "description-similarity";

  return null;
}

/** Strip decorative affixes so "awesome-downloader" and "downloader-android" converge. */
function normaliseName(n: string): string {
  return n
    .replace(/[-_.]/g, "")
    .replace(/^(awesome|simple|easy|my|the|go|py|js|ts|kt)/, "")
    .replace(/(lib|library|sdk|kit|android|ios|js|ts|kt|py|go|java|swift|demo|example|sample|clone|fork|mirror)$/g, "");
}

/** Dice coefficient over character bigrams — cheap and good enough for repo names. */
function nameSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };
  const A = bigrams(a), B = bigrams(b);
  let shared = 0;
  for (const [g, n] of A) shared += Math.min(n, B.get(g) ?? 0);
  const totalA = [...A.values()].reduce((x, y) => x + y, 0);
  const totalB = [...B.values()].reduce((x, y) => x + y, 0);
  return (2 * shared) / (totalA + totalB);
}
