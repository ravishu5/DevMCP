/**
 * Repository quality analysis (spec §7).
 *
 * "Do not assume popularity equals quality." So this reads *structure*: does the project
 * have tests, CI, documentation, releases, a changelog? Those indicate someone maintains
 * this as a product rather than as a snapshot of an experiment — which is what actually
 * predicts whether reusing it will go well.
 *
 * Everything here is derived from the file tree plus cheap metadata calls, so it can be
 * run on many candidates before committing scarce budget to deep analysis.
 */

import type { QualitySignal, RepoMetadata, RepoQuality } from "../types/index.js";
import type { CommitActivity, ReleaseInfo, RepoTreeEntry } from "../providers/github/types.js";

export interface QualityInput {
  metadata: RepoMetadata;
  tree?: RepoTreeEntry[];
  activity?: CommitActivity;
  releases?: ReleaseInfo;
  contributorCount?: number;
  readme?: string;
}

/** Path patterns that identify a test file across ecosystems. */
const TEST_PATTERNS = [
  /(^|\/)(test|tests|spec|specs|__tests__|testing)\//i,
  /(^|\/)src\/test\//i,
  /(^|\/)androidTest\//i,
  /\.(test|spec)\.[jt]sx?$/i,
  /_test\.(go|py|rb)$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /Test[s]?\.(java|kt|swift|cs)$/i,
  /Spec\.(scala|kt)$/i,
];

/** CI configuration, mapped to the system it implies. */
const CI_PATTERNS: [RegExp, string][] = [
  [/^\.github\/workflows\/.+\.ya?ml$/i, "github-actions"],
  [/^\.gitlab-ci\.ya?ml$/i, "gitlab-ci"],
  [/^\.circleci\/config\.ya?ml$/i, "circleci"],
  [/^\.travis\.ya?ml$/i, "travis"],
  [/^azure-pipelines\.ya?ml$/i, "azure-pipelines"],
  [/^Jenkinsfile$/i, "jenkins"],
  [/^\.drone\.ya?ml$/i, "drone"],
  [/^appveyor\.ya?ml$/i, "appveyor"],
];

export function analyzeQuality(input: QualityInput): RepoQuality {
  const tree = input.tree ?? [];
  const files = tree.filter((e) => e.type === "blob").map((e) => e.path);
  const signals: QualitySignal[] = [];

  // --- tests ---------------------------------------------------------------
  const testFiles = files.filter((p) => TEST_PATTERNS.some((re) => re.test(p)));
  const hasTests = testFiles.length > 0;
  if (hasTests) signals.push({ kind: "positive", label: "Has tests", detail: `${testFiles.length} test file(s)` });
  else if (tree.length) signals.push({ kind: "negative", label: "No tests found" });

  // --- CI ------------------------------------------------------------------
  const ciSystems = [...new Set(
    files.flatMap((p) => CI_PATTERNS.filter(([re]) => re.test(p)).map(([, name]) => name)),
  )];
  if (ciSystems.length) signals.push({ kind: "positive", label: "CI configured", detail: ciSystems.join(", ") });

  // --- documentation -------------------------------------------------------
  const hasReadme = files.some((p) => /^readme(\.\w+)?$/i.test(p)) || Boolean(input.readme);
  const hasDocs = files.some((p) => /^(docs?|documentation|website)\//i.test(p));
  const hasChangelog = files.some((p) => /^changelog(\.\w+)?$/i.test(p) || /^CHANGES(\.\w+)?$/i.test(p));
  const hasContributing = files.some((p) => /^contributing(\.\w+)?$/i.test(p));
  const readmeQuality = scoreReadme(input.readme);

  if (hasDocs) signals.push({ kind: "positive", label: "Has documentation directory" });
  if (hasChangelog) signals.push({ kind: "positive", label: "Maintains a changelog" });
  if (!hasReadme && tree.length) signals.push({ kind: "negative", label: "No README" });

  // --- maintenance ---------------------------------------------------------
  const lastActivity = input.activity?.lastCommitAt ?? input.metadata.pushedAt;
  const daysSinceLastPush = lastActivity
    ? Math.round((Date.now() - Date.parse(lastActivity)) / 86_400_000)
    : undefined;

  if (input.metadata.archived) {
    signals.push({ kind: "negative", label: "Archived", detail: "will not receive fixes" });
  } else if (daysSinceLastPush !== undefined) {
    if (daysSinceLastPush <= 90) signals.push({ kind: "positive", label: "Actively maintained", detail: `last activity ${daysSinceLastPush}d ago` });
    else if (daysSinceLastPush > 730) signals.push({ kind: "negative", label: "Appears abandoned", detail: `no activity for ${daysSinceLastPush}d` });
  }

  const releaseCount = input.releases?.count ?? 0;
  if (releaseCount > 0) {
    signals.push({
      kind: "positive",
      label: "Publishes releases",
      // Distinguishing tags from GitHub Releases matters: many mature projects tag only,
      // and reporting "0 releases" for them would be misleading.
      detail: `${releaseCount}${input.releases?.source === "tags" ? " tag(s)" : " release(s)"}`,
    });
  }

  // --- open issues ratio ---------------------------------------------------
  // Interpreted only for repositories with enough signal; a small project with 3 open
  // issues tells us nothing, and treating it as a warning would be noise.
  if (input.metadata.stars > 500 && input.metadata.openIssues > 0) {
    const ratio = input.metadata.openIssues / Math.max(1, input.metadata.stars);
    if (ratio > 0.08) {
      signals.push({ kind: "negative", label: "High open-issue ratio", detail: `${input.metadata.openIssues} open issues` });
    }
  }

  const quality: RepoQuality = {
    score: 0,
    hasTests, testFileCount: testFiles.length,
    hasCi: ciSystems.length > 0, ciSystems,
    hasReadme, readmeQuality, hasDocs, hasChangelog, hasContributing,
    releaseCount,
    latestReleaseAt: input.releases?.latestAt,
    contributorCount: input.contributorCount,
    commitsLast90Days: input.activity?.commitsLast90Days,
    lastCommitAt: lastActivity,
    daysSinceLastPush,
    signals,
  };
  quality.score = compositeScore(quality, input.metadata);
  return quality;
}

/**
 * README quality, 0–1.
 *
 * Proxies for "someone wrote this for other people to use": length, code examples,
 * installation instructions, structure. Crude, but it separates a real README from a
 * one-line placeholder, which is the distinction that matters.
 */
function scoreReadme(readme?: string): number {
  if (!readme) return 0;
  const text = readme.slice(0, 40_000);
  let score = 0;
  if (text.length > 400) score += 0.2;
  if (text.length > 2000) score += 0.15;
  if (/```/.test(text)) score += 0.25;                                    // code examples
  if (/#{1,3}\s*(install|installation|getting started|setup|quick ?start)/i.test(text)) score += 0.2;
  if (/#{1,3}\s*(usage|example|api|documentation)/i.test(text)) score += 0.15;
  if ((text.match(/^#{1,6}\s/gm) ?? []).length >= 3) score += 0.05;       // structured
  return Math.min(1, Math.round(score * 100) / 100);
}

/**
 * Composite 0–100 quality score.
 *
 * Popularity contributes at most 10 points, and only log-scaled. This is where spec §7 is
 * enforced numerically rather than merely asserted in a comment.
 */
function compositeScore(q: RepoQuality, md: RepoMetadata): number {
  let score = 0;
  score += q.hasTests ? Math.min(25, 10 + q.testFileCount) : 0;
  score += q.hasCi ? 15 : 0;
  score += q.readmeQuality * 15;
  score += q.hasDocs ? 8 : 0;
  score += q.hasChangelog ? 5 : 0;
  score += q.hasContributing ? 2 : 0;
  score += Math.min(10, q.releaseCount);
  score += Math.min(10, Math.log10(md.stars + 1) * 2.5);

  const days = q.daysSinceLastPush;
  if (md.archived) score -= 25;
  else if (days !== undefined) {
    if (days <= 90) score += 10;
    else if (days <= 365) score += 5;
    else if (days > 730) score -= 10;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}
