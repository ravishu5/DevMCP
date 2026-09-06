/**
 * Compact response rendering (spec §24).
 *
 * The spec contrasts a bad response ("Here is the entire repository…") with a good one:
 * a labelled, scannable block of decisions and evidence. This module produces the latter.
 *
 * Rendering is deliberately plain text rather than JSON for the human-facing surfaces
 * (CLI, and the text half of an MCP result). Labelled plain text costs roughly 40% fewer
 * tokens than the equivalent JSON — no quotes, braces or repeated key names — and models
 * read it at least as reliably. Structured JSON is still returned alongside, for callers
 * that want to parse rather than read.
 */

import type { Candidate, Degradation } from "../types/index.js";
import type { BundleMetrics, ImplementationBundle } from "../types/bundle.js";
import { estimateTokens } from "../core/tokens.js";

export interface RenderDiscoveryInput {
  feature: string;
  targetStack?: string;
  candidates: Candidate[];
  degradations: Degradation[];
  queriesIssued: string[];
  consideredCount: number;
  deepAnalysedCount: number;
  fromFingerprints?: string[];
  metrics?: BundleMetrics;
  /** How many candidates to render in full. The rest are listed as one-liners. */
  detailCount?: number;
}

export function renderDiscovery(input: RenderDiscoveryInput): string {
  const lines: string[] = [];
  const detailCount = input.detailCount ?? 3;

  lines.push(`FEATURE:\n${input.feature}`);
  if (input.targetStack) lines.push(`\nTARGET STACK:\n${input.targetStack}`);

  if (input.candidates.length === 0) {
    lines.push("\nNO CANDIDATES FOUND");
    lines.push(`\nSearched ${input.queriesIssued.length} quer${input.queriesIssued.length === 1 ? "y" : "ies"}: ${input.queriesIssued.join(", ") || "(none issued)"}`);
    lines.push(
      "\nSUGGESTION:\nTry a broader feature description, or relax the language filter. " +
      "If this capability is genuinely application-specific, build it directly rather than searching further.",
    );
    if (input.degradations.length) lines.push("\n" + renderDegradations(input.degradations));
    return lines.join("\n");
  }

  const top = input.candidates[0] as Candidate;

  // --- headline ------------------------------------------------------------
  lines.push(`\nRECOMMENDED:\n${top.ref.fullName}`);
  if (top.score) {
    lines.push(`\nSCORE:\n${top.score.total}/100  (confidence ${Math.round(top.score.confidence * 100)}%)`);
  }
  if (top.reuse) {
    // Reuse mode leads, because it determines what the agent may actually do.
    lines.push(`\nREUSE MODE:\n${top.reuse.mode} — ${top.reuse.reason}`);
    lines.push(`\nGUIDANCE:\n${top.reuse.guidance}`);
  }
  if (top.score?.reasons.length) {
    lines.push(`\nWHY:\n${top.score.reasons.map((r) => `• ${r.replace(/^[+\-?] /, (m) => m)}`).join("\n")}`);
  }

  // --- minimal implementation set (Layer 2) --------------------------------
  if (top.minimalSet && top.minimalSet.core.length) {
    const m = top.minimalSet;
    const lines2 = [`\nKEY SYMBOLS (minimal set${m.connected ? ", connected" : ", not fully connected"}):`];
    for (const s of m.core) {
      lines2.push(`• ${s.name}${s.kind !== "unknown" ? ` (${s.kind})` : ""} — ${s.filePath}`);
    }
    if (m.supporting.length) {
      lines2.push(`  supporting: ${m.supporting.map((s) => s.name).join(", ")}`);
    }
    if (m.excluded.length) {
      // Reported, never silently dropped — the agent can disagree and ask for more.
      const shown = m.excluded.slice(0, 4).map((e) => `${e.name} (${e.reason})`);
      lines2.push(`  excluded: ${shown.join("; ")}${m.excluded.length > 4 ? `, +${m.excluded.length - 4} more` : ""}`);
    }
    lines2.push(`  ~${Math.round(m.estimatedTokens)} tokens vs ~${Math.round(m.estimatedFullTokens)} for all candidate symbols`);
    lines.push(lines2.join("\n"));
  }

  // --- completeness --------------------------------------------------------
  if (top.completeness && top.completeness.total > 0) {
    const c = top.completeness;
    const marks = c.items.map((i) => {
      const mark = i.status === "evidenced" ? "✓" : i.status === "absent" ? "✗" : "?";
      return `${mark} ${i.requirement}`;
    });
    lines.push(`\nCOMPLETENESS:  ${c.satisfied}/${c.total - c.undetermined.length} evidenced${c.undetermined.length ? ` (${c.undetermined.length} undetermined)` : ""}\n${marks.join("\n")}`);
  }

  // --- dependencies --------------------------------------------------------
  if (top.dependencies?.direct.length) {
    const runtime = top.dependencies.direct.filter((d) => d.scope === "runtime").slice(0, 8);
    lines.push(`\nDEPENDENCIES (${top.dependencies.direct.length} total, showing runtime):\n${
      runtime.map((d) => `• ${d.name}${d.version ? ` ${d.version}` : ""}`).join("\n") || "• (none declared)"
    }`);
  }

  // --- tests ---------------------------------------------------------------
  if (top.quality) {
    lines.push(`\nTESTS:\n${top.quality.hasTests ? `${top.quality.testFileCount} test file(s)${top.quality.hasCi ? `, CI via ${top.quality.ciSystems.join("/")}` : ""}` : "none found"}`);
  }

  // --- licence -------------------------------------------------------------
  if (top.license) {
    const l = top.license;
    lines.push(`\nLICENSE:\n${l.spdx}${l.name !== l.spdx ? ` (${l.name})` : ""} — ${
      l.compatible === true ? "compatible" : l.compatible === false ? "INCOMPATIBLE" : "compatibility unclear"
    }`);
    for (const w of l.warnings) lines.push(`  [${w.severity}] ${w.message}`);
    if (l.obligations.length) lines.push(`  Obligations: ${l.obligations.join("; ")}`);
    lines.push(`  ${l.disclaimer}`);
  }

  // --- integration ---------------------------------------------------------
  if (top.integrationSurface) {
    const s = top.integrationSurface;
    lines.push(`\nINTEGRATION:\n${s.difficulty}${s.drivers.length ? ` — ${s.drivers.join("; ")}` : ""}`);
  }

  // --- provenance ----------------------------------------------------------
  lines.push(`\nSOURCE:\n${top.ref.url ?? top.ref.fullName}${top.ref.commit ? `  commit ${top.ref.commit.slice(0, 7)}` : ""}`);
  if (top.cluster?.members.length) {
    lines.push(`  (${top.cluster.members.length} near-duplicate(s) folded in: ${top.cluster.members.slice(0, 3).join(", ")})`);
  }

  // --- alternatives --------------------------------------------------------
  const alternatives = input.candidates.slice(1, detailCount + 3);
  if (alternatives.length) {
    lines.push("\nALTERNATIVES:");
    for (const a of alternatives) {
      const bits = [
        `${a.ref.fullName} — ${a.score?.total ?? "?"}/100`,
        a.reuse?.mode,
        a.license?.spdx,
        a.completeness ? `${a.completeness.satisfied}/${a.completeness.total - a.completeness.undetermined.length} reqs` : undefined,
      ].filter(Boolean);
      lines.push(`• ${bits.join("  ·  ")}`);
    }
  }

  // --- honesty about what we did not do ------------------------------------
  if (input.degradations.length) lines.push("\n" + renderDegradations(input.degradations));
  lines.push(`\nNEXT:\nCall get_implementation with repository="${top.ref.fullName}" to extract the specific symbols and source.`);

  return lines.join("\n");
}

function renderDegradations(degradations: Degradation[]): string {
  // Deduplicate: five candidates failing the same way is one fact, not five.
  const seen = new Set<string>();
  const unique = degradations.filter((d) => {
    const k = `${d.stage}:${d.reason}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const shown = unique.slice(0, 5);
  const lines = ["LIMITATIONS:"];
  for (const d of shown) {
    lines.push(`• [${d.severity}] ${d.stage}${d.subject ? ` (${d.subject})` : ""}: ${d.reason}${d.fallback ? ` → ${d.fallback}` : ""}`);
  }
  if (unique.length > shown.length) lines.push(`• …and ${unique.length - shown.length} more`);
  return lines.join("\n");
}

/** Spec §25 diagnostic block. */
export function renderMetrics(m: BundleMetrics): string {
  return [
    "DISCOVERY METRICS:",
    `  Repositories considered:      ${m.repositoriesConsidered}`,
    `  Repositories deeply analysed: ${m.repositoriesSelected}`,
    `  GitHub search calls:          ${m.githubSearchCalls}`,
    `  Files examined:               ${m.githubFilesExamined}`,
    `  Cache hits / misses:          ${m.cacheHits} / ${m.cacheMisses}`,
    `  Estimated raw context:        ~${m.estimatedRawTokens.toLocaleString()} tokens`,
    `  Returned context:             ~${m.contextTokensReturned.toLocaleString()} tokens`,
    `  Context reduction:            ~${m.contextReductionPercent}%`,
    `  Elapsed:                      ${m.wallClockMs} ms`,
    ...(m.degradedPaths.length ? [`  Degraded paths:               ${m.degradedPaths.join(", ")}`] : []),
  ].join("\n");
}

/** Measure what we actually returned, so the reduction figure is honest. */
export function measureReturned(text: string): number {
  return estimateTokens(text, "prose");
}

// ---------------------------------------------------------------------------
// Implementation bundle
// ---------------------------------------------------------------------------

/**
 * Render an `ImplementationBundle` in the spec §24 compact style.
 *
 * Field order is decision order, not schema order. The agent reads top-down and should be
 * able to stop as soon as it has what it needs:
 *
 *   1. REUSE MODE      — may I use this at all, and how?
 *   2. WHY / CONCERNS  — should I?
 *   3. KEY SYMBOLS     — what do I actually need to look at?
 *   4. ADAPTATION      — what has to change?
 *   5. everything else
 *
 * Putting licence and reuse mode first is deliberate: they are the fields that can make
 * every subsequent field irrelevant.
 */
export function renderBundle(bundle: ImplementationBundle): string {
  const b = bundle;
  const out: string[] = [];

  out.push(`FEATURE:\n${b.feature}`);
  if (b.targetStack) out.push(`\nTARGET STACK:\n${b.targetStack}`);

  out.push(`\nRECOMMENDED:\n${b.recommendation.repository}  —  ${b.recommendation.score}/100 (confidence ${pct(b.recommendation.confidence)})`);

  // Reuse mode leads: it can render everything below it moot.
  out.push(`\nREUSE MODE:\n${b.reuse.mode} — ${b.reuse.reason}`);
  out.push(`\nWHAT TO DO:\n${b.reuse.guidance}`);
  if (b.reuse.obligations.length) {
    out.push(`\nOBLIGATIONS:\n${b.reuse.obligations.map((o) => `• ${o}`).join("\n")}`);
  }

  if (b.recommendation.why.length) {
    out.push(`\nWHY:\n${b.recommendation.why.map((r) => `${r}`).join("\n")}`);
  }
  if (b.recommendation.concerns.length) {
    out.push(`\nCONCERNS:\n${b.recommendation.concerns.map((r) => `${r}`).join("\n")}`);
  }

  // --- architecture and symbols (Layer 2) ---------------------------------
  out.push(`\nARCHITECTURE:\n${b.architecture.pattern} (confidence ${pct(b.architecture.confidence)})`);
  if (b.architecture.components.length) {
    out.push(`  components: ${b.architecture.components.join(" · ")}`);
  }

  if (b.symbols.length) {
    const core = b.symbols.filter((s) => s.sourceRecommended);
    const supporting = b.symbols.filter((s) => !s.sourceRecommended);
    const lines = [`\nKEY SYMBOLS (${b.minimalSet.connected ? "connected set" : "not fully connected"}):`];
    for (const s of core) {
      lines.push(`• ${s.name} — ${s.role}  [${s.filePath}]`);
    }
    if (supporting.length) lines.push(`  supporting: ${supporting.map((s) => s.name).join(", ")}`);
    if (b.minimalSet.excluded.length) {
      const shown = b.minimalSet.excluded.slice(0, 3).map((e) => `${e.name} (${e.reason})`);
      lines.push(`  excluded: ${shown.join("; ")}${b.minimalSet.excluded.length > 3 ? `, +${b.minimalSet.excluded.length - 3} more` : ""}`);
    }
    out.push(lines.join("\n"));
  }

  // --- completeness --------------------------------------------------------
  if (b.completeness.total > 0) {
    const decidable = b.completeness.total - b.completeness.undetermined.length;
    const marks = b.completeness.items.map((i) =>
      `${i.status === "evidenced" ? "✓" : i.status === "absent" ? "✗" : "?"} ${i.requirement}`);
    out.push(`\nCOMPLETENESS:  ${b.completeness.satisfied}/${decidable} evidenced\n${marks.join("\n")}`);
  }

  // --- adaptation (spec §16) ----------------------------------------------
  if (b.adaptation) {
    const a = b.adaptation;
    out.push(`\nADAPTATION  (${a.sourceArchitecture} → ${a.targetArchitecture}):`);
    for (const step of a.requiredChanges) {
      out.push(`${step.order}. ${step.action}  [${step.effort}]\n   ${step.rationale}`);
    }
    out.push(`\nPRESERVE:\n${a.preserve.map((p) => `• ${p}`).join("\n")}`);
    if (a.risks.length) out.push(`\nADAPTATION RISKS:\n${a.risks.map((r) => `• ${r}`).join("\n")}`);
  }

  // --- integration ---------------------------------------------------------
  if (b.integrationPoints.length) {
    out.push(`\nINTEGRATION POINTS  (difficulty: ${b.integrationDifficulty}):`);
    for (const p of b.integrationPoints) out.push(`• ${p.what} → ${p.location}\n   ${p.how}`);
  }

  // --- dependencies --------------------------------------------------------
  if (b.dependencies.direct.length) {
    out.push(`\nDEPENDENCIES (runtime):\n${b.dependencies.direct.slice(0, 10).map((d) => `• ${d.name}${d.version ? ` ${d.version}` : ""}${d.inferred ? " (version not statically resolvable)" : ""}`).join("\n")}`);
  }

  // --- tests ---------------------------------------------------------------
  const t = b.tests;
  if (t.hasTests) {
    const lines = [`\nTESTS:  ${t.unitTests.length} unit, ${t.integrationTests.length} integration${t.frameworks.length ? ` (${t.frameworks.join(", ")})` : ""}`];
    if (t.edgeCasesCovered.length) {
      // The highest-value part: what the original authors thought to handle.
      lines.push(`  edge cases covered: ${t.edgeCasesCovered.join(" · ")}`);
    }
    lines.push(`  feature-specific test confidence: ${pct(t.featureTestConfidence)}`);
    for (const n of t.notes) lines.push(`  note: ${n}`);
    out.push(lines.join("\n"));
  } else {
    out.push(`\nTESTS:\nnone found — ${t.notes[0] ?? "you will need to write them"}`);
  }

  // --- licence -------------------------------------------------------------
  out.push(`\nLICENSE:\n${b.license.spdx}${b.license.name !== b.license.spdx ? ` (${b.license.name})` : ""} — ${
    b.license.compatible === true ? "compatible" : b.license.compatible === false ? "INCOMPATIBLE" : "compatibility unclear"}`);
  for (const w of b.license.warnings) out.push(`  [${w.severity}] ${w.message}`);
  out.push(`  ${b.license.disclaimer}`);

  // --- provenance (spec §11) ----------------------------------------------
  for (const p of b.provenance) {
    out.push(`\nSOURCE:\n${p.provider}:${p.repository}${p.commit ? `@${p.commit.slice(0, 7)}` : ""}  (${p.retrievalMode}, retrieved ${p.retrievedAt.slice(0, 10)})`);
    if (p.files.length) out.push(`  files: ${p.files.slice(0, 6).join(", ")}${p.files.length > 6 ? `, +${p.files.length - 6}` : ""}`);
  }

  // --- honesty -------------------------------------------------------------
  if (b.unknowns.length) out.push(`\nNOT DETERMINED:\n${b.unknowns.map((u) => `• ${u}`).join("\n")}`);
  if (b.degradations.length) {
    out.push(`\nLIMITATIONS:\n${b.degradations.map((d) => `• [${d.severity}] ${d.stage}: ${d.reason}${d.fallback ? ` → ${d.fallback}` : ""}`).join("\n")}`);
  }

  // --- alternatives --------------------------------------------------------
  if (b.alternatives.length) {
    out.push(`\nALTERNATIVES:\n${b.alternatives.map((a) =>
      `• ${a.repository} — ${a.score}/100 · ${a.reuseMode}\n   choose when: ${a.chooseWhen}`).join("\n")}`);
  }

  // --- progressive disclosure (spec §9) ------------------------------------
  if (b.availableOnRequest.length) {
    out.push(`\nAVAILABLE ON REQUEST (not included, to save context):\n${b.availableOnRequest.map((d) =>
      `• ${d.what} (~${d.estimatedTokens} tokens) — ${d.fetchWith.tool}(${JSON.stringify(d.fetchWith.args)})`).join("\n")}`);
  }

  return out.join("\n");
}

function pct(n: number): string { return `${Math.round(n * 100)}%`; }
