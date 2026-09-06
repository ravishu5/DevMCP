/**
 * Core domain types for the Implementation Intelligence MCP.
 *
 * Design notes
 * ------------
 * These types are deliberately *provider-agnostic*. Nothing here mentions GitHub or
 * jCodeMunch, so a GitLab / Bitbucket / local-codebase provider (spec §33) can be added
 * without touching orchestration, ranking or context building.
 *
 * Every type that carries information derived from an upstream repository also carries
 * enough identity to reconstruct where it came from (spec §11 — provenance is mandatory).
 */

// ---------------------------------------------------------------------------
// Identity & provenance
// ---------------------------------------------------------------------------

/** Canonical repository identity, independent of hosting provider. */
export interface RepoRef {
  /** Hosting provider id, e.g. "github". Lets us add gitlab/bitbucket later. */
  provider: string;
  owner: string;
  name: string;
  /** "owner/name" — the form used in cache keys and tool arguments. */
  fullName: string;
  /** Default branch, when known. */
  defaultBranch?: string;
  /** Commit SHA this view of the repository was taken at. Anchors cache identity. */
  commit?: string;
  /** Tag or branch, when the caller pinned one. */
  ref?: string;
  /** Canonical web URL. */
  url?: string;
}

/**
 * Provenance for every extracted artefact (spec §11).
 * Never drop this. It is required for debugging, reproducibility, attribution,
 * licence compliance and future updates.
 */
export interface Provenance {
  repository: string;
  owner: string;
  provider: string;
  commit?: string;
  ref?: string;
  files: string[];
  symbols?: string[];
  license?: string;
  /** ISO-8601 timestamp of retrieval. */
  retrievedAt: string;
  /** Which retrieval path produced this: the deep index, or the degraded fallback. */
  retrievalMode: RetrievalMode;
}

/** How a piece of information was obtained. Surfaced to the agent (spec §8). */
export type RetrievalMode =
  | "code-index"        // jCodeMunch symbol-level index — the good path
  | "github-fallback"   // degraded: GitHub file/code retrieval
  | "metadata-only"     // no source was read at all
  | "cache"             // served from cache (originating mode preserved separately)
  | "unavailable";      // nothing could be retrieved

// ---------------------------------------------------------------------------
// Requirements & features
// ---------------------------------------------------------------------------

/** A target technology stack, used for compatibility scoring (spec §14). */
export interface TargetStack {
  language?: string;
  framework?: string;
  platform?: string;
  /** Free-form extras: "PostgreSQL", "Prisma", "Next.js"… */
  libraries?: string[];
  /** Licence of the consuming project, for compatibility checks (spec §12). */
  projectLicense?: string;
  /** Whether the consuming project is distributed or internal-only. Affects copyleft risk. */
  distribution?: "proprietary" | "open-source" | "internal" | "unknown";
}

/** One reusable implementation unit produced by decomposition (spec §4 decompose_application). */
export interface FeatureUnit {
  id: string;
  name: string;
  /** One-line statement of what has to exist. */
  description: string;
  /** Concrete sub-requirements, used to sharpen search and relevance scoring. */
  requirements: string[];
  /** Higher = build/discover earlier. Foundational units (networking, db) rank high. */
  priority: number;
  /** ids of other FeatureUnits this one builds on. */
  dependsOn: string[];
  /** Rough guess at whether reuse is likely to pay off. */
  reusePotential: "high" | "medium" | "low";
  /** Search vocabulary the user may not know (spec §20). */
  searchTerms: string[];
  category: FeatureCategory;
}

export type FeatureCategory =
  | "auth" | "networking" | "persistence" | "background" | "ui"
  | "media" | "messaging" | "notifications" | "sync" | "search"
  | "payments" | "analytics" | "infra" | "testing" | "other";

// ---------------------------------------------------------------------------
// Repository observation
// ---------------------------------------------------------------------------

/** Raw-ish repository facts, as reported by a provider. No judgement applied yet. */
export interface RepoMetadata {
  ref: RepoRef;
  description?: string;
  topics: string[];
  language?: string;
  languages?: Record<string, number>;
  stars: number;
  forks: number;
  watchers: number;
  openIssues: number;
  /** True for GitHub forks/mirrors — a strong deduplication signal (spec §19). */
  isFork: boolean;
  parent?: string;
  archived: boolean;
  disabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
  pushedAt?: string;
  size?: number;
  licenseSpdx?: string;
  homepage?: string;
}

/** Derived quality signals (spec §7). Popularity is one signal among many, never the verdict. */
export interface RepoQuality {
  /** 0–100 composite, explained by `signals`. */
  score: number;
  hasTests: boolean;
  testFileCount: number;
  hasCi: boolean;
  ciSystems: string[];
  hasReadme: boolean;
  readmeQuality: number;      // 0–1
  hasDocs: boolean;
  hasChangelog: boolean;
  hasContributing: boolean;
  releaseCount: number;
  latestReleaseAt?: string;
  contributorCount?: number;
  commitsLast90Days?: number;
  lastCommitAt?: string;
  /** Days since last push. Cheap maintenance proxy when commit history is unavailable. */
  daysSinceLastPush?: number;
  /** Human-readable evidence, both positive and negative. */
  signals: QualitySignal[];
}

export interface QualitySignal {
  kind: "positive" | "negative" | "neutral";
  label: string;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

export type SymbolKind =
  | "class" | "function" | "method" | "interface" | "type"
  | "enum" | "constant" | "module" | "struct" | "trait" | "unknown";

/** A code symbol, as understood by the code index. */
export interface CodeSymbol {
  /** Index-native id, e.g. "src/app.py::parse_config#function". Opaque; used for retrieval. */
  id: string;
  name: string;
  kind: SymbolKind;
  filePath: string;
  startLine?: number;
  endLine?: number;
  signature?: string;
  /** Short purpose statement. May be derived from signature when no summariser is present. */
  purpose?: string;
  language?: string;
  /** Relevance to the requested feature, 0–1. Assigned by the symbol analyzer. */
  relevance?: number;
  /** Children (methods of a class), used to render the Layer-2 implementation map. */
  members?: CodeSymbol[];
}

/** Actual source for a symbol. Only ever fetched at Layer 3. */
export interface SymbolSource {
  symbolId: string;
  filePath: string;
  source: string;
  startLine?: number;
  endLine?: number;
  /** Estimated tokens for this fragment — feeds the budget accounting. */
  estimatedTokens: number;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Dependencies, tests, licences
// ---------------------------------------------------------------------------

export interface Dependency {
  name: string;
  version?: string;
  /** Which manifest declared it. */
  ecosystem: DependencyEcosystem;
  scope: "runtime" | "dev" | "test" | "build" | "peer" | "optional" | "unknown";
  /** Where it was declared, for provenance. */
  declaredIn: string;
  /** True when we inferred it rather than read it from a manifest. */
  inferred?: boolean;
  notes?: string;
}

export type DependencyEcosystem =
  | "npm" | "gradle" | "maven" | "pypi" | "cargo" | "go" | "composer"
  | "gem" | "nuget" | "swiftpm" | "cocoapods" | "unknown";

export interface DependencyReport {
  direct: Dependency[];
  /** Populated only where a lockfile made it practical (spec §4 find_dependencies). */
  transitiveSample: Dependency[];
  manifests: string[];
  ecosystems: DependencyEcosystem[];
  /** Config the consumer must supply (env vars, keys, permissions). */
  requiredConfiguration: string[];
  platformRequirements: string[];
  /** Dependencies that clash with the declared target stack. */
  incompatibilities: string[];
  versionAssumptions: string[];
  /** 0–1, higher = simpler. Feeds the "dependency simplicity" ranking axis. */
  simplicity: number;
  notes: string[];
}

export interface TestReport {
  hasTests: boolean;
  frameworks: string[];
  unitTests: TestArtifact[];
  integrationTests: TestArtifact[];
  fixtures: string[];
  mocks: string[];
  testUtilities: string[];
  /** Edge cases the tests visibly exercise — high-value context for the coding agent. */
  edgeCasesCovered: string[];
  /** 0–1 confidence that the feature in question is actually tested. */
  featureTestConfidence: number;
  notes: string[];
}

export interface TestArtifact {
  filePath: string;
  name?: string;
  symbolId?: string;
  /** What this test appears to assert. Derived from names, never executed. */
  asserts?: string;
}

export type LicenseCategory =
  | "permissive" | "weak-copyleft" | "strong-copyleft" | "network-copyleft"
  | "public-domain" | "proprietary" | "unknown" | "none";

export interface LicenseInfo {
  /** SPDX id where identifiable, else "UNKNOWN"/"NOASSERTION". */
  spdx: string;
  name: string;
  category: LicenseCategory;
  /** Confidence the licence was correctly identified, 0–1. */
  confidence: number;
  sourceFile?: string;
  /** Advisory only. We never claim legal certainty (spec §12). */
  compatible: boolean | "unclear";
  /** Concrete obligations the consumer takes on. */
  obligations: string[];
  warnings: LicenseWarning[];
  /** Always present. Restates that this is not legal advice. */
  disclaimer: string;
}

export interface LicenseWarning {
  severity: "info" | "caution" | "high";
  message: string;
}

// ---------------------------------------------------------------------------
// Implementation planning (the layer between decomposition and discovery)
// ---------------------------------------------------------------------------

/**
 * Output of the Implementation Planner.
 *
 * The decomposer answers "what features does this app contain?".
 * The planner answers "which features are worth reusing, and what KIND of existing
 * implementation should we go looking for?" — which is a different, and more useful,
 * question. A feature like "app-specific business rules" is a real feature but a poor
 * reuse target; "resumable HTTP download" is a great one.
 */
export interface ImplementationTask {
  /** FeatureUnit this task was derived from. */
  featureId: string;
  feature: string;
  /** Whether to search at all, and how hard to look. */
  strategy: ReuseStrategy;
  /**
   * The *kind* of artefact worth finding — this is what sharpens discovery.
   * e.g. "mature download engines", "persistent job queue implementations",
   * "HTTP Range / resumable download implementations".
   */
  lookingFor: string[];
  /** Canonical capability tags used for fingerprint lookup and relevance scoring. */
  capabilities: string[];
  /** Concrete checklist the candidate is scored against (drives completeness). */
  requirementChecklist: string[];
  /** Search vocabulary, including terms the user would not know (spec §20). */
  searchQueries: string[];
  /** Why this strategy was chosen — surfaced so the agent can override it. */
  rationale: string;
  /** Relative discovery budget, 0-1. Foundational/high-reuse features get more quota. */
  budgetShare: number;
  priority: number;
  dependsOn: string[];
}

export type ReuseStrategy =
  /** Well-solved problem with mature OSS. Search hard, expect DIRECT_REUSE. */
  | "reuse-library"
  /** Common pattern, many implementations. Search for the pattern, expect ADAPT. */
  | "reuse-pattern"
  /** Tricky algorithm worth studying but not copying. Expect REFERENCE_ONLY. */
  | "study-reference"
  /** App-specific. Do not spend quota here. */
  | "build-from-scratch";

// ---------------------------------------------------------------------------
// Candidate evidence (normalised signals, before ranking touches them)
// ---------------------------------------------------------------------------

/**
 * One measured signal.
 *
 * Recording `source` and `confidence` alongside `value` is what makes the final score
 * reproducible and auditable: a signal we could not measure lowers confidence rather than
 * silently scoring zero, and every number can be traced back to the observation behind it.
 */
export interface EvidenceSignal {
  /** Normalised 0-1. */
  value: number;
  /** How confident we are in `value` itself, 0-1. Low when inferred from weak proxies. */
  confidence: number;
  /** Where this came from, e.g. "github:topics", "jcodemunch:module-map", "readme". */
  source: string;
  /** The raw observation, kept short. Rendered in explanations. */
  observation: string;
  /** True when nothing could be measured and a neutral prior was used. */
  imputed?: boolean;
}

export type EvidenceAxis =
  | "featureRelevance"
  | "architectureMatch"
  | "stackMatch"
  | "completeness"
  | "implementationQuality"
  | "testEvidence"
  | "maintenance"
  | "documentation"
  | "popularity"
  | "dependencySimplicity"
  | "integrationSurface"
  | "licenseCompatibility"
  /** Library vs application — can you actually depend on this? */
  | "reusability";

/** The complete evidence record for one candidate. Ranking consumes only this. */
export interface CandidateEvidence {
  repository: string;
  axes: Record<EvidenceAxis, EvidenceSignal>;
  /** Which sources actually contributed. Shows whether deep analysis ran. */
  sources: string[];
  /** Axes that could not be measured at all. */
  unmeasured: EvidenceAxis[];
  collectedAt: string;
}

/**
 * Implementation completeness: how much of the *requested* checklist this candidate
 * actually evidences. Far more meaningful than star count.
 */
export interface CompletenessReport {
  /** One entry per requested requirement. */
  items: CompletenessItem[];
  satisfied: number;
  total: number;
  /** satisfied / total, 0-1. */
  ratio: number;
  /** Requirements with no evidence either way — distinct from evidenced-absent. */
  undetermined: string[];
}

export interface CompletenessItem {
  requirement: string;
  status: "evidenced" | "absent" | "unknown";
  /** What proved it: symbol names, file paths, dependency names, readme phrases. */
  evidence: string[];
  confidence: number;
}

/**
 * Integration surface: how much of the consuming project this implementation will touch.
 * A first-class measurable signal, not a hand-waved adjective.
 */
export interface IntegrationSurface {
  symbolsRequired: number;
  dependencyCount: number;
  integrationPointCount: number;
  configurationRequirements: number;
  /** 0-1, higher = more tightly bound to its own framework (harder to lift out). */
  frameworkCoupling: number;
  /** 0-1, higher = smaller surface = easier. Feeds the ranking axis directly. */
  score: number;
  difficulty: IntegrationDifficulty;
  /** The concrete drivers, for the explanation. */
  drivers: string[];
}

/**
 * How this implementation may legitimately be used (the most decision-relevant field
 * in the whole bundle). Derived from licence category x stack match x architecture match
 * x the target project's distribution model.
 */
export type ReuseMode = "DIRECT_REUSE" | "ADAPT" | "REFERENCE_ONLY" | "DO_NOT_USE";

export interface ReuseAssessment {
  mode: ReuseMode;
  /** Plain-language reason, always populated — especially for DO_NOT_USE. */
  reason: string;
  /** What the coding agent should concretely do under this mode. */
  guidance: string;
  /** Inputs that produced the verdict, for auditability. */
  factors: {
    licenseCategory: LicenseCategory;
    stackMatch: number;
    architectureMatch: number;
    distribution: string;
  };
  /** Attribution/notice obligations the agent must honour if it proceeds. */
  obligations: string[];
  confidence: number;
}

// ---------------------------------------------------------------------------
// Candidates & ranking
// ---------------------------------------------------------------------------

/** A repository under consideration for a feature, enriched progressively. */
import type { ReusabilityAssessment } from "../analyzers/reusability.js";

export interface Candidate {
  ref: RepoRef;
  metadata: RepoMetadata;
  /** Populated progressively - cheap signals first, deep analysis only for finalists. */
  quality?: RepoQuality;
  license?: LicenseInfo;
  dependencies?: DependencyReport;
  tests?: TestReport;
  symbols?: CodeSymbol[];
  /** The minimal connected symbol set, when symbol-level analysis ran. */
  minimalSet?: MinimalImplementationSet;
  architecture?: ArchitectureSummary;
  completeness?: CompletenessReport;
  integrationSurface?: IntegrationSurface;
  /** Whether this is a distributable library or a runnable application. */
  reusability?: ReusabilityAssessment;
  reuse?: ReuseAssessment;
  /** Normalised signals. The ranking engine reads this and nothing else. */
  evidence?: CandidateEvidence;
  /**
   * How much of this candidate we actually examined.
   *
   * "metadata" means only what search returned — most evidence axes are neutral priors,
   * not measurements. A metadata-only candidate must never be *recommended* over one we
   * deeply analysed, however its raw score compares (see `sortByScore`).
   */
  analysisDepth?: "deep" | "metadata";
  /** Why discovery surfaced this repo. Useful for debugging query generation. */
  discoveredVia: string[];
  /** Set when dedup folded near-duplicates into this candidate (spec §19). */
  cluster?: RepoCluster;
  score?: RankingScore;
  /** Non-fatal problems specific to this candidate. */
  degradations?: Degradation[];
}

export interface RepoCluster {
  /** fullNames of repositories judged near-duplicates of this candidate. */
  members: string[];
  reason: "fork" | "name-similarity" | "description-similarity" | "mirror";
}

/** Explainable ranking output (spec §6). The explanation is not optional. */
export interface RankingScore {
  /** 0-100. */
  total: number;
  /** Per-axis normalised scores, 0-1, before weighting. */
  axes: Record<EvidenceAxis, number>;
  /** Weighted contribution of each axis to `total`. Sums to `total`. */
  contributions: Record<EvidenceAxis, number>;
  /** "+ Strong test coverage", "- Uses dependency X" - rendered verbatim to the agent. */
  reasons: string[];
  /** 0-1. Lower when key signals were missing rather than bad. */
  confidence: number;
  /** Axes we could not measure, which is why confidence is reduced. */
  unmeasured: EvidenceAxis[];
  /** Weight set used, echoed so a score can be reproduced exactly. */
  weightsId: string;
  /**
   * Reuse-mode adjustment applied to the weighted total, when a reuse assessment was
   * available. Recorded explicitly rather than folded silently into `total`, so the
   * adjustment is auditable and the pre-adjustment score is still visible.
   */
  reuseAdjustment?: { mode: ReuseMode; multiplier: number; before: number };
}

/** Configurable ranking weights (spec §6 - "make the weights configurable"). */
export type RankingWeights = Record<EvidenceAxis, number>;

// ---------------------------------------------------------------------------
// Architecture & adaptation
// ---------------------------------------------------------------------------

export interface ArchitectureSummary {
  /** e.g. "queue + worker + persistent state". */
  pattern: string;
  components: string[];
  layers?: string[];
  entryPoints: string[];
  /** Directory-level module map, kept short. */
  modules: { path: string; role: string }[];
  notes: string[];
  /** 0–1 — how confident we are in this reading of the architecture. */
  confidence: number;
}

/** Source→target adaptation analysis (spec §16). More valuable than copying files. */
export interface AdaptationPlan {
  sourceArchitecture: string;
  targetArchitecture: string;
  requiredChanges: AdaptationStep[];
  /** What should be kept as-is. Preserving business logic is the point. */
  preserve: string[];
  integrationDifficulty: IntegrationDifficulty;
  risks: string[];
}

export interface AdaptationStep {
  order: number;
  action: string;
  rationale: string;
  affects: string[];
  effort: "trivial" | "small" | "medium" | "large";
}

export type IntegrationDifficulty = "trivial" | "low" | "medium" | "high" | "very-high";

// ---------------------------------------------------------------------------
// Target project (spec §15)
// ---------------------------------------------------------------------------

export interface TargetProjectProfile {
  root: string;
  language?: string;
  languages: Record<string, number>;
  frameworks: string[];
  architecture?: string;
  dependencyManagers: string[];
  existingLibraries: Dependency[];
  directoryStructure: { path: string; role: string }[];
  stateManagement?: string;
  networkingLayer?: string;
  database?: string;
  testingFrameworks: string[];
  codingPatterns: string[];
  projectLicense?: string;
  /** How this profile was produced, and what it could not see. */
  analysisMode: RetrievalMode;
  gaps: string[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Non-fatal problem. Collected and reported; never aborts the pipeline (spec §21). */
export interface Degradation {
  stage: string;
  subject?: string;
  reason: string;
  /** What the system did instead. */
  fallback?: string;
  severity: "info" | "warning" | "error";
}

// ---------------------------------------------------------------------------
// Minimal Implementation Set — the largest single token win
// ---------------------------------------------------------------------------

/**
 * The smallest CONNECTED set of symbols required to understand and reproduce a feature.
 *
 * A code index will happily surface forty related symbols; almost none are needed. We
 * traverse the call/import graph from relevance-seeded roots, keep the set connected, and
 * cut at a relevance floor and a token budget.
 *
 * Excluded symbols are *reported*, never silently dropped — the agent can disagree and
 * pull more, which is the whole point of progressive disclosure.
 */
export interface MinimalImplementationSet {
  /** Must-have symbols. These define the feature. */
  core: CodeSymbol[];
  /** Named but not expanded — types, entities, DTOs the core references. */
  supporting: CodeSymbol[];
  /** Deliberately left out, each with a reason (e.g. "logging", "analytics"). */
  excluded: { name: string; symbolId: string; reason: string }[];
  /** Roots the traversal started from, and why. */
  seeds: { symbolId: string; reason: string }[];
  /** Whether `core` forms a connected subgraph. False means we had to island-hop. */
  connected: boolean;
  estimatedTokens: number;
  /** Tokens the full candidate symbol set would have cost. */
  estimatedFullTokens: number;
  /** Traversal parameters, so a set can be reproduced or widened. */
  parameters: { relevanceFloor: number; maxDepth: number; tokenBudget: number };
}

// ---------------------------------------------------------------------------
// Feature fingerprints — the seed of the Implementation Knowledge Base
// ---------------------------------------------------------------------------

/**
 * What capabilities a repository was observed to implement, recorded per commit.
 *
 * Once written, a later request for e.g. "download queue implementations" can shortlist
 * known repositories WITHOUT touching GitHub search — which is how this eventually becomes
 * faster than GitHub search itself, and progressively less quota-bound.
 */
export interface FeatureFingerprint {
  repository: string;
  commit: string;
  /** capability tag -> strength 0-1. Sparse: absent means "never looked". */
  capabilities: Record<string, number>;
  language?: string;
  frameworks: string[];
  licenseSpdx?: string;
  /** Schema version of the capability vocabulary used. */
  vocabularyVersion: string;
  computedAt: string;
}
