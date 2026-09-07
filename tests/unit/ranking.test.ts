import { describe, it, expect } from "vitest";
import { analyzeLicense, licenseScore, LICENSE_DISCLAIMER } from "../../src/analyzers/license.js";
import { assessCompleteness } from "../../src/analyzers/completeness.js";
import { assessIntegrationSurface } from "../../src/analyzers/integration.js";
import { assessReuse } from "../../src/analyzers/reuse.js";
import { collectEvidence } from "../../src/ranking/evidence.js";
import { rankCandidate, sortByScore, renderScore } from "../../src/ranking/engine.js";
import { dedupeCandidates } from "../../src/analyzers/dedupe.js";
import { DEFAULT_WEIGHTS } from "../../src/core/config.js";
import { refFromFullName } from "../../src/providers/github/types.js";
import type { Candidate, Dependency, RepoMetadata, RepoQuality, TargetStack } from "../../src/types/index.js";

const md = (over: Partial<RepoMetadata> & { fullName: string }): RepoMetadata => ({
  ref: refFromFullName(over.fullName),
  topics: [], stars: 100, forks: 10, watchers: 5, openIssues: 2,
  isFork: false, archived: false,
  pushedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
  language: "Kotlin",
  ...over,
});

const quality = (over: Partial<RepoQuality> = {}): RepoQuality => ({
  score: 0, hasTests: true, testFileCount: 18, hasCi: true, ciSystems: ["github-actions"],
  hasReadme: true, readmeQuality: 0.8, hasDocs: true, hasChangelog: true, hasContributing: true,
  releaseCount: 12, signals: [], ...over,
});

// ---------------------------------------------------------------------------

describe("licence analysis (spec §12)", () => {
  it("identifies SPDX from provider metadata", () => {
    const l = analyzeLicense({ raw: { spdx: "Apache-2.0" }, repository: "a/b" });
    expect(l.spdx).toBe("Apache-2.0");
    expect(l.category).toBe("permissive");
    expect(l.compatible).toBe(true);
    expect(l.obligations.join(" ")).toMatch(/NOTICE/);
  });

  it("fingerprints licence text when SPDX is absent", () => {
    const l = analyzeLicense({
      raw: { text: "GNU AFFERO GENERAL PUBLIC LICENSE\n Version 3, 19 November 2007", path: "LICENSE" },
      repository: "a/b",
    });
    expect(l.spdx).toBe("AGPL-3.0");
    expect(l.category).toBe("network-copyleft");
  });

  it("uses the exact spec wording for a missing licence", () => {
    const l = analyzeLicense({ raw: null, repository: "a/b" });
    expect(l.spdx).toBe("UNKNOWN");
    expect(l.compatible).toBe("unclear");
    expect(l.warnings[0]!.message).toContain("does not contain a clearly identifiable license");
    expect(l.warnings[0]!.message).toContain("Do not assume the code is freely reusable");
    expect(l.warnings[0]!.severity).toBe("high");
  });

  it("never claims legal certainty", () => {
    for (const raw of [{ spdx: "MIT" }, { spdx: "GPL-3.0" }, null]) {
      expect(analyzeLicense({ raw, repository: "a/b" }).disclaimer).toBe(LICENSE_DISCLAIMER);
    }
  });

  it("evaluates copyleft against the consuming project's distribution model", () => {
    const gpl = { raw: { spdx: "GPL-3.0" }, repository: "a/b" };
    expect(analyzeLicense({ ...gpl, target: { distribution: "proprietary" } }).compatible).toBe(false);
    expect(analyzeLicense({ ...gpl, target: { distribution: "open-source" } }).compatible).toBe(true);
    expect(analyzeLicense({ ...gpl, target: { distribution: "internal" } }).compatible).toBe("unclear");
  });

  it("flags AGPL network-use obligations specifically", () => {
    const l = analyzeLicense({ raw: { spdx: "AGPL-3.0" }, repository: "a/b", target: { distribution: "proprietary" } });
    expect(l.warnings.some((w) => /NETWORK USE/i.test(w.message))).toBe(true);
    expect(l.compatible).toBe(false);
  });

  it("warns that LGPL static linking differs from dynamic", () => {
    const l = analyzeLicense({ raw: { spdx: "LGPL-3.0" }, repository: "a/b" });
    expect(l.category).toBe("weak-copyleft");
    expect(l.warnings.some((w) => /static linking/i.test(w.message))).toBe(true);
  });

  it("treats source-available licences as not open source", () => {
    const l = analyzeLicense({ raw: { spdx: "BUSL-1.1" }, repository: "a/b" });
    expect(l.category).toBe("proprietary");
    expect(l.compatible).toBe(false);
  });

  it("flags an unrecognised SPDX rather than assuming it is fine", () => {
    const l = analyzeLicense({ raw: { spdx: "WTFPL-9.9" }, repository: "a/b" });
    expect(l.compatible).toBe("unclear");
    expect(l.warnings[0]!.message).toMatch(/not in our reference table/);
  });

  it("normalises -only and -or-later suffixes", () => {
    expect(analyzeLicense({ raw: { spdx: "GPL-3.0-or-later" }, repository: "a/b" }).category).toBe("strong-copyleft");
  });

  it("scores permissive above copyleft above unknown above incompatible", () => {
    const s = (spdx: string, target?: TargetStack) => licenseScore(analyzeLicense({ raw: { spdx }, repository: "a/b", target }));
    expect(s("MIT")).toBeGreaterThan(s("MPL-2.0"));
    expect(s("MPL-2.0")).toBeGreaterThan(s("AGPL-3.0"));
    expect(licenseScore(analyzeLicense({ raw: null, repository: "a/b" }))).toBeLessThan(s("MIT"));
    expect(s("GPL-3.0", { distribution: "proprietary" })).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("implementation completeness", () => {
  const checklist = ["sends Range header", "persists byte offset", "resumes after interruption", "validates ETag"];

  it("credits symbol evidence most strongly", () => {
    const r = assessCompleteness({
      checklist,
      symbols: [
        { id: "1", name: "RangeRequestBuilder", kind: "class", filePath: "src/Range.kt" },
        { id: "2", name: "ByteOffsetStore", kind: "class", filePath: "src/Offset.kt" },
      ],
    });
    expect(r.items.find((i) => i.requirement === "sends Range header")!.status).toBe("evidenced");
    expect(r.items.find((i) => i.requirement === "persists byte offset")!.status).toBe("evidenced");
    expect(r.ratio).toBeGreaterThan(0);
  });

  it("matches camelCase and snake_case symbol names", () => {
    for (const name of ["byteOffset", "byte_offset", "BYTE_OFFSET", "ByteOffsetTracker"]) {
      const r = assessCompleteness({
        checklist: ["persists byte offset"],
        symbols: [{ id: "1", name, kind: "class", filePath: "x.kt" }],
      });
      expect(r.items[0]!.status, name).toBe("evidenced");
    }
  });

  it("distinguishes 'absent' from 'unknown'", () => {
    const deep = assessCompleteness({
      checklist: ["sends Range header"],
      symbols: [{ id: "1", name: "Unrelated", kind: "class", filePath: "x.kt" }],
    });
    expect(deep.items[0]!.status).toBe("absent");

    const shallow = assessCompleteness({ checklist: ["sends Range header"], description: "a library" });
    expect(shallow.items[0]!.status).toBe("unknown");
    expect(shallow.undetermined).toHaveLength(1);
  });

  it("computes the ratio over decidable items only", () => {
    // Punishing a candidate for what we never checked would penalise shallow analysis
    // rather than reporting it.
    const r = assessCompleteness({
      checklist: ["sends Range header", "does something we never checked"],
      symbols: [{ id: "1", name: "RangeHeaderWriter", kind: "class", filePath: "x.kt" }],
    });
    expect(r.satisfied).toBe(1);
    expect(r.ratio).toBeGreaterThanOrEqual(0.5);
  });

  it("lets a small complete implementation beat a big incomplete one", () => {
    const complete = assessCompleteness({
      checklist,
      symbols: ["RangeRequest", "ByteOffsetStore", "ResumeHandler", "ETagValidator"]
        .map((n, i) => ({ id: String(i), name: n, kind: "class" as const, filePath: `${n}.kt` })),
    });
    const partial = assessCompleteness({
      checklist,
      symbols: [{ id: "1", name: "SimpleDownloader", kind: "class", filePath: "d.kt" }],
    });
    expect(complete.ratio).toBeGreaterThan(partial.ratio);
  });

  it("records where each piece of evidence came from", () => {
    const r = assessCompleteness({
      checklist: ["retry on failure"],
      dependencies: [{ name: "retry-policy", ecosystem: "npm", scope: "runtime", declaredIn: "package.json" }],
    });
    expect(r.items[0]!.evidence.some((e) => e.startsWith("dependencies:"))).toBe(true);
  });

  it("handles an empty checklist without dividing by zero", () => {
    const r = assessCompleteness({ checklist: [] });
    expect(r.total).toBe(0);
    expect(r.ratio).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("integration surface", () => {
  const dep = (name: string, scope: Dependency["scope"] = "runtime"): Dependency =>
    ({ name, ecosystem: "gradle", scope, declaredIn: "build.gradle" });

  it("prefers the small implementation over the sprawling one", () => {
    const small = assessIntegrationSurface({
      symbols: Array.from({ length: 5 }, (_, i) => ({ id: String(i), name: `C${i}`, kind: "class" as const, filePath: `a/C${i}.kt` })),
      dependencies: [dep("okhttp"), dep("kotlinx-coroutines")],
      integrationPoints: 1,
    });
    const big = assessIntegrationSurface({
      symbols: Array.from({ length: 32 }, (_, i) => ({ id: String(i), name: `C${i}`, kind: "class" as const, filePath: `a/b/c/d/e/f/C${i}.kt` })),
      dependencies: Array.from({ length: 14 }, (_, i) => dep(`dep-${i}`)).concat([dep("spring-core"), dep("dagger")]),
      integrationPoints: 6,
    });
    expect(small.score).toBeGreaterThan(big.score);
    expect(small.difficulty).toBe("trivial");
    expect(["high", "very-high"]).toContain(big.difficulty);
  });

  it("ignores dev and test dependencies — the consumer does not inherit them", () => {
    const withDev = assessIntegrationSurface({ dependencies: [dep("a"), ...Array.from({ length: 20 }, (_, i) => dep(`t${i}`, "test"))] });
    const without = assessIntegrationSurface({ dependencies: [dep("a")] });
    expect(withDev.dependencyCount).toBe(1);
    expect(withDev.score).toBe(without.score);
  });

  it("does not penalise a framework the target already uses", () => {
    const deps = [dep("org.springframework:spring-core")];
    const mismatch = assessIntegrationSurface({ dependencies: deps });
    const match = assessIntegrationSurface({ dependencies: deps, target: { framework: "Spring" } });
    expect(match.frameworkCoupling).toBeLessThan(mismatch.frameworkCoupling);
    expect(match.score).toBeGreaterThan(mismatch.score);
  });

  it("treats DI containers as coupling", () => {
    const s = assessIntegrationSurface({ dependencies: [dep("com.google.dagger:hilt-android")] });
    expect(s.frameworkCoupling).toBeGreaterThan(0);
  });

  it("explains its verdict", () => {
    const s = assessIntegrationSurface({
      dependencies: Array.from({ length: 15 }, (_, i) => dep(`d${i}`)),
    });
    expect(s.drivers.length).toBeGreaterThan(0);
    expect(s.drivers.join(" ")).toMatch(/dependenc/);
  });

  it("falls back to a coarse prior with no data", () => {
    const s = assessIntegrationSurface({ repoSizeKb: 80_000 });
    expect(s.symbolsRequired).toBeGreaterThan(20);
    expect(s.score).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe("reuse mode", () => {
  const base = { metadata: md({ fullName: "a/b" }), stackMatch: 1, architectureMatch: 0.9 };

  it("DIRECT_REUSE for permissive + matching stack + compatible architecture", () => {
    const r = assessReuse({ ...base, license: analyzeLicense({ raw: { spdx: "MIT" }, repository: "a/b" }) });
    expect(r.mode).toBe("DIRECT_REUSE");
    expect(r.guidance).toMatch(/vendor|depend/i);
  });

  it("licence gates everything — a perfect match with AGPL is not DIRECT_REUSE", () => {
    const r = assessReuse({
      ...base,
      license: analyzeLicense({ raw: { spdx: "AGPL-3.0" }, repository: "a/b", target: { distribution: "proprietary" } }),
      target: { distribution: "proprietary" },
    });
    expect(r.mode).toBe("DO_NOT_USE");
    expect(r.reason).toMatch(/incompatible/i);
    expect(r.guidance).toMatch(/find_alternative/);
  });

  it("ADAPT when the stack matches but the architecture does not", () => {
    const r = assessReuse({
      ...base, architectureMatch: 0.3,
      license: analyzeLicense({ raw: { spdx: "MIT" }, repository: "a/b" }),
    });
    expect(r.mode).toBe("ADAPT");
    expect(r.guidance).toMatch(/business logic/i);
  });

  it("REFERENCE_ONLY for a different language, however good", () => {
    const r = assessReuse({
      ...base, stackMatch: 0.1,
      license: analyzeLicense({ raw: { spdx: "MIT" }, repository: "a/b" }),
    });
    expect(r.mode).toBe("REFERENCE_ONLY");
    expect(r.guidance).toMatch(/reimplement|port/i);
  });

  it("REFERENCE_ONLY when there is no licence at all", () => {
    const r = assessReuse({ ...base, license: analyzeLicense({ raw: null, repository: "a/b" }) });
    expect(r.mode).toBe("REFERENCE_ONLY");
    expect(r.reason).toMatch(/all rights reserved/i);
  });

  it("REFERENCE_ONLY for an archived repository", () => {
    const r = assessReuse({
      ...base, metadata: md({ fullName: "a/b", archived: true }),
      license: analyzeLicense({ raw: { spdx: "MIT" }, repository: "a/b" }),
    });
    expect(r.mode).toBe("REFERENCE_ONLY");
    expect(r.reason).toMatch(/archived/i);
  });

  it("always states a reason and guidance, including for DO_NOT_USE", () => {
    const r = assessReuse({
      ...base,
      license: analyzeLicense({ raw: { spdx: "BUSL-1.1" }, repository: "a/b" }),
    });
    expect(r.mode).toBe("DO_NOT_USE");
    expect(r.reason.length).toBeGreaterThan(10);
    expect(r.guidance.length).toBeGreaterThan(10);
    expect(r.factors.licenseCategory).toBe("proprietary");
  });

  it("surfaces attribution obligations when reuse is permitted", () => {
    const r = assessReuse({ ...base, license: analyzeLicense({ raw: { spdx: "Apache-2.0" }, repository: "a/b" }) });
    expect(r.obligations.length).toBeGreaterThan(0);
    expect(r.guidance).toMatch(/NOTICE|copyright/i);
  });
});

// ---------------------------------------------------------------------------

describe("evidence collection", () => {
  const task = {
    featureId: "download", feature: "File downloading", strategy: "reuse-pattern" as const,
    lookingFor: [], capabilities: ["download"], requirementChecklist: [],
    searchQueries: ["file downloader"], rationale: "", budgetShare: 1, priority: 80, dependsOn: [],
  };

  it("records value, confidence, source and observation for every axis", () => {
    const e = collectEvidence({
      metadata: md({ fullName: "a/downloader", topics: ["downloader", "android"] }),
      task, target: { language: "Kotlin" }, quality: quality(),
      license: analyzeLicense({ raw: { spdx: "Apache-2.0" }, repository: "a/downloader" }),
      sources: ["github:metadata", "repo-structure"],
    });
    for (const [axis, sig] of Object.entries(e.axes)) {
      expect(sig.value, axis).toBeGreaterThanOrEqual(0);
      expect(sig.value, axis).toBeLessThanOrEqual(1);
      expect(sig.observation, axis).toBeTruthy();
      expect(sig.source, axis).toBeTruthy();
    }
  });

  it("imputes a neutral prior for unmeasured axes rather than zero", () => {
    const e = collectEvidence({ metadata: md({ fullName: "a/b" }), sources: ["github:metadata"] });
    expect(e.unmeasured.length).toBeGreaterThan(0);
    for (const axis of e.unmeasured) {
      expect(e.axes[axis].value).toBe(0.5);
      expect(e.axes[axis].imputed).toBe(true);
      expect(e.axes[axis].confidence).toBeLessThan(0.2);
    }
  });

  it("scores an exact language match above a related one above an unrelated one", () => {
    const s = (language: string) => collectEvidence({
      metadata: md({ fullName: "a/b", language }), target: { language: "Kotlin" }, sources: [],
    }).axes.stackMatch.value;
    expect(s("Kotlin")).toBeGreaterThan(s("Java"));
    expect(s("Java")).toBeGreaterThan(s("Python"));
  });

  it("treats an archived repository as unmaintained regardless of history", () => {
    const e = collectEvidence({
      metadata: md({ fullName: "a/b", archived: true, pushedAt: new Date().toISOString() }),
      quality: quality({ commitsLast90Days: 100 }), sources: [],
    });
    expect(e.axes.maintenance.value).toBe(0);
  });

  it("log-scales popularity so one huge repo cannot dominate", () => {
    const p = (stars: number) => collectEvidence({ metadata: md({ fullName: "a/b", stars }), sources: [] }).axes.popularity.value;
    expect(p(50_000) - p(40_000)).toBeLessThan(p(1_000) - p(100));
  });

  it("weights topics above README mentions for relevance", () => {
    const withTopic = collectEvidence({
      metadata: md({ fullName: "a/b", topics: ["downloader"] }), task, sources: [],
    }).axes.featureRelevance.value;
    const withReadme = collectEvidence({
      metadata: md({ fullName: "a/b" }), task, relevanceText: "downloader ".repeat(50), sources: [],
    }).axes.featureRelevance.value;
    expect(withTopic).toBeGreaterThan(withReadme);
  });
});

// ---------------------------------------------------------------------------

describe("ranking engine", () => {
  const strong = () => collectEvidence({
    metadata: md({ fullName: "good/repo", topics: ["downloader", "kotlin"], stars: 4000 }),
    task: {
      featureId: "download", feature: "File downloading", strategy: "reuse-pattern",
      lookingFor: [], capabilities: ["download"], requirementChecklist: [],
      searchQueries: ["downloader"], rationale: "", budgetShare: 1, priority: 80, dependsOn: [],
    },
    target: { language: "Kotlin" },
    quality: quality(),
    license: analyzeLicense({ raw: { spdx: "Apache-2.0" }, repository: "good/repo" }),
    completeness: assessCompleteness({
      checklist: ["download", "resume", "retry"],
      symbols: [
        { id: "1", name: "Downloader", kind: "class", filePath: "a.kt" },
        { id: "2", name: "ResumeHandler", kind: "class", filePath: "b.kt" },
        { id: "3", name: "RetryPolicy", kind: "class", filePath: "c.kt" },
      ],
    }),
    integrationSurface: assessIntegrationSurface({ dependencies: [{ name: "okhttp", ecosystem: "gradle", scope: "runtime", declaredIn: "b.gradle" }] }),
    architectureMatch: 0.85,
    sources: ["github:metadata", "repo-structure", "code-index"],
  });

  it("produces a 0-100 score with an explanation", () => {
    const s = rankCandidate(strong(), { weights: DEFAULT_WEIGHTS });
    expect(s.total).toBeGreaterThan(60);
    expect(s.total).toBeLessThanOrEqual(100);
    expect(s.reasons.length).toBeGreaterThan(2);
    expect(s.reasons.some((r) => r.startsWith("+"))).toBe(true);
  });

  it("is reproducible: same evidence and weights give the same score", () => {
    const e = strong();
    expect(rankCandidate(e, { weights: DEFAULT_WEIGHTS }).total)
      .toBe(rankCandidate(e, { weights: DEFAULT_WEIGHTS }).total);
  });

  it("contributions sum to the total", () => {
    const s = rankCandidate(strong(), { weights: DEFAULT_WEIGHTS });
    const sum = Object.values(s.contributions).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - s.total)).toBeLessThan(1.5);
  });

  it("lowers confidence when axes are unmeasured, not the score to zero", () => {
    const shallow = collectEvidence({ metadata: md({ fullName: "a/b" }), sources: ["github:metadata"] });
    const s = rankCandidate(shallow, { weights: DEFAULT_WEIGHTS });
    expect(s.confidence).toBeLessThan(0.5);
    expect(s.total).toBeGreaterThan(20);   // neutral priors, not zeros
    expect(s.unmeasured.length).toBeGreaterThan(0);
  });

  it("reports higher confidence when deep analysis ran", () => {
    const deep = rankCandidate(strong(), { weights: DEFAULT_WEIGHTS });
    const shallow = rankCandidate(
      collectEvidence({ metadata: md({ fullName: "a/b" }), sources: ["github:metadata"] }),
      { weights: DEFAULT_WEIGHTS },
    );
    expect(deep.confidence).toBeGreaterThan(shallow.confidence);
  });

  it("renormalises when an axis is disabled, rather than capping the score", () => {
    const e = strong();
    const withLicence = rankCandidate(e, { weights: DEFAULT_WEIGHTS });
    const without = rankCandidate(e, { weights: DEFAULT_WEIGHTS, disabledAxes: ["licenseCompatibility"] });
    expect(without.total).toBeGreaterThan(withLicence.total - 12);
    expect(without.contributions.licenseCompatibility).toBeUndefined();
  });

  it("respects custom weights", () => {
    const e = strong();
    const popularityHeavy = rankCandidate(e, {
      weights: { ...DEFAULT_WEIGHTS, popularity: 5 } as never, weightsId: "popularity-heavy",
    });
    expect(popularityHeavy.weightsId).toBe("popularity-heavy");
    expect(popularityHeavy.contributions.popularity)
      .toBeGreaterThan(rankCandidate(e, { weights: DEFAULT_WEIGHTS }).contributions.popularity);
  });

  it("orders explanations by contribution, not raw value", () => {
    const s = rankCandidate(strong(), { weights: DEFAULT_WEIGHTS });
    const positives = s.reasons.filter((r) => r.startsWith("+"));
    expect(positives.length).toBeGreaterThan(1);
    // The top positive should reference a heavily-weighted axis, not popularity (4%).
    expect(positives[0]).not.toMatch(/Widely used/);
  });

  it("never hides the caveats", () => {
    const partial = collectEvidence({
      metadata: md({ fullName: "a/b", stars: 3, pushedAt: new Date(Date.now() - 1200 * 86_400_000).toISOString() }),
      quality: quality({ hasTests: false, testFileCount: 0, hasCi: false, hasDocs: false, releaseCount: 0 }),
      license: analyzeLicense({ raw: null, repository: "a/b" }),
      sources: ["github:metadata", "repo-structure"],
    });
    const s = rankCandidate(partial, { weights: DEFAULT_WEIGHTS });
    expect(s.reasons.some((r) => r.startsWith("-"))).toBe(true);
    expect(renderScore("a/b", s)).toContain("-");
  });

  it("reuse mode gates the score, and the adjustment is stated not hidden", () => {
    // Regression: an unlicensed but actively-maintained repository was recommended over an
    // Apache-2.0 alternative, because the licence axis alone is only 7% of the total.
    const e = strong();
    const plain = rankCandidate(e, { weights: DEFAULT_WEIGHTS });
    const referenceOnly = rankCandidate(e, {
      weights: DEFAULT_WEIGHTS,
      reuse: assessReuse({
        metadata: md({ fullName: "a/b" }), stackMatch: 1, architectureMatch: 0.9,
        license: analyzeLicense({ raw: null, repository: "a/b" }),
      }),
    });
    expect(referenceOnly.total).toBeLessThan(plain.total);
    expect(referenceOnly.reuseAdjustment?.mode).toBe("REFERENCE_ONLY");
    expect(referenceOnly.reuseAdjustment?.before).toBe(plain.total);
    expect(referenceOnly.reasons.some((r) => r.startsWith("!"))).toBe(true);
  });

  it("does not penalise DIRECT_REUSE", () => {
    const e = strong();
    const direct = rankCandidate(e, {
      weights: DEFAULT_WEIGHTS,
      reuse: assessReuse({
        metadata: md({ fullName: "a/b" }), stackMatch: 1, architectureMatch: 0.9,
        license: analyzeLicense({ raw: { spdx: "MIT" }, repository: "a/b" }),
      }),
    });
    expect(direct.total).toBe(rankCandidate(e, { weights: DEFAULT_WEIGHTS }).total);
    expect(direct.reuseAdjustment?.multiplier).toBe(1);
  });

  it("lets an outstanding REFERENCE_ONLY still beat a mediocre DIRECT_REUSE", () => {
    // The adjustment is multiplicative, not a hard sort: sometimes the best available
    // option genuinely is one you must reimplement.
    const excellent = rankCandidate(strong(), {
      weights: DEFAULT_WEIGHTS,
      reuse: { mode: "REFERENCE_ONLY", reason: "r", guidance: "g", factors: { licenseCategory: "unknown", stackMatch: 1, architectureMatch: 1, distribution: "unknown" }, obligations: [], confidence: 0.9 },
    });
    const mediocre = rankCandidate(
      collectEvidence({ metadata: md({ fullName: "c/d", stars: 2 }), sources: ["github:metadata"] }),
      { weights: DEFAULT_WEIGHTS, reuse: { mode: "DIRECT_REUSE", reason: "r", guidance: "g", factors: { licenseCategory: "permissive", stackMatch: 1, architectureMatch: 1, distribution: "unknown" }, obligations: [], confidence: 0.9 } },
    );
    expect(excellent.total).toBeGreaterThan(mediocre.total);
  });

  it("penalises DO_NOT_USE hardest without removing it from the results", () => {
    const e = strong();
    const banned = rankCandidate(e, {
      weights: DEFAULT_WEIGHTS,
      reuse: { mode: "DO_NOT_USE", reason: "AGPL vs proprietary", guidance: "g", factors: { licenseCategory: "network-copyleft", stackMatch: 1, architectureMatch: 1, distribution: "proprietary" }, obligations: [], confidence: 0.9 },
    });
    expect(banned.total).toBeLessThan(rankCandidate(e, { weights: DEFAULT_WEIGHTS }).total * 0.5);
    expect(banned.total).toBeGreaterThan(0);   // still reported, with the reason
  });

  it("penalises a candidate that evidences NONE of the checkable requirements", () => {
    // Regression: a Gradle plugin for publishing to the Samsung store scored 58 for
    // "file upload" with 0 of 6 requirements evidenced. The completeness axis is weighted
    // 0.15, so scoring zero cost only ~15 points — nowhere near what "we checked six things
    // and found none of them" actually means.
    const e = strong();
    const none = assessCompleteness({
      checklist: ["multipart encoding", "progress reporting", "retry on failure", "chunked uploads", "resumes after failure"],
      symbols: [{ id: "1", name: "SamsungPublisher", kind: "class", filePath: "src/Publisher.kt" }],
    });
    const plain = rankCandidate(e, { weights: DEFAULT_WEIGHTS });
    const penalised = rankCandidate(e, { weights: DEFAULT_WEIGHTS, completeness: none });
    expect(none.satisfied).toBe(0);
    expect(penalised.total).toBeLessThan(plain.total * 0.6);
    expect(penalised.reasons.some((r) => r.startsWith("!") && /none of the/.test(r))).toBe(true);
  });

  it("does not penalise when even one requirement is evidenced", () => {
    const e = strong();
    const some = assessCompleteness({
      checklist: ["multipart encoding", "progress reporting", "retry on failure"],
      symbols: [{ id: "1", name: "MultipartEncoder", kind: "class", filePath: "src/M.kt" }],
    });
    expect(some.satisfied).toBeGreaterThan(0);
    expect(rankCandidate(e, { weights: DEFAULT_WEIGHTS, completeness: some }).total)
      .toBe(rankCandidate(e, { weights: DEFAULT_WEIGHTS }).total);
  });

  it("does not penalise when too few requirements could be decided", () => {
    // Two checkable items finding nothing is weak evidence; five is strong.
    const e = strong();
    const thin = assessCompleteness({
      checklist: ["does something"],
      symbols: [{ id: "1", name: "Unrelated", kind: "class", filePath: "src/U.kt" }],
    });
    expect(rankCandidate(e, { weights: DEFAULT_WEIGHTS, completeness: thin }).total)
      .toBe(rankCandidate(e, { weights: DEFAULT_WEIGHTS }).total);
  });

  it("sorts by score, then confidence", () => {
    const mk = (total: number, confidence: number) => ({
      score: { total, confidence, axes: {}, contributions: {}, reasons: [], unmeasured: [], weightsId: "d" } as never,
    });
    const sorted = sortByScore([mk(80, 0.9), mk(90, 0.5), mk(80, 0.95)]);
    expect(sorted[0]!.score.total).toBe(90);
    expect(sorted[1]!.score.confidence).toBe(0.95);
  });
});

// ---------------------------------------------------------------------------

describe("deduplication (spec §19)", () => {
  const cand = (fullName: string, over: Partial<RepoMetadata> = {}): Candidate => ({
    ref: refFromFullName(fullName),
    metadata: md({ fullName, ...over }),
    discoveredVia: ["test"],
  });

  it("collapses forks into their parent", () => {
    const r = dedupeCandidates([
      cand("square/okhttp"),
      cand("someone/okhttp", { isFork: true, parent: "square/okhttp", stars: 2, pushedAt: new Date(Date.now() - 400 * 86_400_000).toISOString() }),
    ]);
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0]!.ref.fullName).toBe("square/okhttp");
    expect(r.kept[0]!.cluster?.members).toContain("someone/okhttp");
  });

  it("prefers a maintained fork over an archived original", () => {
    // Popularity is not quality (spec §7): an archived 20k-star repo is worse to recommend
    // than its live 300-star fork.
    const r = dedupeCandidates([
      cand("original/lib", { stars: 20_000, archived: true, pushedAt: new Date(Date.now() - 1000 * 86_400_000).toISOString() }),
      cand("maintainer/lib", { stars: 300, isFork: true, parent: "original/lib", pushedAt: new Date().toISOString() }),
    ]);
    expect(r.kept[0]!.ref.fullName).toBe("maintainer/lib");
  });

  it("clusters identically-named repos under different owners", () => {
    const r = dedupeCandidates([cand("a/downloader"), cand("b/downloader", { stars: 5 })]);
    expect(r.kept).toHaveLength(1);
    expect(r.clusters[0]!.reason).toBe("mirror");
  });

  it("clusters on identical substantial descriptions", () => {
    const desc = "A resumable background download manager for Android with pause and resume support";
    const r = dedupeCandidates([cand("a/one", { description: desc }), cand("b/two", { description: desc, stars: 3 })]);
    expect(r.kept).toHaveLength(1);
    expect(r.clusters[0]!.reason).toBe("description-similarity");
  });

  it("does not cluster on short generic descriptions", () => {
    const r = dedupeCandidates([cand("a/one", { description: "A Kotlin library" }), cand("b/two", { description: "A Kotlin library" })]);
    expect(r.kept).toHaveLength(2);
  });

  it("keeps genuinely distinct repositories", () => {
    const r = dedupeCandidates([cand("a/downloader"), cand("b/uploader"), cand("c/websocket-client")]);
    expect(r.kept).toHaveLength(3);
    expect(r.clusters).toHaveLength(0);
  });

  it("reports what was folded and into what", () => {
    const r = dedupeCandidates([cand("a/lib"), cand("b/lib", { stars: 1 })]);
    expect(r.folded.size).toBe(1);
    expect([...r.folded.values()][0]).toBe("a/lib");
  });

  it("handles an empty list", () => {
    expect(dedupeCandidates([]).kept).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("excludeTerms separate implementing a protocol from observing it", () => {
  /*
   * Real metadata from skymansandy/wiretapKMP, which ranked FIRST for "WebSocket transport
   * with reconnection". Every positive signal was correct: it genuinely declares the topics
   * `websocket`, `websocket-inspector` and `okhttp`, so mustMention:["websocket"] passed and
   * relevance scored 0.99. Nothing in the metadata could express that a tool which inspects
   * WebSocket traffic is not a WebSocket client.
   */
  const wiretap = {
    ref: refFromFullName("skymansandy/wiretapKMP"),
    topics: [
      "android", "api-mocking", "debugging-tool", "http-inspector", "interceptor",
      "kotlin", "ktor", "network-inspector", "okhttp", "websocket", "websocket-inspector",
    ],
    description:
      "Kotlin Multiplatform library for network inspection and mocking. Intercept HTTP and " +
      "WebSocket traffic, mock API responses, and throttle requests.",
    stars: 300, forks: 20, watchers: 10, openIssues: 2,
    isFork: false, archived: false, language: "Kotlin",
    pushedAt: new Date().toISOString(),
  };

  const wsTask = (excludeTerms?: string[]) => ({
    featureId: "websocket", feature: "WebSocket transport with reconnection",
    strategy: "reuse-library" as const, lookingFor: [], capabilities: ["websocket"],
    requirementChecklist: [], searchQueries: ["websocket reconnect okhttp"],
    rationale: "", budgetShare: 1, priority: 80, dependsOn: [],
    mustMention: ["websocket"], excludeTerms,
  });

  it("demotes a tool that describes itself with an excluded term", () => {
    const without = collectEvidence({
      metadata: wiretap, task: wsTask(), sources: ["github:metadata"],
    });
    const with_ = collectEvidence({
      metadata: wiretap, task: wsTask(["inspector", "mocking"]), sources: ["github:metadata"],
    });
    expect(without.axes.featureRelevance.value).toBeGreaterThan(0.4);
    expect(with_.axes.featureRelevance.value).toBeLessThan(without.axes.featureRelevance.value * 0.3);
    expect(with_.axes.featureRelevance.observation).toMatch(/which the feature excludes/i);
  });

  it("leaves a genuine WebSocket client untouched by the same exclusions", () => {
    const client = {
      ...wiretap,
      ref: refFromFullName("VinsonGuo/ReconnectWebSocketWrapper"),
      topics: ["websocket", "okhttp", "android", "reconnect"],
      description: "A WebSocket wrapper with automatic reconnection for Android",
    };
    const e = collectEvidence({
      metadata: client, task: wsTask(["inspector", "mocking"]), sources: ["github:metadata"],
    });
    expect(e.axes.featureRelevance.observation).not.toMatch(/excludes/i);
    // Identical to the score it gets with no exclusions declared at all.
    expect(e.axes.featureRelevance.value).toBe(
      collectEvidence({ metadata: client, task: wsTask(), sources: ["github:metadata"] })
        .axes.featureRelevance.value,
    );
  });

  it("ignores an excluded term that appears only in the README", () => {
    /*
     * A real WebSocket client's README may well discuss debugging or interceptors. Only a
     * repository that describes ITSELF as a debugging tool is one, so the exclusion is
     * matched against name, description and topics — never the body.
     */
    const e = collectEvidence({
      metadata: {
        ...wiretap,
        ref: refFromFullName("VinsonGuo/ReconnectWebSocketWrapper"),
        topics: ["websocket", "okhttp", "android"],
        description: "A WebSocket wrapper with automatic reconnection for Android",
      },
      relevanceText: "Add a logging interceptor for debugging your websocket connection.",
      task: wsTask(["inspector", "interceptor", "debugging"]),
      sources: ["github:metadata", "github:readme"],
    });
    expect(e.axes.featureRelevance.observation).not.toMatch(/excludes/i);
  });
});

describe("named products are hard requirements", () => {
  const task = (over: Partial<{ feature: string; mustMention: string[] }> = {}) => ({
    featureId: "payments", feature: "Stripe payments and subscriptions",
    strategy: "reuse-library" as const, lookingFor: [], capabilities: ["payments"],
    requirementChecklist: [], searchQueries: ["stripe"], rationale: "",
    budgetShare: 1, priority: 80, dependsOn: [], ...over,
  });

  const repo = (fullName: string, description: string, topics: string[] = []) => ({
    ref: refFromFullName(fullName), topics, description,
    stars: 1000, forks: 100, watchers: 20, openIssues: 5,
    isFork: false, archived: false, language: "Kotlin",
    pushedAt: new Date().toISOString(),
  });

  it("demotes a competitor that does not mention the named vendor", () => {
    /*
     * Asked for "Stripe payments", the system returned Adyen (80), Hook0 (73) and
     * Braintree (68) — every payment SDK except the one requested. Relevance scored them
     * highly because they are unambiguously about payments, which is true and beside the
     * point: you cannot satisfy "Stripe" with Adyen.
     */
    const withGate = collectEvidence({
      metadata: repo("Adyen/adyen-android", "Adyen Android Drop-in and Components", ["payments", "android"]),
      task: task({ mustMention: ["Stripe"] }), sources: ["github:metadata"],
    });
    const withoutGate = collectEvidence({
      metadata: repo("Adyen/adyen-android", "Adyen Android Drop-in and Components", ["payments", "android"]),
      task: task(), sources: ["github:metadata"],
    });
    expect(withGate.axes.featureRelevance.value).toBeLessThan(withoutGate.axes.featureRelevance.value);
    expect(withGate.axes.featureRelevance.observation).toMatch(/does not mention stripe/i);
  });

  it("leaves the named vendor's own SDK untouched", () => {
    const e = collectEvidence({
      metadata: repo("stripe/stripe-android", "Stripe Android SDK", ["stripe", "payments", "android"]),
      task: task({ mustMention: ["Stripe"] }), sources: ["github:metadata"],
    });
    expect(e.axes.featureRelevance.observation).not.toMatch(/does not mention/i);
  });

  it("does not fire when nothing was declared and the feature leads with a plain word", () => {
    // "Resumable" is a capitalised English adjective, not a product — guessing here would
    // silently demote correct candidates, which is why mustMention is declared not inferred.
    const e = collectEvidence({
      metadata: repo("gotev/android-upload-service", "Easily upload files", ["android", "upload"]),
      task: task({ feature: "Resumable background uploads", mustMention: undefined }),
      sources: ["github:metadata"],
    });
    expect(e.axes.featureRelevance.observation).not.toMatch(/does not mention/i);
  });
});
