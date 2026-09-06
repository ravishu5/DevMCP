/**
 * Minimal Implementation Set — the largest single token saving in the system.
 *
 * A code index will happily surface forty symbols related to a feature. Almost none are
 * needed:
 *
 *   found     DownloadManager · DownloadWorker · DownloadQueue · DownloadRepository
 *             DownloadDatabase · DownloadEntity · DownloadMapper · NetworkClient
 *             HttpClient · RetryManager · Logger · Analytics · …
 *
 *   question  What is the minimum CONNECTED set of symbols required to understand and
 *             reproduce this feature?
 *
 *   CORE        DownloadManager · DownloadWorker · DownloadQueue · ResumeHandler · RetryPolicy
 *   SUPPORTING  DownloadRepository · DownloadEntity     (named, not expanded)
 *   EXCLUDED    Logger · Analytics · Mapper             (with reasons)
 *
 * Method: a relevance-seeded traversal of the call/import graph, kept connected, cut at a
 * relevance floor and a token budget.
 *
 * Two principles that shape the algorithm:
 *
 *   1. **Connectivity beats relevance.** A highly-relevant symbol that nothing links to is
 *      usually a coincidence of naming; a slightly-less-relevant one that three core
 *      symbols call is load-bearing. So expansion follows edges rather than re-sorting by
 *      score.
 *   2. **Exclusions are reported, never silently dropped.** The agent can disagree and ask
 *      for more — which is the entire premise of progressive disclosure. Silent omission
 *      would make the bundle look complete when it is not.
 */

import type { CodeSymbol, MinimalImplementationSet } from "../types/index.js";
import type { CodeIndexProvider } from "../providers/codeindex/types.js";
import { estimateTokens } from "../core/tokens.js";

export interface MinimalSetOptions {
  repository: string;
  /** Candidate symbols, already relevance-scored by the caller. */
  symbols: CodeSymbol[];
  /** Feature terms, used to seed and to score relevance when the index gave none. */
  featureTerms: string[];
  /** Symbols scoring below this are never promoted to core. */
  relevanceFloor?: number;
  /** How many edges to follow from the seeds. */
  maxDepth?: number;
  /** Token ceiling for the core set's signatures and names. */
  tokenBudget?: number;
  /** Hard cap on core-set size, regardless of budget. */
  maxCore?: number;
}

/**
 * Files that are not implementation, whatever symbols an index extracts from them.
 *
 * Code indexers parse YAML, JSON and TOML too, so a CI workflow yields "symbols" called
 * `name` and `python-version`. Those are perfectly real index entries and completely
 * useless as an implementation map — an early run returned five of them as the minimal set
 * for an HTTP client. Excluded before scoring, because no relevance function can rescue a
 * candidate pool made of config keys.
 */
const NON_IMPLEMENTATION_PATHS = [
  { re: /(^|\/)\.github\//i, reason: "CI configuration, not implementation" },
  { re: /(^|\/)\.(gitlab-ci|circleci|travis|drone)/i, reason: "CI configuration, not implementation" },
  { re: /\.(ya?ml|json|toml|ini|cfg|conf|lock|properties|gradle|xml|plist)$/i, reason: "configuration file, not implementation" },
  { re: /(^|\/)(docs?|documentation|website|examples?|samples?|demos?|fixtures?|benchmarks?)\//i, reason: "documentation or example, not implementation" },
  { re: /\.(md|rst|txt|adoc|html|css|scss)$/i, reason: "documentation or markup, not implementation" },
  { re: /(^|\/)(node_modules|vendor|third_party|dist|build|target|\.venv)\//i, reason: "vendored or generated code" },
  // Sample and demo modules are a repository's advertising, not its implementation. They
  // are also where the most feature-named symbols live, so they out-score real code.
  { re: /(^|\/)(sample|samples|sampleapp|demo|demos|example|examples|playground)([A-Z]|\/|$)/i, reason: "sample or demo module, not the library" },
  // Files that exist to hold message strings or constant tables. Their symbols carry
  // feature vocabulary (FAILED_RENAME_FILE_ASSOCIATED_WITH_INCOMPLETE_DOWNLOAD) without
  // carrying any behaviour, so they score highly and explain nothing.
  { re: /(^|\/)[A-Za-z]*(Strings|Constants?|Consts?|Messages|ErrorCodes|Keys|Defaults)\.\w+$/i, reason: "string/constant table, not behaviour" },
];

function nonImplementationReason(filePath: string): string | null {
  for (const { re, reason } of NON_IMPLEMENTATION_PATHS) {
    if (re.test(filePath)) return reason;
  }
  return null;
}

/** Symbols that are infrastructure rather than implementation of the requested feature. */
const NOISE_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\b(logger|logging|log)\b/i, reason: "logging infrastructure" },
  { re: /\b(analytics|telemetry|tracking|metrics)\b/i, reason: "analytics/telemetry" },
  { re: /\b(mapper|converter|adapter|dto|transformer)\b/i, reason: "data mapping boilerplate" },
  { re: /\b(constants?|config|settings|properties)\b/i, reason: "configuration constants" },
  { re: /\b(util|utils|helper|helpers|extensions?)\b/i, reason: "generic utilities" },
  { re: /\b(exception|error)\b/i, reason: "error type" },
  { re: /^(get|set|is|has)[A-Z]/, reason: "accessor" },
  { re: /\b(builder|factory)\b/i, reason: "construction boilerplate" },
];

/**
 * Symbols that name the *shape* of a feature — strong seeds.
 *
 * Matched against the SPLIT identifier ("DownloadManager" → "download manager"), never the
 * raw name. `\bmanager\b` does not match inside `DownloadManager`, because there is no word
 * boundary between "d" and "M" — so testing the raw name silently failed for every
 * camelCase symbol, which is to say almost all of them.
 */
const ARCHITECTURAL_ROLES = /\b(manager|coordinator|controller|service|engine|worker|handler|queue|scheduler|client|repository|store|session|policy|strategy|state|machine)\b/i;

/** Identifier words joined by spaces, so `\b` patterns behave as intended. */
function words(name: string): string {
  return splitIdentifier(name).join(" ");
}

function hasArchitecturalRole(name: string): boolean {
  return ARCHITECTURAL_ROLES.test(words(name));
}

export async function computeMinimalSet(
  provider: CodeIndexProvider | null,
  opts: MinimalSetOptions,
): Promise<MinimalImplementationSet> {
  const relevanceFloor = opts.relevanceFloor ?? 0.25;
  const maxDepth = opts.maxDepth ?? 2;
  const tokenBudget = opts.tokenBudget ?? 1200;
  const maxCore = opts.maxCore ?? 8;

  const byId = new Map(opts.symbols.map((s) => [s.id, s]));
  const scored = opts.symbols.map((s) => ({ symbol: s, score: scoreSymbol(s, opts.featureTerms) }));

  // --- Seeds -------------------------------------------------------------
  // The highest-scoring symbols that are not obviously noise. These anchor the traversal,
  // so a bad seed is expensive — hence the deliberately strict filter.
  const seeds = scored
    .filter((x) => x.score >= 0.45 && !isNoise(x.symbol).noise)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  if (seeds.length === 0) {
    // Nothing scored well enough to anchor a traversal.
    //
    // Return only symbols with SOME positive relevance. An earlier version returned the
    // top N regardless of score, which — when every score was zero — meant returning the
    // first five symbols in index order. That produced a confident-looking minimal set
    // made of CI config keys. An empty set that says so is strictly more useful than a
    // populated one that is wrong.
    const fallback = scored
      .filter((x) => x.score > 0.15 && !isNoise(x.symbol).noise)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(5, maxCore));
    return {
      core: fallback.map((x) => ({ ...x.symbol, relevance: round2(x.score) })),
      supporting: [],
      excluded: scored
        .filter((x) => !fallback.some((f) => f.symbol.id === x.symbol.id))
        .slice(0, 15)
        .map((x) => ({ name: x.symbol.name, symbolId: x.symbol.id, reason: isNoise(x.symbol).reason ?? "below relevance floor" })),
      seeds: [],
      connected: false,
      estimatedTokens: estimateSetTokens(fallback.map((x) => x.symbol)),
      estimatedFullTokens: estimateSetTokens(opts.symbols),
      parameters: { relevanceFloor, maxDepth, tokenBudget },
    };
  }

  // --- Traversal ---------------------------------------------------------
  const core = new Map<string, CodeSymbol>();
  const supporting = new Map<string, CodeSymbol>();
  const excludedReasons = new Map<string, string>();
  const scoreOf = new Map(scored.map((x) => [x.symbol.id, x.score]));

  let budget = tokenBudget;
  const admit = (s: CodeSymbol, score: number): boolean => {
    const cost = symbolTokens(s);
    if (core.size >= maxCore || cost > budget) return false;
    core.set(s.id, { ...s, relevance: round2(score) });
    budget -= cost;
    return true;
  };

  for (const seed of seeds) {
    if (!admit(seed.symbol, seed.score)) break;
  }

  // Directories the seeds live in. A feature normally lives in one module, so sharing a
  // directory with the seeds is real structural evidence of belonging to the same feature
  // — and it is what separates `src/download/DownloadWorker` from `src/data/DownloadRepository`
  // when their name scores tie.
  const seedDirs = new Set(seeds.map((s) => dirOf(s.symbol.filePath)));
  const cohesionBonus = (s: CodeSymbol): number => (seedDirs.has(dirOf(s.filePath)) ? 0.08 : 0);

  // Breadth-first over relation edges. `connected` records whether we ever had to reach
  // for an unlinked symbol to fill the set — a real quality signal about the result.
  //
  // Each level is GATHERED then RANKED before anything is admitted. Admitting greedily in
  // traversal order lets whichever seed happens to be processed first spend the remaining
  // budget on its own neighbours, regardless of how relevant they are: in the worked
  // example that dropped `DownloadWorker` (core) in favour of `DownloadRepository`
  // (supporting), purely because `DownloadQueue` was visited first.
  let connected = true;
  let frontier = [...core.keys()];
  const visited = new Set(frontier);

  for (let depth = 0; depth < maxDepth && frontier.length && core.size < maxCore; depth++) {
    const level: { symbol: CodeSymbol; score: number }[] = [];

    for (const id of frontier) {
      const relations = provider
        ? await provider.getRelations(opts.repository, id).catch(() => null)
        : null;
      if (!relations) continue;

      // Callees before callers: what a symbol *uses* is needed to understand it; what uses
      // it is context. Related-by-clustering is weakest and comes last.
      for (const nid of [...relations.callees, ...relations.callers, ...relations.related]) {
        if (visited.has(nid)) continue;
        visited.add(nid);
        const symbol = byId.get(nid);
        if (!symbol) continue;

        const noise = isNoise(symbol);
        if (noise.noise) { excludedReasons.set(nid, noise.reason as string); continue; }

        const score = (scoreOf.get(nid) ?? scoreSymbol(symbol, opts.featureTerms)) + cohesionBonus(symbol);
        level.push({ symbol, score: clamp(score) });
      }
    }

    // Admit the best of the level, demote the rest to supporting.
    level.sort((a, b) => b.score - a.score);
    const next: string[] = [];
    for (const { symbol, score } of level) {
      if (score < relevanceFloor) {
        // Linked but weakly relevant: name it as supporting rather than expanding it.
        supporting.set(symbol.id, { ...symbol, relevance: round2(score) });
        continue;
      }
      if (core.size < maxCore && admit(symbol, score)) next.push(symbol.id);
      else supporting.set(symbol.id, { ...symbol, relevance: round2(score) });
    }
    frontier = next;
  }

  // --- Top up ------------------------------------------------------------
  // If the graph was thin (or we had no provider), fill remaining space with the best
  // unvisited symbols — but record that the set is no longer strictly connected.
  if (core.size < Math.min(3, maxCore)) {
    for (const { symbol, score } of scored.sort((a, b) => b.score - a.score)) {
      if (core.size >= maxCore) break;
      if (core.has(symbol.id) || supporting.has(symbol.id)) continue;
      const noise = isNoise(symbol);
      if (noise.noise) { excludedReasons.set(symbol.id, noise.reason as string); continue; }
      if (score < relevanceFloor) continue;
      if (admit(symbol, score)) connected = false;
    }
  }

  // --- Account for everything --------------------------------------------
  for (const { symbol, score } of scored) {
    if (core.has(symbol.id) || supporting.has(symbol.id) || excludedReasons.has(symbol.id)) continue;
    const noise = isNoise(symbol);
    excludedReasons.set(
      symbol.id,
      noise.noise ? (noise.reason as string)
        : score < relevanceFloor ? `relevance ${round2(score)} below floor ${relevanceFloor}`
        : "not reachable from the core set within the traversal depth",
    );
  }

  const coreList = [...core.values()].sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));
  const supportingList = [...supporting.values()]
    .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
    .slice(0, 6);

  return {
    core: coreList,
    supporting: supportingList,
    excluded: [...excludedReasons.entries()]
      .map(([id, reason]) => ({ name: byId.get(id)?.name ?? id, symbolId: id, reason }))
      .slice(0, 20),
    seeds: seeds.map((s) => ({
      symbolId: s.symbol.id,
      reason: `highest feature relevance (${round2(s.score)})${hasArchitecturalRole(s.symbol.name) ? ", architectural role in its name" : ""}`,
    })),
    // Without a provider we never observed a single edge, so connectivity is unproven —
    // claiming it would misrepresent how much we actually know about the set.
    connected: provider ? connected : false,
    estimatedTokens: estimateSetTokens(coreList) + estimateSetTokens(supportingList) / 2,
    estimatedFullTokens: estimateSetTokens(opts.symbols),
    parameters: { relevanceFloor, maxDepth, tokenBudget },
  };
}

/**
 * Relevance of one symbol to the feature.
 *
 * Name match dominates: in practice a symbol called `ResumeHandler` in a downloader
 * repository is about resuming downloads, and no amount of path or signature evidence
 * changes that. Architectural role names get a bonus because they mark the *shape* of an
 * implementation, which is what an agent most needs to see.
 */
function scoreSymbol(symbol: CodeSymbol, featureTerms: string[]): number {
  if (typeof symbol.relevance === "number" && symbol.relevance > 0) {
    // Trust an index-provided score, but still apply the structural adjustments below.
    return clamp(symbol.relevance * 0.7 + structuralBonus(symbol) * 0.3);
  }

  const name = symbol.name.toLowerCase();
  const nameWords = splitIdentifier(symbol.name);
  const path = symbol.filePath.toLowerCase();
  const signature = (symbol.signature ?? "").toLowerCase();
  const purpose = (symbol.purpose ?? "").toLowerCase();

  let score = 0;
  for (const rawTerm of featureTerms) {
    const term = rawTerm.toLowerCase();
    if (term.length < 3) continue;
    if (nameWords.some((w) => w === term)) score += 0.35;         // exact word in the name
    else if (name.includes(term)) score += 0.25;
    else if (purpose.includes(term)) score += 0.12;
    else if (path.includes(term)) score += 0.10;
    else if (signature.includes(term)) score += 0.06;
  }

  return clamp(score + structuralBonus(symbol));
}

function structuralBonus(symbol: CodeSymbol): number {
  let bonus = 0;
  if (hasArchitecturalRole(symbol.name)) bonus += 0.15;
  // Classes and interfaces define structure; a lone method rarely explains a feature.
  if (symbol.kind === "class" || symbol.kind === "interface") bonus += 0.1;
  // Constants and enum members name things; they do not do things. A constant called
  // REQUEST_WITH_FILE_PATH_ALREADY_EXIST matches every feature term and teaches nothing
  // about how the feature works.
  if (symbol.kind === "constant" || symbol.kind === "enum") bonus -= 0.3;
  // SCREAMING_SNAKE_CASE is a constant even when the index did not label it as one.
  if (/^[A-Z0-9_]{6,}$/.test(symbol.name)) bonus -= 0.3;
  // Tests demonstrate a feature but are retrieved separately at Layer 4.
  if (/(^|\/)(test|tests|spec|__tests__|androidTest)\//i.test(symbol.filePath)) bonus -= 0.45;
  if (/(^|\/)(example|examples|sample|samples|demo)\//i.test(symbol.filePath)) bonus -= 0.35;
  return bonus;
}

/**
 * Is this symbol noise rather than implementation of the requested feature?
 *
 * PATH checks run first and are absolute; NAME checks run second and are overridable.
 *
 * That ordering is load-bearing. An earlier version ran the name heuristics first, and the
 * architectural-role override — which exists so `DownloadStoreBuilder` is not discarded as
 * "builder boilerplate" — short-circuited the test-file check. The result:
 * `test_session_get_adapter_prefix_with_trailing_slash` matched the "adapter" noise rule,
 * was rescued by the "session" role word, and returned `noise: false` before the path was
 * ever considered. Five test functions landed in a minimal implementation set.
 *
 * The generalisable lesson: an override scoped to one dimension (names) must not be able to
 * bypass a check on a different dimension (paths). Path facts are structural; name rules
 * are heuristics, and only heuristics get overridden.
 */
function isNoise(symbol: CodeSymbol): { noise: boolean; reason?: string } {
  // --- absolute, path-based exclusions -------------------------------------
  const nonImpl = nonImplementationReason(symbol.filePath);
  if (nonImpl) return { noise: true, reason: nonImpl };

  if (/(^|\/)(test|tests|spec|specs|__tests__|androidTest|testing)\//i.test(symbol.filePath)
      || /(^|\/)(test_[^/]+|[^/]+_test)\.\w+$/i.test(symbol.filePath)
      || /\.(test|spec)\.\w+$/i.test(symbol.filePath)) {
    return { noise: true, reason: "test file — retrieved separately as test evidence" };
  }

  // --- constants: named things, not behaviour ------------------------------
  //
  // A constant is classified as noise rather than merely penalised, because scoring cannot
  // settle it: `DOWNLOAD_RESUME_RETRY_MAX` matches three feature terms and out-scores real
  // implementation symbols, while teaching nothing about how resuming works. The exception
  // is a constant carrying an architectural role in its name, which is usually a strategy
  // or state token worth seeing.
  const isConstant = symbol.kind === "constant" || symbol.kind === "enum"
    || /^[A-Z0-9_]{6,}$/.test(symbol.name);
  if (isConstant && !hasArchitecturalRole(symbol.name)) {
    return { noise: true, reason: "constant or enum value — names a thing, does not implement one" };
  }

  // --- overridable, name-based heuristics ----------------------------------
  const w = words(symbol.name);
  for (const { re, reason } of NOISE_PATTERNS) {
    if (!re.test(w)) continue;
    // A symbol that ALSO carries an architectural role is kept — `DownloadStoreBuilder` is
    // still about the store. The exception is logging/analytics, which are noise no matter
    // what else the name says.
    if (hasArchitecturalRole(symbol.name) && !/\b(logger|logging|analytics|telemetry|tracking)\b/i.test(w)) {
      return { noise: false };
    }
    return { noise: true, reason };
  }
  return { noise: false };
}

/** Split camelCase / snake_case / kebab-case into lowercase words. */
function splitIdentifier(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** Cost of representing a symbol at Layer 2 (name + signature + purpose, not source). */
function symbolTokens(s: CodeSymbol): number {
  return estimateTokens(`${s.name} ${s.signature ?? ""} ${s.purpose ?? ""} ${s.filePath}`, "identifier");
}

function estimateSetTokens(symbols: CodeSymbol[]): number {
  return symbols.reduce((a, s) => a + symbolTokens(s), 0);
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "." : path.slice(0, i);
}

function clamp(n: number): number { return Math.max(0, Math.min(1, n)); }
function round2(n: number): number { return Math.round(n * 100) / 100; }
