/**
 * The Implementation Bundle — the primary deliverable of this MCP (spec §10).
 *
 * Versioning: `schemaVersion` is bumped on breaking change. The spec explicitly asks that
 * the schema be able to evolve, so consumers should tolerate unknown fields and check the
 * version rather than assume shape.
 */

import type {
  AdaptationPlan, ArchitectureSummary, CandidateEvidence, CodeSymbol, CompletenessReport,
  Degradation, Dependency, DependencyReport, IntegrationDifficulty, IntegrationSurface,
  LicenseInfo, MinimalImplementationSet, Provenance, RepoRef, ReuseAssessment, TestReport,
} from "./index.js";

export const BUNDLE_SCHEMA_VERSION = "1.0.0" as const;

export interface ImplementationBundle {
  schemaVersion: string;
  feature: string;
  /** The stack this bundle was tailored for, echoed back so the agent can verify fit. */
  targetStack?: string;

  recommendation: BundleRecommendation;
  /** Runners-up, kept short. Lets the agent second-guess us cheaply. */
  alternatives: BundleAlternative[];

  /**
   * How this may legitimately be used. The single most decision-relevant field here —
   * read it before anything else. DO_NOT_USE bundles are still returned, with the reason,
   * so the agent learns why rather than silently getting nothing.
   */
  reuse: ReuseAssessment;

  architecture: ArchitectureSummary;

  /**
   * The minimal connected symbol set plus what was excluded.
   * This is the Layer-2 implementation map, and the main token saving.
   */
  minimalSet: MinimalImplementationSet;
  /** Flattened, role-annotated view of `minimalSet.core` + `supporting`. */
  symbols: BundleSymbol[];

  /** Requirement-by-requirement scorecard: what this actually implements. */
  completeness: CompletenessReport;
  /** Measured integration cost, not an adjective. */
  integrationSurface: IntegrationSurface;
  /** Normalised signals behind the recommendation, so the score is auditable. */
  evidence?: CandidateEvidence;
  dependencies: DependencyReport;
  tests: TestReport;

  /** Where this plugs into the consuming project. */
  integrationPoints: IntegrationPoint[];
  /** What must change to make it fit (spec §16). */
  adaptationNotes: string[];
  adaptation?: AdaptationPlan;

  license: LicenseInfo;
  provenance: Provenance[];

  /** 0–1 overall confidence in this bundle. */
  confidence: number;
  integrationDifficulty: IntegrationDifficulty;

  /** Things we could not determine. Explicit gaps beat silent omissions. */
  unknowns: string[];
  /** Non-fatal problems encountered while building the bundle (spec §21). */
  degradations: Degradation[];

  /** What was deliberately withheld, and the exact call that would fetch it (spec §9). */
  availableOnRequest: DeferredContent[];

  metrics?: BundleMetrics;
}

export interface BundleRecommendation {
  repository: string;
  ref: RepoRef;
  score: number;
  confidence: number;
  /** The ranking explanation, verbatim. */
  why: string[];
  concerns: string[];
}

export interface BundleAlternative {
  repository: string;
  score: number;
  /** One line on when you would pick this instead. */
  chooseWhen: string;
  tradeoff: string;
  reuseMode: string;
}

// ---------------------------------------------------------------------------
// Alternative discovery — closes the build/test feedback loop
// ---------------------------------------------------------------------------

/**
 * Input to `find_alternative`.
 *
 * The coding agent has already tried something and hit a wall ("requires a dependency
 * incompatible with my project", "licence is AGPL", "needs Java 21"). Rather than let it
 * re-search from zero, we re-rank the candidates we already gathered under an added
 * constraint, and only widen the search if that is not enough.
 */
export interface AlternativeRequest {
  feature: string;
  /** The candidate that failed. */
  currentCandidate?: string;
  /** Why it failed, in the agent's own words. Parsed into a structured constraint. */
  reason: string;
  targetStack?: string;
  /** Repositories already rejected, so we never suggest them again. */
  exclude?: string[];
}

/** A parsed rejection reason, turned into a filter the ranker can apply. */
export interface RejectionConstraint {
  kind:
    | "dependency-incompatible"
    | "license-incompatible"
    | "stack-mismatch"
    | "too-complex"
    | "unmaintained"
    | "missing-capability"
    | "build-failure"
    | "other";
  /** The specific subject, e.g. the offending dependency or licence id. */
  subject?: string;
  /** How the constraint was derived; "verbatim" when we could not parse it. */
  derivedFrom: string;
}

export interface AlternativeResult {
  feature: string;
  constraint: RejectionConstraint;
  alternatives: BundleAlternative[];
  /** True when the existing candidate pool sufficed (no new GitHub quota spent). */
  servedFromExistingCandidates: boolean;
  /** Set when nothing satisfies the constraint — with what to do instead. */
  noneFound?: { reason: string; suggestion: string };
  degradations: Degradation[];
}

/** A symbol in the bundle, enriched with why it matters for this feature. */
export interface BundleSymbol extends CodeSymbol {
  /** Why this symbol is in the bundle at all. */
  role: string;
  /** Whether the agent will likely need the actual source. */
  sourceRecommended: boolean;
}

export interface IntegrationPoint {
  /** Where in the target project this belongs. */
  location: string;
  what: string;
  how: string;
  /** Existing target-project symbols/files this touches, when known. */
  touches: string[];
}

/** Content intentionally not included, plus the call that would retrieve it. */
export interface DeferredContent {
  layer: 3 | 4;
  what: string;
  estimatedTokens: number;
  fetchWith: { tool: string; args: Record<string, unknown> };
}

/** Token-efficiency instrumentation (spec §25). */
export interface BundleMetrics {
  githubSearchCalls: number;
  githubFilesExamined: number;
  repositoriesConsidered: number;
  repositoriesSelected: number;
  codeIndexCalls: number;
  symbolsExamined: number;
  symbolsReturned: number;
  sourceTokensRetrieved: number;
  contextTokensReturned: number;
  cacheHits: number;
  cacheMisses: number;
  /** Tokens the agent would have spent reading this material directly. */
  estimatedRawTokens: number;
  /** 1 - (contextTokensReturned / estimatedRawTokens), as a percentage. */
  contextReductionPercent: number;
  wallClockMs: number;
  degradedPaths: string[];
}

// ---------------------------------------------------------------------------
// Implementation plan (spec §4 generate_implementation_plan, §13 cross-repo synthesis)
// ---------------------------------------------------------------------------

export interface ImplementationPlan {
  schemaVersion: string;
  requirement: string;
  targetStack?: string;
  /** One entry per feature unit, in build order. */
  steps: PlanStep[];
  /** Problems arising from combining several repositories (spec §13). */
  synthesis: SynthesisReport;
  /** Assumptions the agent must verify before trusting the plan. */
  assumptionsToVerify: string[];
  risks: string[];
  licenseSummary: LicenseSummary;
  provenance: Provenance[];
  metrics?: BundleMetrics;
}

export interface PlanStep {
  order: number;
  feature: string;
  /** Which existing implementation to use — or an explicit "build from scratch". */
  useImplementation: { repository: string; score: number; commit?: string } | "build-from-scratch";
  rationale: string;
  relevantSymbols: string[];
  adaptationRequired: string[];
  dependenciesToAdd: Dependency[];
  integrationTargets: string[];
  testsToAdd: string[];
  effort: "trivial" | "small" | "medium" | "large";
  blockedBy: string[];
}

/** Cross-repository synthesis findings (spec §13). */
export interface SynthesisReport {
  overlappingDependencies: { name: string; usedBy: string[]; versions: string[] }[];
  versionConflicts: { name: string; conflicting: { repository: string; version: string }[] }[];
  incompatibleArchitectures: { repositories: string[]; issue: string }[];
  duplicateAbstractions: { concept: string; repositories: string[]; recommendation: string }[];
  namingConflicts: { symbol: string; repositories: string[] }[];
  frameworkDifferences: string[];
  licenseConflicts: { repositories: string[]; issue: string; severity: "caution" | "high" }[];
  /** How to reconcile all of the above into one target architecture. */
  unificationStrategy: string[];
}

export interface LicenseSummary {
  licenses: { repository: string; spdx: string; category: string }[];
  strictest: string;
  overallRisk: "low" | "medium" | "high" | "unknown";
  warnings: string[];
  disclaimer: string;
}

// ---------------------------------------------------------------------------
// Verification (spec §17)
// ---------------------------------------------------------------------------

export interface VerificationReport {
  feature: string;
  checks: VerificationCheck[];
  /** 0–1. Static inspection only — never a correctness guarantee. */
  confidence: number;
  remainingRisks: string[];
  disclaimer: string;
}

export interface VerificationCheck {
  name: string;
  status: "pass" | "fail" | "partial" | "unknown";
  detail: string;
  evidence: string[];
}
