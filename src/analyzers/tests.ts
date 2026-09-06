/**
 * Test discovery (spec §4 find_tests).
 *
 * "Tests are extremely important. Prefer implementations that have strong tests."
 *
 * The valuable output is not a count — it is **which edge cases the tests visibly
 * exercise**. A coding agent adapting an implementation needs to know that the original
 * handled "resume after a 416 response" and "cancel mid-write", because those are exactly
 * the cases it will otherwise omit and rediscover in production.
 *
 * Test *names* are the primary evidence, and they are unusually good evidence: developers
 * name tests after the condition being tested, so `test_resume_after_connection_reset` is a
 * self-describing specification. We never execute anything (spec §22).
 */

import type { CodeSymbol, TestArtifact, TestReport } from "../types/index.js";
import type { Dependency } from "../types/index.js";

export interface TestAnalysisInput {
  filePaths: string[];
  /** Symbols from the code index, when available — gives us test names, not just files. */
  symbols?: CodeSymbol[];
  dependencies?: Dependency[];
  /** Feature terms, used to judge whether the tests cover the capability we care about. */
  featureTerms?: string[];
}

const TEST_FILE = [
  /(^|\/)(test|tests|spec|specs|__tests__|testing)\//i,
  /(^|\/)src\/test\//i,
  /(^|\/)androidTest\//i,
  /\.(test|spec)\.[jt]sx?$/i,
  /_test\.(go|py|rb|dart)$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /Test[s]?\.(java|kt|swift|cs|scala)$/i,
];

const INTEGRATION_HINT = /(integration|e2e|end.?to.?end|functional|acceptance|smoke|androidTest|instrumented)/i;
const FIXTURE_HINT = /(fixture|testdata|test.?data|golden|snapshot|__snapshots__|resources?\/test|mock.?data|cassette|vcr)/i;
const MOCK_HINT = /(mock|stub|fake|double|spy|dummy)/i;
const UTIL_HINT = /(helper|util|support|conftest|setup|base.?test|test.?base|factory)/i;

/** Test framework markers, per ecosystem. */
const FRAMEWORKS: [RegExp, string][] = [
  [/\b(junit|junit-jupiter|junit5)\b/i, "JUnit"],
  [/\bmockito\b/i, "Mockito"],
  [/\brobolectric\b/i, "Robolectric"],
  [/\bespresso\b/i, "Espresso"],
  [/\bkotest\b/i, "Kotest"],
  [/\bmockk\b/i, "MockK"],
  [/\btruth\b/i, "Truth"],
  [/\bassertj\b/i, "AssertJ"],
  [/\b(jest|@types\/jest)\b/i, "Jest"],
  [/\bvitest\b/i, "Vitest"],
  [/\bmocha\b/i, "Mocha"],
  [/\bjasmine\b/i, "Jasmine"],
  [/\b(testing-library|@testing-library)\b/i, "Testing Library"],
  [/\bplaywright\b/i, "Playwright"],
  [/\bcypress\b/i, "Cypress"],
  [/\bpytest\b/i, "pytest"],
  [/\bunittest2?\b/i, "unittest"],
  [/\bhypothesis\b/i, "Hypothesis"],
  [/\btestify\b/i, "testify"],
  [/\bginkgo\b/i, "Ginkgo"],
  [/\brspec\b/i, "RSpec"],
  [/\bxctest\b/i, "XCTest"],
  [/\bquick\/nimble\b/i, "Quick/Nimble"],
  [/\bxunit\b/i, "xUnit"],
  [/\bnunit\b/i, "NUnit"],
  [/\bcriterion\b/i, "Criterion"],
  [/\bproptest\b/i, "proptest"],
];

/**
 * Edge-case vocabulary.
 *
 * These are the conditions that separate a production implementation from a happy-path
 * one, and they are the highest-value thing this analyzer produces: an agent told that the
 * source handled cancellation, timeouts and malformed input will handle them too.
 */
const EDGE_CASES: [RegExp, string][] = [
  [/\b(empty|blank|null|nil|none|undefined|missing)\b/i, "empty/null input"],
  [/\b(invalid|malformed|corrupt|bad|garbage|unparseable)\b/i, "malformed input"],
  [/\b(timeout|timed?.?out|deadline|expire[ds]?|expiry)\b/i, "timeouts and expiry"],
  [/\b(retry|retries|backoff|transient)\b/i, "retry behaviour"],
  [/\b(cancel|abort|interrupt|stop|shutdown)\b/i, "cancellation"],
  [/\b(concurrent|parallel|race|thread.?safe|atomic|lock)\b/i, "concurrency"],
  [/\b(large|huge|big|overflow|limit|boundary|max|oversize)\b/i, "size limits and boundaries"],
  [/\b(offline|disconnect|network.?(error|failure)|unreachable|connection.?(reset|refused|lost))\b/i, "network failure"],
  [/\b(resume|restart|reconnect|recover|restore)\b/i, "resumption and recovery"],
  [/\b(duplicate|idempotent|repeat|twice|reentrant)\b/i, "idempotency and duplicates"],
  [/\b(permission|unauthoriz|forbidden|denied|auth.?(fail|error))\b/i, "authorisation failure"],
  [/\b(unicode|utf|encoding|charset|special.?char|emoji)\b/i, "encoding and unicode"],
  [/\b(negative|zero|one|single|boundary|off.?by.?one)\b/i, "numeric boundaries"],
  [/\b(conflict|collision|clash|merge)\b/i, "conflict handling"],
  [/\b(partial|incomplete|truncat|chunk)\b/i, "partial data"],
  [/\b(disk.?full|out.?of.?(memory|space)|quota|exhaust)\b/i, "resource exhaustion"],
];

export function analyzeTests(input: TestAnalysisInput): TestReport {
  const testFiles = input.filePaths.filter(isTestFile);
  const notes: string[] = [];

  if (testFiles.length === 0) {
    return {
      hasTests: false, frameworks: [], unitTests: [], integrationTests: [],
      fixtures: [], mocks: [], testUtilities: [], edgeCasesCovered: [],
      featureTestConfidence: 0,
      notes: input.filePaths.length
        ? ["No test files found. Adopting this implementation means writing its tests yourself."]
        : ["Repository tree unavailable; test presence could not be determined."],
    };
  }

  // --- frameworks ----------------------------------------------------------
  // From declared dependencies first (authoritative), then from paths (weaker).
  const depText = (input.dependencies ?? []).map((d) => d.name).join(" ");
  const pathText = testFiles.join(" ");
  const frameworks = [...new Set(
    FRAMEWORKS.filter(([re]) => re.test(depText) || re.test(pathText)).map(([, name]) => name),
  )];

  // --- classify test artefacts --------------------------------------------
  const testSymbols = (input.symbols ?? []).filter((s) => isTestFile(s.filePath));
  const unitTests: TestArtifact[] = [];
  const integrationTests: TestArtifact[] = [];

  if (testSymbols.length) {
    // Symbol-level: we know individual test NAMES, which is far richer than file names.
    for (const s of testSymbols) {
      if (!looksLikeTest(s.name)) continue;
      const artifact: TestArtifact = {
        filePath: s.filePath,
        name: s.name,
        symbolId: s.id,
        asserts: describeTest(s.name),
      };
      (INTEGRATION_HINT.test(s.filePath) || INTEGRATION_HINT.test(s.name) ? integrationTests : unitTests)
        .push(artifact);
    }
  } else {
    // File-level only. Honest about the reduced resolution.
    for (const f of testFiles) {
      (INTEGRATION_HINT.test(f) ? integrationTests : unitTests).push({ filePath: f });
    }
    notes.push("Test names unavailable (no code index); classification is by file path only.");
  }

  // --- supporting artefacts ------------------------------------------------
  const fixtures = input.filePaths.filter((p) => FIXTURE_HINT.test(p)).slice(0, 12);
  const mocks = [
    ...testFiles.filter((p) => MOCK_HINT.test(p)),
    ...testSymbols.filter((s) => MOCK_HINT.test(s.name)).map((s) => s.filePath),
  ];
  const testUtilities = testFiles.filter((p) => UTIL_HINT.test(p)).slice(0, 10);

  // --- edge cases ----------------------------------------------------------
  // Scanned over test NAMES where we have them, file paths otherwise.
  const corpus = testSymbols.length
    ? testSymbols.map((s) => humanise(s.name)).join(" \n")
    : testFiles.join(" \n");
  const edgeCasesCovered = [...new Set(
    EDGE_CASES.filter(([re]) => re.test(corpus)).map(([, label]) => label),
  )];

  // --- does any of this test the feature we care about? --------------------
  const featureTestConfidence = scoreFeatureCoverage(
    input.featureTerms ?? [], testSymbols, testFiles, corpus,
  );
  if (featureTestConfidence < 0.3 && (input.featureTerms?.length ?? 0) > 0) {
    notes.push(
      "The repository has tests, but little evidence that the requested capability specifically is covered. " +
      "Verify before relying on it.",
    );
  }
  if (integrationTests.length === 0 && unitTests.length > 0) {
    notes.push("Unit tests only — no integration tests detected.");
  }

  return {
    hasTests: true,
    frameworks,
    unitTests: unitTests.slice(0, 25),
    integrationTests: integrationTests.slice(0, 15),
    fixtures,
    mocks: [...new Set(mocks)].slice(0, 10),
    testUtilities,
    edgeCasesCovered,
    featureTestConfidence,
    notes,
  };
}

/**
 * Confidence that the *requested* capability is tested, not merely that tests exist.
 *
 * A repository can have 200 tests and none touching the feature you need. That distinction
 * is what makes this a useful ranking signal rather than a test-count proxy.
 */
function scoreFeatureCoverage(
  featureTerms: string[], testSymbols: CodeSymbol[], testFiles: string[], corpus: string,
): number {
  if (!featureTerms.length) return testSymbols.length || testFiles.length ? 0.5 : 0;

  const terms = [...new Set(featureTerms.map((t) => t.toLowerCase()).filter((t) => t.length >= 4))];
  if (!terms.length) return 0.5;

  const haystack = (corpus + " " + testFiles.join(" ")).toLowerCase();
  const matched = terms.filter((t) => haystack.includes(t));
  const coverage = matched.length / terms.length;

  // Named test symbols are stronger evidence than file names: a file called
  // `DownloadTest.kt` proves less than a test named `resumes_after_connection_reset`.
  const resolution = testSymbols.length ? 1 : 0.7;
  return Math.round(Math.min(1, coverage * resolution + (matched.length ? 0.15 : 0)) * 100) / 100;
}

function isTestFile(path: string): boolean {
  return TEST_FILE.some((re) => re.test(path));
}

function looksLikeTest(name: string): boolean {
  return /^(test|it|should|when|given)/i.test(name) || /(test|spec)$/i.test(name);
}

/** Turn `test_resume_after_connection_reset` into readable prose. */
function describeTest(name: string): string {
  const cleaned = humanise(name)
    .replace(/^(test|it|should|when|given)\s+/i, "")
    .trim();
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : name;
}

function humanise(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}
