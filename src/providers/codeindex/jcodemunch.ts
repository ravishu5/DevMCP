/**
 * jCodeMunch provider — an MCP client speaking to `jcodemunch-mcp` over stdio.
 *
 * jCodeMunch exposes 91 actions behind three verbs (`route` / `menu` / `order`); we
 * dispatch everything through `order(action, args)`, which is the documented single-verb
 * front door and the only surface stable enough to depend on.
 *
 * Three operational realities shape this file:
 *
 *   1. **Indexing is expensive and state-changing.** `index_repo` clones and parses a
 *      repository. It is gated behind a size check and a timeout, and requires
 *      `allow_state_change: true`, so it can never happen by accident.
 *   2. **The wire format is undocumented.** Responses come back as JSON *or* MUNCH
 *      depending on the action. Every response goes through `parseToolPayload`, and a
 *      parse failure degrades to the fallback provider rather than throwing.
 *   3. **The subprocess may not exist.** `uvx` may be missing, the package unpublished, the
 *      machine offline. `isAvailable()` is cheap, cached, and never throws — an absent code
 *      index is a documented degraded mode, not an error.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CodeSymbol, RetrievalMode, SymbolKind, SymbolSource } from "../../types/index.js";
import type {
  CodeIndexProvider, IndexStatus, RepoOutline, SymbolRelations, SymbolSearchOptions,
} from "./types.js";
import { parseToolPayload, findTable, type MunchDocument } from "./munch.js";
import type { Logger } from "../../core/logger.js";
import type { MetricsCollector } from "../../core/metrics.js";
import type { CacheProvider } from "../../cache/provider.js";
import { getOrCompute } from "../../cache/provider.js";
import { key, repoKey } from "../../cache/keys.js";
import { IntelligenceError } from "../../core/errors.js";
import { estimateTokens } from "../../core/tokens.js";
import { safeRepoPath } from "../../security/paths.js";

export interface JCodeMunchOptions {
  command: string;
  args: string[];
  indexTimeoutMs: number;
  callTimeoutMs: number;
  maxRepoSizeKb: number;
  logger: Logger;
  cache: CacheProvider;
  metrics?: MetricsCollector;
}

export class JCodeMunchProvider implements CodeIndexProvider {
  readonly id = "jcodemunch";
  readonly mode: RetrievalMode = "code-index";

  private client?: Client;
  private connecting?: Promise<Client | null>;
  private availability?: boolean;

  constructor(private readonly o: JCodeMunchOptions) {}

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  /**
   * Lazily connect. Never throws: an unavailable code index is a degraded mode.
   * The result is memoised, including the negative, so a missing `uvx` costs one attempt
   * per process rather than one per candidate.
   */
  private async connect(): Promise<Client | null> {
    if (this.client) return this.client;
    if (this.availability === false) return null;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      try {
        const transport = new StdioClientTransport({
          command: this.o.command,
          args: this.o.args,
          // Inherit the environment so `uvx` finds its Python and cache, but strip our own
          // GitHub token: the subprocess has no need for it, and not passing it is cheaper
          // than trusting it not to log it.
          env: sanitizedEnv(),
          stderr: "ignore",
        });
        const client = new Client(
          { name: "implementation-intelligence-mcp", version: "0.1.0" },
          { capabilities: {} },
        );
        await client.connect(transport);
        this.client = client;
        this.availability = true;
        this.o.logger.debug("code index connected", { command: this.o.command });
        return client;
      } catch (err) {
        this.availability = false;
        this.o.logger.warn("code index unavailable; falling back to GitHub retrieval", {
          command: this.o.command,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      } finally {
        this.connecting = undefined;
      }
    })();

    return this.connecting;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.connect()) !== null;
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      // Closing a already-dead subprocess is not an error worth surfacing.
    }
    this.client = undefined;
  }

  /**
   * Dispatch one action through `order`.
   *
   * Returns null on any failure, having logged it. The null-rather-than-throw contract is
   * deliberate: callers compose several of these, and a single failed relation lookup
   * should degrade one symbol's edges, not abort the extraction.
   */
  private async order<T = unknown>(
    action: string,
    args: Record<string, unknown>,
    opts: { stateChanging?: boolean; timeoutMs?: number } = {},
  ): Promise<T | null> {
    const client = await this.connect();
    if (!client) return null;

    this.o.metrics?.add("codeIndexCalls");
    try {
      const result = await client.callTool(
        {
          name: "order",
          arguments: {
            action,
            args,
            ...(opts.stateChanging ? { allow_state_change: true } : {}),
          },
        },
        undefined,
        { timeout: opts.timeoutMs ?? this.o.callTimeoutMs },
      );

      const text = extractText(result);
      if (!text) return null;

      const parsed = parseToolPayload(text);
      if (parsed.kind === "json") return parsed.value as T;
      if (parsed.kind === "munch") return parsed.value as unknown as T;
      // Plain text: usually an error message from the action itself.
      this.o.logger.debug("code index returned unstructured text", {
        action, preview: parsed.value.slice(0, 200),
      });
      return null;
    } catch (err) {
      this.o.logger.debug("code index call failed", {
        action, error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Indexing
  // -------------------------------------------------------------------------

  /**
   * Ensure a repository is indexed.
   *
   * Checks `list_repos` first — re-indexing an already-indexed repository would waste
   * minutes. The size gate implements spec §21's "huge repositories": rather than let one
   * enormous monorepo hang a tool call, we decline and report why, and the caller degrades
   * to GitHub retrieval.
   */
  async ensureIndexed(
    repository: string, opts: { sizeKb?: number; ref?: string } = {},
  ): Promise<IndexStatus> {
    const existing = await this.getIndexStatus(repository);
    if (existing?.indexed) return existing;

    if (opts.sizeKb !== undefined && opts.sizeKb > this.o.maxRepoSizeKb) {
      return {
        repository, indexed: false,
        reason: `repository is ${Math.round(opts.sizeKb / 1024)} MB, above the ${Math.round(this.o.maxRepoSizeKb / 1024)} MB indexing limit`,
      };
    }

    if (!(await this.isAvailable())) {
      return { repository, indexed: false, reason: "code index unavailable" };
    }

    this.o.logger.debug("indexing repository", { repository });
    const t0 = Date.now();
    const result = await this.order<unknown>(
      "index_repo",
      { url: `https://github.com/${repository}` },
      { stateChanging: true, timeoutMs: this.o.indexTimeoutMs },
    );

    if (result === null) {
      return { repository, indexed: false, reason: "indexing failed or timed out" };
    }
    this.o.logger.debug("indexed repository", { repository, ms: Date.now() - t0 });

    // Re-read status rather than trusting the index response shape, which varies.
    const after = await this.getIndexStatus(repository, { force: true });
    return after ?? { repository, indexed: true };
  }

  /** Read index state from `list_repos`. Cached briefly — it changes only on indexing. */
  private async getIndexStatus(
    repository: string, opts: { force?: boolean } = {},
  ): Promise<IndexStatus | null> {
    const cacheKey = key("index-state", repository.toLowerCase());
    if (opts.force) this.o.cache.delete(cacheKey);

    return getOrCompute(this.o.cache, cacheKey, "index-state", 5 * 60_000, this.o.metrics, async () => {
      const doc = await this.order<MunchDocument | { repos?: unknown[] }>("list_repos", {});
      if (!doc) return { repository, indexed: false, reason: "could not read index state" };

      const rows = rowsOf(doc, "repos");
      const wanted = repository.toLowerCase();
      const row = rows.find((r) => String(r.repo ?? r.repository ?? "").toLowerCase() === wanted)
        // jCodeMunch may key a locally-cloned repo by its display name.
        ?? rows.find((r) => String(r.repo ?? "").toLowerCase().endsWith("/" + wanted.split("/")[1]));

      if (!row) return { repository, indexed: false, reason: "not indexed" };
      return {
        repository: String(row.repo ?? repository),
        indexed: row.index_present !== false && row.loadable !== false,
        commit: typeof row.git_head === "string" ? row.git_head : undefined,
        symbolCount: numberOf(row.symbol_count),
        fileCount: numberOf(row.file_count),
        languages: parsePythonDict(row.languages),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async getOutline(repository: string): Promise<RepoOutline | null> {
    const status = await this.getIndexStatus(repository);
    if (!status?.indexed) return null;

    return getOrCompute(
      this.o.cache, repoKey("symbols", `${repository}#outline`, status.commit), "symbols", null, this.o.metrics,
      async () => {
        const doc = await this.order<MunchDocument | Record<string, unknown>>("get_repo_outline", { repo: repository });
        if (!doc) return null;

        const dirRows = rowsOf(doc, "directories");
        const directories = dirRows
          .map((r) => ({ path: String(r.path ?? r.directory ?? ""), files: numberOf(r.files ?? r.file_count) ?? 0 }))
          .filter((d) => d.path);

        const suggestions = await this.order<MunchDocument | Record<string, unknown>>("suggest_queries", { repo: repository });
        const entryPoints = suggestions
          ? rowsOf(suggestions, "entry_points").map((r) => String(r.file ?? r.path ?? "")).filter(Boolean).slice(0, 8)
          : [];

        return {
          repository,
          commit: status.commit,
          directories: directories.slice(0, 40),
          languages: status.languages ?? {},
          symbolCount: status.symbolCount ?? 0,
          fileCount: status.fileCount ?? 0,
          entryPoints,
          mode: this.mode,
        } satisfies RepoOutline;
      },
    );
  }

  async searchSymbols(
    repository: string, query: string, opts: SymbolSearchOptions = {},
  ): Promise<CodeSymbol[]> {
    const status = await this.getIndexStatus(repository);
    if (!status?.indexed) return [];

    const cacheKey = repoKey("symbols", `${repository}#search#${query}#${opts.kind ?? ""}#${opts.limit ?? 0}`, status.commit);
    return getOrCompute(this.o.cache, cacheKey, "symbols", null, this.o.metrics, async () => {
      const doc = await this.order<MunchDocument | Record<string, unknown>>("search_symbols", {
        repo: repository,
        query,
        ...(opts.kind ? { kind: opts.kind } : {}),
        ...(opts.limit ? { limit: opts.limit } : {}),
      });
      if (!doc) return [];
      const symbols = rowsOf(doc, "symbols").map(toSymbol).filter((s): s is CodeSymbol => s !== null);
      this.o.metrics?.add("symbolsExamined", symbols.length);
      return opts.pathPrefix
        ? symbols.filter((s) => s.filePath.startsWith(opts.pathPrefix as string))
        : symbols;
    });
  }

  async getFileOutline(repository: string, filePath: string): Promise<CodeSymbol[]> {
    const status = await this.getIndexStatus(repository);
    if (!status?.indexed) return [];
    const safe = safeRepoPath(filePath);
    if (!safe) return [];

    return getOrCompute(
      this.o.cache, repoKey("symbols", `${repository}#file#${safe}`, status.commit), "symbols", null, this.o.metrics,
      async () => {
        const doc = await this.order<MunchDocument | Record<string, unknown>>("get_file_outline", {
          repo: repository, file_path: safe,
        });
        if (!doc) return [];
        return rowsOf(doc, "symbols").map(toSymbol).filter((s): s is CodeSymbol => s !== null);
      },
    );
  }

  /**
   * Fetch source for specific symbols — the only Layer-3 operation.
   *
   * Batched into one call because `get_symbol_source` accepts `symbol_ids[]`: N separate
   * round-trips over stdio would dominate the latency of extraction.
   */
  async getSymbolSource(repository: string, symbolIds: string[]): Promise<SymbolSource[]> {
    if (!symbolIds.length) return [];
    const status = await this.getIndexStatus(repository);
    if (!status?.indexed) return [];

    const cacheKey = repoKey("symbols", `${repository}#source#${symbolIds.slice().sort().join("|")}`, status.commit);
    return getOrCompute(this.o.cache, cacheKey, "symbols", null, this.o.metrics, async () => {
      const doc = await this.order<MunchDocument | Record<string, unknown>>("get_symbol_source", {
        repo: repository,
        ...(symbolIds.length === 1 ? { symbol_id: symbolIds[0] } : { symbol_ids: symbolIds }),
      });
      if (!doc) return [];

      const rows = rowsOf(doc, "symbols");
      const out: SymbolSource[] = [];
      for (const r of rows) {
        const source = String(r.source ?? r.code ?? r.content ?? "");
        if (!source) continue;
        const filePath = safeRepoPath(String(r.file_path ?? r.path ?? "")) ?? "";
        const tokens = estimateTokens(source, "code");
        this.o.metrics?.add("sourceTokensRetrieved", tokens);
        out.push({
          symbolId: String(r.symbol_id ?? r.id ?? ""),
          filePath,
          source,
          startLine: numberOf(r.start_line),
          endLine: numberOf(r.end_line),
          estimatedTokens: tokens,
          truncated: false,
        });
      }
      return out;
    });
  }

  /**
   * Relationship edges for one symbol.
   *
   * Three sources combined — call hierarchy, related-symbol clustering, and references —
   * because none alone is complete: call hierarchy misses type usage, clustering misses
   * cross-module calls, and references are file-level rather than symbol-level. The union
   * is what makes the minimal-set traversal land on a *connected* subgraph.
   */
  async getRelations(repository: string, symbolId: string): Promise<SymbolRelations> {
    const empty: SymbolRelations = { symbolId, callees: [], callers: [], related: [], mode: this.mode };
    const status = await this.getIndexStatus(repository);
    if (!status?.indexed) return { ...empty, mode: "unavailable" };

    const cacheKey = repoKey("symbols", `${repository}#rel#${symbolId}`, status.commit);
    return getOrCompute(this.o.cache, cacheKey, "symbols", null, this.o.metrics, async () => {
      const [hierarchy, related] = await Promise.all([
        this.order<MunchDocument | Record<string, unknown>>("get_call_hierarchy", { repo: repository, symbol_id: symbolId, depth: 1 }),
        this.order<MunchDocument | Record<string, unknown>>("get_related_symbols", { repo: repository, symbol_id: symbolId }),
      ]);

      const callees = hierarchy ? idsOf(hierarchy, ["callees", "outgoing"]) : [];
      const callers = hierarchy ? idsOf(hierarchy, ["callers", "incoming"]) : [];
      const rel = related ? idsOf(related, ["related", "symbols"]) : [];

      return { symbolId, callees, callers, related: rel, mode: this.mode };
    });
  }

  async findImporters(repository: string, filePath: string): Promise<string[]> {
    const status = await this.getIndexStatus(repository);
    if (!status?.indexed) return [];
    const safe = safeRepoPath(filePath);
    if (!safe) return [];
    const doc = await this.order<MunchDocument | Record<string, unknown>>("find_importers", {
      repo: repository, file_path: safe,
    });
    if (!doc) return [];
    return rowsOf(doc, "importers")
      .map((r) => safeRepoPath(String(r.file ?? r.path ?? r.importer ?? "")) ?? "")
      .filter(Boolean);
  }
}

// ---------------------------------------------------------------------------
// Response normalisation
// ---------------------------------------------------------------------------

/**
 * Extract rows from either a MUNCH document or a JSON object.
 *
 * jCodeMunch returns different shapes per action and per version, so this tries several
 * plausible shapes rather than assuming one. Returning `[]` for an unrecognised shape is
 * correct: an empty result degrades a signal, whereas throwing would lose the candidate.
 */
function rowsOf(doc: unknown, preferredTable: string): Record<string, unknown>[] {
  if (!doc || typeof doc !== "object") return [];

  // MUNCH document
  if ("tables" in doc && Array.isArray((doc as MunchDocument).tables)) {
    const munch = doc as MunchDocument;
    const table = munch.tables.find((t) => t.name === preferredTable) ?? munch.tables[0];
    return table?.rows ?? [];
  }

  // JSON: a bare array, or an object with a plausible array field.
  if (Array.isArray(doc)) return doc as Record<string, unknown>[];
  const obj = doc as Record<string, unknown>;
  for (const field of [preferredTable, "results", "items", "symbols", "rows", "data", "entries"]) {
    const v = obj[field];
    if (Array.isArray(v)) return v as Record<string, unknown>[];
  }
  // A single flat object (get_symbol_source with one id) is one row.
  if (obj.source || obj.symbol_id || obj.name) return [obj];
  return [];
}

/** Collect symbol ids from any of several plausible field names. */
function idsOf(doc: unknown, fields: string[]): string[] {
  const out = new Set<string>();
  for (const field of fields) {
    for (const row of rowsOf(doc, field)) {
      const id = row.symbol_id ?? row.id ?? row.symbol ?? row.name;
      if (typeof id === "string" && id) out.add(id);
    }
  }
  return [...out];
}

function toSymbol(row: Record<string, unknown>): CodeSymbol | null {
  const name = String(row.name ?? row.symbol ?? "");
  const id = String(row.symbol_id ?? row.id ?? "");
  if (!name && !id) return null;
  const filePath = safeRepoPath(String(row.file_path ?? row.path ?? row.file ?? "")) ?? "";
  return {
    id: id || `${filePath}::${name}`,
    name: name || id.split("::").pop() || id,
    kind: normaliseKind(String(row.kind ?? row.type ?? "")),
    filePath,
    startLine: numberOf(row.start_line ?? row.line),
    endLine: numberOf(row.end_line),
    signature: stringOrUndefined(row.signature),
    purpose: stringOrUndefined(row.summary ?? row.purpose ?? row.docstring),
    language: stringOrUndefined(row.language),
    relevance: typeof row.score === "number" ? row.score : undefined,
  };
}

function normaliseKind(raw: string): SymbolKind {
  const k = raw.toLowerCase();
  const known: SymbolKind[] = ["class", "function", "method", "interface", "type", "enum", "constant", "module", "struct", "trait"];
  return known.find((x) => k.includes(x)) ?? "unknown";
}

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function numberOf(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** jCodeMunch reports language breakdowns as a Python dict literal. */
function parsePythonDict(v: unknown): Record<string, number> | undefined {
  if (typeof v !== "string" || !v.includes(":")) return undefined;
  const out: Record<string, number> = {};
  for (const m of v.matchAll(/'([^']+)'\s*:\s*(\d+)/g)) {
    out[m[1] as string] = Number(m[2]);
  }
  return Object.keys(out).length ? out : undefined;
}

/** MCP tool results are content blocks; concatenate the text ones. */
function extractText(result: unknown): string | null {
  const content = (result as { content?: { type?: string; text?: string }[] })?.content;
  if (!Array.isArray(content)) return null;
  const text = content.filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string).join("\n");
  return text || null;
}

/**
 * Environment for the subprocess, minus our own credentials.
 *
 * `uvx` needs PATH and HOME to find Python and its cache, but the code indexer has no need
 * for our GitHub token. Not passing it is cheaper than trusting a third-party process not
 * to log it (SECURITY.md T4).
 */
function sanitizedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const blocked = /^(GITHUB_TOKEN|GITHUB_PERSONAL_ACCESS_TOKEN|GH_TOKEN|.*_API_KEY|.*_SECRET|.*_PASSWORD|AWS_.*)$/i;
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || blocked.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export { IntelligenceError };
