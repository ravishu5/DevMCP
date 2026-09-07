/**
 * Search query generation (spec §5, §20).
 *
 * "Do not perform only one search. Generate variations." — but with GitHub search at
 * 30/min, variations are expensive, so they must be *diverse* rather than merely numerous.
 * Five near-identical phrasings cost five requests and return one result set; five queries
 * attacking the problem from different angles cost the same and return five.
 *
 * Diversity comes from mixing query *shapes*, in descending expected precision:
 *
 *   1. STACK IDIOM      "WorkManager download"      ← finds implementations
 *   2. DOMAIN TERM      "HTTP Range request"        ← finds the actual technique
 *   3. TOPIC QUALIFIER  "topic:downloader"          ← finds curated, self-labelled repos
 *   4. GENERIC          "resumable download kotlin" ← the obvious query, kept last
 *
 * Shape 1 and 2 are the ones the user could not have written themselves, which is the
 * whole justification for this module existing.
 */

import type { TargetStack } from "../types/index.js";
import { CAPABILITY_BY_ID, type StackIdioms } from "../knowledge/vocabulary.js";

export interface QueryGenInput {
  feature: string;
  capabilityId?: string;
  stack?: TargetStack;
  idioms?: StackIdioms;
  requirements?: string[];
  /** Vendors the agent declared mandatory. See AgentFeature.mustMention. */
  mustMention?: string[];
  limit?: number;
}

export interface GeneratedQuery {
  query: string;
  /** Which shape produced it — used to keep the mix diverse and to explain discovery. */
  shape: "stack-idiom" | "domain-term" | "topic" | "vendor-sdk" | "generic" | "requirement";
  /** Expected precision, 0–1. Higher-precision queries are issued first. */
  precision: number;
}

/**
 * Generate a diverse, budget-limited query set.
 *
 * Returns plain strings because that is what the provider takes; the shape/precision
 * metadata is used internally for ordering and diversity, and would only be noise
 * downstream.
 */
export function generateQueries(input: QueryGenInput): string[] {
  return generateQueriesDetailed(input).map((q) => q.query);
}

export function generateQueriesDetailed(input: QueryGenInput): GeneratedQuery[] {
  const limit = Math.max(1, input.limit ?? 4);
  const cap = input.capabilityId ? CAPABILITY_BY_ID.get(input.capabilityId) : undefined;
  const langHint = input.stack?.language ?? input.idioms?.language;
  const out: GeneratedQuery[] = [];

  // Shape 1 — stack idioms. Highest precision: "WorkManager" appears in code that
  // implements background work, not in blog posts about it.
  const idiomTerms = input.capabilityId ? input.idioms?.idioms[input.capabilityId] ?? [] : [];
  for (const term of idiomTerms.slice(0, 3)) {
    out.push({ query: term, shape: "stack-idiom", precision: 0.95 });
  }

  // Shape 2 — domain terms from the vocabulary: the technique, not the feature name.
  for (const term of (cap?.searchTerms ?? []).slice(0, 4)) {
    out.push({ query: term, shape: "domain-term", precision: 0.8 });
  }

  // Shape 3 — topic qualifier. GitHub topics are curated by maintainers, so a topic match
  // is a self-declaration that the repo is *about* this, which is unusually high signal —
  // provided the topic means what we think. Capabilities may override the derived topic
  // where the id is a homonym: `topic:resume` belongs to CV builders, not downloads.
  const topics = cap?.topics?.length
    ? cap.topics
    : [toTopic(input.capabilityId ?? input.feature)].filter((t): t is string => Boolean(t));
  for (const t of topics.slice(0, 2)) {
    out.push({ query: `topic:${t}`, shape: "topic", precision: 0.7 });
  }

  // Shape 4 — requirement-derived. Catches the specific sub-capability that distinguishes
  // a complete implementation from a partial one.
  for (const req of (input.requirements ?? []).slice(0, 2)) {
    const q = compactRequirement(req);
    if (q) out.push({ query: langHint ? `${q} ${langHint}` : q, shape: "requirement", precision: 0.6 });
  }

  /*
   * Shape 5 — the vendor's own SDK.
   *
   * A feature query cannot find the library that implements it. `stripe/stripe-node` is
   * described "Node.js library for the Stripe API." — no "webhook", no "subscription", no
   * "billing" anywhere in its name, description or topics. Searching "Stripe webhooks Node"
   * and "stripe subscriptions TypeScript" returned 58 candidates and the official SDK was
   * not among them; the top three were 2-star wrappers that happened to name the feature.
   *
   * An SDK is described by what it IS, not by everything it contains. So when the agent has
   * declared a vendor mandatory, ask for the vendor directly.
   */
  for (const vendor of (input.mustMention ?? []).slice(0, 2)) {
    const v = vendor.trim();
    if (!v) continue;
    /*
     * The BARE vendor name, with no descriptive suffix.
     *
     * GitHub ANDs every term, and the provider already appends `language:`. "Stripe
     * TypeScript sdk" therefore requires the words "typescript" AND "sdk" to appear in the
     * name, description or topics — stripe-node's description is "Node.js library for the
     * Stripe API.", so it matched neither and stayed absent. `stripe language:TypeScript`
     * returns it first. Every added word narrows away the thing we are looking for.
     */
    out.push({ query: v, shape: "vendor-sdk", precision: 0.9 });
    out.push({ query: `${v} sdk`, shape: "vendor-sdk", precision: 0.75 });
  }

  // Shape 6 — the obvious query.
  //
  // Only when the feature text is the CALLER'S OWN WORDS. A generated capability label
  // ("Local persistence", "Resumable transfer") is a category name, not something anyone
  // writes in a repository — searching it returned an "ai-resume-analyzer" for resumable
  // transfers and a SharedPreferences wrapper for local persistence. The caller's own
  // phrasing is valuable precisely because it is specific; a taxonomy label is not.
  if (!isCapabilityLabel(input.feature, cap)) {
    const generic = [input.feature.toLowerCase(), langHint].filter(Boolean).join(" ");
    out.push({ query: generic, shape: "generic", precision: 0.5 });
  }

  return selectDiverse(out, limit);
}

/**
 * Pick `limit` queries, maximising shape diversity before precision.
 *
 * Round-robin across shapes rather than taking the top-N by precision: three
 * high-precision idiom queries all search the same corner of GitHub, whereas one idiom +
 * one domain term + one topic query covers three different corners for the same quota.
 */
function selectDiverse(queries: GeneratedQuery[], limit: number): GeneratedQuery[] {
  const byShape = new Map<string, GeneratedQuery[]>();
  for (const q of queries) {
    if (!q.query.trim()) continue;
    const list = byShape.get(q.shape) ?? [];
    list.push(q);
    byShape.set(q.shape, list);
  }
  for (const list of byShape.values()) list.sort((a, b) => b.precision - a.precision);

  // Shapes in descending expected value.
  const shapeOrder: GeneratedQuery["shape"][] = ["vendor-sdk", "stack-idiom", "domain-term", "topic", "requirement", "generic"];
  const picked: GeneratedQuery[] = [];
  const seen = new Set<string>();

  let round = 0;
  while (picked.length < limit && round < 6) {
    let addedThisRound = false;
    for (const shape of shapeOrder) {
      if (picked.length >= limit) break;
      const q = byShape.get(shape)?.[round];
      if (!q) continue;
      const norm = q.query.toLowerCase().trim();
      if (seen.has(norm)) continue;
      seen.add(norm);
      picked.push(q);
      addedThisRound = true;
    }
    if (!addedThisRound) break;
    round++;
  }
  return picked;
}

/** GitHub topics are lowercase, hyphenated, no spaces. */
function toTopic(s: string): string | null {
  const t = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!t || t.length < 3 || t.length > 35) return null;
  return t;
}

/** Turn a checklist sentence into a searchable phrase. */
function compactRequirement(req: string): string | null {
  const stop = new Set([
    "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "with", "is", "are",
    "be", "it", "its", "when", "where", "that", "this", "supports", "support", "handles",
    "handle", "provides", "provide", "must", "should",
  ]);
  const words = req.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w));
  if (words.length === 0) return null;
  return words.slice(0, 4).join(" ");
}

/**
 * Is this feature string one of our own capability labels rather than user text?
 *
 * Matched against the label and the id, both loosely, because a planner-generated task
 * carries the label verbatim while a caller might type something similar but sharper.
 */
export function isCapabilityLabel(feature: string, cap?: { id: string; label: string }): boolean {
  if (!cap) return false;
  const f = feature.trim().toLowerCase();
  return f === cap.label.toLowerCase() || f === cap.id.toLowerCase().replace(/-/g, " ");
}
