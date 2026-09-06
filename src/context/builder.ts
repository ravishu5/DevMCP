/**
 * Context Builder — assembles the `ImplementationBundle` (spec §10, §9).
 *
 * Two jobs, and the tension between them is the whole design:
 *
 *   1. Fit within a token budget.
 *   2. Never drop something the agent needs to implement correctly.
 *
 * Spec §26 settles the tension: we optimise `useful information / token`, not minimum
 * tokens. "A 2,000-token answer that causes the coding agent to make mistakes is worse than
 * a 6,000-token answer that enables correct implementation."
 *
 * So the budget is spent in **priority order**, and a small set of fields are `forceReserve`d
 * — they go in even if the budget is already spent, because a bundle without them is
 * actively dangerous rather than merely incomplete:
 *
 *   • reuse mode + licence  — the agent could otherwise ship infringing code
 *   • provenance            — spec §11, required for attribution and reproducibility
 *   • degradations          — silence about what we could not check reads as confidence
 *
 * Everything else competes for what is left, and whatever does not fit is listed in
 * `availableOnRequest` **with the exact call that would fetch it** — which is what makes
 * progressive disclosure real rather than an excuse for omission.
 */

import type {
  BundleAlternative, BundleMetrics, BundleRecommendation, BundleSymbol, DeferredContent,
  ImplementationBundle, IntegrationPoint,
} from "../types/bundle.js";
import { BUNDLE_SCHEMA_VERSION } from "../types/bundle.js";
import type {
  AdaptationPlan, Candidate, Degradation, ImplementationTask, Provenance, TargetProjectProfile,
  TargetStack,
} from "../types/index.js";
import { TokenBudget, estimateTokens } from "../core/tokens.js";
import { LICENSE_DISCLAIMER } from "../analyzers/license.js";
import { inferArchitecture, planAdaptation } from "../analyzers/architecture.js";
import { analyzeTests } from "../analyzers/tests.js";
import { REUSE_MODE_RANK } from "../analyzers/reuse.js";

export interface BuildBundleInput {
  task: ImplementationTask;
  recommendation: Candidate;
  alternatives: Candidate[];
  target?: TargetStack;
  targetProfile?: TargetProjectProfile;
  filePaths?: string[];
  degradations: Degradation[];
  metrics?: BundleMetrics;
  maxTokens: number;
  /** Retrieval mode of the deepest source consulted, for provenance. */
  retrievalMode: Provenance["retrievalMode"];
}

export function buildBundle(input: BuildBundleInput): ImplementationBundle {
  const c = input.recommendation;
  const budget = new TokenBudget(input.maxTokens);
  const deferred: DeferredContent[] = [];
  const unknowns: string[] = [];

  // --- must-have: reuse mode and licence -----------------------------------
  // Reserved unconditionally. A bundle that omits "you may not copy this" to save tokens
  // is worse than no bundle at all.
  const reuse = c.reuse ?? {
    mode: "REFERENCE_ONLY" as const,
    reason: "Reuse could not be assessed — licence or stack information was unavailable.",
    guidance: "Treat as reference only until the licence has been verified.",
    factors: { licenseCategory: "unknown" as const, stackMatch: 0, architectureMatch: 0, distribution: "unknown" },
    obligations: [],
    confidence: 0.2,
  };
  budget.forceReserve("reuse+license", estimateTokens(`${reuse.reason} ${reuse.guidance}`) + 60);

  const license = c.license ?? {
    spdx: "UNKNOWN", name: "No identifiable licence", category: "unknown" as const,
    confidence: 0, compatible: "unclear" as const, obligations: [],
    warnings: [{ severity: "high" as const, message: "Licence not determined. Do not assume the code is freely reusable." }],
    disclaimer: LICENSE_DISCLAIMER,
  };
  if (license.spdx === "UNKNOWN") unknowns.push("Licence could not be identified");

  // --- architecture --------------------------------------------------------
  const filePaths = input.filePaths ?? [];
  const architecture = c.architecture ?? inferArchitecture({
    filePaths,
    symbols: c.symbols,
    dependencies: c.dependencies?.direct,
    language: c.metadata.language,
  });
  budget.tryReserve("architecture", estimateTokens(JSON.stringify(architecture), "json"));
  if (architecture.confidence < 0.5) {
    unknowns.push(`Architecture inferred with low confidence (${Math.round(architecture.confidence * 100)}%)`);
  }

  // --- symbols (Layer 2) ---------------------------------------------------
  const minimalSet = c.minimalSet;
  const symbols: BundleSymbol[] = [];
  if (minimalSet) {
    for (const s of minimalSet.core) {
      const entry: BundleSymbol = {
        ...s,
        role: roleFor(s.name, architecture.components),
        sourceRecommended: true,
      };
      if (!budget.tryReserve(`symbol:${s.name}`, estimateTokens(`${s.name} ${s.signature ?? ""} ${s.filePath}`, "identifier"))) break;
      symbols.push(entry);
    }
    for (const s of minimalSet.supporting) {
      const entry: BundleSymbol = { ...s, role: "supporting type or collaborator", sourceRecommended: false };
      if (!budget.tryReserve(`symbol:${s.name}`, 20)) break;
      symbols.push(entry);
    }
    if (minimalSet.core.length) {
      deferred.push({
        layer: 3,
        what: `Source for ${minimalSet.core.length} core symbol(s)`,
        estimatedTokens: minimalSet.core.length * 250,
        fetchWith: {
          tool: "get_implementation",
          args: { repository: c.ref.fullName, feature: input.task.feature, include_source: true },
        },
      });
    }
  } else {
    unknowns.push("No symbol-level analysis was performed; key symbols are not identified");
  }

  // --- tests (Layer 4 pointer) ---------------------------------------------
  const tests = c.tests ?? analyzeTests({
    filePaths,
    symbols: c.symbols,
    dependencies: c.dependencies?.direct,
    featureTerms: input.task.capabilities,
  });
  budget.tryReserve("tests", estimateTokens(JSON.stringify({
    hasTests: tests.hasTests, frameworks: tests.frameworks, edgeCasesCovered: tests.edgeCasesCovered,
  }), "json"));
  if (tests.hasTests && (tests.unitTests.length + tests.integrationTests.length) > 6) {
    deferred.push({
      layer: 4,
      what: `${tests.unitTests.length + tests.integrationTests.length} test(s), with names and assertions`,
      estimatedTokens: (tests.unitTests.length + tests.integrationTests.length) * 25,
      fetchWith: {
        tool: "analyze_repository",
        args: { repository: c.ref.fullName, include: ["tests"] },
      },
    });
  }

  // --- dependencies --------------------------------------------------------
  const dependencies = c.dependencies ?? {
    direct: [], transitiveSample: [], manifests: [], ecosystems: [],
    requiredConfiguration: [], platformRequirements: [], incompatibilities: [],
    versionAssumptions: [], simplicity: 0.5,
    notes: ["Dependency manifests were not read."],
  };
  // Runtime dependencies are what the consumer inherits; dev/test cost them nothing.
  const runtimeDeps = dependencies.direct.filter((d) => d.scope === "runtime" || d.scope === "peer");
  budget.tryReserve("dependencies", estimateTokens(runtimeDeps.map((d) => d.name).join(" ")));
  if (dependencies.direct.length > runtimeDeps.length) {
    deferred.push({
      layer: 4,
      what: `${dependencies.direct.length - runtimeDeps.length} dev/test dependenc(ies)`,
      estimatedTokens: (dependencies.direct.length - runtimeDeps.length) * 8,
      fetchWith: { tool: "analyze_repository", args: { repository: c.ref.fullName, include: ["dependencies"] } },
    });
  }

  // --- adaptation ----------------------------------------------------------
  let adaptation: AdaptationPlan | undefined;
  if (reuse.mode !== "DO_NOT_USE") {
    adaptation = planAdaptation({
      source: architecture,
      sourceDependencies: dependencies.direct,
      target: input.target,
      targetProfile: input.targetProfile,
      stackMatch: c.evidence?.axes.stackMatch?.value ?? 0.5,
      coreSymbols: minimalSet?.core,
    });
    budget.tryReserve("adaptation", estimateTokens(JSON.stringify(adaptation), "json"));
  }

  // --- integration points --------------------------------------------------
  const integrationPoints = buildIntegrationPoints(architecture, input.targetProfile, minimalSet?.core?.length ?? 0);

  // --- provenance (must-have, spec §11) ------------------------------------
  const provenance: Provenance[] = [{
    repository: c.ref.fullName,
    owner: c.ref.owner,
    provider: c.ref.provider,
    commit: c.ref.commit,
    ref: c.ref.ref,
    files: [...new Set([
      ...(minimalSet?.core ?? []).map((s) => s.filePath),
      ...dependencies.manifests,
    ])].filter(Boolean).slice(0, 15),
    symbols: minimalSet?.core.map((s) => s.id).slice(0, 15),
    license: license.spdx,
    retrievedAt: new Date().toISOString(),
    retrievalMode: input.retrievalMode,
  }];
  budget.forceReserve("provenance", estimateTokens(JSON.stringify(provenance), "json"));

  // --- confidence ----------------------------------------------------------
  // The product of what we measured, deliberately conservative: a bundle is only as
  // trustworthy as its weakest necessary link.
  const confidence = round2(Math.min(
    c.score?.confidence ?? 0.5,
    reuse.confidence,
    architecture.confidence + 0.25,
  ));

  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    feature: input.task.feature,
    targetStack: [input.target?.language, input.target?.framework, input.target?.platform].filter(Boolean).join(" / ") || undefined,

    recommendation: toRecommendation(c),
    alternatives: input.alternatives.slice(0, 4).map(toAlternative),

    reuse,
    architecture,
    minimalSet: minimalSet ?? {
      core: [], supporting: [], excluded: [], seeds: [], connected: false,
      estimatedTokens: 0, estimatedFullTokens: 0,
      parameters: { relevanceFloor: 0, maxDepth: 0, tokenBudget: 0 },
    },
    symbols,
    completeness: c.completeness ?? { items: [], satisfied: 0, total: 0, ratio: 0, undetermined: [] },
    integrationSurface: c.integrationSurface ?? {
      symbolsRequired: 0, dependencyCount: runtimeDeps.length, integrationPointCount: 0,
      configurationRequirements: 0, frameworkCoupling: 0, score: 0.5,
      difficulty: "medium", drivers: [],
    },
    evidence: c.evidence,

    dependencies: { ...dependencies, direct: runtimeDeps },
    tests,
    integrationPoints,
    adaptationNotes: adaptation?.requiredChanges.map((s) => `${s.order}. ${s.action} — ${s.rationale}`) ?? [],
    adaptation,

    license,
    provenance,
    confidence,
    integrationDifficulty: adaptation?.integrationDifficulty ?? c.integrationSurface?.difficulty ?? "medium",
    unknowns,
    degradations: dedupeDegradations(input.degradations),
    availableOnRequest: deferred,
    metrics: input.metrics,
  };
}

function toRecommendation(c: Candidate): BundleRecommendation {
  return {
    repository: c.ref.fullName,
    ref: c.ref,
    score: c.score?.total ?? 0,
    confidence: c.score?.confidence ?? 0,
    why: c.score?.reasons.filter((r) => r.startsWith("+")) ?? [],
    // Negatives and adjustments are concerns, and they are never filtered out.
    concerns: c.score?.reasons.filter((r) => r.startsWith("-") || r.startsWith("!") || r.startsWith("?")) ?? [],
  };
}

function toAlternative(c: Candidate): BundleAlternative {
  const mode = c.reuse?.mode ?? "REFERENCE_ONLY";
  return {
    repository: c.ref.fullName,
    score: c.score?.total ?? 0,
    chooseWhen: chooseWhenFor(c),
    tradeoff: c.score?.reasons.find((r) => r.startsWith("-"))?.replace(/^- /, "") ?? "no notable drawback recorded",
    reuseMode: mode,
  };
}

/**
 * One line on when this alternative would be the better pick.
 *
 * Derived from where it actually beats the recommendation, rather than a generic
 * "consider if the first does not fit" — which tells the agent nothing.
 */
function chooseWhenFor(c: Candidate): string {
  const axes = c.evidence?.axes;
  if (!axes) return "if the recommendation does not fit your constraints";
  const strengths: string[] = [];
  if ((axes.maintenance?.value ?? 0) >= 0.85) strengths.push("you need active maintenance");
  if ((axes.integrationSurface?.value ?? 0) >= 0.8) strengths.push("you want the smallest integration surface");
  if ((axes.completeness?.value ?? 0) >= 0.8) strengths.push("requirement coverage matters most");
  if ((axes.testEvidence?.value ?? 0) >= 0.85) strengths.push("you want the strongest test evidence");
  if (c.reuse?.mode === "DIRECT_REUSE") strengths.push("you need to vendor code directly");
  return strengths.length ? strengths.slice(0, 2).join(", or ") : "if the recommendation does not fit your constraints";
}

function buildIntegrationPoints(
  architecture: { components: string[]; modules: { path: string; role: string }[] },
  profile: TargetProjectProfile | undefined,
  symbolCount: number,
): IntegrationPoint[] {
  if (!profile) {
    // Generic but honest: say what kind of place this belongs, and how to get specifics.
    return architecture.components.slice(0, 3).map((component) => ({
      location: "(call analyze_target_project for project-specific locations)",
      what: component,
      how: `Introduce ${component} at the layer of your project that owns this responsibility.`,
      touches: [],
    }));
  }

  const points: IntegrationPoint[] = [];
  for (const component of architecture.components.slice(0, 4)) {
    const dir = profile.directoryStructure.find((d) => roleMatches(d.role, component));
    points.push({
      location: dir?.path ?? profile.root,
      what: component,
      how: dir
        ? `Add ${component} under ${dir.path}, which already holds your ${dir.role}.`
        : `No matching module found in the target; create one for ${component}.`,
      touches: dir ? [dir.path] : [],
    });
  }
  if (symbolCount > 0 && profile.testingFrameworks.length) {
    points.push({
      location: "tests",
      what: "Tests for the adapted implementation",
      how: `Write tests using ${profile.testingFrameworks[0]}, which this project already uses.`,
      touches: profile.testingFrameworks,
    });
  }
  return points;
}

function roleMatches(role: string, component: string): boolean {
  const a = role.toLowerCase();
  const b = component.toLowerCase();
  return a.includes(b) || b.includes(a) ||
    (/(data|persist|repositor|storage)/.test(a) && /(data|persist|repositor|storage|entity|dao)/.test(b)) ||
    (/(network|http|api)/.test(a) && /(client|network|http|request)/.test(b)) ||
    (/(background|worker|job)/.test(a) && /(worker|queue|job|scheduler)/.test(b));
}

/** Five candidates failing the same way is one fact, not five. */
function dedupeDegradations(degradations: Degradation[]): Degradation[] {
  const seen = new Set<string>();
  return degradations.filter((d) => {
    const k = `${d.stage}:${d.reason}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 8);
}

function roleFor(name: string, components: string[]): string {
  const humanised = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  const match = components.find((c) => humanised.includes(c.toLowerCase().split(" ")[0] ?? ""));
  if (match) return match;
  if (/manager|coordinator/i.test(name)) return "orchestration";
  if (/worker|executor|runner/i.test(name)) return "execution";
  if (/queue|scheduler/i.test(name)) return "work scheduling";
  if (/handler|policy|strategy/i.test(name)) return "behaviour policy";
  if (/repository|store|dao/i.test(name)) return "persistence";
  if (/client|adapter/i.test(name)) return "external interface";
  return "core implementation";
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

export { REUSE_MODE_RANK };
