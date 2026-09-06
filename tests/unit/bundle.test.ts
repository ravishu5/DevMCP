import { describe, it, expect } from "vitest";
import { analyzeTests } from "../../src/analyzers/tests.js";
import { inferArchitecture, planAdaptation } from "../../src/analyzers/architecture.js";
import { buildBundle } from "../../src/context/builder.js";
import { analyzeLicense } from "../../src/analyzers/license.js";
import { assessReuse } from "../../src/analyzers/reuse.js";
import { assessCompleteness } from "../../src/analyzers/completeness.js";
import { assessIntegrationSurface } from "../../src/analyzers/integration.js";
import { collectEvidence } from "../../src/ranking/evidence.js";
import { rankCandidate } from "../../src/ranking/engine.js";
import { DEFAULT_WEIGHTS } from "../../src/core/config.js";
import { refFromFullName } from "../../src/providers/github/types.js";
import type {
  Candidate, CodeSymbol, Dependency, ImplementationTask, RepoMetadata, TargetProjectProfile,
} from "../../src/types/index.js";

const md = (over: Partial<RepoMetadata> & { fullName: string }): RepoMetadata => ({
  ref: refFromFullName(over.fullName, { commit: "abc1234def5678" }),
  topics: ["downloader", "android"], stars: 3000, forks: 200, watchers: 90, openIssues: 12,
  isFork: false, archived: false, language: "Kotlin",
  pushedAt: new Date(Date.now() - 15 * 86_400_000).toISOString(),
  ...over,
});

const sym = (name: string, filePath: string, kind: CodeSymbol["kind"] = "class"): CodeSymbol =>
  ({ id: `${filePath}::${name}#${kind}`, name, kind, filePath, signature: `class ${name}` });

const dep = (name: string, scope: Dependency["scope"] = "runtime"): Dependency =>
  ({ name, ecosystem: "gradle", scope, declaredIn: "build.gradle" });

const TASK: ImplementationTask = {
  featureId: "download", feature: "resumable background downloader",
  strategy: "reuse-pattern", lookingFor: ["mature download engines"],
  capabilities: ["download", "resume", "retry", "queue"],
  requirementChecklist: ["pause/resume", "background execution", "retry"],
  searchQueries: ["resumable download"], rationale: "r", budgetShare: 1, priority: 80, dependsOn: [],
};

// ---------------------------------------------------------------------------

describe("test analysis (spec §4 find_tests)", () => {
  const testPaths = [
    "src/main/kotlin/Downloader.kt",
    "src/test/kotlin/DownloaderTest.kt",
    "src/androidTest/kotlin/DownloadIntegrationTest.kt",
    "src/test/resources/fixtures/sample.json",
    "src/test/kotlin/FakeServer.kt",
    "src/test/kotlin/TestBase.kt",
  ];

  it("finds tests and classifies unit vs integration", () => {
    const r = analyzeTests({ filePaths: testPaths });
    expect(r.hasTests).toBe(true);
    expect(r.unitTests.length).toBeGreaterThan(0);
    expect(r.integrationTests.some((t) => t.filePath.includes("androidTest"))).toBe(true);
  });

  it("identifies fixtures, mocks and utilities", () => {
    const r = analyzeTests({ filePaths: testPaths });
    expect(r.fixtures.some((f) => f.includes("fixtures"))).toBe(true);
    expect(r.mocks.some((m) => m.includes("Fake"))).toBe(true);
    expect(r.testUtilities.some((u) => u.includes("TestBase"))).toBe(true);
  });

  it("detects frameworks from declared dependencies", () => {
    const r = analyzeTests({
      filePaths: testPaths,
      dependencies: [dep("junit:junit", "test"), dep("io.mockk:mockk", "test"), dep("org.robolectric:robolectric", "test")],
    });
    expect(r.frameworks).toEqual(expect.arrayContaining(["JUnit", "MockK", "Robolectric"]));
  });

  it("extracts edge cases from test NAMES — the highest-value output", () => {
    const symbols = [
      sym("test_resume_after_connection_reset", "src/test/DownloadTest.kt", "function"),
      sym("testCancelMidWrite", "src/test/DownloadTest.kt", "function"),
      sym("test_retry_with_exponential_backoff", "src/test/DownloadTest.kt", "function"),
      sym("testHandlesMalformedRangeHeader", "src/test/DownloadTest.kt", "function"),
      sym("test_concurrent_downloads_are_thread_safe", "src/test/DownloadTest.kt", "function"),
    ];
    const r = analyzeTests({ filePaths: ["src/test/DownloadTest.kt"], symbols });
    expect(r.edgeCasesCovered).toEqual(expect.arrayContaining([
      "resumption and recovery", "cancellation", "retry behaviour", "malformed input", "concurrency",
    ]));
  });

  it("turns a test name into a readable assertion", () => {
    const symbols = [sym("test_resume_after_connection_reset", "src/test/D.kt", "function")];
    const r = analyzeTests({ filePaths: ["src/test/D.kt"], symbols });
    expect(r.unitTests[0]!.asserts).toBe("Resume after connection reset");
  });

  it("distinguishes 'has tests' from 'tests the feature you need'", () => {
    const irrelevant = [
      sym("testUserLogin", "src/test/AuthTest.kt", "function"),
      sym("testPasswordHashing", "src/test/AuthTest.kt", "function"),
    ];
    const relevant = [
      sym("testDownloadResumes", "src/test/DownloadTest.kt", "function"),
      sym("testRetryPolicy", "src/test/DownloadTest.kt", "function"),
    ];
    const terms = ["download", "resume", "retry"];
    const a = analyzeTests({ filePaths: ["src/test/AuthTest.kt"], symbols: irrelevant, featureTerms: terms });
    const b = analyzeTests({ filePaths: ["src/test/DownloadTest.kt"], symbols: relevant, featureTerms: terms });
    expect(a.hasTests).toBe(true);
    expect(b.featureTestConfidence).toBeGreaterThan(a.featureTestConfidence);
    expect(a.notes.join(" ")).toMatch(/little evidence/i);
  });

  it("says plainly when there are no tests", () => {
    const r = analyzeTests({ filePaths: ["src/main/App.kt", "README.md"] });
    expect(r.hasTests).toBe(false);
    expect(r.featureTestConfidence).toBe(0);
    expect(r.notes[0]).toMatch(/writing its tests yourself/i);
  });

  it("admits reduced resolution when only file paths are available", () => {
    const r = analyzeTests({ filePaths: testPaths });
    expect(r.notes.join(" ")).toMatch(/file path only/i);
  });

  it("recognises test conventions across ecosystems", () => {
    for (const p of ["foo_test.go", "src/thing.test.ts", "tests/test_mod.py", "spec/thing_spec.rb", "src/test/java/AppTest.java"]) {
      expect(analyzeTests({ filePaths: [p] }).hasTests, p).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------

describe("architecture inference", () => {
  it("recognises queue + worker + persistence", () => {
    const a = inferArchitecture({
      filePaths: [
        "src/download/DownloadQueue.kt", "src/download/DownloadWorker.kt",
        "src/data/DownloadRepository.kt", "src/download/RetryPolicy.kt",
      ],
      symbols: [sym("DownloadQueue", "src/download/DownloadQueue.kt"), sym("DownloadWorker", "src/download/DownloadWorker.kt")],
    });
    expect(a.pattern).toContain("queue");
    expect(a.components).toContain("Worker");
    expect(a.confidence).toBeGreaterThan(0.5);
  });

  it("recognises clean architecture from directory layout", () => {
    const a = inferArchitecture({
      filePaths: ["src/domain/UseCase.kt", "src/data/Repo.kt", "src/presentation/Screen.kt"],
    });
    expect(a.pattern).toContain("clean architecture");
    expect(a.layers).toEqual(expect.arrayContaining(["domain model", "data access"]));
  });

  it("admits when no pattern is recognised, rather than inventing one", () => {
    const a = inferArchitecture({ filePaths: ["a.kt", "b.kt", "c.kt"] });
    expect(a.pattern).toBe("unrecognised / bespoke");
    expect(a.confidence).toBeLessThan(0.5);
    expect(a.notes.join(" ")).toMatch(/bespoke/i);
  });

  it("reports lower confidence without symbol data", () => {
    const paths = ["src/download/DownloadQueue.kt", "src/download/DownloadWorker.kt", "src/data/Repo.kt"];
    const withSymbols = inferArchitecture({ filePaths: paths, symbols: [sym("DownloadQueue", paths[0]!)] });
    const without = inferArchitecture({ filePaths: paths });
    expect(without.confidence).toBeLessThan(withSymbols.confidence);
    expect(without.notes.join(" ")).toMatch(/file paths only/i);
  });

  it("excludes sample and demo modules from components", () => {
    // Left in, they surfaced as architecture "components" and then as integration points,
    // telling the agent to integrate a sample app.
    const a = inferArchitecture({
      filePaths: [
        "fetch2/src/Download.kt", "fetch2core/src/Core.kt",
        "sampleApp/src/MainActivity.kt", "examples/demo.kt",
      ],
    });
    expect(a.modules.map((m) => m.path)).not.toContain("sampleApp");
    expect(a.modules.map((m) => m.path)).not.toContain("examples");
    expect(a.modules.map((m) => m.path)).toContain("fetch2");
  });

  it("builds a module map with roles", () => {
    const a = inferArchitecture({
      filePaths: ["src/network/Client.kt", "src/network/Api.kt", "src/data/Repo.kt", "src/ui/Screen.kt"],
    });
    expect(a.modules.find((m) => m.path === "network")?.role).toBe("networking");
    expect(a.modules.find((m) => m.path === "ui")?.role).toBe("presentation");
  });
});

// ---------------------------------------------------------------------------

describe("adaptation planning (spec §16)", () => {
  const source = inferArchitecture({
    filePaths: ["src/data/DownloadRepository.kt", "src/download/DownloadQueue.kt", "src/download/DownloadWorker.kt"],
  });

  it("plans a port when the language differs", () => {
    const p = planAdaptation({ source, stackMatch: 0.1, target: { language: "Swift" } });
    expect(p.requiredChanges[0]!.action).toMatch(/port/i);
    expect(p.requiredChanges[0]!.effort).toBe("large");
    expect(p.risks.join(" ")).toMatch(/tests from scratch/i);
    expect(p.integrationDifficulty === "high" || p.integrationDifficulty === "very-high").toBe(true);
  });

  it("names the specific library substitution", () => {
    const p = planAdaptation({
      source,
      sourceDependencies: [dep("androidx.room:room-runtime"), dep("com.squareup.okhttp3:okhttp")],
      target: { language: "Kotlin", libraries: ["SQLDelight", "Ktor"] },
      stackMatch: 1,
    });
    const actions = p.requiredChanges.map((s) => s.action).join(" ");
    expect(actions).toMatch(/local database/i);
    expect(actions).toMatch(/HTTP client/i);
  });

  it("uses the correct article before a vowel sound", () => {
    const p = planAdaptation({
      source, sourceDependencies: [dep("com.squareup.okhttp3:okhttp")],
      target: { language: "Kotlin" }, stackMatch: 1,
    });
    const http = p.requiredChanges.find((s) => /HTTP client/.test(s.action));
    expect(http?.rationale).toContain("an HTTP client");
    expect(http?.rationale).not.toContain("a HTTP client");
  });

  it("flags a dependency the target does not declare at all", () => {
    const p = planAdaptation({
      source, sourceDependencies: [dep("com.google.dagger:hilt-android")],
      target: { language: "Kotlin" }, stackMatch: 1,
    });
    expect(p.requiredChanges.some((s) => /dependency injection/i.test(s.action))).toBe(true);
  });

  it("always says what to PRESERVE, not only what to change", () => {
    // Agents tend to rewrite the valuable part and faithfully copy the glue.
    const p = planAdaptation({ source, stackMatch: 1, target: { language: "Kotlin" } });
    expect(p.preserve.join(" ")).toMatch(/business logic/i);
    expect(p.preserve.join(" ")).toMatch(/edge-case/i);
  });

  it("always ends with a verification step", () => {
    const p = planAdaptation({ source, stackMatch: 1 });
    expect(p.requiredChanges[p.requiredChanges.length - 1]!.action).toMatch(/tests/i);
  });

  it("notes when no target profile was supplied", () => {
    const p = planAdaptation({ source, stackMatch: 1 });
    expect(p.risks.join(" ")).toMatch(/analyze_target_project/);
  });

  it("scales difficulty with the amount of change required", () => {
    const easy = planAdaptation({ source, stackMatch: 1, target: { language: "Kotlin" } });
    const hard = planAdaptation({
      source, stackMatch: 0.1, target: { language: "Swift" },
      sourceDependencies: [dep("androidx.room:room-runtime"), dep("com.google.dagger:hilt-android"), dep("com.squareup.okhttp3:okhttp")],
    });
    const rank = { trivial: 0, low: 1, medium: 2, high: 3, "very-high": 4 } as const;
    expect(rank[hard.integrationDifficulty]).toBeGreaterThan(rank[easy.integrationDifficulty]);
  });
});

// ---------------------------------------------------------------------------

describe("bundle assembly (spec §10)", () => {
  function makeCandidate(over: Partial<Candidate> = {}): Candidate {
    const metadata = md({ fullName: "tonyofrancis/Fetch" });
    const license = analyzeLicense({ raw: { spdx: "Apache-2.0" }, repository: "tonyofrancis/Fetch" });
    const symbols = [
      sym("DownloadManager", "src/download/DownloadManager.kt"),
      sym("DownloadWorker", "src/download/DownloadWorker.kt"),
      sym("ResumeHandler", "src/download/ResumeHandler.kt"),
    ];
    const completeness = assessCompleteness({ checklist: TASK.requirementChecklist, symbols });
    const integrationSurface = assessIntegrationSurface({ symbols, dependencies: [dep("com.squareup.okhttp3:okhttp")] });
    const reuse = assessReuse({ license, metadata, stackMatch: 1, architectureMatch: 0.85 });
    const evidence = collectEvidence({
      metadata, task: TASK, target: { language: "Kotlin" },
      license, completeness, integrationSurface, sources: ["github:metadata", "code-index"],
    });
    return {
      ref: metadata.ref, metadata, discoveredVia: ["test"],
      license, completeness, integrationSurface, reuse, evidence, symbols,
      minimalSet: {
        core: symbols, supporting: [sym("DownloadEntity", "src/data/DownloadEntity.kt")],
        excluded: [{ name: "Logger", symbolId: "x", reason: "logging infrastructure" }],
        seeds: [{ symbolId: symbols[0]!.id, reason: "highest relevance" }],
        connected: true, estimatedTokens: 120, estimatedFullTokens: 400,
        parameters: { relevanceFloor: 0.25, maxDepth: 2, tokenBudget: 1200 },
      },
      dependencies: {
        direct: [dep("com.squareup.okhttp3:okhttp"), dep("junit:junit", "test")],
        transitiveSample: [], manifests: ["build.gradle"], ecosystems: ["gradle"],
        requiredConfiguration: [], platformRequirements: [], incompatibilities: [],
        versionAssumptions: [], simplicity: 0.9, notes: [],
      },
      score: rankCandidate(evidence, { weights: DEFAULT_WEIGHTS, reuse }),
      ...over,
    };
  }

  const filePaths = [
    "src/download/DownloadManager.kt", "src/download/DownloadWorker.kt",
    "src/download/ResumeHandler.kt", "src/data/DownloadEntity.kt",
    "src/test/DownloadTest.kt", "build.gradle",
  ];

  it("produces a complete, versioned bundle", () => {
    const b = buildBundle({
      task: TASK, recommendation: makeCandidate(), alternatives: [],
      target: { language: "Kotlin" }, filePaths, degradations: [],
      maxTokens: 6000, retrievalMode: "code-index",
    });
    expect(b.schemaVersion).toBeTruthy();
    expect(b.feature).toBe(TASK.feature);
    expect(b.recommendation.repository).toBe("tonyofrancis/Fetch");
    expect(b.symbols.length).toBeGreaterThan(0);
    expect(b.architecture.pattern).toBeTruthy();
  });

  it("always carries provenance with a commit SHA (spec §11)", () => {
    const b = buildBundle({
      task: TASK, recommendation: makeCandidate(), alternatives: [],
      filePaths, degradations: [], maxTokens: 6000, retrievalMode: "code-index",
    });
    expect(b.provenance).toHaveLength(1);
    expect(b.provenance[0]!.commit).toBe("abc1234def5678");
    expect(b.provenance[0]!.repository).toBe("tonyofrancis/Fetch");
    expect(b.provenance[0]!.license).toBe("Apache-2.0");
    expect(b.provenance[0]!.retrievalMode).toBe("code-index");
    expect(b.provenance[0]!.files.length).toBeGreaterThan(0);
  });

  it("keeps reuse mode and licence even under an absurdly small budget", () => {
    // These are forceReserve'd: a bundle omitting "you may not copy this" to save tokens
    // is worse than no bundle at all.
    const b = buildBundle({
      task: TASK, recommendation: makeCandidate(), alternatives: [],
      filePaths, degradations: [], maxTokens: 10, retrievalMode: "code-index",
    });
    expect(b.reuse.mode).toBe("DIRECT_REUSE");
    expect(b.license.spdx).toBe("Apache-2.0");
    expect(b.license.disclaimer).toBeTruthy();
    expect(b.provenance).toHaveLength(1);
  });

  it("defers what it withheld, naming the exact call to fetch it (spec §9)", () => {
    const b = buildBundle({
      task: TASK, recommendation: makeCandidate(), alternatives: [],
      filePaths, degradations: [], maxTokens: 6000, retrievalMode: "code-index",
    });
    expect(b.availableOnRequest.length).toBeGreaterThan(0);
    const source = b.availableOnRequest.find((d) => d.layer === 3);
    expect(source?.fetchWith.tool).toBe("get_implementation");
    expect(source?.fetchWith.args.repository).toBe("tonyofrancis/Fetch");
  });

  it("separates the reasons to choose it from the concerns", () => {
    const b = buildBundle({
      task: TASK, recommendation: makeCandidate(), alternatives: [],
      filePaths, degradations: [], maxTokens: 6000, retrievalMode: "code-index",
    });
    expect(b.recommendation.why.every((r) => r.startsWith("+"))).toBe(true);
    expect(b.recommendation.concerns.every((r) => /^[-!?]/.test(r))).toBe(true);
  });

  it("reports unknowns explicitly rather than omitting them silently", () => {
    const bare = makeCandidate({
      license: undefined, minimalSet: undefined, symbols: undefined, reuse: undefined,
    });
    const b = buildBundle({
      task: TASK, recommendation: bare, alternatives: [],
      filePaths: [], degradations: [], maxTokens: 6000, retrievalMode: "metadata-only",
    });
    expect(b.unknowns.join(" ")).toMatch(/licence could not be identified/i);
    expect(b.unknowns.join(" ")).toMatch(/no symbol-level analysis/i);
    // An unassessable candidate must default to the SAFE mode, never DIRECT_REUSE.
    expect(b.reuse.mode).toBe("REFERENCE_ONLY");
  });

  it("says when each alternative would be the better choice", () => {
    const alt = makeCandidate();
    const b = buildBundle({
      task: TASK, recommendation: makeCandidate(), alternatives: [alt],
      filePaths, degradations: [], maxTokens: 6000, retrievalMode: "code-index",
    });
    expect(b.alternatives).toHaveLength(1);
    expect(b.alternatives[0]!.chooseWhen.length).toBeGreaterThan(5);
    expect(b.alternatives[0]!.reuseMode).toBeTruthy();
  });

  it("omits adaptation for DO_NOT_USE, since adapting it is not an option", () => {
    const banned = makeCandidate({
      reuse: assessReuse({
        license: analyzeLicense({ raw: { spdx: "AGPL-3.0" }, repository: "a/b", target: { distribution: "proprietary" } }),
        metadata: md({ fullName: "a/b" }), stackMatch: 1, architectureMatch: 0.9,
        target: { distribution: "proprietary" },
      }),
    });
    const b = buildBundle({
      task: TASK, recommendation: banned, alternatives: [],
      filePaths, degradations: [], maxTokens: 6000, retrievalMode: "code-index",
    });
    expect(b.reuse.mode).toBe("DO_NOT_USE");
    expect(b.adaptation).toBeUndefined();
    expect(b.adaptationNotes).toEqual([]);
  });

  it("deduplicates degradations — five candidates failing alike is one fact", () => {
    const dup = Array.from({ length: 5 }, () => ({
      stage: "deep.license", reason: "rate-limit", severity: "warning" as const,
    }));
    const b = buildBundle({
      task: TASK, recommendation: makeCandidate(), alternatives: [],
      filePaths, degradations: dup, maxTokens: 6000, retrievalMode: "code-index",
    });
    expect(b.degradations).toHaveLength(1);
  });

  it("targets integration points at real directories when a profile is supplied", () => {
    const profile: TargetProjectProfile = {
      root: "/proj", languages: { Kotlin: 100 }, frameworks: ["Android"],
      architecture: "clean architecture", dependencyManagers: ["gradle"],
      existingLibraries: [], testingFrameworks: ["JUnit"], codingPatterns: [],
      directoryStructure: [
        { path: "app/src/main/kotlin/data", role: "data access" },
        { path: "app/src/main/kotlin/worker", role: "background work" },
      ],
      analysisMode: "github-fallback", gaps: [],
    };
    const b = buildBundle({
      task: TASK, recommendation: makeCandidate(), alternatives: [], targetProfile: profile,
      filePaths, degradations: [], maxTokens: 6000, retrievalMode: "code-index",
    });
    expect(b.integrationPoints.some((p) => p.location.includes("app/src/main/kotlin"))).toBe(true);
    expect(b.integrationPoints.some((p) => p.how.includes("JUnit"))).toBe(true);
  });

  it("points at analyze_target_project when no profile is supplied", () => {
    const b = buildBundle({
      task: TASK, recommendation: makeCandidate(), alternatives: [],
      filePaths, degradations: [], maxTokens: 6000, retrievalMode: "code-index",
    });
    expect(b.integrationPoints[0]!.location).toMatch(/analyze_target_project/);
  });

  it("keeps confidence no higher than its weakest input", () => {
    const shaky = makeCandidate({
      reuse: { ...assessReuse({
        license: analyzeLicense({ raw: { spdx: "MIT" }, repository: "a/b" }),
        metadata: md({ fullName: "a/b" }), stackMatch: 1, architectureMatch: 0.9,
      }), confidence: 0.3 },
    });
    const b = buildBundle({
      task: TASK, recommendation: shaky, alternatives: [],
      filePaths, degradations: [], maxTokens: 6000, retrievalMode: "code-index",
    });
    expect(b.confidence).toBeLessThanOrEqual(0.3);
  });

  it("excludes dev/test dependencies from what the consumer inherits", () => {
    const b = buildBundle({
      task: TASK, recommendation: makeCandidate(), alternatives: [],
      filePaths, degradations: [], maxTokens: 6000, retrievalMode: "code-index",
    });
    expect(b.dependencies.direct.every((d) => d.scope !== "test")).toBe(true);
    expect(b.availableOnRequest.some((d) => /dev\/test/.test(d.what))).toBe(true);
  });
});
