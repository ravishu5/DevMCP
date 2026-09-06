/**
 * Enrichment: turn an agent-supplied feature into a searchable ImplementationTask.
 *
 * The inversion at the heart of this module:
 *
 *   BEFORE  vocabulary RECOGNISES the feature  →  fails silently when it does not
 *   AFTER   agent NAMES the feature            →  vocabulary ENRICHES it, or does not
 *
 * When enrichment finds nothing, we still search — using the agent's own words and hints —
 * and say that enrichment was unavailable. That is the property the rule-based decomposer
 * could never offer: a feature the vocabulary has never heard of is still pursued, rather
 * than silently dropped.
 *
 * Matching an agent-supplied feature is also a far easier problem than matching a
 * paragraph. The agent has already isolated the feature, so "Resumable background
 * downloads" arrives as a short, clean phrase instead of being buried in a 155-word
 * requirement alongside twenty others.
 */

import type {
  AgentFeature, ImplementationTask, ReuseStrategy, TargetStack,
} from "../types/index.js";
import { CAPABILITIES, CAPABILITY_BY_ID, findStackIdioms, type Capability } from "../knowledge/vocabulary.js";
import { generateQueries } from "./query.js";

export interface EnrichInput {
  features: AgentFeature[];
  stack?: TargetStack;
  /** Total search queries to distribute. */
  totalQueryBudget?: number;
}

export interface EnrichResult {
  tasks: ImplementationTask[];
  /** Features the agent asked us to skip. */
  skipped: { feature: string; reason: string }[];
  /**
   * Per-feature note on whether the vocabulary recognised it. Surfaced so the caller can
   * see when it is getting the agent's own terms rather than curated domain vocabulary —
   * results are usually still good, just less sharp.
   */
  enrichment: { feature: string; capability?: string; enriched: boolean }[];
}

export function enrichAgentFeatures(input: EnrichInput): EnrichResult {
  const idioms = findStackIdioms(
    input.stack?.language, input.stack?.framework, input.stack?.platform,
  );

  const pursued = input.features.filter((f) => f.reuse !== "build-from-scratch");
  const skipped = input.features
    .filter((f) => f.reuse === "build-from-scratch")
    .map((f) => ({ feature: f.name, reason: "the calling agent judged this application-specific" }));

  const perFeatureBudget = Math.max(
    2,
    Math.floor((input.totalQueryBudget ?? pursued.length * 4) / Math.max(1, pursued.length)),
  );

  const enrichment: EnrichResult["enrichment"] = [];
  const tasks: ImplementationTask[] = [];

  for (const [i, feature] of pursued.entries()) {
    const cap = resolveCapability(feature);
    enrichment.push({ feature: feature.name, capability: cap?.id, enriched: Boolean(cap) });

    tasks.push(toTask(feature, cap, {
      idioms,
      stack: input.stack,
      budget: perFeatureBudget,
      order: i,
      total: pursued.length,
    }));
  }

  // Build order: dependencies first, then the agent's own ordering.
  return { tasks: orderByDependencies(tasks, pursued), skipped, enrichment };
}

/**
 * Find the capability a named feature corresponds to.
 *
 * Preference order: the agent's explicit `capability` id, then a trigger match on the
 * feature NAME, then on its description. Deliberately conservative — a wrong capability
 * supplies wrong idioms, and wrong idioms are worse than none (`topic:resume` returning CV
 * builders is what that failure looks like).
 */
function resolveCapability(feature: AgentFeature): Capability | undefined {
  if (feature.capability) {
    const explicit = CAPABILITY_BY_ID.get(feature.capability);
    if (explicit) return explicit;
  }

  const fromName = bestMatch(feature.name);
  if (fromName) return fromName;

  // Descriptions mention many things, so require a stronger showing there.
  if (feature.description) {
    const fromDescription = bestMatch(feature.description, 0.55);
    if (fromDescription) return fromDescription;
  }

  /*
   * No confident match — and we return NOTHING rather than the best weak one.
   *
   * A weak match is worse than none, because enrichment injects that capability's search
   * vocabulary. "Voice note recording and playback" matched `media-playback` on the single
   * word "playback", so the search was enriched with ExoPlayer and adaptive-streaming terms
   * and returned a video streaming SDK for what is an audio recorder. The agent's own hints
   * — "Android audio recorder opus" — were sound; our vocabulary overrode them with the
   * wrong domain.
   *
   * Wrong idioms have been the most expensive failure mode in this system (topic:resume →
   * CV builders, "Tink Android" → a bank). When unsure, use the agent's words and say so.
   */
  return undefined;
}

/**
 * The capability that best explains a phrase, by COVERAGE rather than hit count.
 *
 * Coverage asks how much of the feature name a capability accounts for, which is the
 * question that matters. "playback" appearing in a five-word feature name explains 25% of
 * it and is a coincidence; "push notifications" being fully explained by the notifications
 * triggers is a match. Counting hits cannot tell those apart — both are one trigger.
 */
function bestMatch(phrase: string, minCoverage = 0.4): Capability | undefined {
  const tokens = contentWords(phrase);
  if (!tokens.length) return undefined;

  const scored = CAPABILITIES
    .map((cap) => {
      const vocabulary = new Set(
        [...cap.triggers, cap.label].flatMap((t) => contentWords(t)),
      );
      const explained = tokens.filter((t) => vocabulary.has(t)).length;
      return { cap, coverage: explained / tokens.length, explained };
    })
    .filter((x) => x.coverage >= minCoverage && x.explained > 0)
    .sort((a, b) => b.coverage - a.coverage || b.explained - a.explained);

  if (!scored.length) return undefined;

  // Among equally-covering capabilities prefer the NARROWER one: "OAuth login" is covered
  // equally by `oauth` and `auth-session`, and `oauth` declares it narrows the other.
  const top = scored[0] as { cap: Capability; coverage: number };
  const tied = scored.filter((x) => Math.abs(x.coverage - top.coverage) < 0.01).map((x) => x.cap);
  const narrower = tied.find((c) => (c.narrows ?? []).some((broader) => tied.some((o) => o.id === broader)));
  return narrower ?? top.cap;
}

/** Lowercase content words, stop-words removed. */
const STOP = new Set([
  "and", "or", "the", "a", "an", "with", "for", "to", "of", "in", "on", "at", "by",
  "using", "via", "support", "supports", "handling", "based",
]);

function contentWords(text: string): string[] {
  return normalise(text).split(" ").filter((w) => w.length >= 3 && !STOP.has(w));
}

function toTask(
  feature: AgentFeature,
  cap: Capability | undefined,
  ctx: { idioms?: ReturnType<typeof findStackIdioms>; stack?: TargetStack; budget: number; order: number; total: number },
): ImplementationTask {
  /*
   * Queries, in descending trust:
   *   1. the agent's own search hints — it knows the domain and this specific project
   *   2. the agent's feature name — its actual words, never a taxonomy label
   *   3. vocabulary idioms and domain terms — where the table earns its keep
   *
   * The agent's terms come FIRST because the failures this design replaces were all cases
   * where our vocabulary was wrong or absent. When both are available they reinforce; when
   * they disagree, the agent read the requirement and we did not.
   */
  const vocabularyQueries = cap
    ? generateQueries({
        feature: feature.name,
        capabilityId: cap.id,
        stack: ctx.stack,
        idioms: ctx.idioms,
        requirements: feature.requirements,
        limit: ctx.budget,
      })
    : [];

  const language = ctx.stack?.language;
  const searchQueries = dedupe([
    ...(feature.searchHints ?? []),
    [feature.name, language].filter(Boolean).join(" "),
    ...vocabularyQueries,
  ]).filter(Boolean).slice(0, Math.max(2, ctx.budget));

  // Checklist: the agent's requirements are ground truth for THIS project; the
  // capability's generic checklist fills gaps rather than overriding.
  const checklist = dedupe([
    ...(feature.requirements ?? []),
    ...(cap?.checklist ?? []),
  ]).slice(0, 12);

  const strategy: ReuseStrategy = cap
    ? (cap.reuseValue === "high" ? "reuse-library" : cap.reuseValue === "low" ? "study-reference" : "reuse-pattern")
    : "reuse-pattern";

  return {
    featureId: cap?.id ?? slug(feature.name),
    feature: feature.name,
    strategy,
    lookingFor: [
      feature.description ?? `existing ${feature.name.toLowerCase()} implementations`,
    ],
    capabilities: cap ? [cap.id, ...(cap.implies ?? [])] : [slug(feature.name)],
    requirementChecklist: checklist,
    searchQueries,
    rationale: cap
      ? `Identified by the calling agent; enriched with ${cap.label} vocabulary.`
      : "Identified by the calling agent. No matching capability in the vocabulary, so the agent's own terms are used — results may be less sharp, but the feature is not dropped.",
    // Earlier features get slightly more budget, respecting the agent's ordering.
    budgetShare: Math.round((1 / ctx.total) * 100) / 100,
    priority: Math.max(10, 90 - ctx.order * 5),
    dependsOn: [],
  };
}

/** Order tasks so a feature's dependencies precede it, preserving agent order otherwise. */
function orderByDependencies(tasks: ImplementationTask[], features: AgentFeature[]): ImplementationTask[] {
  const byName = new Map<string, string>();     // lowercased feature name -> featureId
  features.forEach((f, i) => byName.set(f.name.toLowerCase(), tasks[i]?.featureId ?? slug(f.name)));

  tasks.forEach((t, i) => {
    const declared = features[i]?.dependsOn ?? [];
    t.dependsOn = declared
      .map((d) => byName.get(d.toLowerCase()))
      .filter((id): id is string => Boolean(id) && id !== t.featureId);
  });

  const byId = new Map(tasks.map((t) => [t.featureId, t]));
  const out: ImplementationTask[] = [];
  const state = new Map<string, "visiting" | "done">();

  const visit = (t: ImplementationTask): void => {
    const st = state.get(t.featureId);
    if (st) return;                     // done, or a cycle we decline to follow
    state.set(t.featureId, "visiting");
    for (const dep of t.dependsOn) {
      const d = byId.get(dep);
      if (d) visit(d);
    }
    state.set(t.featureId, "done");
    out.push(t);
  };
  for (const t of tasks) visit(t);
  return out;
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Whole-word containment on the already-normalised strings. */
function containsWord(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

function slug(name: string): string {
  return normalise(name).replace(/\s+/g, "-").slice(0, 40) || "feature";
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}
