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
  Candidate, CandidateEvidence, CompletenessReport, Dependency, EvidenceAxis, EvidenceSignal,
  IntegrationSurface, LicenseInfo, RepoMetadata, RepoQuality, TargetStack,
} from "../types/index.js";
import type { ImplementationTask } from "../types/index.js";
import { licenseScore } from "../analyzers/license.js";
import type { ReusabilityAssessment } from "../analyzers/reusability.js";
import { detectHostFramework, hostFrameworkPenalty } from "../analyzers/host-framework.js";
import { classifyTargetStack, deploymentPenalty, detectDeploymentTarget } from "../analyzers/deployment.js";

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
  /** Refines host-framework detection when available; never required. */
  dependencies?: Dependency[];
  filePaths?: string[];
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
/**
 * Words that look like proper nouns in a feature name but name no product.
 * Includes stacks and platforms, which are matched by the stackMatch axis instead.
 */
const NOT_A_PRODUCT = new Set([
  "android", "ios", "web", "kotlin", "java", "swift", "python", "javascript", "typescript",
  "http", "https", "rest", "api", "sdk", "url", "json", "xml", "csv", "pdf", "sql", "ui",
  "oauth", "jwt", "rtl", "e2ee", "aes", "rsa", "tls", "ssl", "crud", "mvi", "mvvm",
  "build", "create", "add", "the", "and", "with", "for", "full", "text",
]);

/**
 * Products the candidate must reference: the agent's declaration first, then a
 * deliberately low-recall fallback for callers that declared nothing.
 *
 * The fallback only trusts capitalisation AFTER the first word, because sentence case
 * makes the first word uninformative — and it cannot be salvaged by heuristics, since
 * "Stripe" and "Resumable" are both capitalised English words that begin a feature name.
 * That is precisely why `mustMention` exists: the agent knows which is which, and an
 * unreliable guess here silently demotes correct candidates.
 */
function namedProducts(task: { feature: string; mustMention?: string[] }): string[] {
  if (task.mustMention?.length) {
    return task.mustMention.map((t) => t.toLowerCase().trim()).filter(Boolean);
  }
  return task.feature
    .split(/\s+/)
    .filter(Boolean)
    .slice(1)
    .filter((w) => /^[A-Z][A-Za-z0-9.+-]{2,}$/.test(w))
    .map((w) => w.replace(/[^A-Za-z0-9.+-]/g, "").toLowerCase())
    .filter((w) => w.length >= 3 && !NOT_A_PRODUCT.has(w));
}

/**
 * Terms that disqualify a candidate, matched against its declaration only.
 *
 * See AgentFeature.excludeTerms for why this cannot be inferred. The scale is deliberately
 * harsher than the mustMention miss (0.35): a missing product term means "may be the wrong
 * product", while a present exclusion term means "is the wrong KIND of thing". The candidate
 * stays visible — a network inspector is a legitimate answer to a different question — but
 * it can no longer outrank an implementation.
 */
function exclusionHits(
  task: { excludeTerms?: string[] },
  declared: string,
): string[] {
  if (!task.excludeTerms?.length) return [];
  return task.excludeTerms
    .map((t) => t.toLowerCase().trim())
    .filter((t) => t.length > 0 && declared.includes(t));
}

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

  /*
   * Named-product gate.
   *
   * A product named in the feature is a hard requirement. Scaling relevance rather than
   * zeroing it keeps a competitor visible as an alternative — sometimes the answer really
   * is "Stripe has no Android SDK for this, use X" — but it can no longer outrank the thing
   * that was actually asked for.
   */
  const products = namedProducts(task);
  if (products.length) {
    /*
     * WHERE the term appears decides how much it counts.
     *
     * Name, description and topics are DECLARATIVE — they say what a repository is. A
     * README mention is incidental: `wiretapKMP` is a network-inspection tool whose README
     * mentions websockets because it inspects them, and a flat substring search over the
     * README let it satisfy mustMention:["websocket"] and outrank an actual WebSocket
     * client. Requiring the term in the declaration, and treating a README-only mention as
     * partial credit, separates "this is a WebSocket library" from "this talks about
     * WebSockets".
     */
    const declared = `${md.ref.fullName} ${nameText} ${topicText}`.toLowerCase();
    const inBody = bodyText.toLowerCase();

    const declaredHits = products.filter((p) => declared.includes(p));
    const bodyOnlyHits = products.filter((p) => !declared.includes(p) && inBody.includes(p));

    if (declaredHits.length === 0) {
      if (bodyOnlyHits.length > 0) {
        score *= 0.6;
        evidence.push(`mentions ${bodyOnlyHits.join(", ")} only in its README, not in its name, description or topics`);
      } else {
        score *= 0.35;
        evidence.push(`does not mention ${products.join(" or ")}, which the feature names`);
      }
    }
  }

  const excluded = exclusionHits(task, `${md.ref.fullName} ${nameText} ${topicText}`.toLowerCase());
  if (excluded.length) {
    score *= 0.2;
    evidence.push(`describes itself as ${excluded.join(", ")}, which the feature excludes`);
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

  let value = clamp(langScore * 0.75 + frameworkScore * 0.25);

  /*
   * Host-framework gate.
   *
   * `metadata.language` is GitHub's byte-count winner, and for a cross-platform plugin the
   * native shim can win it: `react-native-blob-courier` reports **Kotlin** (47% of bytes)
   * and therefore scored a perfect 1.00 against a native Kotlin/Android target. It was
   * recommended as a file-upload implementation despite being unusable without React
   * Native — its API is TypeScript, behind the RN bridge. The language matched; the runtime
   * did not, and nothing was measuring the runtime.
   */
  const host = detectHostFramework({
    metadata: input.metadata,
    dependencies: input.dependencies,
    filePaths: input.filePaths,
  });
  const penalty = hostFrameworkPenalty(host, [target.framework, target.platform, target.language, ...(target.libraries ?? [])]);
  if (penalty.multiplier !== 1) {
    value = clamp(value * penalty.multiplier);
    observation += `; ${penalty.reason}`;
  }

  /*
   * Deployment-target gate: client-side or server-side?
   *
   * The third way a "Kotlin" match can be wrong. `vgv/kolbasa` is a job queue built on
   * PostgreSQL and won that feature for an Android app; `bloomberg/pushiko` is a JVM
   * library for SENDING push notifications when the app needs to receive them. Both are
   * Kotlin, both are libraries, both are unambiguously about the right domain — every
   * other signal said yes.
   */
  const deployment = detectDeploymentTarget({
    metadata: input.metadata,
    dependencies: input.dependencies,
    filePaths: input.filePaths,
  });
  const side = classifyTargetStack([target.platform, target.framework, ...(target.libraries ?? [])]);
  const sidePenalty = deploymentPenalty(deployment, side);
  if (sidePenalty.multiplier !== 1) {
    value = clamp(value * sidePenalty.multiplier);
    observation += `; ${sidePenalty.reason}`;
  }

  return {
    value,
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

  /*
   * Recency is not maintenance. Maintenance is the claim that a project HAS BEEN kept
   * working, and a repository with no history cannot have demonstrated it.
   *
   * Scored on recency alone, `vinkurov/webhook-kit` — created 2026-08-08, pushed
   * 2026-08-10, zero stars — took a perfect 1.00 and beat stripe/stripe-node (4,503 stars,
   * 52 test files, 55 commits in 90 days) for a Stripe billing query. Every brand-new
   * repository looks perfectly maintained on its second day.
   *
   * The cap is a ceiling, not a penalty: a young project can still be excellent, and this
   * says only that it has not yet proven it will be maintained. It lifts as the project
   * ages, reaching the full range at a year.
   */
  let ageNote = "";
  const createdAt = md.createdAt;
  if (createdAt) {
    const ageDays = (Date.now() - Date.parse(createdAt)) / 86_400_000;
    if (Number.isFinite(ageDays) && ageDays >= 0) {
      const ceiling = ageDays <= 30 ? 0.45 : ageDays <= 90 ? 0.6 : ageDays <= 365 ? 0.8 : 1;
      if (ceiling < value) {
        value = ceiling;
        ageNote = `, only ${Math.round(ageDays)}d old so maintenance is unproven`;
      }
    }
  }

  return {
    value: clamp(value),
    confidence: 0.85,
    source: "github:pushed_at+commits",
    observation: `last activity ${Math.round(days)}d ago` +
      (commits !== undefined ? `, ${commits} commit(s) in 90d` : "") + ageNote,
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
  /*
   * Logarithmic, because the old linear ramp hit its 0.05 floor at 25 dependencies and
   * stopped discriminating exactly where server-side libraries live: golang-migrate (38,
   * nearly all optional database drivers) scored identically to a genuinely bloated
   * 200-dependency project. Doubling the count should cost a constant amount, not fall off
   * a cliff — 3 deps scores 1.00, 10 scores 0.60, 25 scores 0.29, 60 reaches 0.
   */
  const value = n <= 3 ? 1 : clamp(1 - Math.log10(n / 3) / Math.log10(20));
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
    dependencies: c.dependencies?.direct,
    architectureMatch: c.architecture?.confidence,
    relevanceText, sources,
  });
}
