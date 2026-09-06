/**
 * GitHub fallback provider (spec §8: "If jCodeMunch is unavailable, gracefully fall back
 * to GitHub file/code retrieval. The system must clearly indicate when it used a fallback.")
 *
 * This is genuinely degraded, and says so: `mode: "github-fallback"` rides on every result,
 * and the orchestrator surfaces it as a degradation. Being loud about it matters — a weak
 * signal presented as a strong one is worse than no signal.
 *
 * What it can do: infer symbols from file paths and a light regex pass over source; infer
 * relations from imports. What it cannot do: resolve call graphs, cross-file references, or
 * type relationships. So the Minimal Implementation Set computed from this is a reasonable
 * guess rather than a traversal, and is reported as such.
 */

import type { CodeSymbol, RetrievalMode, SymbolKind, SymbolSource } from "../../types/index.js";
import type {
  CodeIndexProvider, IndexStatus, RepoOutline, SymbolRelations, SymbolSearchOptions,
} from "./types.js";
import type { GitHubProvider } from "../github/types.js";
import type { Logger } from "../../core/logger.js";
import type { MetricsCollector } from "../../core/metrics.js";
import { estimateTokens } from "../../core/tokens.js";
import { safeRepoPath } from "../../security/paths.js";

export interface FallbackOptions {
  github: GitHubProvider;
  logger: Logger;
  metrics?: MetricsCollector;
  /** Cap on files opened for symbol extraction — this path is expensive per signal. */
  maxFilesToScan?: number;
}

/** Declaration patterns per language family. Deliberately shallow — this is a fallback. */
const DECLARATIONS: { re: RegExp; kind: SymbolKind }[] = [
  { re: /^\s*(?:public\s+|private\s+|internal\s+|open\s+|abstract\s+|final\s+|export\s+|export\s+default\s+)*(?:data\s+|sealed\s+)?class\s+([A-Z][A-Za-z0-9_]*)/gm, kind: "class" },
  { re: /^\s*(?:public\s+|export\s+)?interface\s+([A-Z][A-Za-z0-9_]*)/gm, kind: "interface" },
  { re: /^\s*(?:public\s+|export\s+)?(?:type|typealias)\s+([A-Z][A-Za-z0-9_]*)/gm, kind: "type" },
  { re: /^\s*(?:public\s+|export\s+)?enum(?:\s+class)?\s+([A-Z][A-Za-z0-9_]*)/gm, kind: "enum" },
  { re: /^\s*(?:public\s+|private\s+|export\s+|export\s+default\s+|suspend\s+|async\s+)*fun\s+([a-zA-Z_][A-Za-z0-9_]*)/gm, kind: "function" },
  { re: /^\s*(?:export\s+|export\s+default\s+|async\s+)*function\s+([a-zA-Z_][A-Za-z0-9_]*)/gm, kind: "function" },
  { re: /^\s*def\s+([a-zA-Z_][A-Za-z0-9_]*)/gm, kind: "function" },
  { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)/gm, kind: "function" },
  { re: /^\s*(?:pub\s+)?(?:struct|trait|impl)\s+([A-Z][A-Za-z0-9_]*)/gm, kind: "struct" },
];

const SOURCE_EXTENSIONS = /\.(kt|kts|java|swift|m|mm|ts|tsx|js|jsx|py|go|rs|rb|php|cs|scala|dart|c|cc|cpp|h|hpp)$/i;

export class GitHubFallbackProvider implements CodeIndexProvider {
  readonly id = "github-fallback";
  readonly mode: RetrievalMode = "github-fallback";

  constructor(private readonly o: FallbackOptions) {}

  /** Always available — that is the entire point of a fallback. */
  async isAvailable(): Promise<boolean> { return true; }

  async ensureIndexed(repository: string): Promise<IndexStatus> {
    return {
      repository, indexed: false,
      reason: "no code index; using GitHub file retrieval (degraded: no call graph or cross-file references)",
    };
  }

  async getOutline(repository: string): Promise<RepoOutline | null> {
    const tree = await this.o.github.getTree(repository).catch(() => []);
    if (!tree.length) return null;
    const files = tree.filter((e) => e.type === "blob");

    const dirCounts = new Map<string, number>();
    for (const f of files) {
      const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ".";
      dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
    }

    const languages = await this.o.github.getLanguages(repository).catch(() => ({}));

    return {
      repository,
      directories: [...dirCounts.entries()]
        .map(([path, n]) => ({ path, files: n }))
        .sort((a, b) => b.files - a.files)
        .slice(0, 40),
      languages,
      symbolCount: 0,           // unknown without an index; honestly reported as zero
      fileCount: files.length,
      entryPoints: files.filter((f) => /(^|\/)(main|index|app|application)\.\w+$/i.test(f.path)).map((f) => f.path).slice(0, 8),
      mode: this.mode,
    };
  }

  /**
   * Approximate symbol search.
   *
   * Path-name matching first (cheap, and file names are surprisingly good signals), then a
   * regex scan of the most promising files. The file cap is what keeps this from becoming
   * a hundred content requests per candidate.
   */
  async searchSymbols(
    repository: string, query: string, opts: SymbolSearchOptions = {},
  ): Promise<CodeSymbol[]> {
    const limit = opts.limit ?? 20;
    const terms = query.toLowerCase().split(/[\s_-]+/).filter((t) => t.length >= 3);
    if (!terms.length) return [];

    const tree = await this.o.github.getTree(repository).catch(() => []);
    const sourceFiles = tree
      .filter((e) => e.type === "blob" && SOURCE_EXTENSIONS.test(e.path))
      .filter((e) => !opts.pathPrefix || e.path.startsWith(opts.pathPrefix));

    // Rank files by how well the path matches, so the scan budget goes to likely files.
    const scored = sourceFiles
      .map((f) => ({ file: f, score: pathScore(f.path, terms) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.o.maxFilesToScan ?? 8);

    const symbols: CodeSymbol[] = [];
    for (const { file, score } of scored) {
      if (symbols.length >= limit) break;
      const content = await this.o.github.getFile(repository, file.path).catch(() => null);
      if (!content) continue;
      this.o.metrics?.add("githubFilesExamined");
      this.o.metrics?.add("estimatedRawTokens", estimateTokens(content.content, "code"));

      for (const s of extractSymbols(content.content, file.path)) {
        const nameMatch = terms.some((t) => s.name.toLowerCase().includes(t));
        symbols.push({ ...s, relevance: nameMatch ? Math.min(1, score / 10 + 0.5) : score / 20 });
        if (symbols.length >= limit * 2) break;
      }
    }

    this.o.metrics?.add("symbolsExamined", symbols.length);
    return symbols
      .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
      .slice(0, limit);
  }

  async getFileOutline(repository: string, filePath: string): Promise<CodeSymbol[]> {
    const safe = safeRepoPath(filePath);
    if (!safe) return [];
    const content = await this.o.github.getFile(repository, safe).catch(() => null);
    if (!content) return [];
    this.o.metrics?.add("githubFilesExamined");
    return extractSymbols(content.content, safe);
  }

  /**
   * "Source" for a symbol, approximated by its enclosing file.
   *
   * Without an index we do not know a symbol's line range, so we return the file and say
   * so via `truncated`. Returning a guessed slice would be worse: a half-function is more
   * confusing to a coding agent than a whole file.
   */
  async getSymbolSource(repository: string, symbolIds: string[]): Promise<SymbolSource[]> {
    const byFile = new Map<string, string[]>();
    for (const id of symbolIds) {
      const filePath = id.includes("::") ? (id.split("::")[0] as string) : id;
      const safe = safeRepoPath(filePath);
      if (!safe) continue;
      byFile.set(safe, [...(byFile.get(safe) ?? []), id]);
    }

    const out: SymbolSource[] = [];
    for (const [filePath, ids] of byFile) {
      const content = await this.o.github.getFile(repository, filePath).catch(() => null);
      if (!content) continue;
      this.o.metrics?.add("githubFilesExamined");
      const tokens = estimateTokens(content.content, "code");
      this.o.metrics?.add("sourceTokensRetrieved", tokens);
      for (const id of ids) {
        out.push({
          symbolId: id, filePath, source: content.content,
          estimatedTokens: tokens,
          truncated: true,   // whole file, not the symbol — the caller must know
        });
      }
    }
    return out;
  }

  /**
   * Relations approximated from imports.
   *
   * File-level, not symbol-level: we can see that A imports B, not that A's method calls
   * B's. Reported as `related` rather than `callees`, because claiming a call edge we did
   * not observe would corrupt the minimal-set traversal.
   */
  async getRelations(repository: string, symbolId: string): Promise<SymbolRelations> {
    const filePath = symbolId.includes("::") ? (symbolId.split("::")[0] as string) : "";
    const safe = safeRepoPath(filePath);
    if (!safe) return { symbolId, callees: [], callers: [], related: [], mode: this.mode };

    const content = await this.o.github.getFile(repository, safe).catch(() => null);
    const related = content ? extractImports(content.content).slice(0, 12) : [];
    return { symbolId, callees: [], callers: [], related, mode: this.mode };
  }

  async findImporters(repository: string, filePath: string): Promise<string[]> {
    // Would require scanning the whole repository. Not worth the quota in a fallback path;
    // reported as empty rather than approximated badly.
    void repository; void filePath;
    return [];
  }
}

// ---------------------------------------------------------------------------

function extractSymbols(source: string, filePath: string): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  const seen = new Set<string>();
  const lines = source.split("\n");

  for (const { re, kind } of DECLARATIONS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(source)) !== null && guard++ < 200) {
      const name = m[1];
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const line = source.slice(0, m.index).split("\n").length;
      out.push({
        id: `${filePath}::${name}#${kind}`,
        name, kind, filePath,
        startLine: line,
        signature: (lines[line - 1] ?? "").trim().slice(0, 200),
        language: languageOf(filePath),
      });
    }
  }
  return out;
}

function extractImports(source: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /^\s*import\s+(?:\{[^}]*\}\s+from\s+)?['"]([^'"]+)['"]/gm,   // JS/TS
    /^\s*import\s+([\w.]+)/gm,                                    // Kotlin/Java/Python
    /^\s*from\s+([\w.]+)\s+import/gm,                             // Python
    /^\s*use\s+([\w:]+)/gm,                                       // Rust
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(source)) !== null && guard++ < 100) {
      if (m[1]) out.add(m[1]);
    }
  }
  return [...out];
}

/** Score a file path against query terms. Filename hits count double — they are the label. */
function pathScore(path: string, terms: string[]): number {
  const lower = path.toLowerCase();
  const fileName = lower.slice(lower.lastIndexOf("/") + 1);
  let score = 0;
  for (const t of terms) {
    if (fileName.includes(t)) score += 4;
    else if (lower.includes(t)) score += 2;
  }
  // Tests are evidence of a feature but not the implementation of it.
  if (/(^|\/)(test|tests|spec|__tests__)\//.test(lower)) score *= 0.4;
  if (/(^|\/)(example|examples|sample|samples|demo)\//.test(lower)) score *= 0.3;
  return score;
}

function languageOf(path: string): string | undefined {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    kt: "Kotlin", kts: "Kotlin", java: "Java", swift: "Swift", ts: "TypeScript",
    tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", py: "Python", go: "Go",
    rs: "Rust", rb: "Ruby", php: "PHP", cs: "C#", scala: "Scala", dart: "Dart",
  };
  return map[ext];
}
