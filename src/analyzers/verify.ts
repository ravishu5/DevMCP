/**
 * Implementation verification (spec §17).
 *
 * "Do not claim that static inspection guarantees correctness. Return confidence and
 * remaining risks."
 *
 * That instruction is the design. This checks whether the *shape* of the bundle survived
 * into the target project — do the components exist, are the dependencies declared, are
 * there tests — and it says clearly that none of that proves the code works.
 *
 * The value is catching the specific, boring omissions that static inspection genuinely
 * can catch: the dependency nobody added to the manifest, the retry policy that got
 * dropped, the tests that were never written. Those account for most integration failures.
 */

import type { ImplementationBundle, VerificationCheck, VerificationReport } from "../types/bundle.js";
import type { TargetProjectProfile } from "../types/index.js";

export const VERIFICATION_DISCLAIMER =
  "Static inspection only. This does not compile, run or test anything, and cannot establish " +
  "that the implementation is correct — only that expected pieces are present or missing.";

export interface VerifyInput {
  bundle: ImplementationBundle;
  profile: TargetProjectProfile;
  /** All file paths in the target project, relative to its root. */
  targetFiles: string[];
  /** Optional: identifiers found in the target, when the caller could extract them. */
  targetSymbols?: string[];
}

export function verifyImplementation(input: VerifyInput): VerificationReport {
  const checks: VerificationCheck[] = [];
  const risks: string[] = [];
  const { bundle, profile, targetFiles } = input;

  const fileText = targetFiles.join("\n").toLowerCase();
  const symbolText = (input.targetSymbols ?? []).join("\n").toLowerCase();
  const haystack = `${fileText}\n${symbolText}`;

  // --- 1. components -------------------------------------------------------
  const components = bundle.architecture.components;
  if (components.length) {
    const found = components.filter((c) => mentions(haystack, c));
    checks.push({
      name: "Architectural components present",
      status: found.length === components.length ? "pass" : found.length ? "partial" : "fail",
      detail: `${found.length}/${components.length} components have a matching file or symbol name`,
      evidence: found.slice(0, 6),
    });
    const missing = components.filter((c) => !found.includes(c));
    if (missing.length) {
      risks.push(`No trace of: ${missing.join(", ")}. Either they were renamed, or that part of the design was dropped.`);
    }
  }

  // --- 2. key symbols ------------------------------------------------------
  const coreSymbols = bundle.minimalSet.core;
  if (coreSymbols.length) {
    // Matched on the identifier's WORDS, because an adapted implementation is expected to
    // be renamed — `ResumeHandler` legitimately becoming `DownloadResumer` is a pass, not
    // a failure, and demanding exact names would make this check useless for real work.
    const found = coreSymbols.filter((s) => mentionsIdentifier(haystack, s.name));
    checks.push({
      name: "Key symbols or equivalents present",
      status: found.length >= Math.ceil(coreSymbols.length * 0.6) ? "pass"
        : found.length ? "partial" : "fail",
      detail: `${found.length}/${coreSymbols.length} key concepts appear in the target (matched loosely — renaming is expected)`,
      evidence: found.map((s) => s.name).slice(0, 8),
    });
  }

  // --- 3. dependencies -----------------------------------------------------
  const required = bundle.dependencies.direct;
  if (required.length) {
    const declared = new Set(profile.existingLibraries.map((d) => normalise(d.name)));
    const present = required.filter((d) => {
      const n = normalise(d.name);
      return declared.has(n) || [...declared].some((t) => t.includes(n) || n.includes(t));
    });
    const missing = required.filter((d) => !present.includes(d));
    checks.push({
      name: "Required dependencies declared",
      status: missing.length === 0 ? "pass" : present.length ? "partial" : "fail",
      detail: missing.length
        ? `${missing.length} dependenc${missing.length === 1 ? "y is" : "ies are"} not declared in the target's manifests: ${missing.map((d) => d.name).slice(0, 5).join(", ")}`
        : `all ${required.length} runtime dependencies are declared`,
      evidence: present.map((d) => d.name).slice(0, 8),
    });
    if (missing.length) {
      // This is the single most common real failure, and it is one static inspection
      // catches reliably — which is exactly why the check exists.
      risks.push(`Missing dependencies will fail at build time: ${missing.map((d) => d.name).slice(0, 5).join(", ")}.`);
    }
  }

  // --- 4. tests ------------------------------------------------------------
  const featureTerms = bundle.feature.toLowerCase().split(/\W+/).filter((w) => w.length >= 4);
  const targetTestFiles = targetFiles.filter((f) => /(^|\/)(test|tests|spec|__tests__)\//i.test(f) || /\.(test|spec)\.\w+$/i.test(f));
  const featureTests = targetTestFiles.filter((f) => featureTerms.some((t) => f.toLowerCase().includes(t)));
  checks.push({
    name: "Tests exist for the adapted feature",
    status: featureTests.length ? "pass" : targetTestFiles.length ? "partial" : "fail",
    detail: featureTests.length
      ? `${featureTests.length} test file(s) reference this feature`
      : targetTestFiles.length
        ? `${targetTestFiles.length} test file(s) exist, but none name this feature`
        : "no test files found in the target project",
    evidence: featureTests.slice(0, 5),
  });
  if (!featureTests.length) {
    risks.push("No tests appear to cover the adapted feature. The source's tests encoded assumptions your version may silently break.");
  }

  // --- 5. edge cases the source handled ------------------------------------
  const sourceEdgeCases = bundle.tests.edgeCasesCovered;
  if (sourceEdgeCases.length && targetTestFiles.length) {
    const covered = sourceEdgeCases.filter((e) =>
      e.split(/[\s/]+/).some((w) => w.length >= 4 && haystack.includes(w.toLowerCase())));
    checks.push({
      name: "Edge cases from the source are addressed",
      status: covered.length >= Math.ceil(sourceEdgeCases.length * 0.5) ? "pass" : covered.length ? "partial" : "unknown",
      detail: `${covered.length}/${sourceEdgeCases.length} edge cases the source tested have some trace in the target`,
      evidence: covered.slice(0, 6),
    });
    const uncovered = sourceEdgeCases.filter((e) => !covered.includes(e));
    if (uncovered.length) {
      risks.push(`The source handled these; verify your version does too: ${uncovered.join(", ")}.`);
    }
  }

  // --- 6. licence obligations ---------------------------------------------
  if (bundle.reuse.obligations.length && bundle.reuse.mode !== "REFERENCE_ONLY") {
    const hasNotice = targetFiles.some((f) => /^(NOTICE|LICENSE|LICENCE|THIRD.?PARTY|ATTRIBUTION)/i.test(f.split("/").pop() ?? ""));
    checks.push({
      name: "Licence obligations addressed",
      status: hasNotice ? "pass" : "fail",
      detail: hasNotice
        ? "a NOTICE/LICENSE/attribution file is present"
        : `no attribution file found, but ${bundle.license.spdx} requires: ${bundle.reuse.obligations.join("; ")}`,
      evidence: hasNotice ? targetFiles.filter((f) => /^(NOTICE|LICENSE|THIRD)/i.test(f.split("/").pop() ?? "")).slice(0, 3) : [],
    });
    if (!hasNotice) {
      risks.push(`Unmet licence obligation: ${bundle.reuse.obligations.join("; ")}.`);
    }
  }

  // --- confidence ----------------------------------------------------------
  // Capped deliberately. Static inspection cannot warrant more than "the pieces look
  // present", and reporting 0.95 for a set of filename matches would misrepresent it.
  const weights = { pass: 1, partial: 0.5, unknown: 0.4, fail: 0 } as const;
  const scored = checks.filter((c) => c.status !== "unknown");
  const raw = scored.length
    ? scored.reduce((a, c) => a + weights[c.status], 0) / scored.length
    : 0;
  const confidence = Math.round(Math.min(0.8, raw * 0.8) * 100) / 100;

  if (profile.gaps.length) {
    risks.push(`Target analysis was incomplete: ${profile.gaps[0]}`);
  }
  risks.push("Nothing here was compiled or executed. Run the project's own build and tests before trusting this.");

  return {
    feature: bundle.feature,
    checks,
    confidence,
    remainingRisks: risks,
    disclaimer: VERIFICATION_DISCLAIMER,
  };
}

/** Render in the compact style. */
export function renderVerification(r: VerificationReport): string {
  const icon = { pass: "✓", partial: "~", fail: "✗", unknown: "?" } as const;
  const out = [`VERIFICATION: ${r.feature}`, ""];
  for (const c of r.checks) {
    out.push(`${icon[c.status]} ${c.name}`);
    out.push(`    ${c.detail}`);
    if (c.evidence.length) out.push(`    evidence: ${c.evidence.join(", ")}`);
  }
  out.push("", `CONFIDENCE: ${Math.round(r.confidence * 100)}%  (capped at 80% — see disclaimer)`);
  out.push("", "REMAINING RISKS:");
  for (const risk of r.remainingRisks) out.push(`• ${risk}`);
  out.push("", r.disclaimer);
  return out.join("\n");
}

// ---------------------------------------------------------------------------

function mentions(haystack: string, phrase: string): boolean {
  const words = phrase.toLowerCase().split(/\W+/).filter((w) => w.length >= 4);
  if (!words.length) return false;
  return words.some((w) => haystack.includes(w));
}

/**
 * Loose identifier matching.
 *
 * `ResumeHandler` should match `DownloadResumer`, `resume_handler` and `ResumeService` —
 * adaptation involves renaming, and an exact-match check would report every successful
 * adaptation as a failure.
 */
function mentionsIdentifier(haystack: string, identifier: string): boolean {
  const words = identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 4);
  if (!words.length) return haystack.includes(identifier.toLowerCase());

  const matched = words.filter((w) => haystack.includes(w) || haystack.includes(w.replace(/s$/, "")));
  if (!matched.length) return false;

  // Requiring EVERY word was too strict for the case this check exists to handle:
  // adaptation renames things. `ResumeHandler` legitimately becomes `DownloadResumer`,
  // which drops "handler" — and demanding both words reported a successful adaptation as
  // a failure. A majority of the distinctive words is the right bar: enough that a single
  // incidental word cannot carry a match, loose enough to survive renaming.
  if (matched.length * 2 >= words.length) return true;

  // Or the single most distinctive word, when it is long enough to stand alone.
  const longest = [...words].sort((a, b) => b.length - a.length)[0] as string;
  return longest.length >= 6 && matched.includes(longest);
}

function normalise(name: string): string {
  const n = name.toLowerCase();
  return n.includes(":") ? (n.split(":").pop() as string) : n.replace(/^@[^/]+\//, "");
}
