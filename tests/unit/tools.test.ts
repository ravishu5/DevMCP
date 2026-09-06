import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeTargetProject } from "../../src/analyzers/target-project.js";
import { compareImplementations, renderComparison } from "../../src/analyzers/compare.js";
import { synthesise, summariseLicenses } from "../../src/analyzers/synthesis.js";
import { verifyImplementation } from "../../src/analyzers/verify.js";
import { parseRejection, violatesConstraint, describeConstraint } from "../../src/analyzers/alternative.js";
import { analyzeLicense } from "../../src/analyzers/license.js";
import { assessReuse } from "../../src/analyzers/reuse.js";
import { assessCompleteness } from "../../src/analyzers/completeness.js";
import { assessIntegrationSurface } from "../../src/analyzers/integration.js";
import { collectEvidence } from "../../src/ranking/evidence.js";
import { rankCandidate } from "../../src/ranking/engine.js";
import { DEFAULT_WEIGHTS } from "../../src/core/config.js";
import { refFromFullName } from "../../src/providers/github/types.js";
import { TOOLS } from "../../src/mcp/server.js";
import type { Candidate, Dependency, RepoMetadata, TargetProjectProfile } from "../../src/types/index.js";
import type { ImplementationBundle } from "../../src/types/bundle.js";

const dep = (name: string, version?: string, scope: Dependency["scope"] = "runtime"): Dependency =>
  ({ name, version, ecosystem: "gradle", scope, declaredIn: "build.gradle" });

const md = (over: Partial<RepoMetadata> & { fullName: string }): RepoMetadata => ({
  ref: refFromFullName(over.fullName, { commit: "abc1234" }),
  topics: [], stars: 1000, forks: 50, watchers: 20, openIssues: 5,
  isFork: false, archived: false, language: "Kotlin",
  pushedAt: new Date(Date.now() - 20 * 86_400_000).toISOString(),
  ...over,
});

function candidate(fullName: string, opts: {
  spdx?: string | null; deps?: Dependency[]; archived?: boolean; language?: string;
  stars?: number; days?: number; symbols?: string[]; pattern?: string;
} = {}): Candidate {
  const metadata = md({
    fullName, archived: opts.archived ?? false, language: opts.language ?? "Kotlin",
    stars: opts.stars ?? 1000,
    pushedAt: new Date(Date.now() - (opts.days ?? 20) * 86_400_000).toISOString(),
  });
  const license = analyzeLicense({
    raw: opts.spdx === null ? null : { spdx: opts.spdx ?? "MIT" },
    repository: fullName,
  });
  const deps = opts.deps ?? [dep("com.squareup.okhttp3:okhttp", "4.12.0")];
  const symbols = (opts.symbols ?? ["DownloadManager"]).map((n) => ({
    id: `src/${n}.kt::${n}#class`, name: n, kind: "class" as const, filePath: `src/${n}.kt`,
  }));
  const completeness = assessCompleteness({ checklist: ["download", "resume", "retry"], symbols });
  const integrationSurface = assessIntegrationSurface({ symbols, dependencies: deps });
  const reuse = assessReuse({ license, metadata, stackMatch: 1, architectureMatch: 0.8 });
  const evidence = collectEvidence({
    metadata, target: { language: "Kotlin" }, license, completeness, integrationSurface,
    quality: {
      score: 0, hasTests: true, testFileCount: 10, hasCi: true, ciSystems: ["gh"],
      hasReadme: true, readmeQuality: 0.8, hasDocs: true, hasChangelog: false,
      hasContributing: false, releaseCount: 5, daysSinceLastPush: opts.days ?? 20, signals: [],
    },
    sources: ["github:metadata", "repo-structure"],
  });
  return {
    ref: metadata.ref, metadata, discoveredVia: ["test"], license, completeness,
    integrationSurface, reuse, evidence, symbols,
    minimalSet: {
      core: symbols, supporting: [], excluded: [], seeds: [], connected: true,
      estimatedTokens: 50, estimatedFullTokens: 100,
      parameters: { relevanceFloor: 0.25, maxDepth: 2, tokenBudget: 1200 },
    },
    dependencies: {
      direct: deps, transitiveSample: [], manifests: ["build.gradle"], ecosystems: ["gradle"],
      requiredConfiguration: [], platformRequirements: [], incompatibilities: [],
      versionAssumptions: [], simplicity: 0.8, notes: [],
    },
    architecture: opts.pattern
      ? { pattern: opts.pattern, components: ["A", "B"], entryPoints: [], modules: [], notes: [], confidence: 0.7 }
      : undefined,
    quality: {
      score: 0, hasTests: true, testFileCount: 10, hasCi: true, ciSystems: ["gh"],
      hasReadme: true, readmeQuality: 0.8, hasDocs: true, hasChangelog: false,
      hasContributing: false, releaseCount: 5, daysSinceLastPush: opts.days ?? 20, signals: [],
    },
    score: rankCandidate(evidence, { weights: DEFAULT_WEIGHTS, reuse }),
  };
}

// ---------------------------------------------------------------------------

describe("target project analysis (spec §15)", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "iimcp-target-"));
    await mkdir(join(root, "src/domain"), { recursive: true });
    await mkdir(join(root, "src/data"), { recursive: true });
    await mkdir(join(root, "src/presentation"), { recursive: true });
    await mkdir(join(root, "src/test"), { recursive: true });
    await mkdir(join(root, "node_modules/junk"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({
      dependencies: { next: "14.0.0", react: "18.2.0", "@prisma/client": "5.0.0", zustand: "4.0.0", axios: "1.6.0" },
      devDependencies: { vitest: "2.0.0", "@testing-library/react": "14.0.0" },
    }));
    await writeFile(join(root, "src/domain/UseCase.ts"), "export class UseCase {}");
    await writeFile(join(root, "src/data/UserRepository.ts"), "export class UserRepository {}");
    await writeFile(join(root, "src/presentation/Screen.tsx"), "export const Screen = () => null;");
    await writeFile(join(root, "src/test/app.test.ts"), "test('x', () => {});");
    await writeFile(join(root, "node_modules/junk/index.js"), "module.exports={}");
    await writeFile(join(root, ".env"), "DATABASE_PASSWORD=supersecretvalue123");
    await writeFile(join(root, "LICENSE"), "MIT License\n\nPermission is hereby granted, free of charge…");
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it("detects language, frameworks and dependency manager", async () => {
    const p = await analyzeTargetProject({ root });
    expect(p.language).toBe("TypeScript");
    expect(p.frameworks).toEqual(expect.arrayContaining(["Next.js", "React"]));
    expect(p.dependencyManagers).toContain("npm");
  });

  it("identifies the existing layers an integration must plug into", async () => {
    const p = await analyzeTargetProject({ root });
    expect(p.database).toBe("Prisma");
    expect(p.stateManagement).toBe("Zustand");
    expect(p.networkingLayer).toBe("axios");
    expect(p.testingFrameworks).toEqual(expect.arrayContaining(["Vitest", "Testing Library"]));
  });

  it("infers architecture from directory layout", async () => {
    const p = await analyzeTargetProject({ root });
    expect(p.architecture).toContain("clean architecture");
    expect(p.directoryStructure.find((d) => d.path === "src/data")?.role).toBe("data access");
  });

  it("never reads or lists .env — even in the user's own project", async () => {
    const p = await analyzeTargetProject({ root });
    const serialised = JSON.stringify(p);
    expect(serialised).not.toContain("supersecretvalue123");
    expect(serialised).not.toContain(".env");
  });

  it("skips node_modules", async () => {
    const p = await analyzeTargetProject({ root });
    expect(JSON.stringify(p.directoryStructure)).not.toContain("node_modules");
  });

  it("detects the project licence, for compatibility checks", async () => {
    expect((await analyzeTargetProject({ root })).projectLicense).toBe("MIT");
  });

  it("reports gaps rather than silently guessing", async () => {
    const empty = await mkdtemp(join(tmpdir(), "iimcp-empty-"));
    const p = await analyzeTargetProject({ root: empty });
    expect(p.gaps.length).toBeGreaterThan(0);
    await rm(empty, { recursive: true, force: true });
  });

  it("returns an unavailable profile for an unreadable path instead of throwing", async () => {
    const p = await analyzeTargetProject({ root: "/definitely/not/a/real/path/xyz" });
    expect(p.analysisMode).toBe("unavailable");
    expect(p.gaps[0]).toMatch(/could not read/i);
  });

  it("does not follow a symlink out of the project root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "iimcp-outside-"));
    await writeFile(join(outside, "secret-outside.ts"), "export const x = 1;");
    const linked = await mkdtemp(join(tmpdir(), "iimcp-linked-"));
    await writeFile(join(linked, "package.json"), "{}");
    await symlink(outside, join(linked, "escape"));
    const p = await analyzeTargetProject({ root: linked });
    expect(JSON.stringify(p)).not.toContain("secret-outside");
    await rm(outside, { recursive: true, force: true });
    await rm(linked, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------

describe("implementation comparison", () => {
  it("reports only axes on which candidates genuinely differ", () => {
    const r = compareImplementations({
      feature: "downloader",
      candidates: [
        candidate("a/fresh", { days: 5 }),
        candidate("b/stale", { days: 900 }),
      ],
    });
    expect(r.differentiators.some((d) => d.axis === "maintenance")).toBe(true);
    // Both are MIT, so licence must be reported as tied, not as a differentiator.
    expect(r.differentiators.some((d) => d.axis === "licenseCompatibility")).toBe(false);
    expect(r.tied).toContain("licence");
  });

  it("surfaces blockers ahead of any score", () => {
    const r = compareImplementations({
      feature: "downloader",
      candidates: [candidate("a/unlicensed", { spdx: null, stars: 50_000 }), candidate("b/mit")],
    });
    expect(r.blockers.some((b) => b.repository === "a/unlicensed")).toBe(true);
    expect(renderComparison(r).indexOf("BLOCKERS")).toBeLessThan(renderComparison(r).indexOf("RECOMMENDED"));
  });

  it("never recommends a DO_NOT_USE candidate", () => {
    const banned = candidate("a/agpl", { spdx: "AGPL-3.0" });
    banned.reuse = assessReuse({
      license: analyzeLicense({ raw: { spdx: "AGPL-3.0" }, repository: "a/agpl", target: { distribution: "proprietary" } }),
      metadata: banned.metadata, stackMatch: 1, architectureMatch: 0.9, target: { distribution: "proprietary" },
    });
    const r = compareImplementations({ feature: "x", candidates: [banned, candidate("b/mit")] });
    expect(r.recommendation).toBe("b/mit");
  });

  it("states the condition under which a different candidate wins", () => {
    // Days must straddle a real maintenance boundary: 20d and 2d both score 1.0, so they
    // legitimately tie and there would be nothing to switch on.
    const r = compareImplementations({
      feature: "downloader",
      candidates: [candidate("a/complete", { days: 400, symbols: ["DownloadManager", "ResumeHandler", "RetryPolicy"] }),
                   candidate("b/fresh", { days: 2 })],
    });
    expect(r.switchIf.length).toBeGreaterThan(0);
    expect(r.switchIf[0]!.condition.length).toBeGreaterThan(10);
    expect(r.switchIf[0]!.instead).toBe("b/fresh");
  });

  it("reports an axis as tied when the difference is not decision-relevant", () => {
    // 20d and 2d since last push are both "actively maintained" — reporting that as a
    // differentiator would be noise dressed up as signal.
    const r = compareImplementations({
      feature: "downloader",
      candidates: [candidate("a/x", { days: 20 }), candidate("b/y", { days: 2 })],
    });
    expect(r.tied).toContain("maintenance");
  });

  it("handles an empty candidate list", () => {
    const r = compareImplementations({ feature: "x", candidates: [] });
    expect(r.recommendation).toBe("(none)");
    expect(r.reasoning[0]).toMatch(/no candidates/i);
  });
});

// ---------------------------------------------------------------------------

describe("cross-repository synthesis (spec §13)", () => {
  it("finds shared dependencies across selections", () => {
    const s = synthesise({
      selections: [
        { feature: "a", candidate: candidate("x/a", { deps: [dep("okhttp", "4.12.0"), dep("gson", "2.10")] }) },
        { feature: "b", candidate: candidate("x/b", { deps: [dep("okhttp", "4.12.0")] }) },
      ],
    });
    expect(s.overlappingDependencies.find((d) => d.name === "okhttp")?.usedBy).toHaveLength(2);
  });

  it("flags only MAJOR version conflicts, not minor drift", () => {
    const major = synthesise({
      selections: [
        { feature: "a", candidate: candidate("x/a", { deps: [dep("okhttp", "3.14.0")] }) },
        { feature: "b", candidate: candidate("x/b", { deps: [dep("okhttp", "4.12.0")] }) },
      ],
    });
    expect(major.versionConflicts.some((v) => v.name === "okhttp")).toBe(true);

    const minor = synthesise({
      selections: [
        { feature: "a", candidate: candidate("x/a", { deps: [dep("okhttp", "4.11.0")] }) },
        { feature: "b", candidate: candidate("x/b", { deps: [dep("okhttp", "4.12.0")] }) },
      ],
    });
    expect(minor.versionConflicts).toHaveLength(0);
  });

  it("detects two libraries providing the same concept", () => {
    const s = synthesise({
      selections: [
        { feature: "a", candidate: candidate("x/a", { deps: [dep("com.squareup.okhttp3:okhttp")] }) },
        { feature: "b", candidate: candidate("x/b", { deps: [dep("io.ktor:ktor-client-core")] }) },
      ],
    });
    const http = s.duplicateAbstractions.find((d) => d.concept === "HTTP client");
    expect(http).toBeDefined();
    expect(http!.recommendation).toMatch(/pick one/i);
  });

  it("does not report sibling artifacts of one library as duplicates", () => {
    // Regression: a live plan reported androidx.room:room-runtime + room-ktx + room-compiler
    // as a "DUPLICATE LOCAL DATABASE", and slf4j-api + slf4j-simple as duplicate logging.
    // Four of eight findings in that plan were false positives.
    const s = synthesise({
      selections: [
        { feature: "a", candidate: candidate("x/a", { deps: [dep("androidx.room:room-runtime"), dep("androidx.room:room-ktx")] }) },
        { feature: "b", candidate: candidate("x/b", { deps: [dep("androidx.room:room-compiler")] }) },
      ],
    });
    expect(s.duplicateAbstractions.find((d) => d.concept === "local database")).toBeUndefined();
  });

  it("does not report an api and its binding as duplicates", () => {
    const s = synthesise({
      selections: [
        { feature: "a", candidate: candidate("x/a", { deps: [dep("org.slf4j:slf4j-api")] }) },
        { feature: "b", candidate: candidate("x/b", { deps: [dep("org.slf4j:slf4j-simple")] }) },
      ],
    });
    expect(s.duplicateAbstractions.find((d) => d.concept === "logging")).toBeUndefined();
  });

  it("treats a version-catalog reference as the library it names", () => {
    // `libs.okhttp` and `com.squareup.okhttp3:okhttp` are the same dependency.
    const s = synthesise({
      selections: [
        { feature: "a", candidate: candidate("x/a", { deps: [dep("com.squareup.okhttp3:okhttp")] }) },
        { feature: "b", candidate: candidate("x/b", { deps: [dep("libs.okhttp")] }) },
      ],
    });
    expect(s.duplicateAbstractions.find((d) => d.concept === "HTTP client")).toBeUndefined();
  });

  it("does not flag test frameworks, which legitimately coexist", () => {
    // JUnit for unit tests + Espresso for instrumentation is normal, not a conflict.
    const s = synthesise({
      selections: [
        { feature: "a", candidate: candidate("x/a", { deps: [dep("junit:junit")] }) },
        { feature: "b", candidate: candidate("x/b", { deps: [dep("androidx.test.ext:junit")] }) },
      ],
    });
    expect(s.duplicateAbstractions.find((d) => d.concept === "testing framework")).toBeUndefined();
  });

  it("does not flag a logging facade and its binding", () => {
    // slf4j-api + logback-classic is the recommended JVM setup, not a conflict. Different
    // group ids and different artifact stems, so key intersection alone cannot see it.
    const s = synthesise({
      selections: [
        { feature: "a", candidate: candidate("x/a", { deps: [dep("org.slf4j:slf4j-api")] }) },
        { feature: "b", candidate: candidate("x/b", { deps: [dep("ch.qos.logback:logback-classic")] }) },
      ],
    });
    expect(s.duplicateAbstractions.find((d) => d.concept === "logging")).toBeUndefined();
  });

  it("still detects a GENUINE duplicate across different library families", () => {
    // The signal must survive the noise reduction.
    const s = synthesise({
      selections: [
        { feature: "a", candidate: candidate("x/a", { deps: [dep("com.squareup.okhttp3:okhttp")] }) },
        { feature: "b", candidate: candidate("x/b", { deps: [dep("io.ktor:ktor-client-core")] }) },
      ],
    });
    expect(s.duplicateAbstractions.find((d) => d.concept === "HTTP client")).toBeDefined();
  });

  it("detects incompatible concurrency models", () => {
    const s = synthesise({
      selections: [
        { feature: "a", candidate: candidate("x/rx", { deps: [dep("io.reactivex.rxjava2:rxjava")] }) },
        { feature: "b", candidate: candidate("x/co", { deps: [dep("org.jetbrains.kotlinx:kotlinx-coroutines-core")] }) },
      ],
    });
    expect(s.incompatibleArchitectures.some((a) => /concurrency models/i.test(a.issue))).toBe(true);
  });

  it("detects symbol name collisions", () => {
    const s = synthesise({
      selections: [
        { feature: "a", candidate: candidate("x/a", { symbols: ["DownloadManager"] }) },
        { feature: "b", candidate: candidate("x/b", { symbols: ["DownloadManager"] }) },
      ],
    });
    expect(s.namingConflicts.some((n) => n.symbol === "DownloadManager")).toBe(true);
  });

  it("warns that the strictest licence governs the combination", () => {
    const s = synthesise({
      selections: [
        { feature: "a", candidate: candidate("x/mit", { spdx: "MIT" }) },
        { feature: "b", candidate: candidate("x/gpl", { spdx: "GPL-3.0" }) },
      ],
    });
    const conflict = s.licenseConflicts.find((c) => c.severity === "high");
    expect(conflict?.issue).toMatch(/strictest licence governs/i);
    expect(conflict?.issue).toMatch(/do not dilute/i);
  });

  it("summarises to the strictest licence in the set", () => {
    const summary = summariseLicenses([
      { feature: "a", candidate: candidate("x/mit", { spdx: "MIT" }) },
      { feature: "b", candidate: candidate("x/apache", { spdx: "Apache-2.0" }) },
      { feature: "c", candidate: candidate("x/agpl", { spdx: "AGPL-3.0" }) },
    ]);
    expect(summary.strictest).toContain("AGPL-3.0");
    expect(summary.overallRisk).toBe("high");
    expect(summary.disclaimer).toMatch(/not legal advice/i);
  });

  it("lists a repository once even when it covers several features", () => {
    // One repository selected twice is one licence obligation, not two.
    const shared = candidate("x/multi", { spdx: "Apache-2.0" });
    const summary = summariseLicenses([
      { feature: "queue", candidate: shared },
      { feature: "background", candidate: shared },
      { feature: "storage", candidate: candidate("x/other", { spdx: "MIT" }) },
    ]);
    expect(summary.licenses).toHaveLength(2);
    expect(summary.licenses.filter((l) => l.repository === "x/multi")).toHaveLength(1);
  });

  it("always produces a unification strategy", () => {
    const s = synthesise({ selections: [{ feature: "a", candidate: candidate("x/a") }] });
    expect(s.unificationStrategy.length).toBeGreaterThan(1);
    expect(s.unificationStrategy[0]).toMatch(/interfaces FIRST/i);
  });

  it("handles zero selections", () => {
    const s = synthesise({ selections: [] });
    expect(s.overlappingDependencies).toEqual([]);
    expect(s.unificationStrategy).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("verification (spec §17)", () => {
  const profile: TargetProjectProfile = {
    root: "/proj", languages: { Kotlin: 50 }, frameworks: ["Android"],
    dependencyManagers: ["gradle"],
    existingLibraries: [dep("com.squareup.okhttp3:okhttp", "4.12.0")],
    directoryStructure: [{ path: "app/download", role: "background work" }],
    testingFrameworks: ["JUnit"], codingPatterns: [], analysisMode: "github-fallback", gaps: [],
  };

  const bundle = (over: Partial<ImplementationBundle> = {}): ImplementationBundle => ({
    schemaVersion: "1.0.0", feature: "resumable download",
    recommendation: { repository: "a/b", ref: refFromFullName("a/b"), score: 80, confidence: 0.8, why: [], concerns: [] },
    alternatives: [],
    reuse: { mode: "ADAPT", reason: "r", guidance: "g",
      factors: { licenseCategory: "permissive", stackMatch: 1, architectureMatch: 0.8, distribution: "unknown" },
      obligations: ["Preserve copyright notice"], confidence: 0.8 },
    architecture: { pattern: "queue + worker", components: ["DownloadQueue", "DownloadWorker"], entryPoints: [], modules: [], notes: [], confidence: 0.7 },
    minimalSet: {
      core: [{ id: "1", name: "ResumeHandler", kind: "class", filePath: "src/ResumeHandler.kt" }],
      supporting: [], excluded: [], seeds: [], connected: true,
      estimatedTokens: 40, estimatedFullTokens: 100,
      parameters: { relevanceFloor: 0.25, maxDepth: 2, tokenBudget: 1200 },
    },
    symbols: [], completeness: { items: [], satisfied: 0, total: 0, ratio: 0, undetermined: [] },
    integrationSurface: { symbolsRequired: 1, dependencyCount: 1, integrationPointCount: 1, configurationRequirements: 0, frameworkCoupling: 0, score: 0.9, difficulty: "low", drivers: [] },
    dependencies: { direct: [dep("com.squareup.okhttp3:okhttp", "4.12.0")], transitiveSample: [], manifests: [], ecosystems: [], requiredConfiguration: [], platformRequirements: [], incompatibilities: [], versionAssumptions: [], simplicity: 0.9, notes: [] },
    tests: { hasTests: true, frameworks: ["JUnit"], unitTests: [], integrationTests: [], fixtures: [], mocks: [], testUtilities: [], edgeCasesCovered: ["cancellation", "retry behaviour"], featureTestConfidence: 0.8, notes: [] },
    integrationPoints: [], adaptationNotes: [],
    license: { spdx: "Apache-2.0", name: "Apache License 2.0", category: "permissive", confidence: 1, compatible: true, obligations: ["Preserve copyright notice"], warnings: [], disclaimer: "d" },
    provenance: [], confidence: 0.8, integrationDifficulty: "low", unknowns: [], degradations: [], availableOnRequest: [],
    ...over,
  });

  it("never claims more than 80% confidence", () => {
    const perfect = verifyImplementation({
      bundle: bundle(), profile,
      targetFiles: ["app/download/DownloadQueue.kt", "app/download/DownloadWorker.kt",
                    "app/download/DownloadResumer.kt", "test/DownloadResumeTest.kt", "NOTICE"],
    });
    expect(perfect.confidence).toBeLessThanOrEqual(0.8);
    expect(perfect.disclaimer).toMatch(/does not compile, run or test/i);
  });

  it("passes a key symbol that was renamed during adaptation", () => {
    // ResumeHandler → DownloadResumer is a successful adaptation, not a failure.
    const r = verifyImplementation({
      bundle: bundle(), profile,
      targetFiles: ["app/download/DownloadResumer.kt"],
    });
    const check = r.checks.find((c) => c.name.includes("Key symbols"));
    expect(check?.status).toBe("pass");
  });

  it("catches a missing dependency — the most common real failure", () => {
    const r = verifyImplementation({
      bundle: bundle(), profile: { ...profile, existingLibraries: [] },
      targetFiles: ["app/download/DownloadQueue.kt"],
    });
    const check = r.checks.find((c) => c.name.includes("dependencies"));
    expect(check?.status).toBe("fail");
    expect(r.remainingRisks.join(" ")).toMatch(/fail at build time/i);
  });

  it("catches missing tests for the feature", () => {
    const r = verifyImplementation({
      bundle: bundle(), profile, targetFiles: ["app/download/DownloadQueue.kt"],
    });
    expect(r.checks.find((c) => c.name.includes("Tests"))?.status).toBe("fail");
    expect(r.remainingRisks.join(" ")).toMatch(/no tests/i);
  });

  it("catches an unmet licence obligation", () => {
    const r = verifyImplementation({
      bundle: bundle(), profile, targetFiles: ["app/download/DownloadQueue.kt"],
    });
    expect(r.checks.find((c) => c.name.includes("Licence"))?.status).toBe("fail");
    expect(r.remainingRisks.join(" ")).toMatch(/licence obligation/i);
  });

  it("always ends with the 'nothing was executed' risk", () => {
    const r = verifyImplementation({ bundle: bundle(), profile, targetFiles: [] });
    expect(r.remainingRisks[r.remainingRisks.length - 1]).toMatch(/compiled or executed/i);
  });
});

// ---------------------------------------------------------------------------

describe("rejection parsing (find_alternative)", () => {
  const cases: [string, string][] = [
    ["requires Room but this project uses SQLDelight", "dependency-incompatible"],
    ["the licence is AGPL and we ship a proprietary app", "license-incompatible"],
    ["it's GPL-3.0", "license-incompatible"],
    ["wrong language — it's Swift and we need Kotlin", "stack-mismatch"],
    ["too complex, 32 classes and 14 dependencies", "too-complex"],
    ["unmaintained, last commit 3 years ago", "unmaintained"],
    ["doesn't support pause and resume", "missing-capability"],
    ["gradle build error when we added it", "build-failure"],
  ];

  for (const [reason, kind] of cases) {
    it(`classifies "${reason.slice(0, 40)}…" as ${kind}`, () => {
      expect(parseRejection(reason).kind).toBe(kind);
    });
  }

  it("extracts the specific subject when it can", () => {
    expect(parseRejection("licence is AGPL-3.0 and we ship proprietary").subject).toMatch(/AGPL/i);
    expect(parseRejection("requires okhttp which conflicts with ours").subject).toMatch(/okhttp/i);
  });

  it("admits when it cannot classify, rather than guessing", () => {
    const c = parseRejection("it just felt wrong somehow");
    expect(c.kind).toBe("other");
    expect(c.derivedFrom).toMatch(/verbatim/);
    expect(describeConstraint(c)).toMatch(/unclassified/);
  });

  it("handles an empty reason", () => {
    expect(parseRejection("").kind).toBe("other");
  });

  it("rejects candidates that share the licence problem", () => {
    const c = parseRejection("licence is GPL and we ship proprietary");
    const gpl = candidate("x/gpl", { spdx: "GPL-3.0" });
    const mit = candidate("x/mit", { spdx: "MIT" });
    expect(violatesConstraint(gpl, c)).toMatch(/copyleft/i);
    expect(violatesConstraint(mit, c)).toBeNull();
  });

  it("rejects candidates that share the offending dependency", () => {
    const c = parseRejection("requires okhttp which conflicts with ours");
    const withDep = candidate("x/a", { deps: [dep("com.squareup.okhttp3:okhttp")] });
    const without = candidate("x/b", { deps: [dep("io.ktor:ktor-client-core")] });
    expect(violatesConstraint(withDep, c)).toMatch(/okhttp/);
    expect(violatesConstraint(without, c)).toBeNull();
  });

  it("rejects other stale candidates when the complaint was staleness", () => {
    const c = parseRejection("unmaintained, last commit 3 years ago");
    expect(violatesConstraint(candidate("x/stale", { days: 900 }), c)).toMatch(/stale/i);
    expect(violatesConstraint(candidate("x/fresh", { days: 10 }), c)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("MCP tool surface", () => {
  it("exposes exactly 8 tools", () => {
    expect(TOOLS).toHaveLength(8);
  });

  it("every tool has a description saying WHEN to use it", () => {
    for (const t of TOOLS) {
      expect(t.description!.length, t.name).toBeGreaterThan(120);
      // Every description must tell the model WHEN to reach for the tool, not only what
      // it does — tool selection is the failure mode that costs the most.
      expect(t.description!, t.name).toMatch(
        /\bUse (this|after|when|it)\b|\bStart here\b|\bYou tried\b|\bRun this (FIRST|when|after)\b|\bBEFORE\b/i,
      );
    }
  });

  it("every tool declares its required arguments", () => {
    for (const t of TOOLS) {
      expect(t.inputSchema.type).toBe("object");
      expect(Array.isArray(t.inputSchema.required), t.name).toBe(true);
      expect((t.inputSchema.required as string[]).length, t.name).toBeGreaterThan(0);
    }
  });

  it("documents why distribution matters wherever it is accepted", () => {
    const withDistribution = TOOLS.filter((t) =>
      (t.inputSchema.properties as Record<string, unknown> | undefined)?.distribution);
    expect(withDistribution.length).toBeGreaterThan(3);
    for (const t of withDistribution) {
      const prop = (t.inputSchema.properties as Record<string, { description?: string }>).distribution;
      expect(prop.description, t.name).toMatch(/licence|license/i);
    }
  });

  it("tells the calling agent to decompose the requirement itself", () => {
    // The tool description IS the mechanism: it is how the server asks the agent to do the
    // semantic work instead of relying on a keyword table that loses requirements silently.
    const plan = TOOLS.find((t) => t.name === "build_implementation_plan")!;
    expect(plan.description).toMatch(/DECOMPOSE THE REQUIREMENT YOURSELF/);
    expect((plan.inputSchema.properties as Record<string, unknown>).features).toBeDefined();
  });

  it("lets the agent supply search vocabulary on every discovery tool", () => {
    for (const name of ["discover_implementations", "get_implementation", "compare_implementations"]) {
      const t = TOOLS.find((x) => x.name === name)!;
      const props = t.inputSchema.properties as Record<string, { description?: string }>;
      expect(props.search_hints, name).toBeDefined();
      expect(props.capability, name).toBeDefined();
    }
  });

  it("does not expose internal analyzers as tools", () => {
    const names = TOOLS.map((t) => t.name);
    for (const internal of ["find_tests", "find_dependencies", "check_license", "decompose_application", "rank_candidates"]) {
      expect(names).not.toContain(internal);
    }
  });
});

// ---------------------------------------------------------------------------

describe("provider adaptation must not lose methods", () => {
  /**
   * The general form of the bug found by the Android downloader demo: adapting a class
   * instance with object spread drops every prototype method. This asserts the property at
   * the level it actually matters — any adapter must forward the whole surface.
   */
  class FakeProvider {
    readonly id = "fake";
    async searchRepositories() { return []; }
    async getTree() { return []; }
    async getLicense() { return null; }
    quotaSnapshot() { return {}; }
  }

  it("object spread loses prototype methods (the bug)", () => {
    const spread = { ...new FakeProvider() } as Record<string, unknown>;
    expect(typeof spread.getTree).not.toBe("function");
  });

  it("a Proxy adapter forwards them (the fix)", async () => {
    const real = new FakeProvider();
    const pinned = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "searchRepositories") return async () => ["pinned"];
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as unknown as FakeProvider;

    expect(typeof pinned.getTree).toBe("function");
    expect(await pinned.getTree()).toEqual([]);
    expect(await pinned.searchRepositories()).toEqual(["pinned"]);
    expect(pinned.quotaSnapshot()).toEqual({});
  });
});
