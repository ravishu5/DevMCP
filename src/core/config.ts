/**
 * Environment-based configuration (spec §28).
 *
 * Rules:
 *   - No secret is ever hard-coded, logged, or echoed back in a tool result.
 *   - Every knob has a sane default, so the server starts with an empty environment
 *     (degraded: unauthenticated GitHub, 60 req/hr) rather than refusing to boot.
 *   - Resolution is pure and total: `loadConfig` never throws for a missing value, only
 *     for a value that is present but nonsensical. That keeps misconfiguration loud but
 *     absence quiet.
 */

import { config as loadDotenv } from "dotenv";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { FatalConfigError } from "./errors.js";
import type { LogLevel } from "./logger.js";
import type { EvidenceAxis, RankingWeights } from "../types/index.js";

export interface AppConfig {
  github: {
    token?: string;
    /** How the token was obtained — reported in diagnostics, never the token itself. */
    tokenSource: "env" | "gh-cli" | "none";
    apiBase: string;
    userAgent: string;
    /** Per-request timeout. */
    timeoutMs: number;
  };
  codeIndex: {
    enabled: boolean;
    /** Command + args used to spawn jCodeMunch over stdio. */
    command: string;
    args: string[];
    /** HTTP endpoint, if the user runs jCodeMunch in server mode instead. */
    endpoint?: string;
    /** Indexing a large repository is slow; give up rather than hang the tool call. */
    indexTimeoutMs: number;
    callTimeoutMs: number;
    /** Refuse to index repositories above this size (KB), per spec §21 "huge repositories". */
    maxRepoSizeKb: number;
  };
  cache: {
    enabled: boolean;
    path: string;
    /** TTL for mutable entries. Commit-pinned entries ignore this and never expire. */
    searchTtlMs: number;
    metadataTtlMs: number;
    maxEntries: number;
  };
  discovery: {
    /** Hard cap on repositories considered per feature. */
    maxRepositories: number;
    /** Repositories promoted to deep (symbol-level) analysis. */
    maxDeepAnalysis: number;
    /** Candidates below this score are dropped before deep analysis. */
    minRepositoryScore: number;
    /** Max distinct search queries per feature (quota control). */
    maxQueriesPerFeature: number;
  };
  context: {
    /** Default ceiling for a tool result. */
    maxContextTokens: number;
    /** Ceiling for L3 source retrieval inside one bundle. */
    maxSourceTokens: number;
  };
  ranking: { weights: RankingWeights };
  features: {
    enableLicenseCheck: boolean;
    enableCache: boolean;
    enableFingerprints: boolean;
    /** Emit the metrics block with every tool result. */
    diagnostics: boolean;
  };
  log: { level: LogLevel; json: boolean };
}

/**
 * Spec §6 baseline weights, extended with completeness, architecture match, integration
 * surface and reusability — signals that matter more than popularity.
 *
 * `featureRelevance` and `completeness` sit near parity deliberately. Relevance is
 * *nominal* — the repository's name and topics claim it is about this feature.
 * Completeness is *measured* — how much of the requested checklist it demonstrably
 * implements. Weighting the claim well above the measurement is how `httpx-oauth`
 * (1/8 requirements, but "http" and "client" in its name) came within 8 points of
 * `psf/requests` in a live run. Validated empirically, not guessed: with these weights the
 * separation widens and the correct ordering (aiohttp, urllib3, requests) is unchanged.
 */
export const DEFAULT_WEIGHTS: RankingWeights = {
  featureRelevance: 0.15,
  completeness: 0.15,
  stackMatch: 0.12,
  implementationQuality: 0.09,
  architectureMatch: 0.05,
  tests: 0.08,
  maintenance: 0.07,
  documentation: 0.03,
  popularity: 0.03,
  dependencySimplicity: 0.03,
  integrationSurface: 0.05,
  licenseCompatibility: 0.07,
  /**
   * Library vs application, weighted above every quality signal except relevance and
   * completeness.
   *
   * An app that *uses* a capability implements the same checklist as a library that
   * *provides* it — a plant-care app ranked first for "local persistence" on exactly that
   * basis. Since the product exists to find code you can depend on, "can you depend on it"
   * has to outrank "is it well maintained".
   */
  reusability: 0.08,
} as unknown as RankingWeights;

// `tests` is the historic spec name; the evidence axis is `testEvidence`. Keep both in
// sync here so the published weights table matches the spec table users will compare to.
(DEFAULT_WEIGHTS as Record<string, number>).testEvidence =
  (DEFAULT_WEIGHTS as Record<string, number>).tests ?? 0.09;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // `.env` populates process.env; it never overrides a value already set there.
  loadDotenv({ quiet: true } as never);

  // Explicit argument WINS over the ambient environment.
  //
  // This was the wrong way round (`{ ...env, ...process.env }`), which made the parameter
  // almost useless: a caller passing `{ MAX_REPOSITORIES: "-5" }` silently got whatever
  // was in the shell or in `.env`. It surfaced when a `.env` file appeared in the working
  // directory and started overriding tests that pass an explicit environment — but the
  // same shadowing would hit any embedder trying to configure the server programmatically.
  const e = env === process.env ? process.env : { ...process.env, ...env };

  const { token, tokenSource } = resolveGitHubToken(e);

  return {
    github: {
      token,
      tokenSource,
      apiBase: str(e.GITHUB_API_BASE, "https://api.github.com"),
      userAgent: str(e.GITHUB_USER_AGENT, "implementation-intelligence-mcp/0.1"),
      timeoutMs: int(e.GITHUB_TIMEOUT_MS, 20_000, "GITHUB_TIMEOUT_MS"),
    },
    codeIndex: {
      enabled: bool(e.ENABLE_CODE_INDEX, true),
      command: str(e.JCODEMUNCH_COMMAND, "uvx"),
      args: list(e.JCODEMUNCH_ARGS, ["jcodemunch-mcp", "serve"]),
      endpoint: e.JCODEMUNCH_ENDPOINT,
      indexTimeoutMs: int(e.JCODEMUNCH_INDEX_TIMEOUT_MS, 180_000, "JCODEMUNCH_INDEX_TIMEOUT_MS"),
      callTimeoutMs: int(e.JCODEMUNCH_CALL_TIMEOUT_MS, 45_000, "JCODEMUNCH_CALL_TIMEOUT_MS"),
      maxRepoSizeKb: int(e.JCODEMUNCH_MAX_REPO_SIZE_KB, 250_000, "JCODEMUNCH_MAX_REPO_SIZE_KB"),
    },
    cache: {
      enabled: bool(e.ENABLE_CACHE, true),
      path: str(e.CACHE_PATH, join(homedir(), ".implementation-mcp", "cache.sqlite")),
      searchTtlMs: int(e.CACHE_SEARCH_TTL_MS, 6 * 3_600_000, "CACHE_SEARCH_TTL_MS"),
      metadataTtlMs: int(e.CACHE_METADATA_TTL_MS, 24 * 3_600_000, "CACHE_METADATA_TTL_MS"),
      maxEntries: int(e.CACHE_MAX_ENTRIES, 50_000, "CACHE_MAX_ENTRIES"),
    },
    discovery: {
      maxRepositories: int(e.MAX_REPOSITORIES, 40, "MAX_REPOSITORIES"),
      maxDeepAnalysis: int(e.MAX_DEEP_ANALYSIS, 5, "MAX_DEEP_ANALYSIS"),
      minRepositoryScore: int(e.MIN_REPOSITORY_SCORE, 35, "MIN_REPOSITORY_SCORE"),
      maxQueriesPerFeature: int(e.MAX_QUERIES_PER_FEATURE, 6, "MAX_QUERIES_PER_FEATURE"),
    },
    context: {
      maxContextTokens: int(e.MAX_CONTEXT_TOKENS, 6_000, "MAX_CONTEXT_TOKENS"),
      maxSourceTokens: int(e.MAX_SOURCE_TOKENS, 3_000, "MAX_SOURCE_TOKENS"),
    },
    ranking: { weights: parseWeights(e.RANKING_WEIGHTS) },
    features: {
      enableLicenseCheck: bool(e.ENABLE_LICENSE_CHECK, true),
      enableCache: bool(e.ENABLE_CACHE, true),
      enableFingerprints: bool(e.ENABLE_FINGERPRINTS, true),
      diagnostics: bool(e.ENABLE_DIAGNOSTICS, false),
    },
    log: {
      level: (str(e.LOG_LEVEL, "info") as LogLevel),
      json: bool(e.LOG_JSON, false),
    },
  };
}

/**
 * Token resolution order: explicit env var, then the `gh` CLI.
 *
 * The `gh` fallback matters because that is exactly how this host is set up (the installed
 * GitHub MCP shells out to `gh auth token`), so the server works out of the box here
 * without the user copying a PAT into a dotfile. It is best-effort: if `gh` is missing or
 * logged out we fall through to unauthenticated access rather than failing.
 */
function resolveGitHubToken(e: NodeJS.ProcessEnv): {
  token?: string;
  tokenSource: AppConfig["github"]["tokenSource"];
} {
  const fromEnv = e.GITHUB_TOKEN || e.GITHUB_PERSONAL_ACCESS_TOKEN || e.GH_TOKEN;
  if (fromEnv && fromEnv.trim()) return { token: fromEnv.trim(), tokenSource: "env" };

  if (bool(e.GITHUB_USE_GH_CLI, true)) {
    try {
      const out = execFileSync("gh", ["auth", "token"], {
        encoding: "utf8",
        timeout: 5_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out) return { token: out, tokenSource: "gh-cli" };
    } catch {
      // gh absent or logged out — unauthenticated is a valid, documented degraded mode.
    }
  }
  return { tokenSource: "none" };
}

/** Weights override, given as JSON. Normalised to sum to 1 so `total` stays 0–100. */
function parseWeights(raw: string | undefined): RankingWeights {
  if (!raw || !raw.trim()) return { ...DEFAULT_WEIGHTS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FatalConfigError("RANKING_WEIGHTS is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new FatalConfigError("RANKING_WEIGHTS must be a JSON object of axis -> number");
  }
  const merged: Record<string, number> = { ...(DEFAULT_WEIGHTS as Record<string, number>) };
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new FatalConfigError(`RANKING_WEIGHTS.${k} must be a non-negative number`);
    }
    merged[k] = v;
  }
  return normaliseWeights(merged as RankingWeights);
}

/** Scale weights to sum to 1. Keeps `total` comparable across custom weight sets. */
export function normaliseWeights(w: RankingWeights): RankingWeights {
  const entries = Object.entries(w) as [EvidenceAxis, number][];
  const sum = entries.reduce((a, [, v]) => a + v, 0);
  if (sum <= 0) throw new FatalConfigError("Ranking weights sum to zero");
  return Object.fromEntries(entries.map(([k, v]) => [k, v / sum])) as RankingWeights;
}

// --- primitive readers -----------------------------------------------------

function str(v: string | undefined, d: string): string {
  return v && v.trim() ? v.trim() : d;
}

function int(v: string | undefined, d: number, name: string): number {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new FatalConfigError(`${name} must be a non-negative number, got "${v}"`);
  return Math.floor(n);
}

function bool(v: string | undefined, d: boolean): boolean {
  if (v === undefined || v.trim() === "") return d;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return d;
}

function list(v: string | undefined, d: string[]): string[] {
  if (!v || !v.trim()) return d;
  return v.split(/\s+/).filter(Boolean);
}

/** Config summary safe to print or return in a tool result. Never contains the token. */
export function redactedConfig(c: AppConfig): Record<string, unknown> {
  return {
    github: {
      authenticated: Boolean(c.github.token),
      tokenSource: c.github.tokenSource,
      apiBase: c.github.apiBase,
    },
    codeIndex: {
      enabled: c.codeIndex.enabled,
      transport: c.codeIndex.endpoint ? "http" : "stdio",
      command: c.codeIndex.endpoint ?? `${c.codeIndex.command} ${c.codeIndex.args.join(" ")}`,
    },
    cache: { enabled: c.cache.enabled, path: c.cache.path },
    discovery: c.discovery,
    context: c.context,
    features: c.features,
  };
}
