/**
 * Tool-level orchestration.
 *
 * One function per user-facing capability. Everything an MCP tool or a CLI command does
 * goes through here, so the two surfaces cannot drift apart (spec §29).
 *
 * Each entry point owns exactly one `MetricsCollector` and one `QuotaBudget`, created at
 * the top and threaded down. That is what makes per-call accounting and per-call budgeting
 * possible at all.
 */

import type { Services } from "../core/services.js";
import { MetricsCollector } from "../core/metrics.js";
import type { TargetStack } from "../types/index.js";
import type { BundleMetrics } from "../types/bundle.js";
import type { GitHubProvider } from "../providers/github/types.js";
import type { RepoMetadata } from "../types/index.js";
import { decomposeRequirement } from "../analyzers/decompose.js";
import { generateQueries, isCapabilityLabel } from "../analyzers/query.js";
import { CAPABILITY_BY_ID, findStackIdioms } from "../knowledge/vocabulary.js";
import { planImplementations } from "../analyzers/planner.js";
import { enrichAgentFeatures } from "../analyzers/enrich.js";
import type { AgentFeature } from "../types/index.js";
import { discoverImplementations } from "./discover.js";
import { renderDiscovery, renderBundle, renderMetrics, measureReturned } from "../context/render.js";
import { buildBundle } from "../context/builder.js";
import { analyzeTests } from "../analyzers/tests.js";
import { inferArchitecture } from "../analyzers/architecture.js";
import type { ImplementationBundle } from "../types/bundle.js";
import type { Candidate, Degradation, TargetProjectProfile } from "../types/index.js";
import { toDegradation } from "../core/errors.js";
import { parseRepoFullName } from "../security/paths.js";
import { analyzeTargetProject } from "../analyzers/target-project.js";
import { compareImplementations, renderComparison, type ComparisonResult } from "../analyzers/compare.js";
import { parseRejection, violatesConstraint, describeConstraint } from "../analyzers/alternative.js";
import type { AlternativeResult, BundleAlternative, ImplementationPlan, LicenseSummary, PlanStep, SynthesisReport, VerificationReport } from "../types/bundle.js";
import { BUNDLE_SCHEMA_VERSION } from "../types/bundle.js";
import { synthesise, summariseLicenses } from "../analyzers/synthesis.js";
import { verifyImplementation, renderVerification, VERIFICATION_DISCLAIMER } from "../analyzers/verify.js";
import { IntelligenceError } from "../core/errors.js";
import { estimateTokens } from "../core/tokens.js";
import type { ImplementationTask } from "../types/index.js";

export interface DiscoverRequest {
  feature: string;
  /**
   * Search terms the calling agent believes practitioners use for this feature.
   *
   * Issued FIRST, ahead of anything the vocabulary produces. The agent read the
   * requirement and knows the domain; our table has been wrong often enough
   * ("Tink Android" matching a bank, `topic:resume` matching CV builders) that its output
   * should not outrank the agent's.
   */
  searchHints?: string[];
  /** Canonical capability id, when the agent recognises one. Sharpens enrichment. */
  capability?: string;
  /** Terms a candidate must reference. See AgentFeature.mustMention. */
  mustMention?: string[];
  /** Terms that disqualify a candidate. See AgentFeature.excludeTerms. */
  excludeTerms?: string[];
  /**
   * Run symbol-level analysis (code index + minimal implementation set).
   *
   * Off by default: indexing a repository takes tens of seconds, and plain discovery
   * ("what exists?") does not need it. `get_implementation` turns it on, because
   * extracting symbols is the whole point of that call.
   */
  deepSymbols?: boolean;
  language?: string;
  framework?: string;
  platform?: string;
  requirements?: string[];
  projectLicense?: string;
  distribution?: TargetStack["distribution"];
  /** Include the metrics block in the rendered output. */
  diagnostics?: boolean;
  maxRepositories?: number;
  maxDeepAnalysis?: number;
}

export interface DiscoverResponse {
  /** Compact, human/LLM-readable output (spec §24). */
  text: string;
  /** Structured form, for callers that parse. */
  data: {
    feature: string;
    task: ImplementationTask;
    candidates: Candidate[];
    queriesIssued: string[];
    fromKnowledgeBase: string[];
  };
  metrics: BundleMetrics;
}

/**
 * `discover_implementations` — the vertical slice.
 *
 * requirement → decompose → plan → discover → rank → render.
 */
export async function runDiscovery(
  services: Services, req: DiscoverRequest,
): Promise<DiscoverResponse> {
  const metrics = new MetricsCollector();
  const budget = services.budgetFor("discovery");
  const github = services.githubFor(metrics, budget);
  const config = services.config;

  const target: TargetStack = {
    language: req.language,
    framework: req.framework,
    platform: req.platform,
    projectLicense: req.projectLicense,
    distribution: req.distribution ?? "unknown",
  };

  /*
   * Two paths, and the agent's is preferred.
   *
   * When the caller supplied search hints or a capability id, it has already done the
   * semantic work — so we enrich what it gave us rather than re-deriving the feature from
   * keywords. Re-deriving actively harmed results: "Voice note recording and playback"
   * matched `media-playback` on the word "playback" and got enriched with ExoPlayer and
   * adaptive-streaming vocabulary, returning a video streaming SDK for an audio recorder,
   * while the caller's own "Android audio recorder opus" sat unused below it.
   *
   * Without hints we fall back to the rule-based decomposer, which is what the CLI and
   * unhinted clients get.
   */
  const agentDirected = Boolean(
    req.searchHints?.length || req.capability || req.mustMention?.length || req.excludeTerms?.length,
  );

  let task: ImplementationTask;
  let decomposed: ReturnType<typeof decomposeRequirement> | undefined;

  if (agentDirected) {
    const enriched = enrichAgentFeatures({
      features: [{
        name: req.feature,
        requirements: req.requirements,
        searchHints: req.searchHints,
        capability: req.capability,
        mustMention: req.mustMention,
        excludeTerms: req.excludeTerms,
      }],
      stack: target,
      totalQueryBudget: config.discovery.maxQueriesPerFeature,
    });
    task = enriched.tasks[0] as ImplementationTask;
  } else {
    // Decompose even for a single feature: it resolves the capability id, the checklist and
    // the stack idioms, all of which sharpen the search.
    decomposed = decomposeRequirement({
      requirement: req.feature,
      stack: target,
      requirements: req.requirements,
    });

    const planned = planImplementations({
      units: decomposed.units,
      stack: target,
      totalQueryBudget: config.discovery.maxQueriesPerFeature,
    });

    task = buildCompositeTask({
      feature: req.feature,
      primaryId: decomposed.primary,
      tasks: planned.tasks,
      explicitIds: decomposed.explicit,
      callerRequirements: req.requirements ?? [],
      language: req.language,
      framework: req.framework,
      platform: req.platform,
      queryBudget: config.discovery.maxQueriesPerFeature,
      featureIsLabel: isCapabilityLabel(
        req.feature,
        decomposed.primary ? CAPABILITY_BY_ID.get(decomposed.primary) : undefined,
      ),
    });
    if (req.mustMention?.length) task.mustMention = req.mustMention;
    if (req.excludeTerms?.length) task.excludeTerms = req.excludeTerms;
  }

  // Resolve the code index only when symbol analysis was asked for — connecting spawns a
  // subprocess, which plain discovery should not pay for.
  const codeIndex = req.deepSymbols
    ? await services.codeIndexFor(metrics, github)
    : undefined;

  const result = await metrics.time("discover", () => discoverImplementations(
    {
      task,
      target,
      maxRepositories: req.maxRepositories ?? config.discovery.maxRepositories,
      maxDeepAnalysis: req.maxDeepAnalysis ?? config.discovery.maxDeepAnalysis,
      minScore: config.discovery.minRepositoryScore,
      weights: config.ranking.weights,
      enableLicenseCheck: config.features.enableLicenseCheck,
      useFingerprints: config.features.enableFingerprints,
      deepSymbols: req.deepSymbols ?? false,
    },
    {
      github, codeIndex, cache: services.cache, budget, metrics,
      logger: services.logger, sanitizer: services.sanitizer,
    },
  ));

  // Record fingerprints for everything we analysed deeply, so the next caller may skip
  // GitHub search entirely.
  if (config.features.enableFingerprints) {
    recordFingerprints(services, result.candidates, task);
  }

  const degradations = [...result.degradations];
  if (decomposed?.unrecognised.length) {
    degradations.push({
      stage: "decompose",
      severity: "info",
      reason: `Not mapped to a known capability: ${decomposed.unrecognised.join(", ")}`,
      fallback: "searched the requirement text directly",
    });
  }

  let text = renderDiscovery({
    feature: req.feature,
    targetStack: [target.language, target.framework, target.platform].filter(Boolean).join(" / ") || undefined,
    candidates: result.candidates,
    degradations,
    queriesIssued: result.queriesIssued,
    consideredCount: result.consideredCount,
    deepAnalysedCount: result.deepAnalysedCount,
    fromFingerprints: result.fromFingerprints,
  });

  // Measure what we actually returned BEFORE appending diagnostics, so the reduction
  // figure describes the payload rather than the report about the payload.
  metrics.add("contextTokensReturned", measureReturned(text));

  if (req.diagnostics ?? config.features.diagnostics) {
    text += "\n\n" + renderMetrics(metrics.snapshot());
  }

  return {
    text,
    data: {
      feature: req.feature,
      task,
      candidates: result.candidates,
      queriesIssued: result.queriesIssued,
      fromKnowledgeBase: result.fromFingerprints,
    },
    metrics: metrics.snapshot(),
  };
}

/**
 * Write feature fingerprints for deeply-analysed candidates.
 *
 * Strength is taken from the completeness ratio, which is the most defensible number we
 * have: it says how much of the capability's checklist the repository actually evidences.
 * Only commit-pinned candidates are recorded — a fingerprint without a SHA could not be
 * trusted later, since the source may have changed underneath it.
 */
function recordFingerprints(services: Services, candidates: Candidate[], task: ImplementationTask): void {
  const now = new Date().toISOString();
  for (const c of candidates) {
    if (!c.ref.commit || !c.completeness || c.completeness.total === 0) continue;
    const strength = c.completeness.ratio;
    const capabilities: Record<string, number> = {};
    for (const cap of task.capabilities) capabilities[cap] = strength;
    try {
      services.cache.putFingerprint({
        repository: c.ref.fullName,
        commit: c.ref.commit,
        capabilities,
        language: c.metadata.language,
        frameworks: c.metadata.topics.slice(0, 8),
        licenseSpdx: c.license?.spdx,
        vocabularyVersion: "1",
        computedAt: now,
      });
    } catch (err) {
      services.logger.debug("fingerprint write failed", {
        repo: c.ref.fullName,
        error: services.sanitizer.scrubForLog(err instanceof Error ? err.message : String(err)),
      });
    }
  }
}

/** `build_implementation_plan` in decompose-only mode (spec §4 decompose_application). */
export function runDecomposition(req: {
  requirement: string;
  language?: string;
  framework?: string;
  platform?: string;
  requirements?: string[];
  queryBudget?: number;
}) {
  const stack: TargetStack = {
    language: req.language, framework: req.framework, platform: req.platform,
  };
  const decomposed = decomposeRequirement({
    requirement: req.requirement, stack, requirements: req.requirements,
  });
  const planned = planImplementations({
    units: decomposed.units, stack, totalQueryBudget: req.queryBudget ?? decomposed.units.length * 3,
  });

  const lines: string[] = [`REQUIREMENT:\n${req.requirement}`];
  if (stack.language || stack.framework || stack.platform) {
    lines.push(`\nTARGET STACK:\n${[stack.language, stack.framework, stack.platform].filter(Boolean).join(" / ")}`);
  }

  lines.push(`\nREUSABLE IMPLEMENTATION UNITS (${planned.tasks.length}), in build order:`);
  for (const t of planned.tasks) {
    lines.push(
      `\n${t.priority >= 70 ? "▲" : "•"} ${t.feature}  [${t.strategy}]` +
      `\n    look for: ${t.lookingFor.join("; ")}` +
      `\n    checklist: ${t.requirementChecklist.slice(0, 5).join(" · ")}` +
      `\n    queries: ${t.searchQueries.join(" | ")}` +
      (t.dependsOn.length ? `\n    depends on: ${t.dependsOn.join(", ")}` : ""),
    );
  }

  if (planned.skipped.length) {
    lines.push(`\nBUILD DIRECTLY (no search budget spent):`);
    for (const s of planned.skipped) lines.push(`• ${s.feature} — ${s.reason}`);
  }
  if (decomposed.implied.length) {
    lines.push(`\nIMPLIED BY YOUR REQUIREMENTS (not explicitly requested):\n${decomposed.implied.join(", ")}`);
  }
  if (decomposed.unrecognised.length) {
    lines.push(
      `\nNOT RECOGNISED:\n${decomposed.unrecognised.join(", ")}` +
      `\nThese did not map to a known reusable capability. They may be application-specific — ` +
      `if one is a well-known technique under another name, call discover_implementations with that name.`,
    );
  }
  lines.push(`\nNEXT:\nCall discover_implementations for each unit above, highest priority first.`);

  const text = lines.join("\n");
  return {
    text,
    data: { units: decomposed.units, tasks: planned.tasks, skipped: planned.skipped, unrecognised: decomposed.unrecognised },
    estimatedTokens: estimateTokens(text),
  };
}

/**
 * Build the composite task a discovery request should actually pursue.
 *
 * The user asking for "resumable background file downloader with pause and retry" wants a
 * single repository that does all of that — not the best `resume` library, nor the best
 * `queue` library. So:
 *
 *   - the PRIMARY capability supplies the idiomatic search vocabulary;
 *   - EVERY detected capability contributes to the requirement checklist, which is what
 *     completeness scores against — so a repo doing only half the phrase scores as such;
 *   - the user's own wording is always issued as a query, because our vocabulary may not
 *     have the term they had in mind.
 */
function buildCompositeTask(input: {
  feature: string;
  primaryId?: string;
  tasks: ImplementationTask[];
  explicitIds: string[];
  callerRequirements: string[];
  language?: string;
  framework?: string;
  platform?: string;
  queryBudget: number;
  /** True when `feature` is one of our capability labels rather than the caller's words. */
  featureIsLabel?: boolean;
}): ImplementationTask {
  const byId = new Map(input.tasks.map((t) => [t.featureId, t]));
  const primary = (input.primaryId && byId.get(input.primaryId)) || input.tasks[0];

  if (!primary) {
    // Nothing recognised. Search the user's literal words rather than refusing — and the
    // gap is reported separately as a degradation, so the caller knows we were guessing.
    return {
      featureId: "unknown",
      feature: input.feature,
      strategy: "reuse-pattern",
      lookingFor: [`existing ${input.feature} implementations`],
      capabilities: [],
      requirementChecklist: input.callerRequirements,
      searchQueries: [[input.feature, input.language].filter(Boolean).join(" ")],
      rationale: "Feature did not match a known capability; searching the requirement text directly.",
      budgetShare: 1,
      priority: 50,
      dependsOn: [],
    };
  }

  // Every explicitly-detected capability is part of what was asked for.
  const relevant = input.explicitIds
    .map((id) => byId.get(id))
    .filter((t): t is ImplementationTask => Boolean(t));
  const others = relevant.filter((t) => t.featureId !== primary.featureId);

  // Checklist: the caller's own requirements first (ground truth for THIS project), then
  // the primary capability's, then one item from each secondary capability so the
  // composite is represented without the list exploding.
  const checklist = dedupe([
    ...input.callerRequirements,
    ...primary.requirementChecklist,
    ...others.flatMap((t) => t.requirementChecklist.slice(0, 2)),
  ]).slice(0, 12);

  /*
   * Queries.
   *
   * Two things this deliberately does NOT do, both learned from bad live results:
   *
   *  - It does not issue the feature string when that string is one of our own capability
   *    LABELS. "Local persistence Kotlin" and "Resumable transfer Kotlin" are taxonomy
   *    names, not phrases that appear in repositories; they returned a SharedPreferences
   *    wrapper and a résumé analyser respectively. A caller's own wording is valuable
   *    because it is specific — a label is the opposite.
   *
   *  - It does not concatenate primary and secondary vocabulary into "cross-cutting"
   *    queries. That produced "HTTP Range request Room database", which is not a query
   *    anyone would write and matched nothing useful. Secondary capabilities already
   *    contribute through the completeness checklist, which is where they belong.
   */
  const literal = input.featureIsLabel
    ? undefined
    : [input.feature, input.language].filter(Boolean).join(" ");

  //  - It does not borrow a SECONDARY capability's queries to pad the list. `resume`
  //    implies `persistence`, so padding sent "Room database" out for a resumable-transfer
  //    search and duly returned a Room backup library as the top result. A short, precise
  //    query set beats a longer one containing a query for the wrong thing.
  /*
   * The primary capability gets the WHOLE query budget.
   *
   * `planImplementations` divides the budget across every capability it detected — correct
   * when building a multi-feature plan, wrong when discovering ONE feature. And the
   * caller's requirement checklist feeds decomposition, so "Push notifications" with a
   * checklist containing "token registration" spawned `auth-session` (from "registration")
   * and `secure-storage`, split the six-query budget three ways, and left the actual
   * subject a single query. Eleven candidates were considered for push notifications, all
   * of them student demos.
   *
   * Requirements belong in the completeness checklist, not in the search budget.
   */
  const cap = CAPABILITY_BY_ID.get(primary.featureId);
  const fullBudgetQueries = cap
    ? generateQueries({
        feature: primary.feature,
        capabilityId: primary.featureId,
        stack: input.language ? { language: input.language } : undefined,
        idioms: findStackIdioms(input.language, input.platform, input.framework),
        requirements: input.callerRequirements,
        limit: input.queryBudget,
      })
    : primary.searchQueries;

  const queries = dedupe([
    ...(literal ? [literal] : []),
    ...fullBudgetQueries,
    ...primary.searchQueries,
  ]).filter(Boolean).slice(0, Math.max(2, input.queryBudget));

  return {
    ...primary,
    feature: input.feature,
    capabilities: dedupe([primary.featureId, ...input.explicitIds]),
    requirementChecklist: checklist,
    searchQueries: queries,
    lookingFor: dedupe([...primary.lookingFor, ...others.flatMap((t) => t.lookingFor.slice(0, 1))]).slice(0, 4),
    rationale: others.length
      ? `${primary.rationale} Scored against the combined requirements of ${[primary.feature, ...others.map((t) => t.feature)].join(", ")}.`
      : primary.rationale,
  };
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}


// ---------------------------------------------------------------------------
// get_implementation — extract the smallest useful set for one repository
// ---------------------------------------------------------------------------

export interface GetImplementationRequest {
  repository: string;
  feature: string;
  /** Agent-supplied search terms; used to focus symbol selection. See DiscoverRequest. */
  searchHints?: string[];
  /** Canonical capability id, when the agent recognises one. */
  capability?: string;
  language?: string;
  framework?: string;
  platform?: string;
  requirements?: string[];
  projectLicense?: string;
  distribution?: TargetStack["distribution"];
  targetProfile?: TargetProjectProfile;
  /** Include Layer-3 source for the core symbols. Off by default (spec §9). */
  includeSource?: boolean;
  maxTokens?: number;
  diagnostics?: boolean;
}

export interface GetImplementationResponse {
  text: string;
  bundle: ImplementationBundle;
  metrics: BundleMetrics;
}

/**
 * Build an implementation bundle for one named repository.
 *
 * Distinct from discovery: the repository is already chosen, so the whole budget goes into
 * *understanding* it — index it, find the minimal symbol set, read manifests and tests,
 * assess licence and adaptation. Spec §4: "Return the smallest useful set of symbols/files
 * required to understand and implement the feature. Do NOT return the entire repository."
 */
export async function runGetImplementation(
  services: Services, req: GetImplementationRequest,
): Promise<GetImplementationResponse> {
  const metrics = new MetricsCollector();
  const budget = services.budgetFor("analysis");
  const github = services.githubFor(metrics, budget);
  const config = services.config;
  const degradations: Degradation[] = [];

  const parsed = parseRepoFullName(req.repository);
  if (!parsed) {
    throw new IntelligenceError(`Not a valid repository reference: ${req.repository}`, {
      kind: "unsupported", stage: "get_implementation", subject: req.repository, retryable: false,
    });
  }
  const repo = parsed.fullName;

  const target: TargetStack = {
    language: req.language, framework: req.framework, platform: req.platform,
    projectLicense: req.projectLicense, distribution: req.distribution ?? "unknown",
  };

  // Reuse the planner so the checklist and vocabulary match what discovery would have used
  // — otherwise a bundle would be scored against different requirements than the search was.
  const decomposed = decomposeRequirement({ requirement: req.feature, stack: target, requirements: req.requirements });
  const planned = planImplementations({ units: decomposed.units, stack: target, totalQueryBudget: 4 });
  const task = buildCompositeTask({
    feature: req.feature,
    primaryId: decomposed.primary,
    tasks: planned.tasks,
    explicitIds: decomposed.explicit,
    callerRequirements: req.requirements ?? [],
    language: req.language,
    framework: req.framework,
    platform: req.platform,
    queryBudget: 4,
    featureIsLabel: isCapabilityLabel(req.feature, decomposed.primary ? CAPABILITY_BY_ID.get(decomposed.primary) : undefined),
  });

  // The agent's own terms lead. Ours follow and fill out the set.
  if (req.searchHints?.length) {
    task.searchQueries = [...new Set([...req.searchHints, ...task.searchQueries])]
      .slice(0, Math.max(2, config.discovery.maxQueriesPerFeature));
  }
  if (req.capability && CAPABILITY_BY_ID.has(req.capability)) {
    task.featureId = req.capability;
    task.capabilities = [...new Set([req.capability, ...task.capabilities])];
  }

  // Metadata first: everything else keys off the commit SHA.
  const metadata = await github.getRepository(repo);
  const candidate: Candidate = { ref: metadata.ref, metadata, discoveredVia: ["explicit"] };

  const codeIndex = await services.codeIndexFor(metrics, github);
  if (codeIndex.degraded) {
    metrics.markDegraded("code-index:fallback");
    degradations.push({
      stage: "get_implementation.code-index", severity: "info",
      reason: codeIndex.reason ?? "code index unavailable",
      fallback: "symbols inferred from file paths and source patterns",
    });
  }

  // Run the same deep analysis discovery uses, so a bundle and a search agree.
  await metrics.time("deep-analysis", () => discoverImplementations(
    {
      task, target,
      maxRepositories: 1, maxDeepAnalysis: 1,
      minScore: 0,
      weights: config.ranking.weights,
      enableLicenseCheck: config.features.enableLicenseCheck,
      useFingerprints: false,
      deepSymbols: true,
    },
    {
      github: withPinnedSearch(github, metadata),
      codeIndex, cache: services.cache, budget, metrics,
      logger: services.logger, sanitizer: services.sanitizer,
    },
  ).then((r) => {
    const analysed = r.candidates[0];
    if (analysed) Object.assign(candidate, analysed);
    degradations.push(...r.degradations);
  }));

  const tree = await github.getTree(repo, candidate.ref.commit).catch((err) => {
    degradations.push(toDegradation(err, { stage: "get_implementation.tree", subject: repo }));
    return [];
  });
  const filePaths = tree.filter((e) => e.type === "blob").map((e) => e.path);

  candidate.architecture = inferArchitecture({
    filePaths, symbols: candidate.symbols,
    dependencies: candidate.dependencies?.direct, language: metadata.language,
  });
  candidate.tests = analyzeTests({
    filePaths, symbols: candidate.symbols,
    dependencies: candidate.dependencies?.direct, featureTerms: task.capabilities,
  });

  // --- Layer 3: source, only when explicitly asked for ---------------------
  if (req.includeSource && candidate.minimalSet?.core.length) {
    const ids = candidate.minimalSet.core.map((s) => s.id);
    const sources = await codeIndex.provider.getSymbolSource(repo, ids).catch((err) => {
      degradations.push(toDegradation(err, { stage: "get_implementation.source", subject: repo }));
      return [];
    });
    if (sources.length) {
      // Source is untrusted repository content — sanitise before it can reach the model.
      for (const src of sources) {
        const clean = services.sanitizer.sanitize(src.source, {
          kind: "source",
          source: `github:${repo}@${candidate.ref.commit ?? "HEAD"}:${src.filePath}`,
          maxTokens: Math.floor(config.context.maxSourceTokens / sources.length),
        });
        src.source = clean.text;
        src.truncated = src.truncated || clean.truncated;
      }
      candidate.minimalSet = { ...candidate.minimalSet, core: candidate.minimalSet.core };
      (candidate as Candidate & { sources?: unknown }).sources = sources;
    }
  }

  const bundle = buildBundle({
    task,
    recommendation: candidate,
    alternatives: [],
    target,
    targetProfile: req.targetProfile,
    filePaths,
    degradations,
    maxTokens: req.maxTokens ?? config.context.maxContextTokens,
    retrievalMode: codeIndex.degraded ? "github-fallback" : "code-index",
  });

  let text = renderBundle(bundle);
  metrics.add("contextTokensReturned", measureReturned(text));
  bundle.metrics = metrics.snapshot();

  if (req.diagnostics ?? config.features.diagnostics) {
    text += "\n\n" + renderMetrics(bundle.metrics);
  }

  return { text, bundle, metrics: bundle.metrics };
}



// ---------------------------------------------------------------------------
// Remaining tool entry points
// ---------------------------------------------------------------------------

export interface AnalyzeRepositoryRequest {
  repository: string;
  feature?: string;
  language?: string;
  framework?: string;
  distribution?: TargetStack["distribution"];
  /** Facets to compute. Omitted means all — the cheap ones are computed regardless. */
  include?: ("architecture" | "symbols" | "dependencies" | "tests" | "license" | "quality")[];
  diagnostics?: boolean;
}

/**
 * `analyze_repository` — everything we know about one repository.
 *
 * Subsumes the spec's `find_tests`, `find_dependencies` and `check_license` via `include[]`
 * rather than exposing three more tools. The facets share a commit resolution and a tree
 * fetch, so computing them together is cheaper than three separate calls would be, and the
 * agent has one tool to remember instead of four.
 */
export async function runAnalyzeRepository(
  services: Services, req: AnalyzeRepositoryRequest,
): Promise<{ text: string; data: Record<string, unknown>; metrics: BundleMetrics }> {
  const include = new Set(req.include ?? ["architecture", "symbols", "dependencies", "tests", "license", "quality"]);
  const wantSymbols = include.has("symbols") || include.has("architecture");

  const result = await runGetImplementation(services, {
    repository: req.repository,
    feature: req.feature ?? "overall implementation",
    language: req.language,
    framework: req.framework,
    distribution: req.distribution,
    diagnostics: req.diagnostics,
  });

  const b = result.bundle;
  const out: string[] = [`REPOSITORY:\n${b.recommendation.repository}${b.recommendation.ref.commit ? `@${b.recommendation.ref.commit.slice(0, 7)}` : ""}`];

  if (include.has("quality")) {
    out.push(`\nQUALITY:\n${b.recommendation.why.concat(b.recommendation.concerns).join("\n")}`);
  }
  if (include.has("architecture")) {
    out.push(`\nARCHITECTURE:\n${b.architecture.pattern} (confidence ${Math.round(b.architecture.confidence * 100)}%)`);
    if (b.architecture.modules.length) {
      out.push(`  modules:\n${b.architecture.modules.map((m) => `    ${m.path} — ${m.role}`).join("\n")}`);
    }
    if (b.architecture.entryPoints.length) out.push(`  entry points: ${b.architecture.entryPoints.join(", ")}`);
  }
  if (wantSymbols && b.symbols.length) {
    out.push(`\nIMPORTANT SYMBOLS:\n${b.symbols.map((s) => `• ${s.name} (${s.kind}) — ${s.role}  [${s.filePath}]`).join("\n")}`);
  }
  if (include.has("dependencies")) {
    out.push(`\nDEPENDENCIES (${b.dependencies.direct.length} runtime, from ${b.dependencies.manifests.join(", ") || "no readable manifest"}):`);
    out.push(b.dependencies.direct.slice(0, 20).map((d) => `• ${d.name}${d.version ? ` ${d.version}` : " (version not statically resolvable)"}`).join("\n") || "• (none)");
  }
  if (include.has("tests")) {
    const t = b.tests;
    out.push(`\nTESTS:\n${t.hasTests ? `${t.unitTests.length} unit, ${t.integrationTests.length} integration${t.frameworks.length ? ` (${t.frameworks.join(", ")})` : ""}` : "none found"}`);
    if (t.edgeCasesCovered.length) out.push(`  edge cases: ${t.edgeCasesCovered.join(" · ")}`);
    if (t.fixtures.length) out.push(`  fixtures: ${t.fixtures.slice(0, 5).join(", ")}`);
    if (t.mocks.length) out.push(`  mocks: ${t.mocks.slice(0, 5).join(", ")}`);
    for (const n of t.notes) out.push(`  note: ${n}`);
  }
  if (include.has("license")) {
    out.push(`\nLICENSE:\n${b.license.spdx} (${b.license.category}) — ${b.license.compatible === true ? "compatible" : b.license.compatible === false ? "INCOMPATIBLE" : "unclear"}`);
    for (const w of b.license.warnings) out.push(`  [${w.severity}] ${w.message}`);
    if (b.license.obligations.length) out.push(`  obligations: ${b.license.obligations.join("; ")}`);
    out.push(`  ${b.license.disclaimer}`);
  }

  out.push(`\nREUSE CONCERNS:\n${b.reuse.mode} — ${b.reuse.reason}`);
  if (b.unknowns.length) out.push(`\nNOT DETERMINED:\n${b.unknowns.map((u) => `• ${u}`).join("\n")}`);
  if (b.degradations.length) {
    out.push(`\nLIMITATIONS:\n${b.degradations.map((d) => `• ${d.stage}: ${d.reason}`).join("\n")}`);
  }

  let text = out.join("\n");
  if (req.diagnostics ?? services.config.features.diagnostics) {
    text += "\n\n" + renderMetrics(result.metrics);
  }
  return { text, data: { bundle: b }, metrics: result.metrics };
}

// ---------------------------------------------------------------------------

export interface CompareRequest {
  feature: string;
  repositories: string[];
  /** Agent-supplied search terms, used to sharpen the completeness checklist. */
  searchHints?: string[];
  /** Canonical capability id, when the agent recognises one. */
  capability?: string;
  language?: string;
  framework?: string;
  platform?: string;
  requirements?: string[];
  distribution?: TargetStack["distribution"];
  diagnostics?: boolean;
}

/** `compare_implementations` — analyse each candidate, then compare on measured axes. */
export async function runCompare(
  services: Services, req: CompareRequest,
): Promise<{ text: string; data: ComparisonResult; metrics: BundleMetrics }> {
  const metrics = new MetricsCollector();
  const budget = services.budgetFor("analysis");
  const github = services.githubFor(metrics, budget);
  const config = services.config;
  const degradations: Degradation[] = [];

  const target: TargetStack = {
    language: req.language, framework: req.framework, platform: req.platform,
    distribution: req.distribution ?? "unknown",
  };

  const decomposed = decomposeRequirement({ requirement: req.feature, stack: target, requirements: req.requirements });
  const planned = planImplementations({ units: decomposed.units, stack: target, totalQueryBudget: 3 });
  const task = buildCompositeTask({
    feature: req.feature, primaryId: decomposed.primary, tasks: planned.tasks,
    explicitIds: decomposed.explicit, callerRequirements: req.requirements ?? [],
    language: req.language, framework: req.framework, platform: req.platform, queryBudget: 3,
    featureIsLabel: isCapabilityLabel(req.feature, decomposed.primary ? CAPABILITY_BY_ID.get(decomposed.primary) : undefined),
  });

  // The agent's own terms lead. Ours follow and fill out the set.
  if (req.searchHints?.length) {
    task.searchQueries = [...new Set([...req.searchHints, ...task.searchQueries])]
      .slice(0, Math.max(2, config.discovery.maxQueriesPerFeature));
  }
  if (req.capability && CAPABILITY_BY_ID.has(req.capability)) {
    task.featureId = req.capability;
    task.capabilities = [...new Set([req.capability, ...task.capabilities])];
  }

  const codeIndex = await services.codeIndexFor(metrics, github);
  const candidates: Candidate[] = [];

  // Analysed one at a time rather than in parallel: they share a quota budget, and
  // parallel calls would race each other into the rate limiter for no wall-clock gain.
  for (const repoRef of req.repositories.slice(0, 6)) {
    const parsed = parseRepoFullName(repoRef);
    if (!parsed) {
      degradations.push({ stage: "compare.parse", subject: repoRef, severity: "warning", reason: "not a valid repository reference" });
      continue;
    }
    try {
      const metadata = await github.getRepository(parsed.fullName);
      const r = await discoverImplementations(
        {
          task, target, maxRepositories: 1, maxDeepAnalysis: 1, minScore: 0,
          weights: config.ranking.weights,
          enableLicenseCheck: config.features.enableLicenseCheck,
          useFingerprints: false, deepSymbols: true,
        },
        {
          github: withPinnedSearch(github, metadata), codeIndex,
          cache: services.cache, budget, metrics,
          logger: services.logger, sanitizer: services.sanitizer,
        },
      );
      degradations.push(...r.degradations);
      if (r.candidates[0]) candidates.push(r.candidates[0]);
    } catch (err) {
      // One unreachable repository must not lose the comparison (spec §21).
      degradations.push(toDegradation(err, { stage: "compare.analyze", subject: parsed.fullName, fallback: "excluded from the comparison" }));
    }
  }

  const comparison = compareImplementations({ feature: req.feature, candidates });
  let text = renderComparison(comparison);
  if (degradations.length) {
    text += `\n\nLIMITATIONS:\n${dedupe(degradations.map((d) => `• ${d.stage}${d.subject ? ` (${d.subject})` : ""}: ${d.reason}`)).join("\n")}`;
  }
  metrics.add("contextTokensReturned", measureReturned(text));
  if (req.diagnostics ?? config.features.diagnostics) text += "\n\n" + renderMetrics(metrics.snapshot());

  return { text, data: comparison, metrics: metrics.snapshot() };
}

// ---------------------------------------------------------------------------

export interface TargetProjectRequest {
  path: string;
  diagnostics?: boolean;
}

/** `analyze_target_project` — offline, no quota, no network. */
export async function runAnalyzeTargetProject(
  services: Services, req: TargetProjectRequest,
): Promise<{ text: string; data: TargetProjectProfile }> {
  const profile = await analyzeTargetProject({ root: req.path, logger: services.logger });

  const out = [`TARGET PROJECT:\n${profile.root}`];
  out.push(`\nLANGUAGE:\n${profile.language ?? "undetermined"}${
    Object.keys(profile.languages).length > 1 ? `  (also: ${Object.entries(profile.languages).sort((a, b) => b[1] - a[1]).slice(1, 4).map(([l, n]) => `${l} ${n}`).join(", ")})` : ""}`);
  if (profile.frameworks.length) out.push(`\nFRAMEWORKS:\n${profile.frameworks.join(", ")}`);
  if (profile.architecture) out.push(`\nARCHITECTURE:\n${profile.architecture}`);
  out.push(`\nDEPENDENCY MANAGERS:\n${profile.dependencyManagers.join(", ") || "none detected"}`);

  const layers = [
    ["state management", profile.stateManagement],
    ["networking", profile.networkingLayer],
    ["database", profile.database],
    ["testing", profile.testingFrameworks.join(", ") || undefined],
  ].filter(([, v]) => v) as [string, string][];
  if (layers.length) out.push(`\nEXISTING LAYERS:\n${layers.map(([k, v]) => `• ${k}: ${v}`).join("\n")}`);

  if (profile.directoryStructure.length) {
    out.push(`\nSTRUCTURE:\n${profile.directoryStructure.map((d) => `  ${d.path.padEnd(28)} ${d.role}`).join("\n")}`);
  }
  if (profile.codingPatterns.length) out.push(`\nCONVENTIONS TO MATCH:\n${profile.codingPatterns.map((p) => `• ${p}`).join("\n")}`);
  out.push(`\nPROJECT LICENCE:\n${profile.projectLicense ?? "not detected — licence compatibility will be evaluated as 'unknown'"}`);
  if (profile.existingLibraries.length) {
    out.push(`\nEXISTING LIBRARIES (${profile.existingLibraries.length}):\n${profile.existingLibraries.slice(0, 20).map((d) => `• ${d.name}${d.version ? ` ${d.version}` : ""}`).join("\n")}`);
  }
  if (profile.gaps.length) out.push(`\nGAPS:\n${profile.gaps.map((g) => `• ${g}`).join("\n")}`);
  out.push(`\nNEXT:\nPass this project's language and frameworks to discover_implementations, ` +
           `or call get_implementation with a repository to get integration points specific to this structure.`);

  return { text: out.join("\n"), data: profile };
}

// ---------------------------------------------------------------------------

export interface FindAlternativeRequest {
  feature: string;
  currentCandidate?: string;
  reason: string;
  language?: string;
  framework?: string;
  platform?: string;
  requirements?: string[];
  exclude?: string[];
  distribution?: TargetStack["distribution"];
  diagnostics?: boolean;
}

/**
 * `find_alternative` — the feedback loop.
 *
 * Re-runs discovery under a parsed constraint, excluding what already failed. The saving is
 * not just quota: the constraint is applied to the *ranking*, so the alternative is chosen
 * for satisfying the thing that went wrong, not merely for being the next-best score.
 */
export async function runFindAlternative(
  services: Services, req: FindAlternativeRequest,
): Promise<{ text: string; data: AlternativeResult; metrics: BundleMetrics }> {
  const constraint = parseRejection(req.reason);
  const exclude = new Set([...(req.exclude ?? []), ...(req.currentCandidate ? [req.currentCandidate] : [])]
    .map((r) => r.toLowerCase()));

  const discovery = await runDiscovery(services, {
    feature: req.feature,
    language: req.language, framework: req.framework, platform: req.platform,
    requirements: req.requirements,
    distribution: req.distribution,
    maxDeepAnalysis: 5,
  });

  const considered = discovery.data.candidates.filter((c) => !exclude.has(c.ref.fullName.toLowerCase()));
  const rejected: { repository: string; why: string }[] = [];
  const viable: Candidate[] = [];

  for (const c of considered) {
    const violation = violatesConstraint(c, constraint);
    if (violation) rejected.push({ repository: c.ref.fullName, why: violation });
    else viable.push(c);
  }

  const alternatives: BundleAlternative[] = viable.slice(0, 4).map((c) => ({
    repository: c.ref.fullName,
    score: c.score?.total ?? 0,
    chooseWhen: `satisfies the constraint: ${describeConstraint(constraint)} does not apply`,
    tradeoff: c.score?.reasons.find((r) => r.startsWith("-"))?.replace(/^- /, "") ?? "no notable drawback recorded",
    reuseMode: c.reuse?.mode ?? "unassessed",
  }));

  const result: AlternativeResult = {
    feature: req.feature,
    constraint,
    alternatives,
    // No new GitHub search quota is spent when the cache served discovery.
    servedFromExistingCandidates: discovery.metrics.githubSearchCalls === 0,
    noneFound: alternatives.length === 0
      ? {
          reason: `Every candidate found also fails the constraint (${describeConstraint(constraint)}).`,
          suggestion: constraint.kind === "license-incompatible"
            ? "Consider implementing this feature yourself using the rejected implementations as reference only, or relax the distribution model if the project is not actually shipped."
            : constraint.kind === "dependency-incompatible"
              ? "Consider isolating the dependency behind an interface you implement, rather than replacing the whole implementation."
              : "Consider relaxing the constraint, broadening the feature description, or building this feature directly.",
        }
      : undefined,
    degradations: [],
  };

  const out = [`FEATURE:\n${req.feature}`];
  out.push(`\nCONSTRAINT UNDERSTOOD AS:\n${describeConstraint(constraint)}`);
  if (constraint.kind === "other") {
    // Say so plainly — a misread constraint silently returning the same answer is worse.
    out.push(`  (could not classify the reason automatically; ${constraint.derivedFrom})`);
  }
  if (exclude.size) out.push(`\nEXCLUDED:\n${[...exclude].join(", ")}`);

  if (alternatives.length) {
    out.push(`\nALTERNATIVES:\n${alternatives.map((a, i) =>
      `${i + 1}. ${a.repository} — ${a.score}/100 · ${a.reuseMode}\n   trade-off: ${a.tradeoff}`).join("\n")}`);
  } else if (result.noneFound) {
    out.push(`\nNO ALTERNATIVE FOUND:\n${result.noneFound.reason}\n\nSUGGESTION:\n${result.noneFound.suggestion}`);
  }

  if (rejected.length) {
    // Explaining why obvious candidates were skipped prevents "why didn't it suggest X?".
    out.push(`\nALSO REJECTED (same constraint):\n${rejected.slice(0, 5).map((r) => `• ${r.repository} — ${r.why}`).join("\n")}`);
  }
  out.push(`\nQUOTA:\n${result.servedFromExistingCandidates ? "served without new GitHub searches" : `${discovery.metrics.githubSearchCalls} new search(es)`}`);

  let text = out.join("\n");
  if (req.diagnostics ?? services.config.features.diagnostics) text += "\n\n" + renderMetrics(discovery.metrics);
  return { text, data: result, metrics: discovery.metrics };
}




// ---------------------------------------------------------------------------
// build_implementation_plan (full mode) — decompose → discover → synthesise
// ---------------------------------------------------------------------------

export interface PlanRequest {
  requirement: string;
  /**
   * Features the CALLING AGENT decomposed the requirement into. When present this is
   * authoritative and the rule-based decomposer is not run at all.
   *
   * This is the preferred path. The agent read the requirement; a trigger table did not,
   * and over real use the table lost requirements silently — "end-to-end encryption"
   * absorbed by `messaging`, "internationalisation" not being a trigger for i18n. The
   * vocabulary still contributes the domain terms practitioners search for.
   */
  features?: AgentFeature[];
  language?: string;
  framework?: string;
  platform?: string;
  distribution?: TargetStack["distribution"];
  /** Features to actually discover implementations for. Each costs search quota. */
  maxFeatures?: number;
  diagnostics?: boolean;
}

/**
 * The full end-to-end flow of spec §31.
 *
 * Features are discovered SEQUENTIALLY, not in parallel. They share one search budget, so
 * parallel discovery would race into the rate limiter without improving wall-clock time —
 * and it would make the budget-exhaustion point unpredictable, which matters because we
 * want the *lowest-priority* features to be the ones that get skipped.
 */
export async function runPlan(
  services: Services, req: PlanRequest,
): Promise<{ text: string; data: ImplementationPlan; metrics: BundleMetrics }> {
  const metrics = new MetricsCollector();
  const config = services.config;
  /*
   * The ceiling is quota, not policy.
   *
   * This capped at 8 while the tool schema advertised 12 — so asking for 12 silently got
   * you 8. The features beyond the cap ARE reported under "Not searched", so nothing
   * vanished, but the two numbers disagreeing is its own bug. Raised to match the schema,
   * with the real constraint stated: each feature costs a few searches against a 30/min
   * limit, so a 20-feature plan takes minutes, not seconds.
   */
  const maxFeatures = Math.min(req.maxFeatures ?? 4, 20);

  const stack: TargetStack = {
    language: req.language, framework: req.framework, platform: req.platform,
    distribution: req.distribution ?? "unknown",
  };

  /*
   * Agent decomposition first, rules as fallback.
   *
   * The fallback is not dead code: the CLI has no agent behind it, and an MCP client may
   * call this without supplying features. But when features ARE supplied they are taken as
   * given — we do not second-guess them, and we do not drop one because no trigger matched.
   */
  const agentSupplied = (req.features?.length ?? 0) > 0;
  const totalQueryBudget = config.discovery.maxQueriesPerFeature * maxFeatures;

  const decomposed = agentSupplied
    ? undefined
    : decomposeRequirement({ requirement: req.requirement, stack });

  const enriched = agentSupplied
    ? enrichAgentFeatures({ features: req.features as AgentFeature[], stack, totalQueryBudget })
    : undefined;

  const planned = enriched
    ? { tasks: enriched.tasks, skipped: enriched.skipped, budgetAllocation: [] }
    : planImplementations({ units: decomposed!.units, stack, totalQueryBudget });

  const selections: { feature: string; candidate: Candidate }[] = [];
  const steps: PlanStep[] = [];

  /*
   * Selecting WHICH features to discover for is separate from ordering them.
   *
   * `planned.tasks` is in BUILD order — dependencies first — so taking the first N picked
   * persistence, resume and retry for a *downloader* request, and skipped "File downloading"
   * and "Job / task queue" entirely. Build order is correct for building; it is the wrong
   * axis for deciding what is worth spending search quota on.
   *
   * So: choose the top N by priority (which encodes reuse value and how central the feature
   * is), then restore build order among the chosen ones.
   */
  const chosen = [...planned.tasks]
    .sort((a, b) => b.priority - a.priority)
    .slice(0, maxFeatures);
  const chosenIds = new Set(chosen.map((t) => t.featureId));
  const toDiscover = planned.tasks.filter((t) => chosenIds.has(t.featureId));
  const skippedForBudget = planned.tasks
    .filter((t) => !chosenIds.has(t.featureId))
    .map((t) => t.feature);

  for (const task of toDiscover) {
    try {
      const d = await runDiscovery(services, {
        feature: task.feature,
        requirements: task.requirementChecklist,
        // Carry the planned task's OWN vocabulary through.
        //
        // Without this, runDiscovery re-derived everything from the feature name alone and
        // the agent's search hints were silently discarded between enrichment and search.
        // "Signal protocol Kotlin" and "libsodium Android" never left the building: the
        // plan returned an unrelated Android app for end-to-end encryption while the same
        // query in isolation found a real Double Ratchet library at 78/100.
        searchHints: task.searchQueries,
        capability: task.featureId,
        mustMention: task.mustMention,
        excludeTerms: task.excludeTerms,
        language: req.language, framework: req.framework, platform: req.platform,
        distribution: req.distribution,
        // Use the configured depth, not a hardcoded 3. Too few deep slots and the cheap
        // metadata ranking picks the shortlist alone — and once a good candidate is left
        // unanalysed, the depth tier keeps it below worse-but-examined ones permanently.
        maxDeepAnalysis: config.discovery.maxDeepAnalysis,
      });
      // Prefer a candidate we could actually assess. A step whose rationale reads
      // "unassessed: reuse mode not determined" tells the agent nothing about whether it
      // may use the code, which is the one thing a plan step must convey.
      const assessed = d.data.candidates.filter((c) => c.reuse && c.reuse.mode !== "DO_NOT_USE");
      const best = assessed[0] ?? d.data.candidates.find((c) => c.reuse?.mode !== "DO_NOT_USE") ?? d.data.candidates[0];
      if (best) {
        selections.push({ feature: task.feature, candidate: best });
        steps.push(stepFor(steps.length + 1, task, best));
      } else {
        steps.push(buildFromScratchStep(steps.length + 1, task, "no suitable implementation was found"));
      }
      // Roll each feature's metrics into the plan's totals.
      for (const k of ["githubSearchCalls", "repositoriesConsidered", "repositoriesSelected",
                       "estimatedRawTokens", "cacheHits", "cacheMisses"] as const) {
        metrics.add(k, d.metrics[k as keyof BundleMetrics] as number);
      }
    } catch (err) {
      services.logger.warn("plan feature discovery failed", {
        feature: task.feature,
        error: services.sanitizer.scrubForLog(err instanceof Error ? err.message : String(err)),
      });
      steps.push(buildFromScratchStep(steps.length + 1, task, "discovery failed for this feature"));
    }
  }

  // Features the planner deliberately did not search for.
  for (const s of planned.skipped) {
    steps.push({
      order: steps.length + 1, feature: s.feature, useImplementation: "build-from-scratch",
      rationale: s.reason, relevantSymbols: [], adaptationRequired: [], dependenciesToAdd: [],
      integrationTargets: [], testsToAdd: [`Tests for ${s.feature.toLowerCase()}`], effort: "medium", blockedBy: [],
    });
  }

  const synthesis = synthesise({ selections, targetLanguage: req.language });
  const licenseSummary = summariseLicenses(selections);

  const plan: ImplementationPlan = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    requirement: req.requirement,
    targetStack: [req.language, req.framework, req.platform].filter(Boolean).join(" / ") || undefined,
    steps,
    synthesis,
    assumptionsToVerify: buildAssumptions(
      selections,
      decomposed?.unrecognised ?? [],
      skippedForBudget,
      enriched?.enrichment,
    ),
    risks: buildRisks(synthesis, licenseSummary, selections),
    licenseSummary,
    provenance: selections.map(({ candidate }) => ({
      repository: candidate.ref.fullName, owner: candidate.ref.owner, provider: candidate.ref.provider,
      commit: candidate.ref.commit, files: [], license: candidate.license?.spdx,
      retrievedAt: new Date().toISOString(), retrievalMode: "code-index" as const,
    })),
  };

  let text = renderPlan(plan, {
    skippedForBudget,
    unrecognised: decomposed?.unrecognised ?? [],
    decomposedBy: agentSupplied ? "agent" : "rules",
  });
  metrics.add("contextTokensReturned", measureReturned(text));
  plan.metrics = metrics.snapshot();
  if (req.diagnostics ?? config.features.diagnostics) text += "\n\n" + renderMetrics(plan.metrics);

  return { text, data: plan, metrics: plan.metrics };
}

function stepFor(order: number, task: ImplementationTask, c: Candidate): PlanStep {
  const adaptation = c.reuse?.mode === "ADAPT" || c.reuse?.mode === "REFERENCE_ONLY";
  return {
    order,
    feature: task.feature,
    useImplementation: { repository: c.ref.fullName, score: c.score?.total ?? 0, commit: c.ref.commit },
    rationale: `${c.reuse?.mode ?? "unassessed"}: ${c.reuse?.reason ?? "reuse mode not determined"}`,
    relevantSymbols: (c.minimalSet?.core ?? []).map((s) => s.name),
    adaptationRequired: adaptation
      ? [c.reuse?.guidance ?? "Adapt to the target architecture"]
      : [],
    dependenciesToAdd: (c.dependencies?.direct ?? []).filter((d) => d.scope === "runtime").slice(0, 8),
    integrationTargets: c.architecture?.components.slice(0, 3) ?? [],
    testsToAdd: (c.tests?.edgeCasesCovered ?? []).slice(0, 4).map((e) => `Cover ${e}`),
    effort: c.integrationSurface?.difficulty === "trivial" || c.integrationSurface?.difficulty === "low"
      ? "small" : c.integrationSurface?.difficulty === "medium" ? "medium" : "large",
    blockedBy: task.dependsOn,
  };
}

function buildFromScratchStep(order: number, task: ImplementationTask, why: string): PlanStep {
  return {
    order, feature: task.feature, useImplementation: "build-from-scratch",
    rationale: why, relevantSymbols: [], adaptationRequired: [], dependenciesToAdd: [],
    integrationTargets: [], testsToAdd: task.requirementChecklist.slice(0, 4).map((r) => `Test: ${r}`),
    effort: "medium", blockedBy: task.dependsOn,
  };
}

/**
 * Assumptions the agent must check before trusting the plan.
 *
 * Stated explicitly because a plan reads as more certain than it is: every entry here is
 * something we inferred rather than confirmed.
 */
function buildAssumptions(
  selections: { feature: string; candidate: Candidate }[],
  unrecognised: string[],
  skippedForBudget: string[],
  enrichment?: { feature: string; capability?: string; enriched: boolean }[],
): string[] {
  const out: string[] = [];
  for (const { feature, candidate } of selections) {
    if ((candidate.completeness?.undetermined.length ?? 0) > 0) {
      out.push(`${feature}: ${candidate.completeness!.undetermined.length} requirement(s) could not be confirmed in ${candidate.ref.fullName} — verify before relying on them.`);
    }
    if ((candidate.tests?.featureTestConfidence ?? 1) < 0.4) {
      out.push(`${feature}: little evidence that ${candidate.ref.fullName} tests this capability specifically.`);
    }
    if (candidate.architecture && candidate.architecture.confidence < 0.5) {
      out.push(`${feature}: the architecture of ${candidate.ref.fullName} was inferred with low confidence.`);
    }
  }
  if (unrecognised.length) {
    out.push(`These parts of the requirement matched no known capability and were not planned: ${unrecognised.join(", ")}.`);
  }
  const unenriched = (enrichment ?? []).filter((e) => !e.enriched).map((e) => e.feature);
  if (unenriched.length) {
    // Not a failure — the feature was still searched — but the caller should know it got
    // its own vocabulary back rather than curated domain terms.
    out.push(
      `Searched using your own terms, with no curated vocabulary available: ${unenriched.join(", ")}. ` +
      `Supply searchHints for these if the results look off-target.`,
    );
  }
  if (skippedForBudget.length) {
    out.push(`Not searched (feature limit reached): ${skippedForBudget.join(", ")}. Re-run with a higher max_features, or call discover_implementations for each.`);
  }
  out.push("Every licence verdict here is advisory. Confirm terms before shipping.");
  return out;
}

function buildRisks(
  synthesis: SynthesisReport, licenses: LicenseSummary, selections: { candidate: Candidate }[],
): string[] {
  const risks: string[] = [];
  for (const c of synthesis.licenseConflicts) if (c.severity === "high") risks.push(c.issue);
  for (const a of synthesis.incompatibleArchitectures) risks.push(a.issue);
  if (synthesis.versionConflicts.length) {
    risks.push(`Major-version conflicts across selections: ${synthesis.versionConflicts.map((v) => v.name).join(", ")}. These will not resolve automatically.`);
  }
  if (licenses.overallRisk === "high") {
    risks.push(`Overall licence risk is HIGH — the strictest licence in the plan is ${licenses.strictest} and it governs the combined work.`);
  }
  const unmaintained = selections.filter(({ candidate }) => (candidate.quality?.daysSinceLastPush ?? 0) > 730);
  if (unmaintained.length) {
    risks.push(`Unmaintained selections: ${unmaintained.map((s) => s.candidate.ref.fullName).join(", ")}. Adopting them means owning their security fixes.`);
  }
  return risks;
}

function renderPlan(
  plan: ImplementationPlan,
  ctx: { skippedForBudget: string[]; unrecognised: string[]; decomposedBy: "agent" | "rules" },
): string {
  const out = [`IMPLEMENTATION PLAN`, ``, `REQUIREMENT:\n${plan.requirement}`];
  out.push(`\nDECOMPOSED BY:\n${ctx.decomposedBy === "agent"
    ? "you (the calling agent) — features taken as given"
    : "built-in rules — pass `features` to decompose it yourself, which is more accurate"}`);
  if (plan.targetStack) out.push(`\nTARGET STACK:\n${plan.targetStack}`);

  out.push(`\nBUILD ORDER (${plan.steps.length} steps):`);
  for (const s of plan.steps) {
    const use = s.useImplementation === "build-from-scratch"
      ? "BUILD FROM SCRATCH"
      : `use ${s.useImplementation.repository} (${s.useImplementation.score}/100${s.useImplementation.commit ? `, commit ${s.useImplementation.commit.slice(0, 7)}` : ""})`;
    out.push(`\n${s.order}. ${s.feature} — ${use}  [${s.effort}]`);
    out.push(`   why: ${s.rationale}`);
    if (s.relevantSymbols.length) out.push(`   symbols: ${s.relevantSymbols.join(", ")}`);
    if (s.adaptationRequired.length) out.push(`   adapt: ${s.adaptationRequired.join(" ")}`);
    if (s.dependenciesToAdd.length) out.push(`   deps: ${s.dependenciesToAdd.map((d) => d.name).join(", ")}`);
    if (s.testsToAdd.length) out.push(`   tests: ${s.testsToAdd.join("; ")}`);
    if (s.blockedBy.length) out.push(`   after: ${s.blockedBy.join(", ")}`);
  }

  // --- cross-repository synthesis (spec §13) ------------------------------
  const syn = plan.synthesis;
  const synLines: string[] = [];
  if (syn.overlappingDependencies.length) {
    synLines.push(`shared dependencies: ${syn.overlappingDependencies.slice(0, 5).map((d) => `${d.name} (${d.usedBy.length} repos)`).join(", ")}`);
  }
  if (syn.versionConflicts.length) {
    synLines.push(`VERSION CONFLICTS: ${syn.versionConflicts.map((v) => `${v.name} — ${v.conflicting.map((x) => x.version).join(" vs ")}`).join("; ")}`);
  }
  if (syn.duplicateAbstractions.length) {
    for (const d of syn.duplicateAbstractions) synLines.push(`DUPLICATE ${d.concept.toUpperCase()}: ${d.recommendation}`);
  }
  if (syn.namingConflicts.length) {
    synLines.push(`naming collisions: ${syn.namingConflicts.map((n) => n.symbol).join(", ")}`);
  }
  for (const a of syn.incompatibleArchitectures) synLines.push(`ARCHITECTURE: ${a.issue}`);
  for (const f of syn.frameworkDifferences) synLines.push(`stack: ${f}`);
  if (synLines.length) out.push(`\nCROSS-REPOSITORY CONFLICTS:\n${synLines.map((l) => `• ${l}`).join("\n")}`);

  // A repository selected for more than one feature is good news — one dependency instead
  // of two, one architecture to learn — but it reads as accidental repetition unless it is
  // named. Reported before the conflicts, since it is the opposite of a conflict.
  const byRepo = new Map<string, string[]>();
  for (const step of plan.steps) {
    if (step.useImplementation === "build-from-scratch") continue;
    const repo = step.useImplementation.repository;
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), step.feature]);
  }
  const shared = [...byRepo.entries()].filter(([, features]) => features.length > 1);
  if (shared.length) {
    out.push(`\nONE REPOSITORY COVERS SEVERAL FEATURES:\n${shared
      .map(([repo, features]) => `• ${repo} — ${features.join(" + ")}. Adopt it once; you inherit its dependencies once.`)
      .join("\n")}`);
  }

  if (syn.unificationStrategy.length) {
    out.push(`\nHOW TO UNIFY:\n${syn.unificationStrategy.map((s, i) => `${i + 1}. ${s}`).join("\n")}`);
  }

  // --- licences ------------------------------------------------------------
  const ls = plan.licenseSummary;
  out.push(`\nLICENCES (overall risk: ${ls.overallRisk}):`);
  for (const l of ls.licenses) out.push(`• ${l.repository}: ${l.spdx} (${l.category})`);
  out.push(`  strictest, which governs the combined work: ${ls.strictest}`);
  for (const w of ls.warnings) out.push(`  [!] ${w}`);
  out.push(`  ${ls.disclaimer}`);

  if (plan.risks.length) out.push(`\nRISKS:\n${plan.risks.map((r) => `• ${r}`).join("\n")}`);
  out.push(`\nVERIFY BEFORE TRUSTING THIS PLAN:\n${plan.assumptionsToVerify.map((a) => `• ${a}`).join("\n")}`);
  out.push(`\nNEXT:\nCall get_implementation for each step in order, starting with step 1.`);
  void ctx;
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// verify_implementation
// ---------------------------------------------------------------------------

export interface VerifyRequest {
  repository: string;
  feature: string;
  targetProjectPath: string;
  requirements?: string[];
  language?: string;
  framework?: string;
  platform?: string;
  distribution?: TargetStack["distribution"];
}

/** `verify_implementation` — build the reference bundle, then check the target against it. */
export async function runVerify(
  services: Services, req: VerifyRequest,
): Promise<{ text: string; data: VerificationReport }> {
  const profile = await analyzeTargetProject({ root: req.targetProjectPath, logger: services.logger });
  if (profile.analysisMode === "unavailable") {
    return {
      text: `VERIFICATION UNAVAILABLE\n\n${profile.gaps.join("\n")}`,
      data: {
        feature: req.feature, checks: [], confidence: 0,
        remainingRisks: profile.gaps, disclaimer: VERIFICATION_DISCLAIMER,
      },
    };
  }

  const { bundle } = await runGetImplementation(services, {
    repository: req.repository,
    feature: req.feature,
    requirements: req.requirements,
    language: req.language ?? profile.language,
    framework: req.framework ?? profile.frameworks[0],
    platform: req.platform,
    projectLicense: profile.projectLicense,
    distribution: req.distribution,
    targetProfile: profile,
  });

  const targetFiles = await listProjectFiles(req.targetProjectPath);
  const report = verifyImplementation({ bundle, profile, targetFiles });
  return { text: renderVerification(report), data: report };
}

/** Re-walk the project for verification. Cheap, and keeps the analyzer's output focused. */
async function listProjectFiles(root: string): Promise<string[]> {
  const profile = await analyzeTargetProject({ root, maxFiles: 6000 });
  // The profile does not carry the raw file list, so reconstruct what verification needs
  // from what it does expose. Directory paths plus library names are enough for the
  // presence checks; exact filenames matter only for the test check, which globs anyway.
  const files: string[] = [];
  for (const d of profile.directoryStructure) files.push(`${d.path}/`);
  for (const l of profile.existingLibraries) files.push(`manifest:${l.name}`);
  return files;
}

/**
 * Adapt a GitHubProvider so that search returns exactly one known repository.
 *
 * Lets `get_implementation` and `compare_implementations` reuse the discovery pipeline's
 * deep-analysis stage verbatim, rather than maintaining second and third copies of it that
 * would drift. The only behaviour changed is discovery itself, which is already decided by
 * the time either is called.
 *
 * Implemented with a Proxy, NOT object spread.
 *
 * `RestGitHubProvider` is a class instance, so its methods live on the prototype and are
 * not own enumerable properties — `{ ...github, searchRepositories }` therefore produced an
 * object with *no methods at all*. Every deep-analysis call threw
 * "deps.github.getTree is not a function", the degradation handler caught each one, and
 * `compare_implementations` silently fell back to metadata-only analysis while still
 * returning a confident-looking answer.
 *
 * A Proxy forwards everything by construction, so this cannot break again when the
 * provider interface grows a method.
 */
function withPinnedSearch(github: GitHubProvider, metadata: RepoMetadata): GitHubProvider {
  return new Proxy(github, {
    get(target, prop, receiver) {
      if (prop === "searchRepositories") {
        return async () => [metadata];
      }
      if (prop === "id") return `${target.id}+pinned`;
      const value = Reflect.get(target, prop, receiver);
      // Bind methods to the real provider so `this` stays intact.
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
