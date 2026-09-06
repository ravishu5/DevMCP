import { describe, it, expect } from "vitest";
import { parseMunch, isMunch, findTable, parseToolPayload } from "../../src/providers/codeindex/munch.js";
import { computeMinimalSet } from "../../src/analyzers/minimal-set.js";
import type { CodeSymbol } from "../../src/types/index.js";
import type { CodeIndexProvider, SymbolRelations } from "../../src/providers/codeindex/types.js";

const MUNCH_SAMPLE = `#MUNCH/1 tool=list_repos enc=gen1

@1=/srv/index/repos/
@5=loadable
@9=sqlite
@65=faustomilletari/
@66=MASILab/

count=31 __stypes=count:int __tables=t:repos:repo|indexed_at|symbol_count|git_head|git_root|index_present|backend|languages|loadable:str|str|int|str|str|bool|str|str|bool

t,282857341/nnFormer,2026-09-05T23:01:37,967,d48aaeb05612a09538f70c38a2357149ea3a7ac0,@1282857341/nnFormer,T,@9,"{'yaml': 1, 'python': 164}",T
t,@66RepUX-Net,2026-09-05T22:53:19,2345,3cd20c4764fcca69e874600bc5a052a2e4125e31,@1MASILab/RepUX-Net,T,@9,"{'python': 233}",T
t,@653D-Caffe,2026-09-05T22:47:48,4421,47f1ee2ef28d546b7189f84275dc8fa189bc1189,@1faustomilletari/3D-Caffe,T,@9,"{'cpp': 182}",F`;

describe("MUNCH wire-format parser", () => {
  it("recognises the format", () => {
    expect(isMunch(MUNCH_SAMPLE)).toBe(true);
    expect(isMunch('{"a":1}')).toBe(false);
  });

  it("parses the header and scalars", () => {
    const doc = parseMunch(MUNCH_SAMPLE)!;
    expect(doc.version).toBe("1");
    expect(doc.tool).toBe("list_repos");
    expect(doc.encoding).toBe("gen1");
    expect(doc.scalars.count).toBe(31);   // coerced via __stypes
  });

  it("expands interned symbols used as whole fields", () => {
    const doc = parseMunch(MUNCH_SAMPLE)!;
    const rows = findTable(doc, "repos")!.rows;
    expect(rows[0]!.backend).toBe("sqlite");
  });

  it("expands interned symbols used as PREFIXES of longer values", () => {
    // This is the subtle case: "@66RepUX-Net" means "<@66>RepUX-Net", not a lookup of @66RepUX.
    const rows = findTable(parseMunch(MUNCH_SAMPLE)!, "repos")!.rows;
    expect(rows[1]!.repo).toBe("MASILab/RepUX-Net");
    expect(rows[2]!.repo).toBe("faustomilletari/3D-Caffe");
    expect(rows[1]!.git_root).toBe("/srv/index/repos/MASILab/RepUX-Net");
  });

  it("prefers the longest matching symbol so @1 cannot shadow @66", () => {
    const rows = findTable(parseMunch(MUNCH_SAMPLE)!, "repos")!.rows;
    // If @6/@1 shadowed @66/@65, these would be corrupted paths.
    expect(String(rows[1]!.repo)).not.toContain("/Users");
    expect(String(rows[2]!.repo)).toBe("faustomilletari/3D-Caffe");
  });

  it("coerces declared types", () => {
    const rows = findTable(parseMunch(MUNCH_SAMPLE)!, "repos")!.rows;
    expect(rows[0]!.symbol_count).toBe(967);
    expect(typeof rows[0]!.symbol_count).toBe("number");
    expect(rows[0]!.loadable).toBe(true);
    expect(rows[2]!.loadable).toBe(false);
  });

  it("respects quoted fields containing commas", () => {
    const rows = findTable(parseMunch(MUNCH_SAMPLE)!, "repos")!.rows;
    expect(rows[0]!.languages).toBe("{'yaml': 1, 'python': 164}");
  });

  it("returns null rather than throwing on unparseable input", () => {
    expect(parseMunch("not munch at all")).toBeNull();
    expect(parseMunch("")).toBeNull();
    // A truncated document should degrade, not throw.
    expect(() => parseMunch("#MUNCH/1 tool=x\n@1=\nt,broken")).not.toThrow();
  });

  it("routes JSON, MUNCH and plain text distinctly", () => {
    expect(parseToolPayload('{"a":1}').kind).toBe("json");
    expect(parseToolPayload("[1,2]").kind).toBe("json");
    expect(parseToolPayload(MUNCH_SAMPLE).kind).toBe("munch");
    expect(parseToolPayload("Error: repo not indexed").kind).toBe("text");
    // Malformed JSON must not be reported as JSON.
    expect(parseToolPayload("{broken").kind).toBe("text");
  });
});

// ---------------------------------------------------------------------------

const sym = (name: string, filePath: string, kind: CodeSymbol["kind"] = "class"): CodeSymbol => ({
  id: `${filePath}::${name}#${kind}`, name, kind, filePath,
  signature: `class ${name}`,
});

/** Stub index whose edges are declared as a plain adjacency map. */
function stubProvider(edges: Record<string, string[]>): CodeIndexProvider {
  return {
    id: "stub", mode: "code-index",
    isAvailable: async () => true,
    ensureIndexed: async (repository) => ({ repository, indexed: true }),
    getOutline: async () => null,
    searchSymbols: async () => [],
    getFileOutline: async () => [],
    getSymbolSource: async () => [],
    findImporters: async () => [],
    getRelations: async (_r, symbolId): Promise<SymbolRelations> => ({
      symbolId, callees: edges[symbolId] ?? [], callers: [], related: [], mode: "code-index",
    }),
  };
}

describe("Minimal Implementation Set", () => {
  // The worked example the minimal-set algorithm was designed against.
  const symbols = [
    sym("DownloadManager", "src/download/DownloadManager.kt"),
    sym("DownloadWorker", "src/download/DownloadWorker.kt"),
    sym("DownloadQueue", "src/download/DownloadQueue.kt"),
    sym("ResumeHandler", "src/download/ResumeHandler.kt"),
    sym("RetryPolicy", "src/download/RetryPolicy.kt"),
    sym("DownloadRepository", "src/data/DownloadRepository.kt"),
    sym("DownloadDatabase", "src/data/DownloadDatabase.kt"),
    sym("DownloadEntity", "src/data/DownloadEntity.kt"),
    sym("DownloadMapper", "src/data/DownloadMapper.kt"),
    sym("NetworkClient", "src/net/NetworkClient.kt"),
    sym("HttpClient", "src/net/HttpClient.kt"),
    sym("RetryManager", "src/net/RetryManager.kt"),
    sym("Logger", "src/util/Logger.kt"),
    sym("Analytics", "src/util/Analytics.kt"),
  ];

  const edges = {
    "src/download/DownloadManager.kt::DownloadManager#class": [
      "src/download/DownloadQueue.kt::DownloadQueue#class",
      "src/download/DownloadWorker.kt::DownloadWorker#class",
      "src/util/Logger.kt::Logger#class",
    ],
    "src/download/DownloadWorker.kt::DownloadWorker#class": [
      "src/download/ResumeHandler.kt::ResumeHandler#class",
      "src/download/RetryPolicy.kt::RetryPolicy#class",
      "src/util/Analytics.kt::Analytics#class",
    ],
    "src/download/DownloadQueue.kt::DownloadQueue#class": [
      "src/data/DownloadRepository.kt::DownloadRepository#class",
    ],
  };

  const featureTerms = ["download", "resume", "retry", "queue", "background"];

  it("reproduces the documented worked example exactly", async () => {
    // Regression guard for two bugs found while building this:
    // camelCase role matching (`\bmanager\b` never matches inside `DownloadManager`), and
    // greedy BFS letting the first-visited seed spend the budget on its own neighbours.
    const richEdges = {
      ...edges,
      "src/download/DownloadQueue.kt::DownloadQueue#class": [
        "src/data/DownloadRepository.kt::DownloadRepository#class",
        "src/data/DownloadEntity.kt::DownloadEntity#class",
      ],
    };
    const set = await computeMinimalSet(stubProvider(richEdges), {
      repository: "a/b", symbols, featureTerms, maxCore: 5,
    });
    expect(set.core.map((s) => s.name).sort()).toEqual(
      ["DownloadManager", "DownloadQueue", "DownloadWorker", "ResumeHandler", "RetryPolicy"],
    );
    expect(set.supporting.map((s) => s.name)).toContain("DownloadRepository");
    expect(set.excluded.map((e) => e.name)).toEqual(expect.arrayContaining(["Logger", "Analytics", "DownloadMapper"]));
    expect(set.connected).toBe(true);
  });

  it("ranks each traversal level before admitting, not greedily in visit order", async () => {
    // DownloadQueue is visited before DownloadManager; without level ranking its lower-value
    // neighbour (DownloadRepository) would take the last core slot from DownloadWorker.
    const richEdges = {
      ...edges,
      "src/download/DownloadQueue.kt::DownloadQueue#class": ["src/data/DownloadRepository.kt::DownloadRepository#class"],
    };
    const set = await computeMinimalSet(stubProvider(richEdges), {
      repository: "a/b", symbols, featureTerms, maxCore: 5,
    });
    expect(set.core.map((s) => s.name)).toContain("DownloadWorker");
    expect(set.core.map((s) => s.name)).not.toContain("DownloadRepository");
  });

  it("matches architectural roles inside camelCase names", async () => {
    const set = await computeMinimalSet(null, {
      repository: "a/b",
      symbols: [sym("DownloadManager", "src/DownloadManager.kt"), sym("Thing", "src/Thing.kt")],
      featureTerms: ["download"],
    });
    // Scores above the 0.45 seed threshold only if the "manager" role bonus applied.
    expect(set.core.map((s) => s.name)).toContain("DownloadManager");
    expect(set.core[0]!.relevance!).toBeGreaterThanOrEqual(0.45);
  });

  it("selects the core implementation symbols", async () => {
    const set = await computeMinimalSet(stubProvider(edges), {
      repository: "a/b", symbols, featureTerms, maxCore: 6,
    });
    const names = set.core.map((s) => s.name);
    expect(names).toContain("DownloadManager");
    expect(names).toContain("DownloadQueue");
    expect(names.length).toBeLessThanOrEqual(6);
  });

  it("excludes logging and analytics with a stated reason", async () => {
    const set = await computeMinimalSet(stubProvider(edges), {
      repository: "a/b", symbols, featureTerms,
    });
    expect(set.core.map((s) => s.name)).not.toContain("Logger");
    expect(set.core.map((s) => s.name)).not.toContain("Analytics");
    const logger = set.excluded.find((e) => e.name === "Logger");
    expect(logger?.reason).toMatch(/logging/i);
    const analytics = set.excluded.find((e) => e.name === "Analytics");
    expect(analytics?.reason).toMatch(/analytics|telemetry/i);
  });

  it("keeps architecturally-named symbols that would otherwise look like boilerplate", async () => {
    // "RetryPolicy" matches no noise rule, but "policy" is an architectural role — the
    // point is that a naive keyword filter would have dropped it.
    const set = await computeMinimalSet(stubProvider(edges), {
      repository: "a/b", symbols, featureTerms, maxCore: 8,
    });
    const kept = [...set.core, ...set.supporting].map((s) => s.name);
    expect(kept).toContain("RetryPolicy");
  });

  it("accounts for every symbol — nothing vanishes silently", async () => {
    const set = await computeMinimalSet(stubProvider(edges), {
      repository: "a/b", symbols, featureTerms,
    });
    const accounted = new Set([
      ...set.core.map((s) => s.id),
      ...set.supporting.map((s) => s.id),
      ...set.excluded.map((e) => e.symbolId),
    ]);
    for (const s of symbols) expect(accounted.has(s.id), `${s.name} unaccounted`).toBe(true);
  });

  it("reports a real token saving", async () => {
    const set = await computeMinimalSet(stubProvider(edges), {
      repository: "a/b", symbols, featureTerms, maxCore: 5,
    });
    expect(set.estimatedTokens).toBeLessThan(set.estimatedFullTokens);
    expect(set.estimatedFullTokens).toBeGreaterThan(0);
  });

  it("records its seeds and parameters so the result can be reproduced or widened", async () => {
    const set = await computeMinimalSet(stubProvider(edges), {
      repository: "a/b", symbols, featureTerms, relevanceFloor: 0.3, maxDepth: 2, tokenBudget: 900,
    });
    expect(set.seeds.length).toBeGreaterThan(0);
    expect(set.seeds[0]!.reason).toMatch(/relevance/);
    expect(set.parameters).toEqual({ relevanceFloor: 0.3, maxDepth: 2, tokenBudget: 900 });
  });

  it("demotes test symbols rather than treating them as implementation", async () => {
    const withTests = [
      ...symbols,
      sym("DownloadManagerTest", "src/test/DownloadManagerTest.kt"),
      sym("DownloadQueueSpec", "tests/DownloadQueueSpec.kt"),
    ];
    const set = await computeMinimalSet(stubProvider(edges), {
      repository: "a/b", symbols: withTests, featureTerms,
    });
    expect(set.core.map((s) => s.name)).not.toContain("DownloadManagerTest");
    const excluded = set.excluded.find((e) => e.name === "DownloadManagerTest");
    expect(excluded?.reason).toMatch(/test/i);
  });

  it("works without a provider, marking the set as not connected", async () => {
    const set = await computeMinimalSet(null, {
      repository: "a/b", symbols, featureTerms, maxCore: 5,
    });
    expect(set.core.length).toBeGreaterThan(0);
    expect(set.connected).toBe(false);   // no edges were available to prove connectivity
  });

  it("respects the token budget", async () => {
    const tight = await computeMinimalSet(stubProvider(edges), {
      repository: "a/b", symbols, featureTerms, tokenBudget: 40,
    });
    const loose = await computeMinimalSet(stubProvider(edges), {
      repository: "a/b", symbols, featureTerms, tokenBudget: 2000,
    });
    expect(tight.core.length).toBeLessThanOrEqual(loose.core.length);
  });

  it("degrades honestly when nothing is relevant", async () => {
    const irrelevant = [sym("Foo", "src/Foo.kt"), sym("Bar", "src/Bar.kt")];
    const set = await computeMinimalSet(stubProvider({}), {
      repository: "a/b", symbols: irrelevant, featureTerms: ["download", "resume"],
    });
    expect(set.connected).toBe(false);
    expect(set.seeds).toHaveLength(0);
  });

  it("survives a provider whose relations throw", async () => {
    const broken: CodeIndexProvider = {
      ...stubProvider(edges),
      getRelations: async () => { throw new Error("index exploded"); },
    };
    const set = await computeMinimalSet(broken, { repository: "a/b", symbols, featureTerms });
    expect(set.core.length).toBeGreaterThan(0);
  });

  it("excludes config and CI files, whatever the index extracted from them", async () => {
    // Regression: an HTTP-client query returned `name` and `python-version` from
    // .github/workflows/build.yml as its five "key symbols".
    const polluted = [
      { id: ".github/workflows/build.yml::name#constant", name: "name", kind: "constant" as const, filePath: ".github/workflows/build.yml" },
      { id: ".github/workflows/build.yml::python-version#constant", name: "python-version", kind: "constant" as const, filePath: ".github/workflows/build.yml" },
      { id: "docs/guide.md::client#constant", name: "client", kind: "constant" as const, filePath: "docs/guide.md" },
      sym("HttpClient", "src/net/HttpClient.kt"),
    ];
    const set = await computeMinimalSet(null, {
      repository: "a/b", symbols: polluted, featureTerms: ["http", "client", "connection"],
    });
    const coreFiles = set.core.map((s) => s.filePath);
    expect(coreFiles.every((f) => !f.includes(".github/") && !f.startsWith("docs/"))).toBe(true);
    expect(set.excluded.find((e) => e.name === "name")?.reason).toMatch(/CI configuration/i);
    expect(set.excluded.find((e) => e.name === "client")?.reason).toMatch(/documentation/i);
  });

  it("returns an empty core rather than arbitrary symbols when nothing is relevant", async () => {
    const set = await computeMinimalSet(null, {
      repository: "a/b",
      symbols: [
        { id: "a.yml::name#constant", name: "name", kind: "constant" as const, filePath: "a.yml" },
        { id: "b.yml::version#constant", name: "version", kind: "constant" as const, filePath: "b.yml" },
      ],
      featureTerms: ["download", "resume"],
    });
    expect(set.core).toEqual([]);
    expect(set.excluded.length).toBeGreaterThan(0);
  });

  it("path exclusions cannot be overridden by name heuristics", async () => {
    // Regression: `test_session_get_adapter_prefix` matched the "adapter" noise rule, was
    // rescued by the "session" architectural-role override, and reached the core set —
    // because the name override short-circuited the test-PATH check.
    const set = await computeMinimalSet(null, {
      repository: "a/b",
      symbols: [
        { id: "tests/test_requests.py::test_session_get_adapter_prefix#function",
          name: "test_session_get_adapter_prefix", kind: "function" as const,
          filePath: "tests/test_requests.py", relevance: 1 },
        { id: "src/adapters.py::HTTPAdapter#class", name: "HTTPAdapter", kind: "class" as const,
          filePath: "src/adapters.py", relevance: 1 },
      ],
      featureTerms: ["session", "adapter", "http"],
    });
    expect(set.core.map((s) => s.filePath)).not.toContain("tests/test_requests.py");
    expect(set.excluded.find((e) => e.name === "test_session_get_adapter_prefix")?.reason).toMatch(/test file/i);
  });

  it("recognises test files by naming convention as well as directory", async () => {
    for (const filePath of ["foo_test.go", "src/thing.test.ts", "src/thing.spec.js", "test_module.py"]) {
      const set = await computeMinimalSet(null, {
        repository: "a/b",
        symbols: [{ id: `${filePath}::DownloadManager#class`, name: "DownloadManager", kind: "class" as const, filePath, relevance: 1 }],
        featureTerms: ["download"],
      });
      expect(set.core.map((s) => s.filePath), filePath).not.toContain(filePath);
    }
  });

  it("excludes constant tables, which carry feature vocabulary but no behaviour", async () => {
    // Regression: FAILED_RENAME_FILE_ASSOCIATED_WITH_INCOMPLETE_DOWNLOAD matched every
    // download term and reached the core set of a download bundle, explaining nothing.
    const set = await computeMinimalSet(null, {
      repository: "a/b",
      symbols: [
        { id: "core/ErrorStrings.kt::FAILED_RENAME_FILE_ASSOCIATED_WITH_INCOMPLETE_DOWNLOAD#constant",
          name: "FAILED_RENAME_FILE_ASSOCIATED_WITH_INCOMPLETE_DOWNLOAD", kind: "constant" as const,
          filePath: "core/ErrorStrings.kt" },
        { id: "core/Consts.kt::DOWNLOAD_RESUME_RETRY_MAX#constant",
          name: "DOWNLOAD_RESUME_RETRY_MAX", kind: "constant" as const, filePath: "core/Consts.kt" },
        sym("DownloadResumeHandler", "src/DownloadResumeHandler.kt"),
      ],
      featureTerms: ["download", "resume", "retry", "file"],
    });
    expect(set.core.map((s) => s.name)).toEqual(["DownloadResumeHandler"]);
    expect(set.excluded.find((e) => e.name.startsWith("FAILED_RENAME"))?.reason).toMatch(/constant/i);
    expect(set.excluded.find((e) => e.name === "DOWNLOAD_RESUME_RETRY_MAX")?.reason).toMatch(/constant/i);
  });

  it("excludes sample and demo modules — a repository's advertising, not its library", async () => {
    const set = await computeMinimalSet(null, {
      repository: "a/b",
      symbols: [
        sym("DownloadManager", "sampleApp/src/main/java/DownloadManager.kt"),
        sym("DownloadManager", "fetch2/src/main/java/DownloadManager.kt"),
      ],
      featureTerms: ["download"],
    });
    expect(set.core.map((s) => s.filePath)).toEqual(["fetch2/src/main/java/DownloadManager.kt"]);
    expect(set.excluded[0]?.reason).toMatch(/sample or demo/i);
  });

  it("keeps a constant that names an architectural role", async () => {
    // `RETRY_POLICY_DEFAULT` is a strategy token worth seeing; `MAX_ATTEMPTS` is not.
    const set = await computeMinimalSet(null, {
      repository: "a/b",
      symbols: [
        { id: "a.kt::DOWNLOAD_RETRY_POLICY#constant", name: "DOWNLOAD_RETRY_POLICY",
          kind: "constant" as const, filePath: "src/a.kt" },
      ],
      featureTerms: ["download", "retry"],
    });
    expect(set.excluded.map((e) => e.name)).not.toContain("DOWNLOAD_RETRY_POLICY");
  });

  it("excludes SCREAMING_SNAKE_CASE even when the index did not label it a constant", async () => {
    const set = await computeMinimalSet(null, {
      repository: "a/b",
      symbols: [
        { id: "a.kt::MAX_DOWNLOAD_RETRY_ATTEMPTS#unknown", name: "MAX_DOWNLOAD_RETRY_ATTEMPTS",
          kind: "unknown" as const, filePath: "src/a.kt" },
        sym("DownloadRetryPolicy", "src/DownloadRetryPolicy.kt"),
      ],
      featureTerms: ["download", "retry"],
    });
    expect(set.core[0]!.name).toBe("DownloadRetryPolicy");
  });

  it("handles an empty symbol list", async () => {
    const set = await computeMinimalSet(null, { repository: "a/b", symbols: [], featureTerms: ["x"] });
    expect(set.core).toEqual([]);
    expect(set.estimatedFullTokens).toBe(0);
  });
});
