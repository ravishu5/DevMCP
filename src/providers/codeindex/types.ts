/**
 * CodeIndexProvider — the deep-understanding boundary (spec §8, §27).
 *
 * Division of labour: GitHub *finds* candidates, the code index *understands* them.
 * Everything here is symbol-level, because that is the point — spec §8 asks for
 *
 *     Repository → DownloadManager → DownloadWorker → ResumeHandler → RetryPolicy
 *
 * rather than "read every .kt file".
 *
 * Two implementations:
 *   - `JCodeMunchProvider`  — the real thing, over MCP stdio
 *   - `GitHubFallbackProvider` — degraded, path-and-heuristic based
 *
 * The interface reports `mode` on every result so the system can state, per spec §8, when
 * it used a fallback. Silently degrading would let a caller trust a weak signal as if it
 * were a strong one.
 */

import type { CodeSymbol, RetrievalMode, SymbolSource } from "../../types/index.js";

export interface IndexStatus {
  repository: string;
  indexed: boolean;
  /** Commit the index was built at — anchors immutable cache entries. */
  commit?: string;
  symbolCount?: number;
  fileCount?: number;
  languages?: Record<string, number>;
  /** Why indexing was not attempted or did not succeed. */
  reason?: string;
}

export interface RepoOutline {
  repository: string;
  commit?: string;
  /** Directory-level structure with file counts. */
  directories: { path: string; files: number }[];
  languages: Record<string, number>;
  symbolCount: number;
  fileCount: number;
  entryPoints: string[];
  mode: RetrievalMode;
}

export interface SymbolSearchOptions {
  kind?: string;
  limit?: number;
  /** Restrict to a path prefix — useful for isolating a feature's module. */
  pathPrefix?: string;
}

/** Relationship edges used to build the Minimal Implementation Set. */
export interface SymbolRelations {
  symbolId: string;
  /** Symbols this one calls or constructs. */
  callees: string[];
  /** Symbols that call this one. */
  callers: string[];
  /** Heuristically related (same file, shared importers, name overlap). */
  related: string[];
  mode: RetrievalMode;
}

export interface CodeIndexProvider {
  readonly id: string;
  /** Whether the provider is usable at all right now. */
  isAvailable(): Promise<boolean>;

  /**
   * Ensure a repository is indexed, indexing it if necessary.
   *
   * Indexing is the expensive, state-changing operation, so it is explicit rather than
   * implicit in every call — a caller must decide a repository is worth it.
   */
  ensureIndexed(repository: string, opts?: { sizeKb?: number; ref?: string }): Promise<IndexStatus>;

  getOutline(repository: string): Promise<RepoOutline | null>;
  searchSymbols(repository: string, query: string, opts?: SymbolSearchOptions): Promise<CodeSymbol[]>;
  getFileOutline(repository: string, filePath: string): Promise<CodeSymbol[]>;
  getSymbolSource(repository: string, symbolIds: string[]): Promise<SymbolSource[]>;
  getRelations(repository: string, symbolId: string): Promise<SymbolRelations>;
  /** Files that import the given file — used for connectivity in the minimal set. */
  findImporters(repository: string, filePath: string): Promise<string[]>;

  /** Retrieval mode this provider represents, for provenance. */
  readonly mode: RetrievalMode;
}
