/**
 * RestGitHubProvider — the V1 implementation of `GitHubProvider`.
 *
 * Every method obeys the same four rules, which is why they can be read quickly:
 *   1. acquire quota before the request (the client does this, given a budget);
 *   2. cache under the namespace whose expiry semantics match the data;
 *   3. sanitise every string that leaves this file;
 *   4. throw `IntelligenceError` only — never a raw fetch error.
 *
 * The interesting design work here is *which* endpoint to call. GitHub offers several
 * routes to most facts at wildly different quota costs, and the cheap route is usually
 * good enough for a ranking signal.
 */

import type {
  Dependency, RepoMetadata,
} from "../../types/index.js";
import type {
  CodeSearchHit, CodeSearchOptions, CommitActivity, FileContent, GitHubProvider,
  LicenseRaw, ReleaseInfo, RepoSearchOptions, RepoTreeEntry,
} from "./types.js";
import { refFromFullName } from "./types.js";
import { GitHubClient } from "./client.js";
import { dedupeDependencies, findManifests, parseManifest } from "./manifests.js";
import type { CacheProvider } from "../../cache/provider.js";
import { getOrCompute } from "../../cache/provider.js";
import { key, repoKey, searchKey } from "../../cache/keys.js";
import type { QuotaBudget } from "../../cache/quota.js";
import type { Sanitizer } from "../../security/sanitize.js";
import type { Logger } from "../../core/logger.js";
import type { MetricsCollector } from "../../core/metrics.js";
import { IntelligenceError } from "../../core/errors.js";
import { isValidRepoFullName, isValidRef, isValidSha, safeRepoPath } from "../../security/paths.js";

export interface RestGitHubProviderOptions {
  client: GitHubClient;
  cache: CacheProvider;
  sanitizer: Sanitizer;
  logger: Logger;
  metrics?: MetricsCollector;
  budget?: QuotaBudget;
  searchTtlMs: number;
  metadataTtlMs: number;
}

/** Raw shapes we consume from the API. Narrowed defensively — upstream is not trusted. */
interface RawRepo {
  full_name?: string; owner?: { login?: string }; name?: string;
  description?: string | null; topics?: string[]; language?: string | null;
  stargazers_count?: number; forks_count?: number; watchers_count?: number;
  subscribers_count?: number; open_issues_count?: number;
  fork?: boolean; parent?: { full_name?: string }; archived?: boolean; disabled?: boolean;
  created_at?: string; updated_at?: string; pushed_at?: string; size?: number;
  license?: { spdx_id?: string | null; name?: string | null; key?: string } | null;
  homepage?: string | null; default_branch?: string;
}

export class RestGitHubProvider implements GitHubProvider {
  readonly id = "github-rest";

  constructor(private readonly o: RestGitHubProviderOptions) {}

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /**
   * Repository search.
   *
   * `excludeForks`/`excludeArchived` default to true and are pushed into the GitHub query
   * rather than filtered client-side: filtering afterwards wastes the 100-result page on
   * repositories we were always going to discard, and forks are the single largest source
   * of near-duplicates (spec §19).
   */
  async searchRepositories(query: string, opts: RepoSearchOptions = {}): Promise<RepoMetadata[]> {
    const q = this.buildRepoQuery(query, opts);
    const perPage = Math.min(opts.perPage ?? 30, 100);
    const cacheKey = searchKey("search", q, { perPage, sort: opts.sort ?? "best-match", page: opts.page ?? 1 });

    return getOrCompute(this.o.cache, cacheKey, "search", this.o.searchTtlMs, this.o.metrics, async () => {
      this.o.metrics?.add("githubSearchCalls");
      const res = await this.o.client.request<{ items?: RawRepo[]; total_count?: number }>(
        "/search/repositories",
        {
          quotaClass: "search",
          budget: this.o.budget,
          query: {
            q,
            per_page: perPage,
            page: opts.page ?? 1,
            ...(opts.sort && opts.sort !== "best-match" ? { sort: opts.sort, order: "desc" } : {}),
          },
        },
      );
      const items = res?.data.items ?? [];
      this.o.logger.debug("repo search", { q, results: items.length });
      return items.map((r) => this.toMetadata(r)).filter((r): r is RepoMetadata => r !== null);
    });
  }

  /**
   * Code search — the scarcest resource in the system (10/min).
   *
   * Reserved for high-signal questions: "does THIS repository actually contain a
   * resume/Range implementation?". Callers must pass `repo` for that use; an unscoped code
   * search burns the same quota for a far weaker signal.
   */
  async searchCode(query: string, opts: CodeSearchOptions = {}): Promise<CodeSearchHit[]> {
    const parts = [query];
    if (opts.repo) parts.push(`repo:${opts.repo}`);
    if (opts.language) parts.push(`language:${opts.language}`);
    if (opts.path) parts.push(`path:${opts.path}`);
    if (opts.filename) parts.push(`filename:${opts.filename}`);
    if (opts.extension) parts.push(`extension:${opts.extension}`);
    const q = parts.join(" ");
    const perPage = Math.min(opts.perPage ?? 20, 100);
    const cacheKey = searchKey("code-search", q, { perPage });

    return getOrCompute(this.o.cache, cacheKey, "code-search", this.o.searchTtlMs, this.o.metrics, async () => {
      this.o.metrics?.add("githubCodeSearchCalls");
      const res = await this.o.client.request<{
        items?: { repository?: { full_name?: string }; path?: string; sha?: string; html_url?: string;
                  text_matches?: { fragment?: string }[] }[];
      }>("/search/code", {
        quotaClass: "code-search",
        budget: this.o.budget,
        // text-match returns the matching fragment, which is what makes a hit *evidence*
        // rather than just a filename. Worth the larger response on a 10/min budget.
        accept: "application/vnd.github.text-match+json",
        query: { q, per_page: perPage },
      });
      return (res?.data.items ?? []).flatMap((i) => {
        const repository = i.repository?.full_name;
        const path = i.path ? safeRepoPath(i.path) : null;
        if (!repository || !path || !isValidRepoFullName(repository)) return [];
        return [{
          repository,
          path,
          sha: i.sha,
          url: i.html_url,
          // Fragments are attacker-controlled source excerpts — sanitise on the way in.
          fragments: (i.text_matches ?? [])
            .map((t) => this.o.sanitizer.sanitizeField(t.fragment ?? "", 200))
            .filter(Boolean),
        }];
      });
    });
  }

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  async getRepository(fullName: string): Promise<RepoMetadata> {
    this.assertRepo(fullName);
    return getOrCompute(this.o.cache, key("repo", fullName.toLowerCase()), "repo", this.o.metadataTtlMs, this.o.metrics, async () => {
      this.o.metrics?.add("githubApiCalls");
      const res = await this.o.client.request<RawRepo>(`/repos/${fullName}`, { budget: this.o.budget });
      const md = res ? this.toMetadata(res.data) : null;
      if (!md) throw new IntelligenceError("Repository metadata unusable", {
        kind: "upstream-malformed", stage: "github.getRepository", subject: fullName,
      });
      return md;
    });
  }

  /**
   * Resolve a ref to a commit SHA — the anchor for every immutable cache entry.
   *
   * Uses `/commits/{ref}` with a 1-item page rather than the tree or branch endpoints:
   * it works uniformly for a branch, tag or SHA, and costs one core call.
   */
  async resolveCommit(fullName: string, ref?: string): Promise<string> {
    this.assertRepo(fullName);
    if (ref && isValidSha(ref) && ref.length >= 40) return ref.toLowerCase();
    if (ref && !isValidRef(ref) && !isValidSha(ref)) {
      throw new IntelligenceError(`Invalid ref: ${ref}`, { kind: "unsupported", stage: "github.resolveCommit", subject: fullName });
    }
    const target = ref ?? "HEAD";
    return getOrCompute(this.o.cache, key("repo", `${fullName.toLowerCase()}#commit#${target}`), "repo", this.o.metadataTtlMs, this.o.metrics, async () => {
      this.o.metrics?.add("githubApiCalls");
      const res = await this.o.client.request<{ sha?: string }[]>(`/repos/${fullName}/commits`, {
        budget: this.o.budget,
        query: { per_page: 1, ...(ref ? { sha: ref } : {}) },
      });
      const sha = res?.data?.[0]?.sha;
      if (!sha || !isValidSha(sha)) {
        throw new IntelligenceError("Could not resolve a commit (empty repository?)", {
          kind: "not-found", stage: "github.resolveCommit", subject: fullName,
        });
      }
      return sha;
    });
  }

  async getLanguages(fullName: string): Promise<Record<string, number>> {
    this.assertRepo(fullName);
    return getOrCompute(this.o.cache, key("repo", `${fullName.toLowerCase()}#languages`), "repo", this.o.metadataTtlMs, this.o.metrics, async () => {
      this.o.metrics?.add("githubApiCalls");
      const res = await this.o.client.request<Record<string, number>>(`/repos/${fullName}/languages`, {
        budget: this.o.budget, allow404: true,
      });
      return res?.data ?? {};
    });
  }

  /**
   * Commit activity.
   *
   * Uses `/commits?per_page=100` (one core call) rather than `/stats/commit_activity`,
   * which returns a 202 and asks you to poll while GitHub computes it — unacceptable
   * inside a tool call. Sampling the last 100 commits gives a good-enough recency signal:
   * we only need to distinguish "actively maintained" from "abandoned".
   */
  async getCommitActivity(fullName: string): Promise<CommitActivity> {
    this.assertRepo(fullName);
    return getOrCompute(this.o.cache, key("repo", `${fullName.toLowerCase()}#activity`), "repo", this.o.metadataTtlMs, this.o.metrics, async () => {
      this.o.metrics?.add("githubApiCalls");
      const res = await this.o.client.request<{ commit?: { author?: { date?: string; name?: string } } }[]>(
        `/repos/${fullName}/commits`, { budget: this.o.budget, allow404: true, query: { per_page: 100 } },
      );
      const commits = res?.data ?? [];
      if (!commits.length) return {};
      const cutoff = Date.now() - 90 * 86_400_000;
      const dates = commits.map((c) => c.commit?.author?.date).filter((d): d is string => Boolean(d));
      const recent = dates.filter((d) => Date.parse(d) >= cutoff).length;
      const authors = new Set(commits.map((c) => c.commit?.author?.name).filter(Boolean));
      return {
        // Saturated: 100 is the page size, so ">= 100" is all we can honestly claim.
        commitsLast90Days: recent,
        lastCommitAt: dates[0],
        recentAuthors: authors.size,
      };
    });
  }

  /**
   * Release history — with a git-tag fallback.
   *
   * Many mature projects publish git TAGS but never create GitHub Release objects.
   * `square/okhttp` is the canonical example: 0 Releases, but hundreds of tags and a
   * decade of shipping. Scoring maturity off the Releases endpoint alone would rank one of
   * the most widely deployed Android libraries in existence as "never released", which is
   * exactly the kind of popularity-shaped mismeasurement spec §7 warns against.
   *
   * So: try Releases (richer — carries publish dates), and fall back to tags when it is
   * empty. `source` is reported, because "20 tags, no GitHub Releases" is itself a fact
   * worth surfacing rather than laundering into an undifferentiated number.
   */
  async getReleases(fullName: string): Promise<ReleaseInfo> {
    this.assertRepo(fullName);
    return getOrCompute(this.o.cache, key("repo", `${fullName.toLowerCase()}#releases`), "repo", this.o.metadataTtlMs, this.o.metrics, async () => {
      this.o.metrics?.add("githubApiCalls");
      const res = await this.o.client.request<{ tag_name?: string; published_at?: string; created_at?: string }[]>(
        `/repos/${fullName}/releases`, { budget: this.o.budget, allow404: true, query: { per_page: 30 } },
      );
      const rel = Array.isArray(res?.data) ? res.data : [];
      if (rel.length > 0) {
        return {
          count: rel.length,
          latestTag: rel[0]?.tag_name ? this.o.sanitizer.sanitizeField(rel[0].tag_name, 60) : undefined,
          latestAt: rel[0]?.published_at ?? rel[0]?.created_at,
          source: "releases" as const,
        };
      }

      this.o.metrics?.add("githubApiCalls");
      const tags = await this.o.client.request<{ name?: string; commit?: { sha?: string } }[]>(
        `/repos/${fullName}/tags`, { budget: this.o.budget, allow404: true, query: { per_page: 30 } },
      );
      const tagList = Array.isArray(tags?.data) ? tags.data : [];
      if (tagList.length === 0) return { count: 0, source: "none" as const };

      // The tags endpoint carries no dates, and resolving one costs another call. We spend
      // that single call only for the newest tag, because "when did this last ship?" is a
      // real maintenance signal while the other 29 dates are not.
      let latestAt: string | undefined;
      const headSha = tagList[0]?.commit?.sha;
      if (headSha) {
        try {
          this.o.metrics?.add("githubApiCalls");
          const c = await this.o.client.request<{ commit?: { committer?: { date?: string } } }>(
            `/repos/${fullName}/commits/${headSha}`, { budget: this.o.budget, allow404: true },
          );
          latestAt = c?.data.commit?.committer?.date;
        } catch {
          // A missing date only weakens one signal; it must not lose the tag count.
        }
      }
      return {
        // Saturated at the page size: ">= 30" is all we can honestly claim.
        count: tagList.length,
        latestTag: tagList[0]?.name ? this.o.sanitizer.sanitizeField(tagList[0].name, 60) : undefined,
        latestAt,
        source: "tags" as const,
      };
    });
  }

  /**
   * Contributor count.
   *
   * `per_page=1&anon=1` and read the count out of the Link header's `last` page — one
   * call instead of paging through thousands of contributors.
   */
  async getContributorCount(fullName: string): Promise<number | undefined> {
    this.assertRepo(fullName);
    return getOrCompute(this.o.cache, key("repo", `${fullName.toLowerCase()}#contributors`), "repo", this.o.metadataTtlMs, this.o.metrics, async () => {
      this.o.metrics?.add("githubApiCalls");
      const res = await this.o.client.request<unknown[]>(`/repos/${fullName}/contributors`, {
        budget: this.o.budget, allow404: true, query: { per_page: 1, anon: 1 },
      });
      if (!res) return undefined;
      const last = /[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(res.headers.get("link") ?? "")?.[1];
      return last ? Number(last) : (res.data?.length ?? 0);
    });
  }

  // -------------------------------------------------------------------------
  // Content
  // -------------------------------------------------------------------------

  async getTree(fullName: string, ref?: string): Promise<RepoTreeEntry[]> {
    this.assertRepo(fullName);
    const commit = await this.resolveCommit(fullName, ref);
    return getOrCompute(this.o.cache, repoKey("content", `${fullName}#tree`, commit), "content", null, this.o.metrics, async () => {
      this.o.metrics?.add("githubApiCalls");
      const res = await this.o.client.request<{ tree?: { path?: string; type?: string; size?: number; sha?: string }[]; truncated?: boolean }>(
        `/repos/${fullName}/git/trees/${commit}`, { budget: this.o.budget, allow404: true, query: { recursive: 1 } },
      );
      if (res?.data.truncated) {
        this.o.logger.debug("tree truncated by GitHub", { repo: fullName });
      }
      return (res?.data.tree ?? []).flatMap((e) => {
        const p = e.path ? safeRepoPath(e.path) : null;
        if (!p || !e.sha) return [];
        return [{ path: p, type: e.type === "tree" ? "tree" as const : "blob" as const, size: e.size, sha: e.sha }];
      });
    });
  }

  async getFile(fullName: string, path: string, ref?: string): Promise<FileContent | null> {
    this.assertRepo(fullName);
    const check = this.o.sanitizer.checkFilePath(path);
    if (!check.ok) {
      this.o.logger.debug("file refused", { repo: fullName, path, reason: check.reason });
      return null;
    }
    const commit = await this.resolveCommit(fullName, ref);
    return getOrCompute(this.o.cache, repoKey("content", `${fullName}#file#${check.path}`, commit), "content", null, this.o.metrics, async () => {
      this.o.metrics?.add("githubFilesExamined");
      const res = await this.o.client.request<{ content?: string; encoding?: string; size?: number; sha?: string; type?: string }>(
        `/repos/${fullName}/contents/${encodeURI(check.path)}`, { budget: this.o.budget, allow404: true, query: { ref: commit } },
      );
      const d = res?.data;
      if (!d || d.type !== "file" || !d.content) return null;
      if (d.encoding !== "base64") return null;

      const buf = Buffer.from(d.content, "base64");
      // Binary detection: a NUL byte in the first 8 KB. Returning binary as text produces
      // mojibake that wastes tokens and can smuggle control characters.
      if (buf.subarray(0, 8192).includes(0)) return null;

      return {
        path: check.path,
        content: buf.toString("utf8"),
        sha: d.sha ?? "",
        size: d.size ?? buf.length,
        truncated: false,
      };
    });
  }

  /** README under any conventional name. Tries the API endpoint first (it knows them all). */
  async getReadme(fullName: string, ref?: string): Promise<FileContent | null> {
    this.assertRepo(fullName);
    const commit = await this.resolveCommit(fullName, ref);
    return getOrCompute(this.o.cache, repoKey("content", `${fullName}#readme`, commit), "content", null, this.o.metrics, async () => {
      this.o.metrics?.add("githubFilesExamined");
      const res = await this.o.client.request<{ content?: string; encoding?: string; path?: string; size?: number; sha?: string }>(
        `/repos/${fullName}/readme`, { budget: this.o.budget, allow404: true, query: { ref: commit } },
      );
      const d = res?.data;
      if (!d?.content || d.encoding !== "base64") return null;
      return {
        path: d.path ?? "README.md",
        content: Buffer.from(d.content, "base64").toString("utf8"),
        sha: d.sha ?? "", size: d.size ?? 0, truncated: false,
      };
    });
  }

  /**
   * Licence.
   *
   * Read from the licence endpoint (which reports GitHub's own SPDX detection) and the
   * licence FILE. Never from prose claims in a README — those are attacker-controlled
   * (SECURITY.md T8).
   */
  async getLicense(fullName: string): Promise<LicenseRaw | null> {
    this.assertRepo(fullName);
    return getOrCompute(this.o.cache, key("license", fullName.toLowerCase()), "license", null, this.o.metrics, async () => {
      this.o.metrics?.add("githubApiCalls");
      const res = await this.o.client.request<{
        license?: { spdx_id?: string | null; name?: string | null };
        path?: string; content?: string; encoding?: string;
      }>(`/repos/${fullName}/license`, { budget: this.o.budget, allow404: true });
      const d = res?.data;
      if (!d) return null;
      const spdx = d.license?.spdx_id ?? undefined;
      return {
        spdx: spdx && spdx !== "NOASSERTION" ? spdx : undefined,
        name: d.license?.name ?? undefined,
        path: d.path,
        text: d.content && d.encoding === "base64"
          ? Buffer.from(d.content, "base64").toString("utf8").slice(0, 20_000)
          : undefined,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Dependencies
  // -------------------------------------------------------------------------

  async getManifestDependencies(fullName: string, ref?: string): Promise<{ deps: Dependency[]; manifests: string[] }> {
    this.assertRepo(fullName);
    const commit = await this.resolveCommit(fullName, ref);
    return getOrCompute(this.o.cache, repoKey("deps", fullName, commit), "deps", null, this.o.metrics, async () => {
      const tree = await this.getTree(fullName, commit);
      const specs = findManifests(tree.filter((e) => e.type === "blob").map((e) => e.path));
      const deps: Dependency[] = [];
      const manifests: string[] = [];

      for (const spec of specs) {
        // One bad manifest must not lose the others (spec §21).
        try {
          const file = await this.getFile(fullName, spec.path, commit);
          if (!file) continue;
          manifests.push(spec.path);
          deps.push(...parseManifest(spec, file.content));
        } catch (err) {
          this.o.logger.debug("manifest read failed", {
            repo: fullName, path: spec.path,
            error: this.o.sanitizer.scrubForLog(err instanceof Error ? err.message : String(err)),
          });
        }
      }
      return { deps: dedupeDependencies(deps), manifests };
    });
  }

  quotaSnapshot(): Record<string, unknown> {
    return { authenticated: this.o.client.authenticated, budget: this.o.budget?.spentSummary() };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private buildRepoQuery(query: string, opts: RepoSearchOptions): string {
    const parts = [query.trim()];
    if (opts.language) parts.push(`language:${quoteIfNeeded(opts.language)}`);
    if (opts.topic) parts.push(`topic:${opts.topic}`);
    if (opts.minStars !== undefined) parts.push(`stars:>=${opts.minStars}`);
    if (opts.pushedAfter) parts.push(`pushed:>=${opts.pushedAfter}`);
    // Pushed into the query, not filtered client-side: filtering afterwards would waste
    // the result page on repositories we always intended to discard.
    if (opts.excludeForks !== false) parts.push("fork:false");
    if (opts.excludeArchived !== false) parts.push("archived:false");
    return parts.filter(Boolean).join(" ");
  }

  /** Narrow an untrusted API object into our domain type, sanitising as we go. */
  private toMetadata(r: RawRepo): RepoMetadata | null {
    const fullName = r.full_name;
    if (!fullName || !isValidRepoFullName(fullName)) return null;
    return {
      ref: refFromFullName(fullName, { defaultBranch: r.default_branch }),
      description: this.o.sanitizer.sanitizeField(r.description, 400),
      topics: (r.topics ?? []).slice(0, 25).map((t) => this.o.sanitizer.sanitizeField(t, 50)).filter(Boolean),
      language: r.language ?? undefined,
      stars: num(r.stargazers_count),
      forks: num(r.forks_count),
      watchers: num(r.subscribers_count ?? r.watchers_count),
      openIssues: num(r.open_issues_count),
      isFork: Boolean(r.fork),
      parent: r.parent?.full_name,
      archived: Boolean(r.archived),
      disabled: Boolean(r.disabled),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      pushedAt: r.pushed_at,
      size: r.size,
      licenseSpdx: r.license?.spdx_id && r.license.spdx_id !== "NOASSERTION" ? r.license.spdx_id : undefined,
      homepage: this.o.sanitizer.sanitizeField(r.homepage, 200) || undefined,
    };
  }

  private assertRepo(fullName: string): void {
    if (!isValidRepoFullName(fullName)) {
      throw new IntelligenceError(`Invalid repository name: ${fullName}`, {
        kind: "unsupported", stage: "github", subject: fullName, retryable: false,
      });
    }
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** GitHub qualifiers need quoting when they contain spaces (e.g. `language:"Objective-C"`). */
function quoteIfNeeded(s: string): string {
  return /\s/.test(s) ? `"${s}"` : s;
}
