/**
 * Candidate Evidence — normalised signals, collected before ranking touches anything.
 *
 * A bare `91/100` is not useful. Signals from independent sources are normalised into one
 * record, where every axis carries **value, confidence, source and the raw observation**:
 *
 *   featureRelevance   0.94  github:topics+readme   "topics: downloader, android"
 *   architectureMatch  0.88  jcodemunch:module-map  "queue + worker + persistence"
 *   stackMatch         1.00  github:language        "Kotlin matches target Kotlin"
 *   completeness       0.71  checklist              "5/7 requirements evidenced"
 *   testEvidence       0.91  tree                   "18 test files, 6 touch the feature"
 *   maintenance        0.84  github:commits         "last push 9d ago, 47 commits/90d"
 *   integrationSurface 0.72  computed               "5 symbols, 2 deps, 1 interface"
 *   licenseCompatibility 1.00 license-file          "Apache-2.0"
 *
 * Two consequences fall out of this design, and both matter:
 *
 *   1. The score is **reproducible and auditable** — every number traces to an observation.
 *   2. A signal we could not measure lowers **confidence**, rather than silently scoring
 *      zero. Scoring an unmeasured axis as 0 would systematically punish candidates we
 *      simply had no budget to analyse, which is a bias, not a measurement.
 */

import type {
  Candidate, CandidateEvidence, CompletenessReport, EvidenceAxis, EvidenceSignal,
  IntegrationSurface, LicenseInfo, RepoMetadata, RepoQuality, TargetStack,
} from "../types/index.js";
import type { ImplementationTask } from "../types/index.js";
import { licenseScore } from "../analyzers/license.js";
import type { ReusabilityAssessment } from "../analyzers/reusability.js";

export interface EvidenceInput {
  metadata: RepoMetadata;
  task?: ImplementationTask;
  target?: TargetStack;
  quality?: RepoQuality;
  license?: LicenseInfo;
  completeness?: CompletenessReport;
  integrationSurface?: IntegrationSurface;
  /** 0–1 architectural fit, when the code index produced a module map. */
  architectureMatch?: number;
  reusability?: ReusabilityAssessment;
  /** Extra text used for relevance: readme excerpt, code-search fragments. */
  relevanceText?: string;
  /** Which sources actually contributed. */
  sources: string[];
}

/** A neutral prior for an axis we could not measure. Not 0 — absence is not badness. */
const NEUTRAL = 0.5;

export function collectEvidence(input: EvidenceInput): CandidateEvidence {
  const axes = {} as Record<EvidenceAxis, EvidenceSignal>;
  const unmeasured: EvidenceAxis[] = [];

  const set = (axis: EvidenceAxis, signal: EvidenceSignal | null) => {
    if (signal) { axes[axis] = signal; return; }
    axes[axis] = {
      value: NEUTRAL, confidence: 0.1, source: "none",
      observation: "not measured", imputed: true,
    };
    unmeasured.push(axis);
  };

  set("featureRelevance", featureRelevance(input));
  set("stackMatch", stackMatch(input));
  set("completeness", completeness(input));
  set("architectureMatch", architectureMatch(input));
  set("implementationQuality", implementationQuality(input));
  set("testEvidence", testEvidence(input));
  set("maintenance", maintenance(input));
  set("documentation", documentation(input));
  set("popularity", popularity(input));
  set("dependencySimplicity", dependencySimplicity(input));
  set("integrationSurface", integrationSurfaceSignal(input));
  set("reusability", reusabilitySignal(input));
  set("licenseCompatibility", licenseSignal(input));

  return {
    repository: input.metadata.ref.fullName,
    axes,
    sources: [...new Set(input.sources)],
    unmeasured,
    collectedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Individual signals
// ---------------------------------------------------------------------------

/**
 * Feature relevance: does this repository appear to be ABOUT the requested feature?
 *
 * Topics are weighted highest because they are maintainer-curated self-declarations — a
 * repo tagged `downloader` is asserting its own purpose, which is far stronger than the
 * word appearing somewhere in a README.
 */
function featureRelevance(input: EvidenceInput): EvidenceSignal | null {
  const task = input.task;
  if (!task) return null;

  const terms = new Set(
    [task.feature, ...task.capabilities, ...task.searchQueries]
      .join(" ").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/)
      .filter((w) => w.length >= 4),
  );
  if (!terms.size) return null;

  const md = input.metadata;
  const topicText = md.topics.join(" ").toLowerCase();
  const nameText = `${md.ref.name} ${md.description ?? ""}`.toLowerCase();
  const bodyText = (input.relevanceText ?? "").toLowerCase().slice(0, 20_000);

  let score = 0;
  const evidence: string[] = [];

  const topicHits = [...terms].filter((t) => topicText.includes(t));
  if (topicHits.length) {
    score += Math.min(0.45, topicHits.length * 0.18);
    evidence.push(`topics: ${topicHits.slice(0, 3).join(", ")}`);
  }
  const nameHits = [...terms].filter((t) => nameText.includes(t));
  if (nameHits.length) {
    score += Math.min(0.35, nameHits.length * 0.12);
    evidence.push(`name/description: ${nameHits.slice(0, 3).join(", ")}`);
  }
  const bodyHits = [...terms].filter((t) => bodyText.includes(t));
  if (bodyHits.length) {
    score += Math.min(0.30, bodyHits.length * 0.06);
    evidence.push(`readme/code: ${bodyHits.length} term(s)`);
  }

  return {
    value: clamp(score),
    confidence: bodyText ? 0.85 : 0.6,
    source: "github:topics+description" + (bodyText ? "+readme" : ""),
    observation: evidence.join("; ") || "no direct term matches",
  };
}

/**
 * Stack match (spec §14).
 *
 * Language dominates, because a language mismatch means the code cannot be reused at all.
 * Framework/library overlap refines within a matching language. Related languages
 * (Kotlin/Java, TypeScript/JavaScript) score partially — the code is not directly usable
 * but is far closer than an unrelated language.
 */
const RELATED_LANGUAGES: Record<string, string[]> = {
  kotlin: ["java"], java: ["kotlin"],
  typescript: ["javascript"], javascript: ["typescript"],
  "objective-c": ["swift"], swift: ["objective-c"],
  "c++": ["c"], c: ["c++"],
};

function stackMatch(input: EvidenceInput): EvidenceSignal | null {
  const target = input.target;
  if (!target?.language && !target?.framework) return null;

  const repoLang = (input.metadata.language ?? "").toLowerCase();
  const wantLang = (target.language ?? "").toLowerCase();
  const haystack = [
    input.metadata.description ?? "", input.metadata.topics.join(" "),
    Object.keys(input.metadata.languages ?? {}).join(" "),
  ].join(" ").toLowerCase();

  let langScore = 0;
  let observation: string;
  if (!wantLang) {
    langScore = 0.6;
    observation = "no target language specified";
  } else if (repoLang === wantLang) {
    langScore = 1;
    observation = `${input.metadata.language} matches target`;
  } else if ((RELATED_LANGUAGES[wantLang] ?? []).includes(repoLang)) {
    langScore = 0.6;
    observation = `${input.metadata.language} is interoperable with ${target.language}`;
  } else if (haystack.includes(wantLang)) {
    // Secondary language present — e.g. a Java repo with Kotlin sources.
    langScore = 0.45;
    observation = `primary language ${input.metadata.language}, but ${target.language} also present`;
  } else {
    langScore = 0.1;
    observation = `${input.metadata.language ?? "unknown"} vs target ${target.language}`;
  }

  const wanted = [target.framework, target.platform, ...(target.libraries ?? [])]
    .filter(Boolean).map((s) => (s as string).toLowerCase());
  const frameworkHits = wanted.filter((w) => haystack.includes(w));
  const frameworkScore = wanted.length ? frameworkHits.length / wanted.length : 0.5;
  if (frameworkHits.length) observation += `; matches ${frameworkHits.join(", ")}`;

  return {
    value: clamp(langScore * 0.75 + frameworkScore * 0.25),
    confidence: input.metadata.language ? 0.9 : 0.4,
    source: "github:language+topics",
    observation,
  };
}

function completeness(input: EvidenceInput): EvidenceSignal | null {
  const c = input.completeness;
  if (!c || c.total === 0) return null;
  const decidable = c.total - c.undetermined.length;
  if (decidable === 0) return null;
  return {
    value: clamp(c.ratio),
    // Confidence scales with how much of the checklist we could actually decide.
    confidence: clamp(0.4 + 0.5 * (decidable / c.total)),
    source: "checklist",
    observation: `${c.satisfied}/${decidable} requirements evidenced` +
      (c.undetermined.length ? `; ${c.undetermined.length} undetermined` : ""),
  };
}

function architectureMatch(input: EvidenceInput): EvidenceSignal | null {
  if (input.architectureMatch === undefined) return null;
  return {
    value: clamp(input.architectureMatch),
    confidence: 0.7,
    source: "code-index:module-map",
    observation: `architectural fit ${Math.round(input.architectureMatch * 100)}%`,
  };
}

/**
 * Implementation quality — structural signals only.
 *
 * Explicitly NOT popularity (spec §7: "Do not assume popularity equals quality"). CI,
 * releases and documentation indicate that someone maintains this as a product rather than
 * a snapshot of an experiment.
 */
function implementationQuality(input: EvidenceInput): EvidenceSignal | null {
  const q = input.quality;
  if (!q) return null;
  const parts: [string, number, number][] = [
    ["CI configured", q.hasCi ? 1 : 0, 0.3],
    ["has releases", q.releaseCount > 0 ? Math.min(1, q.releaseCount / 5) : 0, 0.25],
    ["documentation", q.hasDocs ? 1 : q.hasReadme ? 0.5 : 0, 0.2],
    ["contribution guide", q.hasContributing ? 1 : 0, 0.1],
    ["changelog", q.hasChangelog ? 1 : 0, 0.15],
  ];
  const value = parts.reduce((a, [, v, w]) => a + v * w, 0);
  const present = parts.filter(([, v]) => v > 0).map(([label]) => label);
  return {
    value: clamp(value),
    confidence: 0.75,
    source: "repo-structure",
    observation: present.length ? present.join(", ") : "no structural quality signals",
  };
}

function testEvidence(input: EvidenceInput): EvidenceSignal | null {
  const q = input.quality;
  if (!q) return null;
  if (!q.hasTests) {
    return { value: 0.05, confidence: 0.8, source: "repo-tree", observation: "no test files found" };
  }
  // Saturates around 25 files: past that, more tests do not mean proportionally more
  // confidence, and would otherwise let large repos dominate the axis.
  const value = clamp(0.35 + Math.min(0.65, q.testFileCount / 25 * 0.65));
  return {
    value, confidence: 0.8, source: "repo-tree",
    observation: `${q.testFileCount} test file(s)`,
  };
}

/**
 * Maintenance.
 *
 * Recency of the last push dominates: a repository last touched three years ago is
 * unmaintained regardless of how many commits it once had. Archived is decisive.
 */
function maintenance(input: EvidenceInput): EvidenceSignal | null {
  const md = input.metadata;
  const q = input.quality;
  const last = q?.lastCommitAt ?? md.pushedAt;
  if (!last) return null;

  if (md.archived) {
    return { value: 0, confidence: 0.95, source: "github:archived", observation: "repository is archived" };
  }

  const days = (Date.now() - Date.parse(last)) / 86_400_000;
  let value: number;
  if (days <= 30) value = 1;
  else if (days <= 90) value = 0.85;
  else if (days <= 180) value = 0.7;
  else if (days <= 365) value = 0.5;
  else if (days <= 730) value = 0.25;
  else value = 0.08;

  // Commit volume refines but never rescues a stale repository.
  const commits = q?.commitsLast90Days;
  if (commits !== undefined && days <= 180) {
    value = clamp(value * 0.8 + Math.min(1, commits / 30) * 0.2);
  }

  return {
    value: clamp(value),
    confidence: 0.85,
    source: "github:pushed_at+commits",
    observation: `last activity ${Math.round(days)}d ago` +
      (commits !== undefined ? `, ${commits} commit(s) in 90d` : ""),
  };
}

function documentation(input: EvidenceInput): EvidenceSignal | null {
  const q = input.quality;
  if (!q) return null;
  const value = clamp(q.readmeQuality * 0.6 + (q.hasDocs ? 0.25 : 0) + (q.hasChangelog ? 0.15 : 0));
  return {
    value, confidence: 0.7, source: "repo-structure",
    observation: q.hasReadme ? `README quality ${Math.round(q.readmeQuality * 100)}%${q.hasDocs ? ", docs/ present" : ""}` : "no README",
  };
}

/**
 * Popularity — deliberately log-scaled and weighted low.
 *
 * Linear star counts would let one 50k-star repository dominate every other axis combined.
 * Log scaling means the difference between 100 and 1 000 stars matters more than between
 * 40 000 and 50 000, which is closer to how stars actually relate to quality.
 */
function popularity(input: EvidenceInput): EvidenceSignal | null {
  const md = input.metadata;
  const stars = md.stars;
  const value = clamp(Math.log10(stars + 1) / 4.5);   // 30k stars ≈ 1.0
  return {
    value, confidence: 0.9, source: "github:stars",
    observation: `${stars.toLocaleString()} stars, ${md.forks.toLocaleString()} forks`,
  };
}

function dependencySimplicity(input: EvidenceInput): EvidenceSignal | null {
  const s = input.integrationSurface;
  if (!s) return null;
  const n = s.dependencyCount;
  const value = n <= 3 ? 1 : n >= 25 ? 0.05 : clamp(1 - (n - 3) / 22);
  return {
    value, confidence: 0.8, source: "manifests",
    observation: `${n} runtime dependenc${n === 1 ? "y" : "ies"}`,
  };
}

function integrationSurfaceSignal(input: EvidenceInput): EvidenceSignal | null {
  const s = input.integrationSurface;
  if (!s) return null;
  return {
    value: clamp(s.score),
    confidence: 0.75,
    source: "computed:integration-surface",
    observation: `${s.difficulty} — ${s.drivers.slice(0, 3).join("; ") || "no notable drivers"}`,
  };
}

/**
 * Can you actually depend on this?
 *
 * Deliberately reported with the classification in the observation, because "application"
 * is the reason a plausible-looking candidate is being ranked down, and the caller should
 * see that rather than an unexplained deduction.
 */
function reusabilitySignal(input: EvidenceInput): EvidenceSignal | null {
  const r = input.reusability;
  if (!r || r.kind === "unknown") return null;
  return {
    value: r.score,
    confidence: r.confidence,
    source: "repo-structure:library-vs-app",
    observation: `${r.kind}${r.signals.length ? ` — ${r.signals.slice(0, 2).join("; ")}` : ""}`,
  };
}

function licenseSignal(input: EvidenceInput): EvidenceSignal | null {
  const l = input.license;
  if (!l) return null;
  return {
    value: licenseScore(l),
    confidence: l.confidence,
    source: l.sourceFile ? `license-file:${l.sourceFile}` : "github:license",
    observation: `${l.spdx}${l.category !== "unknown" ? ` (${l.category})` : ""}`,
  };
}

// ---------------------------------------------------------------------------

function clamp(n: number): number {
  return Math.max(0, Math.min(1, Math.round(n * 100) / 100));
}

/** Convenience for callers holding a partially-enriched Candidate. */
export function evidenceFromCandidate(
  c: Candidate, task?: ImplementationTask, target?: TargetStack, relevanceText?: string,
): CandidateEvidence {
  const sources = ["github:metadata"];
  if (c.quality) sources.push("repo-structure");
  if (c.symbols?.length) sources.push("code-index");
  if (c.license) sources.push("license");
  if (c.dependencies) sources.push("manifests");
  return collectEvidence({
    metadata: c.metadata, task, target,
    quality: c.quality, license: c.license,
    completeness: c.completeness, integrationSurface: c.integrationSurface,
    reusability: c.reusability,
    architectureMatch: c.architecture?.confidence,
    relevanceText, sources,
  });
}
