/**
 * Discovery pipeline — the vertical slice.
 *
 *   ImplementationTask
 *        ↓  multi-query search, quota-budgeted        (fingerprints first — free)
 *   raw candidates
 *        ↓  dedupe                                     (spec §19)
 *   distinct candidates
 *        ↓  cheap evidence + rank                      (metadata only)
 *   shortlist
 *        ↓  deep analysis of finalists only            (tree, licence, deps, quality)
 *   ranked candidates with evidence, reuse mode, completeness
 *
 * The shape is a funnel because quota is scarce: search is 30/min, and deep analysis costs
 * several core calls per repository. Ranking *twice* — once cheaply on metadata, then again
 * after deep analysis — is what lets us spend the expensive calls on five repositories
 * instead of forty, and it is the single biggest determinant of both latency and cost.
 *
 * Every stage is wrapped so that one failing repository degrades that candidate, never the
 * run (spec §21).
 */

import type {
  Candidate, CandidateEvidence, CodeSymbol, Degradation, ImplementationTask, RankingWeights,
  RepoMetadata, TargetStack,
} from "../types/index.js";
import type { GitHubProvider } from "../providers/github/types.js";
import type { CodeIndexProvider } from "../providers/codeindex/types.js";
import { computeMinimalSet } from "../analyzers/minimal-set.js";
import type { CacheProvider } from "../cache/provider.js";
import type { QuotaBudget } from "../cache/quota.js";
import type { Logger } from "../core/logger.js";
import type { MetricsCollector } from "../core/metrics.js";
import type { Sanitizer } from "../security/sanitize.js";
import { toDegradation } from "../core/errors.js";
import { estimateTokens } from "../core/tokens.js";
import { dedupeCandidates } from "../analyzers/dedupe.js";
import { analyzeQuality } from "../analyzers/quality.js";
import { analyzeLicense } from "../analyzers/license.js";
import { assessCompleteness } from "../analyzers/completeness.js";
import { assessIntegrationSurface } from "../analyzers/integration.js";
import { assessReuse } from "../analyzers/reuse.js";
import { assessReusability } from "../analyzers/reusability.js";
import { collectEvidence } from "../ranking/evidence.js";
import { rankCandidate, sortByScore, sortByScoreOnly } from "../ranking/engine.js";

export interface DiscoverOptions {
  task: ImplementationTask;
  target?: TargetStack;
  maxRepositories: number;
  maxDeepAnalysis: number;
  minScore: number;
  weights: RankingWeights;
  enableLicenseCheck: boolean;
  /** Consult the fingerprint knowledge base before spending search quota. */
  useFingerprints: boolean;
  /**
   * Run symbol-level analysis on finalists. Off for cheap discovery, on when the caller
   * needs architecture fit and a minimal implementation set — indexing is expensive.
   */
  deepSymbols?: boolean;
}

export interface DiscoverDeps {
  github: GitHubProvider;
  /** Code index, when symbol-level analysis is wanted. Absent means metadata-only. */
  codeIndex?: { provider: CodeIndexProvider; degraded: boolean; reason?: string };
  cache: CacheProvider;
  budget: QuotaBudget;
  metrics: MetricsCollector;
  logger: Logger;
  sanitizer: Sanitizer;
}

export interface DiscoverResult {
  task: ImplementationTask;
  candidates: Candidate[];
  degradations: Degradation[];
  /** Queries actually issued, for diagnostics and query-generation debugging. */
  queriesIssued: string[];
  /** Repositories the knowledge base supplied without a GitHub search. */
  fromFingerprints: string[];
  consideredCount: number;
  deepAnalysedCount: number;
}

export async function discoverImplementations(
  opts: DiscoverOptions, deps: DiscoverDeps,
): Promise<DiscoverResult> {
  const degradations: Degradation[] = [];
  const queriesIssued: string[] = [];
  const byName = new Map<string, Candidate>();

  // --- Stage 0: knowledge base (free) --------------------------------------
  // Repositories we have already fingerprinted as implementing these capabilities cost no
  // quota at all. This is what makes the system get faster the more it is used.
  const fromFingerprints: string[] = [];
  if (opts.useFingerprints) {
    try {
      const hits = deps.cache.findByCapabilities(opts.task.capabilities, {
        minStrength: 0.5,
        language: opts.target?.language,
        limit: Math.ceil(opts.maxRepositories / 2),
      });
      for (const fp of hits) {
        deps.metrics.add("fingerprintHits");
        fromFingerprints.push(fp.repository);
      }
      if (hits.length) deps.logger.debug("fingerprint shortlist", { count: hits.length });
    } catch (err) {
      degradations.push(toDegradation(err, { stage: "discover.fingerprints", fallback: "GitHub search only" }));
    }
  }

  // --- Stage 1: multi-query search -----------------------------------------
  for (const query of opts.task.searchQueries) {
    if (byName.size >= opts.maxRepositories) break;
    if (!deps.budget.canAfford("search")) {
      degradations.push({
        stage: "discover.search",
        reason: "search budget exhausted for this call",
        fallback: `proceeding with ${byName.size} candidate(s) already found`,
        severity: "info",
      });
      break;
    }
    try {
      const results = await deps.github.searchRepositories(query, {
        language: opts.target?.language,
        perPage: Math.min(30, opts.maxRepositories),
        excludeForks: true,
        excludeArchived: true,
      });
      queriesIssued.push(query);
      for (const md of results) {
        const key = md.ref.fullName.toLowerCase();
        const existing = byName.get(key);
        if (existing) {
          // Appearing in several independent queries is itself a relevance signal.
          if (!existing.discoveredVia.includes(query)) existing.discoveredVia.push(query);
          continue;
        }
        if (byName.size >= opts.maxRepositories) break;
        byName.set(key, { ref: md.ref, metadata: md, discoveredVia: [query] });
      }
    } catch (err) {
      // One failed query must not lose the others.
      degradations.push(toDegradation(err, {
        stage: "discover.search", subject: query, fallback: "continuing with other queries",
      }));
    }
  }

  // Pull in fingerprint hits we have not already seen.
  for (const repo of fromFingerprints) {
    const key = repo.toLowerCase();
    if (byName.has(key)) {
      byName.get(key)!.discoveredVia.push("knowledge-base");
      continue;
    }
    if (byName.size >= opts.maxRepositories) break;
    try {
      const md = await deps.github.getRepository(repo);
      byName.set(key, { ref: md.ref, metadata: md, discoveredVia: ["knowledge-base"] });
    } catch (err) {
      degradations.push(toDegradation(err, { stage: "discover.fingerprint-hydrate", subject: repo }));
    }
  }

  deps.metrics.add("repositoriesConsidered", byName.size);

  if (byName.size === 0) {
    return {
      task: opts.task, candidates: [], degradations, queriesIssued, fromFingerprints,
      consideredCount: 0, deepAnalysedCount: 0,
    };
  }

  // --- Stage 2: dedupe (spec §19) ------------------------------------------
  const { kept, clusters } = dedupeCandidates([...byName.values()]);
  if (clusters.length) {
    deps.logger.debug("clustered near-duplicates", {
      clusters: clusters.length,
      folded: clusters.reduce((a, c) => a + c.members.length, 0),
    });
  }

  // --- Stage 3: cheap ranking on metadata alone ----------------------------
  // The point of the funnel: decide who deserves expensive calls using only what search
  // already returned. No additional quota is spent here.
  for (const c of kept) {
    c.analysisDepth = "metadata";
    /*
     * Reusability is assessed HERE, not only during deep analysis.
     *
     * The shortlist is chosen from these cheap scores, so a signal that only exists after
     * deep analysis cannot influence who gets analysed. With reusability arriving late,
     * three WorkManager *demo* repositories won the three deep-analysis slots for
     * "job / task queue" and a real scheduler library was never examined at all — and once
     * unexamined, the depth tier kept it permanently below them.
     *
     * Name, description and topics are enough to spot "…Example", "Demo-2-…" and
     * "…-boilerplate". Confidence is correspondingly low, and deep analysis refines it.
     */
    c.reusability = assessReusability({ metadata: c.metadata });
    c.evidence = collectEvidence({
      metadata: c.metadata,
      task: opts.task,
      target: opts.target,
      reusability: c.reusability,
      sources: ["github:metadata"],
    });
    c.score = rankCandidate(c.evidence, {
      weights: opts.weights,
      disabledAxes: opts.enableLicenseCheck ? [] : ["licenseCompatibility"],
    });
  }

  // Shortlisting uses score ALONE — at this point nothing has been analysed, so the depth
  // tier would be meaningless and would just preserve arbitrary order.
  const shortlist = sortByScoreOnly(kept).slice(0, opts.maxDeepAnalysis);

  // --- Stage 4: deep analysis of finalists only ----------------------------
  if (deps.codeIndex?.degraded && opts.deepSymbols) {
    // Spec §8: the system must clearly indicate when it used a fallback.
    deps.metrics.markDegraded("code-index:fallback");
    degradations.push({
      stage: "discover.code-index",
      severity: "info",
      reason: deps.codeIndex.reason ?? "code index unavailable",
      fallback: "symbols inferred from file paths and source patterns",
    });
  }
  for (const c of shortlist) {
    await analyzeDeeply(c, opts, deps, degradations);
    c.analysisDepth = "deep";
  }
  deps.metrics.add("repositoriesSelected", shortlist.length);

  // --- Stage 5: re-rank with full evidence ---------------------------------
  const ranked = sortByScore(kept).filter(
    (c) => (c.score?.total ?? 0) >= opts.minScore || shortlist.includes(c),
  );

  return {
    task: opts.task,
    candidates: ranked,
    degradations,
    queriesIssued,
    fromFingerprints,
    consideredCount: byName.size,
    deepAnalysedCount: shortlist.length,
  };
}

/**
 * Deep analysis of one finalist.
 *
 * Each sub-step is independently guarded: a repository with an unreadable manifest should
 * still get its licence and quality analysed. Failing the whole candidate because one of
 * six calls failed would throw away work we already paid quota for.
 */
async function analyzeDeeply(
  c: Candidate, opts: DiscoverOptions, deps: DiscoverDeps, degradations: Degradation[],
): Promise<void> {
  const repo = c.ref.fullName;
  const sources = ["github:metadata"];
  const local: Degradation[] = [];

  const guard = async <T>(stage: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      local.push(toDegradation(err, { stage, subject: repo, fallback: "signal treated as unmeasured" }));
      return undefined;
    }
  };

  // Commit SHA first: it anchors every immutable cache entry for this repository.
  const commit = await guard("deep.resolveCommit", () => deps.github.resolveCommit(repo));
  if (commit) c.ref.commit = commit;

  const [tree, readmeFile, licenseRaw, activity, releases, deps_] = await Promise.all([
    guard("deep.tree", () => deps.github.getTree(repo, commit)),
    guard("deep.readme", () => deps.github.getReadme(repo, commit)),
    opts.enableLicenseCheck ? guard("deep.license", () => deps.github.getLicense(repo)) : Promise.resolve(undefined),
    guard("deep.activity", () => deps.github.getCommitActivity(repo)),
    guard("deep.releases", () => deps.github.getReleases(repo)),
    guard("deep.dependencies", () => deps.github.getManifestDependencies(repo, commit)),
  ]);

  // README is untrusted prose — sanitise before it touches relevance scoring or output.
  let readmeText = "";
  if (readmeFile) {
    const s = deps.sanitizer.sanitize(readmeFile.content, {
      kind: "readme",
      source: `github:${repo}@${commit ?? "HEAD"}:${readmeFile.path}`,
      maxTokens: 1500,
      frame: false,   // used internally for scoring, not returned verbatim
    });
    readmeText = s.withheld ? "" : s.text;
    if (s.withheld) {
      local.push({
        stage: "deep.readme", subject: repo, severity: "warning",
        reason: `README withheld: ${s.injectionFindings.length} prompt-injection pattern(s)`,
        fallback: "relevance scored without README",
      });
    }
    // Count what the agent would have had to read itself.
    deps.metrics.add("estimatedRawTokens", estimateTokens(readmeFile.content));
  }

  const filePaths = (tree ?? []).filter((e) => e.type === "blob").map((e) => e.path);
  if (tree) {
    sources.push("repo-tree");
    // The tree is how an agent would orient itself in a repo; count it as avoided reading.
    deps.metrics.add("estimatedRawTokens", estimateTokens(filePaths.join("\n")));
  }

  c.quality = analyzeQuality({
    metadata: c.metadata, tree, activity, releases,
    readme: readmeText || undefined,
  });
  if (tree || activity || releases) sources.push("repo-structure");

  if (opts.enableLicenseCheck) {
    c.license = analyzeLicense({
      raw: licenseRaw ?? null,
      metadataSpdx: c.metadata.licenseSpdx,
      target: opts.target,
      repository: repo,
    });
    sources.push("license");
  }

  const dependencies = deps_?.deps ?? [];
  if (deps_) {
    sources.push("manifests");
    c.dependencies = {
      direct: dependencies,
      transitiveSample: [],
      manifests: deps_.manifests,
      ecosystems: [...new Set(dependencies.map((d) => d.ecosystem))],
      requiredConfiguration: [],
      platformRequirements: [],
      incompatibilities: [],
      versionAssumptions: [],
      simplicity: 0,
      notes: [],
    };
  }

  c.completeness = assessCompleteness({
    checklist: opts.task.requirementChecklist,
    capabilityTerms: opts.task.capabilities,
    symbols: c.symbols,
    filePaths,
    dependencies,
    readme: readmeText,
    description: c.metadata.description,
    topics: c.metadata.topics,
    // Without a code index we have no symbols, so absence of evidence is genuinely
    // inconclusive rather than evidence of absence.
    metadataOnly: false,
  });

  /*
   * Manifest text, for publishing-configuration detection.
   *
   * `getManifestDependencies` already fetched and cached each manifest under a
   * commit-pinned `content:` key, so re-reading the top few costs cache hits rather than
   * API calls. Publishing config (`maven-publish`, `"private": false`, `[lib]`) is the
   * single strongest library-vs-application signal, and it only lives in the raw text.
   */
  const manifestTexts: string[] = [];
  for (const path of (deps_?.manifests ?? []).slice(0, 3)) {
    const file = await guard("deep.manifest-text", () => deps.github.getFile(repo, path, commit));
    if (file) manifestTexts.push(file.content.slice(0, 20_000));
  }

  // Library or application? Uses only data already fetched — tree, manifests, metadata.
  c.reusability = assessReusability({
    metadata: c.metadata,
    filePaths,
    dependencies,
    manifestContents: manifestTexts,
    readme: readmeText,
  });

  c.integrationSurface = assessIntegrationSurface({
    symbols: c.minimalSet?.core,
    dependencies,
    filePaths,
    target: opts.target,
    repoSizeKb: c.metadata.size,
  });
  if (c.dependencies) c.dependencies.simplicity = c.integrationSurface.score;

  // --- symbol-level analysis (Layer 2) -------------------------------------
  let architectureMatch: number | undefined;
  if (opts.deepSymbols && deps.codeIndex) {
    const { provider, degraded } = deps.codeIndex;
    const indexed = await guard("deep.index", () => provider.ensureIndexed(repo, { sizeKb: c.metadata.size }));

    if (indexed && !indexed.indexed && indexed.reason) {
      local.push({
        stage: "deep.index", subject: repo, severity: "info",
        reason: indexed.reason, fallback: "symbols inferred without an index",
      });
    }
    // Prefer the index's own commit — it is what the symbols were extracted from, and
    // pinning cache entries to anything else would be a lie about their identity.
    if (indexed?.commit) c.ref.commit = indexed.commit;

    const featureTerms = [
      ...opts.task.capabilities,
      ...opts.task.feature.toLowerCase().split(/\W+/).filter((w) => w.length >= 4),
    ];
    // Search with two queries and merge.
    //
    // A single query against a well-tested repository comes back dominated by test symbols
    // — `psf/requests` returned 9 test functions and one implementation symbol for
    // "session adapter retry". Those are correctly excluded from the minimal set, but they
    // consume the result budget first and starve the core. Two queries plus a wider limit
    // give the traversal enough implementation symbols to work with.
    const symbolQueries = [...new Set([
      opts.task.searchQueries.find((q) => !q.startsWith("topic:")) ?? opts.task.feature,
      opts.task.capabilities.slice(0, 2).join(" ") || opts.task.feature,
    ])].filter(Boolean);

    const symbolBatches = await Promise.all(symbolQueries.map((q) =>
      guard("deep.symbols", () => provider.searchSymbols(repo, q, { limit: 40 }))));
    const symbols = dedupeSymbols(symbolBatches.flatMap((b) => b ?? []));

    if (symbols?.length) {
      sources.push(degraded ? "github-fallback:symbols" : "code-index");
      const minimal = await guard("deep.minimal-set", () => computeMinimalSet(provider, {
        repository: repo,
        symbols,
        featureTerms: [...new Set(featureTerms)],
        maxCore: 8,
      }));
      if (minimal) {
        c.symbols = [...minimal.core, ...minimal.supporting];
        c.minimalSet = minimal;
        deps.metrics.add("symbolsReturned", minimal.core.length + minimal.supporting.length);
        // The counterfactual: what reading all these symbols would have cost the agent.
        deps.metrics.add("estimatedRawTokens", minimal.estimatedFullTokens);
      }

      // Architecture fit: how much of the requested capability shape the symbol names
      // actually exhibit. A weak proxy, but a measured one — better than the 0.6 constant
      // it replaces, and reported with its own confidence via the evidence layer.
      architectureMatch = scoreArchitectureFit(symbols, featureTerms);
    }
  }

  const stackMatchValue = c.evidence?.axes.stackMatch?.value ?? 0.5;
  if (c.license) {
    c.reuse = assessReuse({
      license: c.license,
      metadata: c.metadata,
      target: opts.target,
      stackMatch: stackMatchValue,
      reusability: c.reusability,
      // Measured when symbols were available; otherwise a neutral value, which the
      // evidence layer separately reports as unmeasured rather than asserting a fit.
      architectureMatch: architectureMatch ?? 0.6,
      abandoned: (c.quality?.daysSinceLastPush ?? 0) > 730,
    });
  }

  c.evidence = collectEvidence({
    metadata: c.metadata,
    task: opts.task,
    target: opts.target,
    quality: c.quality,
    license: c.license,
    completeness: c.completeness,
    integrationSurface: c.integrationSurface,
    reusability: c.reusability,
    architectureMatch,
    relevanceText: readmeText,
    sources,
  });
  c.score = rankCandidate(c.evidence, {
    weights: opts.weights,
    disabledAxes: opts.enableLicenseCheck ? [] : ["licenseCompatibility"],
    // Reuse mode gates the final score. Without this, an unlicensed repository can be
    // recommended over a permissively-licensed one on maintenance alone (spec §12).
    reuse: c.reuse,
  });

  if (local.length) {
    c.degradations = local;
    degradations.push(...local);
  }
}

/** Build a lightweight Candidate from repository metadata, for tools given an explicit repo. */
export function candidateFromMetadata(md: RepoMetadata, via = "explicit"): Candidate {
  return { ref: md.ref, metadata: md, discoveredVia: [via] };
}

export type { CandidateEvidence };

/**
 * How well the candidate's symbol names exhibit the requested capability shape.
 *
 * A proxy, not an analysis: we are asking "do the names of this codebase look like an
 * implementation of this feature?". It is nonetheless a real measurement, unlike the
 * constant it replaces, and it is the signal that turns `? Not measured: compatible
 * architecture` into an actual number.
 */
function scoreArchitectureFit(symbols: CodeSymbol[], featureTerms: string[]): number {
  if (!symbols.length || !featureTerms.length) return 0.5;
  const terms = new Set(featureTerms.map((t) => t.toLowerCase()).filter((t) => t.length >= 4));
  if (!terms.size) return 0.5;

  const names = symbols.map((s) => s.name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase());
  let covered = 0;
  for (const term of terms) {
    if (names.some((n) => n.includes(term))) covered++;
  }
  const coverage = covered / terms.size;

  // Architectural role words indicate a structured implementation rather than a script.
  const structured = names.filter((n) =>
    /\b(manager|coordinator|controller|service|engine|worker|handler|queue|scheduler|client|repository|store|policy|strategy|state)\b/.test(n),
  ).length;
  const structureRatio = Math.min(1, structured / Math.max(3, symbols.length * 0.2));

  return Math.round(Math.min(1, coverage * 0.7 + structureRatio * 0.3) * 100) / 100;
}

/** Merge symbol batches, keeping the highest relevance seen for each id. */
function dedupeSymbols(symbols: CodeSymbol[]): CodeSymbol[] {
  const byId = new Map<string, CodeSymbol>();
  for (const s of symbols) {
    const existing = byId.get(s.id);
    if (!existing || (s.relevance ?? 0) > (existing.relevance ?? 0)) byId.set(s.id, s);
  }
  return [...byId.values()];
}
