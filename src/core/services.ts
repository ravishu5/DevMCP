/**
 * Service container.
 *
 * Constructed once and shared by BOTH the MCP server and the CLI. Spec §29 is explicit:
 * "The CLI should use the same internal services as the MCP. Do not implement separate
 * business logic for the CLI." Making the container the only way to obtain a provider is
 * how that is enforced structurally rather than by discipline.
 */

import { loadConfig, type AppConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { MetricsCollector } from "./metrics.js";
import { SqliteCache } from "../cache/sqlite.js";
import { NullCache, type CacheProvider } from "../cache/provider.js";
import { RateLimiter, type QuotaBudget } from "../cache/quota.js";
import { Sanitizer } from "../security/sanitize.js";
import { GitHubClient } from "../providers/github/client.js";
import { RestGitHubProvider } from "../providers/github/provider.js";
import type { GitHubProvider } from "../providers/github/types.js";
import { JCodeMunchProvider } from "../providers/codeindex/jcodemunch.js";
import { GitHubFallbackProvider } from "../providers/codeindex/fallback.js";
import type { CodeIndexProvider } from "../providers/codeindex/types.js";

export interface Services {
  config: AppConfig;
  logger: Logger;
  cache: CacheProvider;
  sanitizer: Sanitizer;
  limiter: RateLimiter;
  /** Build a GitHub provider bound to one call's metrics and quota slice. */
  githubFor(metrics: MetricsCollector, budget: QuotaBudget): GitHubProvider;
  /** Reserve a quota slice for one tool call. */
  budgetFor(kind: "discovery" | "analysis" | "light"): QuotaBudget;
  /**
   * Resolve the code-index provider, preferring jCodeMunch and falling back to GitHub
   * retrieval (spec §8). Returns which one was chosen, so callers can report the fallback
   * rather than silently presenting a weaker signal as a stronger one.
   */
  codeIndexFor(
    metrics: MetricsCollector, github: GitHubProvider,
  ): Promise<{ provider: CodeIndexProvider; degraded: boolean; reason?: string }>;
  close(): Promise<void> | void;
}

export interface CreateServicesOptions {
  config?: AppConfig;
  /** Override the cache — tests use `:memory:`. */
  cache?: CacheProvider;
  logger?: Logger;
}

export function createServices(opts: CreateServicesOptions = {}): Services {
  const config = opts.config ?? loadConfig();
  const logger = opts.logger ?? createLogger(config.log.level, config.log.json);

  const sanitizer = new Sanitizer();
  // Register our own token first, so it can never appear in a log line or tool result.
  sanitizer.registerSecret(config.github.token);

  const cache: CacheProvider = opts.cache ?? (config.cache.enabled
    ? new SqliteCache({ path: config.cache.path, maxEntries: config.cache.maxEntries })
    : new NullCache());

  const limiter = new RateLimiter(logger);

  // One jCodeMunch subprocess per process, not per call: connecting costs ~1s and the
  // index is shared state anyway. Created lazily, on first use.
  let jcodemunch: JCodeMunchProvider | undefined;

  return {
    config,
    logger,
    cache,
    sanitizer,
    limiter,

    githubFor(metrics: MetricsCollector, budget: QuotaBudget): GitHubProvider {
      const client = new GitHubClient({
        apiBase: config.github.apiBase,
        token: config.github.token,
        userAgent: config.github.userAgent,
        timeoutMs: config.github.timeoutMs,
        logger, limiter, sanitizer,
      });
      return new RestGitHubProvider({
        client, cache, sanitizer, logger, metrics, budget,
        searchTtlMs: config.cache.searchTtlMs,
        metadataTtlMs: config.cache.metadataTtlMs,
      });
    },

    /**
     * Quota slices, sized to the shape of each call.
     *
     * `discovery` fans out across queries but touches few repositories deeply; `analysis`
     * is the reverse — one repository, many core calls. Sizing them separately stops a
     * deep analysis from being throttled by a search budget it never needed.
     */
    budgetFor(kind): QuotaBudget {
      switch (kind) {
        case "discovery":
          return limiter.createBudget({
            search: config.discovery.maxQueriesPerFeature,
            core: 40 + config.discovery.maxDeepAnalysis * 12,
            "code-search": 2,
          });
        case "analysis":
          return limiter.createBudget({ search: 1, core: 60, "code-search": 3 });
        case "light":
        default:
          return limiter.createBudget({ search: 2, core: 12, "code-search": 0 });
      }
    },

    async codeIndexFor(metrics, github) {
      if (config.codeIndex.enabled) {
        jcodemunch ??= new JCodeMunchProvider({
          command: config.codeIndex.command,
          args: config.codeIndex.args,
          indexTimeoutMs: config.codeIndex.indexTimeoutMs,
          callTimeoutMs: config.codeIndex.callTimeoutMs,
          maxRepoSizeKb: config.codeIndex.maxRepoSizeKb,
          logger, cache, metrics,
        });
        if (await jcodemunch.isAvailable()) {
          return { provider: jcodemunch, degraded: false };
        }
      }
      return {
        provider: new GitHubFallbackProvider({ github, logger, metrics }),
        degraded: true,
        reason: config.codeIndex.enabled
          ? "code index unavailable; using GitHub file retrieval (no call graph or cross-file references)"
          : "code index disabled by configuration; using GitHub file retrieval",
      };
    },

    async close(): Promise<void> {
      await jcodemunch?.close();
      cache.close();
    },
  };
}
