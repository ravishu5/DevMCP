/**
 * Ranking engine (spec §6).
 *
 * Reads `CandidateEvidence` and **nothing else**. That constraint is what makes a score
 * reproducible: given the same evidence record and the same weights, the number is
 * identical, and every point of it traces back to a stated observation.
 *
 * Two properties the spec asks for, implemented literally:
 *
 *   - `score: 91/100` **and** an explanation, always together. The explanation is not a
 *     debug feature; it is what lets the agent disagree with us.
 *   - Weights are configurable and renormalised, so `total` stays comparable across
 *     configurations.
 *
 * Confidence is tracked separately from score. A candidate scoring 82 from eight measured
 * axes is a different proposition from one scoring 82 from three measured axes and five
 * neutral priors, and collapsing that distinction would be dishonest.
 */

import type {
  CandidateEvidence, CompletenessReport, EvidenceAxis, RankingScore, RankingWeights,
  ReuseAssessment, ReuseMode,
} from "../types/index.js";
import { normaliseWeights } from "../core/config.js";

export interface RankOptions {
  weights: RankingWeights;
  /** Identifier for the weight set, echoed into the score so it can be reproduced. */
  weightsId?: string;
  /** Axes to exclude entirely (e.g. skip licence when ENABLE_LICENSE_CHECK=false). */
  disabledAxes?: EvidenceAxis[];
  /**
   * Reuse assessment, when one has been computed. Applies the mode multiplier below.
   * Omitted for shallow candidates, which are therefore ranked on evidence alone.
   */
  reuse?: ReuseAssessment;
  /**
   * Completeness report, when one was computed. Applies the zero-evidence penalty below.
   */
  completeness?: CompletenessReport;
}

/**
 * Penalty for evidencing NONE of the requirements we were able to check.
 *
 * The completeness axis is weighted 0.15, so scoring zero costs about fifteen points — and
 * that is far too gentle for what it means. A Gradle plugin for publishing to the Samsung
 * store scored 58 for "file upload" with **0 of 6** requirements evidenced, and beat a
 * candidate we had simply not analysed. Fifteen points does not express "we checked six
 * things this feature needs and found none of them".
 *
 * Applied as a multiplier rather than more axis weight, for the same reason as the reuse
 * adjustment: it is a verdict about the whole candidate, not one more signal to average in.
 * Not annihilating, because a total miss can also mean unusual naming — but enough that a
 * repository which shows no sign of doing the job cannot win on licence and stars alone.
 */
export function completenessPenalty(c?: CompletenessReport): { multiplier: number; decidable: number } {
  if (!c || c.total === 0) return { multiplier: 1, decidable: 0 };
  const decidable = c.total - c.undetermined.length;
  if (decidable < 3 || c.satisfied > 0) return { multiplier: 1, decidable };
  return { multiplier: decidable >= 5 ? 0.45 : 0.55, decidable };
}

/**
 * Reuse-mode multipliers.
 *
 * Why the total is adjusted rather than the mode being a twelfth axis: reuse mode is not
 * an independent signal, it is a *composite verdict* over licence, stack, architecture and
 * distribution — axes already scored individually. Adding it as an axis would double-count
 * them and dilute everything else. Applying it as a multiplier keeps the axes clean while
 * letting the verdict do the job it exists for.
 *
 * Why this matters concretely: an unlicensed but actively-maintained repository scored the
 * same 76/100 as an Apache-2.0 alternative and was recommended over it, because the licence
 * axis is only 7% of the total. Spec §12 is explicit that we must "never silently recommend
 * copying code whose license may be incompatible" — a 7% deduction is silent.
 *
 * Deliberately multiplicative, not a hard sort: an outstanding REFERENCE_ONLY (95 → 71) can
 * still beat a mediocre DIRECT_REUSE (65), which is correct — sometimes the best available
 * option genuinely is one you must reimplement.
 */
export const REUSE_MULTIPLIER: Record<ReuseMode, number> = {
  DIRECT_REUSE: 1.0,
  ADAPT: 0.95,
  REFERENCE_ONLY: 0.75,
  DO_NOT_USE: 0.4,
};

/** Thresholds for turning an axis value into "+ strong X" / "- weak X" prose. */
const STRONG = 0.75;
const WEAK = 0.4;

const AXIS_LABELS: Record<EvidenceAxis, { good: string; bad: string }> = {
  featureRelevance:     { good: "Strong feature match",            bad: "Weak feature match" },
  architectureMatch:    { good: "Compatible architecture",         bad: "Architecture needs adaptation" },
  stackMatch:           { good: "Matches target stack",            bad: "Different technology stack" },
  completeness:         { good: "Implements most requirements",    bad: "Implements few of the requirements" },
  implementationQuality:{ good: "Well-structured project",         bad: "Few structural quality signals" },
  testEvidence:         { good: "Strong test coverage",            bad: "Little or no test coverage" },
  maintenance:          { good: "Actively maintained",             bad: "Little recent maintenance" },
  documentation:        { good: "Good documentation",              bad: "Thin documentation" },
  popularity:           { good: "Widely used",                     bad: "Low adoption" },
  dependencySimplicity: { good: "Few dependencies",                bad: "Heavy dependency footprint" },
  integrationSurface:   { good: "Small integration surface",       bad: "Large integration surface" },
  licenseCompatibility: { good: "Compatible licence",              bad: "Licence needs review" },
  reusability:          { good: "Distributable library",           bad: "An application, not a reusable library" },
};

export function rankCandidate(evidence: CandidateEvidence, opts: RankOptions): RankingScore {
  const disabled = new Set(opts.disabledAxes ?? []);
  const active = (Object.keys(evidence.axes) as EvidenceAxis[]).filter((a) => !disabled.has(a));

  // Renormalise over the ACTIVE axes only. Otherwise disabling licence checking would
  // silently cap every score at 93 rather than rescaling the remaining axes.
  const rawWeights = Object.fromEntries(
    active.map((a) => [a, (opts.weights as Record<string, number>)[a] ?? 0]),
  ) as RankingWeights;
  const weights = normaliseWeights(rawWeights);

  const axes = {} as Record<EvidenceAxis, number>;
  const contributions = {} as Record<EvidenceAxis, number>;
  let total = 0;

  for (const axis of active) {
    const signal = evidence.axes[axis];
    const w = (weights as Record<string, number>)[axis] ?? 0;
    axes[axis] = signal.value;
    const contribution = signal.value * w * 100;
    contributions[axis] = round1(contribution);
    total += contribution;
  }

  const completeness = completenessPenalty(opts.completeness);
  if (completeness.multiplier !== 1) total *= completeness.multiplier;

  const before = Math.round(total);
  let reuseAdjustment: RankingScore["reuseAdjustment"];
  if (opts.reuse) {
    const multiplier = REUSE_MULTIPLIER[opts.reuse.mode];
    if (multiplier !== 1) {
      total *= multiplier;
      reuseAdjustment = { mode: opts.reuse.mode, multiplier, before };
    } else {
      reuseAdjustment = { mode: opts.reuse.mode, multiplier, before };
    }
  }

  return {
    total: Math.round(total),
    axes,
    contributions,
    reasons: explain(evidence, weights, active, opts.reuse, completeness),
    confidence: computeConfidence(evidence, weights, active),
    unmeasured: evidence.unmeasured.filter((a) => !disabled.has(a)),
    weightsId: opts.weightsId ?? "default",
    reuseAdjustment,
  };
}

/**
 * Build the explanation (spec §6's worked example).
 *
 * Ordered by **contribution to the score**, not by axis value: an axis that moved the
 * total by 12 points is more worth reading about than one that moved it by 0.4, however
 * good its raw value. Positives first, then the caveats — and caveats are never omitted,
 * because an explanation that only lists strengths is marketing.
 */
function explain(
  evidence: CandidateEvidence, weights: RankingWeights, active: EvidenceAxis[],
  reuse?: ReuseAssessment,
  completeness?: { multiplier: number; decidable: number },
): string[] {
  const scored = active
    .map((axis) => ({
      axis,
      signal: evidence.axes[axis],
      weight: (weights as Record<string, number>)[axis] ?? 0,
    }))
    .filter((x) => x.signal && !x.signal.imputed);

  const positives = scored
    .filter((x) => x.signal.value >= STRONG)
    .sort((a, b) => b.signal.value * b.weight - a.signal.value * a.weight)
    .slice(0, 5)
    .map((x) => `+ ${AXIS_LABELS[x.axis].good} — ${x.signal.observation}`);

  const negatives = scored
    .filter((x) => x.signal.value <= WEAK)
    // Ordered by how much score the axis LOST: a weak, heavily-weighted axis is the real
    // problem, and a weak axis worth 3% is noise.
    .sort((a, b) => (1 - a.signal.value) * b.weight - (1 - b.signal.value) * a.weight)
    .slice(0, 4)
    .map((x) => `- ${AXIS_LABELS[x.axis].bad} — ${x.signal.observation}`);

  const unmeasured = evidence.unmeasured.filter((a) => active.includes(a));
  const caveat = unmeasured.length
    ? [`? Not measured: ${unmeasured.map((a) => AXIS_LABELS[a]?.good.toLowerCase() ?? a).join(", ")} — score assumes a neutral value for these`]
    : [];

  const completenessNote = completeness && completeness.multiplier !== 1
    ? [`! Score reduced ×${completeness.multiplier} — none of the ${completeness.decidable} checkable requirements were evidenced in this repository`]
    : [];

  // The adjustment is stated in the explanation, never applied invisibly.
  const adjustment = reuse && REUSE_MULTIPLIER[reuse.mode] !== 1
    ? [`! Score reduced ×${REUSE_MULTIPLIER[reuse.mode]} because reuse mode is ${reuse.mode} — ${reuse.reason}`]
    : [];

  return [...positives, ...negatives, ...completenessNote, ...adjustment, ...caveat];
}

/**
 * Confidence in the score itself.
 *
 * Weighted by axis importance: not knowing `popularity` (4% weight) barely dents
 * confidence, whereas not knowing `featureRelevance` (20%) should. A simple count of
 * measured axes would treat those as equivalent.
 */
function computeConfidence(
  evidence: CandidateEvidence, weights: RankingWeights, active: EvidenceAxis[],
): number {
  let weighted = 0;
  let totalWeight = 0;
  for (const axis of active) {
    const signal = evidence.axes[axis];
    const w = (weights as Record<string, number>)[axis] ?? 0;
    if (!signal) continue;
    weighted += signal.confidence * w;
    totalWeight += w;
  }
  const base = totalWeight > 0 ? weighted / totalWeight : 0;
  // Deep analysis is genuinely more trustworthy than metadata alone.
  const depthBonus = evidence.sources.includes("code-index") ? 0.1 : 0;
  return Math.round(Math.min(1, base + depthBonus) * 100) / 100;
}

/**
 * Sort candidates for presentation.
 *
 * **Deeply-analysed candidates rank above metadata-only ones**, regardless of raw score.
 *
 * This is not a tie-break, it is a tier. Unmeasured axes are scored with a neutral 0.5
 * prior — which is the honest thing to do when ranking *within* a tier — but it means a
 * repository we never opened can accumulate a respectable total from priors alone. Observed
 * live: two never-analysed repositories scored 61 (confidence 0.38) and outranked the one
 * we had actually examined at 60 (confidence 0.81). We were recommending a repository we
 * knew almost nothing about, and the score gave no hint of it.
 *
 * The funnel exists precisely because we can only speak to the finalists. Metadata-only
 * candidates remain in the list — they are real alternatives, and dropping them would hide
 * work from the caller — but they cannot displace an examined one.
 */
export function sortByScore<
  T extends { score?: RankingScore; evidence?: CandidateEvidence; analysisDepth?: "deep" | "metadata" },
>(items: T[]): T[] {
  const depthRank = (x: T): number => (x.analysisDepth === "deep" ? 1 : 0);
  return [...items].sort((a, b) => {
    const tier = depthRank(b) - depthRank(a);
    if (tier !== 0) return tier;
    const d = (b.score?.total ?? 0) - (a.score?.total ?? 0);
    if (d !== 0) return d;
    const c = (b.score?.confidence ?? 0) - (a.score?.confidence ?? 0);
    if (c !== 0) return c;
    return (b.evidence?.axes.featureRelevance?.value ?? 0) - (a.evidence?.axes.featureRelevance?.value ?? 0);
  });
}

/** Rank ignoring analysis depth. Used to choose WHICH candidates to analyse deeply. */
export function sortByScoreOnly<T extends { score?: RankingScore; evidence?: CandidateEvidence }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const d = (b.score?.total ?? 0) - (a.score?.total ?? 0);
    if (d !== 0) return d;
    const c = (b.score?.confidence ?? 0) - (a.score?.confidence ?? 0);
    if (c !== 0) return c;
    return (b.evidence?.axes.featureRelevance?.value ?? 0) - (a.evidence?.axes.featureRelevance?.value ?? 0);
  });
}

/** Render a score block in the spec §24 compact style. */
export function renderScore(repository: string, score: RankingScore): string {
  const lines = [`${repository} — ${score.total}/100 (confidence ${Math.round(score.confidence * 100)}%)`];
  for (const r of score.reasons) lines.push(`  ${r}`);
  return lines.join("\n");
}

function round1(n: number): number { return Math.round(n * 10) / 10; }
