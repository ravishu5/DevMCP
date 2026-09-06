/**
 * Reuse mode — the most decision-relevant field in a bundle.
 *
 * Not every good implementation should be copied. The agent needs to be told *how* it may
 * legitimately use what we found:
 *
 *   DIRECT_REUSE    permissive licence + compatible stack + compatible architecture
 *                   → depend on it or vendor it, minimal change
 *   ADAPT           same language/framework, different architecture
 *                   → port the logic into the target's architecture
 *   REFERENCE_ONLY  different language, or copyleft licence, but an excellent approach
 *                   → learn from it, write independent code
 *   DO_NOT_USE      licence incompatible with the target, or abandoned/unsafe
 *                   → exclude, with the reason stated
 *
 * Order of evaluation matters: **licence gates everything**. No amount of stack fit or
 * elegance makes AGPL code safe to paste into a proprietary product, and a tool that
 * ranked on quality first and mentioned licence later would be actively dangerous.
 *
 * DO_NOT_USE candidates are still *returned*, with their reason. Silently dropping them
 * means the agent re-discovers the same repository next time and wonders why it vanished.
 */

import type {
  LicenseInfo, ReuseAssessment, ReuseMode, RepoMetadata, TargetStack,
} from "../types/index.js";
import type { ReusabilityAssessment } from "./reusability.js";

export interface ReuseAssessmentInput {
  license: LicenseInfo;
  metadata: RepoMetadata;
  target?: TargetStack;
  /** 0–1 language/framework fit. */
  stackMatch: number;
  /** 0–1 architectural fit with the target. */
  architectureMatch: number;
  /** Set when the candidate is effectively unmaintained. */
  abandoned?: boolean;
  /** Library vs application. An application cannot be depended upon, whatever else is true. */
  reusability?: ReusabilityAssessment;
}

export function assessReuse(input: ReuseAssessmentInput): ReuseAssessment {
  const { license, stackMatch, architectureMatch, target } = input;
  const distribution = target?.distribution ?? "unknown";
  const factors = {
    licenseCategory: license.category,
    stackMatch: round2(stackMatch),
    architectureMatch: round2(architectureMatch),
    distribution,
  };

  // --- Gate 1: licence. Nothing overrides this. ----------------------------
  if (license.compatible === false) {
    return {
      mode: "DO_NOT_USE",
      reason: `Licence ${license.spdx} (${license.category}) is incompatible with a ${distribution} project.`,
      guidance:
        "Do not copy or adapt this code. You may read it to understand the approach, but any implementation you write " +
        "must be independent. Prefer a permissively-licensed alternative — call find_alternative with " +
        "reason=\"license incompatible\".",
      factors,
      obligations: license.obligations,
      confidence: license.confidence,
      ...{},
    };
  }

  if (license.category === "unknown" || license.category === "none") {
    return {
      mode: "REFERENCE_ONLY",
      reason: "No clearly identifiable licence. Default copyright applies — all rights reserved.",
      guidance:
        "Treat as reference only. Do not copy code. If this implementation is important, contact the maintainers " +
        "to request a licence, or find a licensed alternative.",
      factors,
      obligations: [],
      confidence: 0.9,   // we are confident it is UNCLEAR, which is itself a firm verdict
    };
  }

  // --- Gate 2: abandonment ------------------------------------------------
  if (input.abandoned || input.metadata.archived) {
    return {
      mode: "REFERENCE_ONLY",
      reason: input.metadata.archived
        ? "Repository is archived by its owner and will not receive fixes."
        : "Repository shows no meaningful maintenance activity.",
      guidance:
        "The approach may still be sound, but adopting unmaintained code means owning it, including its security fixes. " +
        "Read it for the design, then implement against a maintained equivalent where one exists.",
      factors,
      obligations: license.obligations,
      confidence: 0.8,
    };
  }

  // --- Gate 3: is there anything to depend ON? ----------------------------
  //
  // An application is not a library. It may be an excellent working example — often the
  // only one — but there is no artifact to depend on and no API surface to call, so
  // DIRECT_REUSE is not a thing it can be, regardless of licence or stack fit. Weighting
  // alone could not express this: a plant-care app was ranking second for "local
  // persistence" because it genuinely does implement schemas, DAOs and migrations.
  const kind = input.reusability?.kind;
  if ((kind === "application" || kind === "example") && (input.reusability?.confidence ?? 0) >= 0.4) {
    return {
      mode: "REFERENCE_ONLY",
      reason: kind === "example"
        ? "This is a sample or demo project, not a distributable library."
        : "This is an application, not a library — there is no artifact to depend on.",
      guidance:
        "Read it as a worked example of the approach, then implement your own version. " +
        `${input.reusability?.signals.length ? `Classified from: ${input.reusability.signals.slice(0, 2).join("; ")}. ` : ""}` +
        "If you want something to depend on, call find_alternative with reason=\"need a library, not an app\".",
      factors,
      obligations: license.obligations,
      confidence: input.reusability?.confidence ?? 0.5,
    };
  }

  // --- Gate 4: copyleft that is legal but consequential -------------------
  const copyleft = license.category === "strong-copyleft" || license.category === "network-copyleft";
  if (copyleft && distribution !== "open-source") {
    return {
      mode: "REFERENCE_ONLY",
      reason: `${license.spdx} is ${license.category}; reusing the code would impose its obligations on your project.`,
      guidance:
        "Study the implementation and write your own. If you intend to adopt the code, confirm with legal counsel first — " +
        `see the obligations list${license.warnings.length ? " and warnings" : ""}.`,
      factors,
      obligations: license.obligations,
      confidence: license.confidence,
    };
  }

  // --- Gate 5: stack fit --------------------------------------------------
  // A different language means the code cannot be reused at all, however good it is. The
  // *algorithm* still transfers, which is exactly what REFERENCE_ONLY means.
  if (stackMatch < 0.35) {
    return {
      mode: "REFERENCE_ONLY",
      reason: `Different technology stack (stack match ${pct(stackMatch)}). The code will not compile in your project.`,
      guidance:
        "Port the algorithm and the architecture, not the source. Extract the design decisions — data structures, state " +
        "machine, error handling — and reimplement them idiomatically in your stack.",
      factors,
      obligations: license.obligations,
      confidence: 0.85,
    };
  }

  // --- Gate 6: architecture fit -------------------------------------------
  if (architectureMatch < 0.55 || stackMatch < 0.7) {
    return {
      mode: "ADAPT",
      reason: stackMatch < 0.7
        ? `Same language family but a different framework (stack match ${pct(stackMatch)}).`
        : `Compatible stack, different architecture (architecture match ${pct(architectureMatch)}).`,
      guidance:
        "Lift the core logic and reshape it to your architecture. Keep the business logic and edge-case handling — that is " +
        "the valuable part — and replace the framework-specific boundaries. See adaptationNotes for the specific changes.",
      factors,
      obligations: license.obligations,
      confidence: 0.75,
    };
  }

  // --- Direct reuse -------------------------------------------------------
  return {
    mode: "DIRECT_REUSE",
    reason: `${license.spdx} licence, matching stack (${pct(stackMatch)}) and compatible architecture (${pct(architectureMatch)}).`,
    guidance: license.obligations.length
      ? `Depend on it or vendor the relevant symbols with minimal change. You must: ${license.obligations.join("; ")}.`
      : "Depend on it or vendor the relevant symbols with minimal change.",
    factors,
    obligations: license.obligations,
    confidence: Math.min(0.95, (license.confidence + stackMatch + architectureMatch) / 3 + 0.15),
  };
}

/** Ordering for comparison and reporting. */
export const REUSE_MODE_RANK: Record<ReuseMode, number> = {
  DIRECT_REUSE: 3, ADAPT: 2, REFERENCE_ONLY: 1, DO_NOT_USE: 0,
};

function pct(n: number): string { return `${Math.round(n * 100)}%`; }
function round2(n: number): number { return Math.round(n * 100) / 100; }
