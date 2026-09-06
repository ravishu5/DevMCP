import { describe, it, expect } from "vitest";
import { assessReusability } from "../../src/analyzers/reusability.js";
import { assessReuse } from "../../src/analyzers/reuse.js";
import { analyzeLicense } from "../../src/analyzers/license.js";
import { sortByScore, sortByScoreOnly } from "../../src/ranking/engine.js";
import { generateQueries, generateQueriesDetailed, isCapabilityLabel } from "../../src/analyzers/query.js";
import { CAPABILITY_BY_ID, findStackIdioms } from "../../src/knowledge/vocabulary.js";
import { refFromFullName } from "../../src/providers/github/types.js";
import type { RepoMetadata } from "../../src/types/index.js";

const md = (over: Partial<RepoMetadata> & { fullName: string }): RepoMetadata => ({
  ref: refFromFullName(over.fullName), topics: [], stars: 100, forks: 10, watchers: 5,
  openIssues: 2, isFork: false, archived: false, language: "Kotlin",
  pushedAt: new Date().toISOString(), ...over,
});

describe("library vs application (reusability)", () => {
  it("recognises a library from its publishing configuration", () => {
    const r = assessReusability({
      metadata: md({ fullName: "square/okhttp", description: "An HTTP client for Android" }),
      manifestContents: [`plugins { id("maven-publish") }\npublishing { publications { } }`],
      filePaths: ["okhttp/src/main/kotlin/OkHttpClient.kt", "build.gradle.kts"],
    });
    expect(r.kind).toBe("library");
    expect(r.score).toBe(1);
    expect(r.signals.join(" ")).toMatch(/maven-publish|publishing/i);
  });

  it("recognises an Android application from applicationId", () => {
    // Regression: a plant-care app ranked FIRST for "local persistence", because an app
    // using Room genuinely implements schemas, DAOs, migrations and transactional writes.
    const r = assessReusability({
      metadata: md({ fullName: "someone/taru-plants-android", description: "Plant care app", topics: ["android-app"] }),
      manifestContents: [`android { defaultConfig { applicationId "com.example.plants" } }`],
      filePaths: ["app/src/main/AndroidManifest.xml", "app/src/main/java/MainActivity.kt"],
    });
    expect(r.kind).toBe("application");
    expect(r.score).toBeLessThan(0.3);
  });

  it("recognises a demo or sample project", () => {
    const r = assessReusability({
      metadata: md({
        fullName: "someone/Android-Kotlin-Demo-WorkManager",
        description: "Demo project showing WorkManager chaining", topics: ["demo", "sample"],
      }),
      manifestContents: [`android { defaultConfig { applicationId "com.demo" } }`],
      filePaths: ["app/src/main/AndroidManifest.xml"],
    });
    expect(r.kind).toBe("example");
  });

  it("treats a library that ships a sample app as a library", () => {
    const r = assessReusability({
      metadata: md({ fullName: "tonyofrancis/Fetch", description: "Download manager library", topics: ["library"] }),
      manifestContents: [`publishing { publications { } }`],
      filePaths: [
        "fetch2/src/main/AndroidManifest.xml",
        "sampleApp/src/main/AndroidManifest.xml",
        "fetch2/src/main/java/Fetch.kt",
      ],
    });
    expect(r.kind).toBe("library");
  });

  it("credits a README that documents installing it as a dependency", () => {
    const r = assessReusability({
      metadata: md({ fullName: "a/b" }),
      readme: '## Install\n```groovy\nimplementation("com.example:thing:1.0")\n```',
    });
    expect(r.score).toBeGreaterThan(0.5);
  });

  it("returns unknown with low confidence when there is no evidence", () => {
    const r = assessReusability({ metadata: md({ fullName: "a/b" }) });
    expect(r.kind).toBe("unknown");
    expect(r.score).toBe(0.5);        // neutral, not penalised
    expect(r.confidence).toBeLessThan(0.2);
  });

  it("explains its classification", () => {
    const r = assessReusability({
      metadata: md({ fullName: "a/b", topics: ["library"] }),
      manifestContents: [`publishing {}`],
    });
    expect(r.signals.length).toBeGreaterThan(0);
  });
});

describe("an application cannot be DIRECT_REUSE", () => {
  const base = {
    metadata: md({ fullName: "a/plants" }),
    license: analyzeLicense({ raw: { spdx: "MIT" }, repository: "a/plants" }),
    stackMatch: 1,
    architectureMatch: 0.9,
  };

  it("downgrades a perfect-fit application to REFERENCE_ONLY", () => {
    // Permissive licence, exact stack, compatible architecture — and still not something
    // you can depend on, because there is no artifact.
    const r = assessReuse({
      ...base,
      reusability: { kind: "application", score: 0.15, confidence: 0.8, signals: ["- Android applicationId"] },
    });
    expect(r.mode).toBe("REFERENCE_ONLY");
    expect(r.reason).toMatch(/no artifact to depend on/i);
    expect(r.guidance).toMatch(/find_alternative/);
  });

  it("downgrades a sample project too, with a distinct reason", () => {
    const r = assessReuse({
      ...base,
      reusability: { kind: "example", score: 0.2, confidence: 0.7, signals: [] },
    });
    expect(r.mode).toBe("REFERENCE_ONLY");
    expect(r.reason).toMatch(/sample or demo/i);
  });

  it("leaves a library alone", () => {
    const r = assessReuse({
      ...base,
      reusability: { kind: "library", score: 1, confidence: 0.8, signals: [] },
    });
    expect(r.mode).toBe("DIRECT_REUSE");
  });

  it("does not act on a low-confidence classification", () => {
    // Guessing "application" from one weak signal must not veto reuse.
    const r = assessReuse({
      ...base,
      reusability: { kind: "application", score: 0.15, confidence: 0.2, signals: [] },
    });
    expect(r.mode).toBe("DIRECT_REUSE");
  });

  it("licence still gates ahead of everything", () => {
    const r = assessReuse({
      ...base,
      license: analyzeLicense({ raw: { spdx: "AGPL-3.0" }, repository: "a/b", target: { distribution: "proprietary" } }),
      target: { distribution: "proprietary" },
      reusability: { kind: "library", score: 1, confidence: 0.9, signals: [] },
    });
    expect(r.mode).toBe("DO_NOT_USE");
  });
});

describe("unexamined candidates cannot be recommended", () => {
  const cand = (name: string, total: number, confidence: number, depth?: "deep" | "metadata") => ({
    name,
    analysisDepth: depth,
    score: { total, confidence, axes: {}, contributions: {}, reasons: [], unmeasured: [], weightsId: "d" } as never,
  });

  it("ranks a deeply-analysed candidate above a higher-scoring unexamined one", () => {
    // Observed live: two never-analysed repos scored 61 (confidence 0.38) and outranked the
    // one actually examined at 60 (confidence 0.81). Unmeasured axes sit at a neutral 0.5
    // prior, so a repository we never opened accumulates a respectable total from priors.
    const sorted = sortByScore([
      cand("unexamined-a", 61, 0.38, "metadata"),
      cand("unexamined-b", 61, 0.38, "metadata"),
      cand("examined", 60, 0.81, "deep"),
    ]);
    expect(sorted[0]!.name).toBe("examined");
  });

  it("keeps unexamined candidates in the list rather than dropping them", () => {
    const sorted = sortByScore([
      cand("unexamined", 61, 0.38, "metadata"),
      cand("examined", 60, 0.81, "deep"),
    ]);
    expect(sorted).toHaveLength(2);
    expect(sorted[1]!.name).toBe("unexamined");
  });

  it("orders within a tier by score", () => {
    const sorted = sortByScore([
      cand("low", 50, 0.8, "deep"),
      cand("high", 80, 0.8, "deep"),
    ]);
    expect(sorted[0]!.name).toBe("high");
  });

  it("shortlisting ignores depth, because nothing is analysed yet", () => {
    const sorted = sortByScoreOnly([
      cand("a", 60, 0.4),
      cand("b", 70, 0.4),
    ]);
    expect(sorted[0]!.name).toBe("b");
  });
});

describe("query generation for capability labels", () => {
  it("recognises a generated capability label", () => {
    expect(isCapabilityLabel("Local persistence", CAPABILITY_BY_ID.get("persistence"))).toBe(true);
    expect(isCapabilityLabel("Resumable transfer", CAPABILITY_BY_ID.get("resume"))).toBe(true);
    expect(isCapabilityLabel("resumable downloads with pause", CAPABILITY_BY_ID.get("resume"))).toBe(false);
  });

  it("never emits topic:resume, which belongs to CV builders", () => {
    // Regression: "Resumable transfer" surfaced an ai-resume-analyzer as a candidate.
    const qs = generateQueries({ feature: "Resumable transfer", capabilityId: "resume", limit: 6 });
    expect(qs).not.toContain("topic:resume");
    expect(qs.some((q) => q.startsWith("topic:resumable-download"))).toBe(true);
  });

  it("uses capability topic overrides where they exist", () => {
    const qs = generateQueriesDetailed({ feature: "Job / task queue", capabilityId: "queue", limit: 6 });
    const topics = qs.filter((q) => q.shape === "topic").map((q) => q.query);
    expect(topics).toContain("topic:job-queue");
  });

  it("still derives a topic when a capability has no override", () => {
    const qs = generateQueriesDetailed({ feature: "Caching", capabilityId: "caching", limit: 6 });
    expect(qs.some((q) => q.shape === "topic" && /^topic:[a-z0-9-]+$/.test(q.query))).toBe(true);
  });

  it("keeps the caller's own phrasing, which is specific", () => {
    const idioms = findStackIdioms("Kotlin", "Android");
    const qs = generateQueries({
      feature: "resumable background downloader with pause", capabilityId: "resume",
      stack: { language: "Kotlin" }, idioms, limit: 6,
    });
    expect(qs.join(" | ")).toContain("resumable background downloader with pause");
  });
});
