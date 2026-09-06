/**
 * GitHubProvider — the discovery boundary (spec §27).
 *
 * We call the GitHub REST API directly rather than proxying the installed GitHub MCP
 * (`Our MCP → GitHub MCP → GitHub API`). That removes a protocol hop, a subprocess, a
 * failure point and context pollution, and — decisively — gives us the real
 * `x-ratelimit-*` response headers that the quota budgeter needs to reconcile against.
 * The installed GitHub MCP is also `--toolsets repos`, which does not expose code search.
 *
 * But this is an interface, not a hard-coded client: an `McpGitHubProvider` adapter can be
 * dropped in for enterprise setups where only an MCP endpoint is reachable, and a
 * `GitLabProvider` can implement the same shape (spec §33), without orchestration knowing.
 */

import type { Dependency, RepoMetadata, RepoRef } from "../../types/index.js";

export interface RepoSearchOptions {
  language?: string;
  /** Minimum stars. Used sparingly — popularity is a weak signal (spec §7). */
  minStars?: number;
  /** Repositories pushed since this ISO date. Filters abandoned projects cheaply. */
  pushedAfter?: string;
  topic?: string;
  /** GitHub's own sort. We re-rank anyway, so this only shapes the candidate pool. */
  sort?: "stars" | "forks" | "updated" | "best-match";
  perPage?: number;
  page?: number;
  /** Exclude forks. Default true — forks are usually near-duplicates (spec §19). */
  excludeForks?: boolean;
  /** Exclude archived repositories. Default true. */
  excludeArchived?: boolean;
}

export interface CodeSearchOptions {
  language?: string;
  /** Restrict to one repository — the high-value use, for verifying a capability. */
  repo?: string;
  path?: string;
  filename?: string;
  extension?: string;
  perPage?: number;
}

export interface CodeSearchHit {
  repository: string;
  path: string;
  /** Text fragments GitHub matched. Untrusted; sanitised before use. */
  fragments: string[];
  sha?: string;
  url?: string;
}

export interface RepoTreeEntry {
  path: string;
  type: "blob" | "tree";
  size?: number;
  sha: string;
}

export interface FileContent {
  path: string;
  /** Decoded text. Binary files are refused rather than returned as mojibake. */
  content: string;
  sha: string;
  size: number;
  truncated: boolean;
}

export interface CommitActivity {
  /** Commits in the trailing 90 days, when computable. */
  commitsLast90Days?: number;
  lastCommitAt?: string;
  /** Distinct authors seen in the sampled window. */
  recentAuthors?: number;
}

export interface ReleaseInfo {
  count: number;
  latestTag?: string;
  latestAt?: string;
  /**
   * Where the count came from. Many mature projects tag without publishing GitHub
   * Releases (square/okhttp has 0 Releases and hundreds of tags), so conflating the two
   * would misreport maturity. Surfaced rather than hidden.
   */
  source?: "releases" | "tags" | "none";
}

export interface LicenseRaw {
  spdx?: string;
  name?: string;
  /** Path of the licence file, when identified. */
  path?: string;
  /** Raw licence text, when fetched. Only read from the licence FILE, never prose claims. */
  text?: string;
}

/**
 * Repository discovery and metadata retrieval.
 *
 * Every method is expected to:
 *   - acquire quota before its request,
 *   - cache its result under the appropriate namespace,
 *   - sanitise every string it returns,
 *   - throw `IntelligenceError` (never a raw fetch error) so stage boundaries can degrade.
 */
export interface GitHubProvider {
  readonly id: string;

  searchRepositories(query: string, opts?: RepoSearchOptions): Promise<RepoMetadata[]>;
  searchCode(query: string, opts?: CodeSearchOptions): Promise<CodeSearchHit[]>;

  getRepository(fullName: string): Promise<RepoMetadata>;
  /** Resolve a ref (or the default branch) to a commit SHA — the cache-identity anchor. */
  resolveCommit(fullName: string, ref?: string): Promise<string>;

  getTree(fullName: string, ref?: string): Promise<RepoTreeEntry[]>;
  getFile(fullName: string, path: string, ref?: string): Promise<FileContent | null>;
  /** Best-effort README in any of its conventional names/locations. */
  getReadme(fullName: string, ref?: string): Promise<FileContent | null>;

  getLicense(fullName: string): Promise<LicenseRaw | null>;
  getLanguages(fullName: string): Promise<Record<string, number>>;
  getCommitActivity(fullName: string): Promise<CommitActivity>;
  getReleases(fullName: string): Promise<ReleaseInfo>;
  getContributorCount(fullName: string): Promise<number | undefined>;

  /** Manifests found in the tree, parsed into dependencies. Empty when none are readable. */
  getManifestDependencies(fullName: string, ref?: string): Promise<{ deps: Dependency[]; manifests: string[] }>;

  /** Quota state, for diagnostics. */
  quotaSnapshot(): Record<string, unknown>;
}

/** Convenience: build a RepoRef from a full name. */
export function refFromFullName(fullName: string, extra?: Partial<RepoRef>): RepoRef {
  const [owner = "", name = ""] = fullName.split("/");
  return {
    provider: "github",
    owner,
    name,
    fullName,
    url: `https://github.com/${fullName}`,
    ...extra,
  };
}
