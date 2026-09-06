/**
 * Implementation comparison (spec §4 compare_implementations).
 *
 * "Compare several candidate implementations… Return a recommendation with reasoning."
 *
 * The design problem is that a table of twelve axes across four repositories is a wall of
 * numbers nobody reads. So the output leads with **where they actually differ** — an axis
 * on which every candidate scores 0.9 is not a comparison, it is noise — and states the
 * trade-off in the form the decision actually takes: "A unless X, in which case B".
 */

import type { Candidate, EvidenceAxis } from "../types/index.js";
import { REUSE_MODE_RANK } from "./reuse.js";

export interface ComparisonInput {
  feature: string;
  candidates: Candidate[];
}

export interface AxisComparison {
  axis: EvidenceAxis;
  label: string;
  /** repository -> value */
  values: Record<string, number>;
  /** Spread between best and worst. Only axes that discriminate are reported. */
  spread: number;
  winner: string;
  /** The winner's observation, so the number is grounded. */
  evidence: string;
}

export interface ComparisonResult {
  feature: string;
  recommendation: string;
  /** Why this one, in decision terms. */
  reasoning: string[];
  /** Concrete conditions under which a different candidate is the better pick. */
  switchIf: { condition: string; instead: string }[];
  /** Axes on which the candidates genuinely differ, most discriminating first. */
  differentiators: AxisComparison[];
  /** Axes where they are effectively tied — reported so their absence is not suspicious. */
  tied: string[];
  /** Facts that override score: licence blocks, abandonment. */
  blockers: { repository: string; issue: string }[];
  candidates: {
    repository: string; score: number; confidence: number;
    reuseMode: string; license: string; completeness: string;
    integrationDifficulty: string; tests: string;
  }[];
}

const AXIS_LABELS: Record<EvidenceAxis, string> = {
  featureRelevance: "feature match",
  architectureMatch: "architecture fit",
  stackMatch: "stack match",
  completeness: "requirement coverage",
  implementationQuality: "project quality",
  testEvidence: "test evidence",
  maintenance: "maintenance",
  documentation: "documentation",
  popularity: "adoption",
  dependencySimplicity: "dependency simplicity",
  integrationSurface: "integration surface",
  licenseCompatibility: "licence",
  reusability: "reusable as a dependency",
};

/** Below this spread, an axis is not telling the caller anything useful. */
const DISCRIMINATION_THRESHOLD = 0.15;

export function compareImplementations(input: ComparisonInput): ComparisonResult {
  const candidates = [...input.candidates].sort((a, b) => (b.score?.total ?? 0) - (a.score?.total ?? 0));

  if (candidates.length === 0) {
    return {
      feature: input.feature, recommendation: "(none)",
      reasoning: ["No candidates were supplied to compare."],
      switchIf: [], differentiators: [], tied: [], blockers: [], candidates: [],
    };
  }

  // --- blockers ------------------------------------------------------------
  // Computed first, because a licence block outranks any score. A comparison that ranked a
  // DO_NOT_USE candidate first and mentioned the licence in a footnote would be worse than
  // useless.
  const blockers: ComparisonResult["blockers"] = [];
  for (const c of candidates) {
    if (c.reuse?.mode === "DO_NOT_USE") {
      blockers.push({ repository: c.ref.fullName, issue: c.reuse.reason });
    } else if (c.metadata.archived) {
      blockers.push({ repository: c.ref.fullName, issue: "Repository is archived and will not receive fixes." });
    } else if (c.license?.spdx === "UNKNOWN") {
      blockers.push({ repository: c.ref.fullName, issue: "No identifiable licence; reuse rights are unclear." });
    }
  }

  const usable = candidates.filter((c) => c.reuse?.mode !== "DO_NOT_USE");
  const winner = usable[0] ?? candidates[0] as Candidate;

  // --- differentiating axes ------------------------------------------------
  const axes = Object.keys(AXIS_LABELS) as EvidenceAxis[];
  const differentiators: AxisComparison[] = [];
  const tied: string[] = [];

  for (const axis of axes) {
    const values: Record<string, number> = {};
    let measured = 0;
    for (const c of candidates) {
      const signal = c.evidence?.axes[axis];
      if (!signal || signal.imputed) continue;
      values[c.ref.fullName] = signal.value;
      measured++;
    }
    if (measured < 2) continue;   // nothing to compare

    const nums = Object.values(values);
    const max = Math.max(...nums);
    const min = Math.min(...nums);
    const spread = Math.round((max - min) * 100) / 100;

    if (spread < DISCRIMINATION_THRESHOLD) {
      tied.push(AXIS_LABELS[axis]);
      continue;
    }
    const winnerRepo = Object.entries(values).find(([, v]) => v === max)?.[0] ?? "";
    differentiators.push({
      axis,
      label: AXIS_LABELS[axis],
      values,
      spread,
      winner: winnerRepo,
      evidence: candidates.find((c) => c.ref.fullName === winnerRepo)?.evidence?.axes[axis]?.observation ?? "",
    });
  }
  differentiators.sort((a, b) => b.spread - a.spread);

  // --- reasoning -----------------------------------------------------------
  const reasoning: string[] = [];
  const winnerWins = differentiators.filter((d) => d.winner === winner.ref.fullName);
  for (const d of winnerWins.slice(0, 4)) {
    reasoning.push(`Best on ${d.label} — ${d.evidence}`);
  }
  if (winner.reuse) {
    reasoning.push(`Reuse mode ${winner.reuse.mode}: ${winner.reuse.reason}`);
  }
  if (!winnerWins.length) {
    reasoning.push("Wins on aggregate score rather than on any single axis — no candidate dominates.");
  }
  if (usable.length < candidates.length) {
    reasoning.push(`${candidates.length - usable.length} candidate(s) excluded from consideration by a licence or safety blocker.`);
  }

  // --- switching conditions ------------------------------------------------
  // The genuinely useful part: the specific circumstance in which the runner-up is right.
  const switchIf: ComparisonResult["switchIf"] = [];
  for (const d of differentiators) {
    if (d.winner === winner.ref.fullName) continue;
    const alt = candidates.find((c) => c.ref.fullName === d.winner);
    if (!alt || alt.reuse?.mode === "DO_NOT_USE") continue;
    if (switchIf.some((s) => s.instead === d.winner)) continue;
    switchIf.push({ condition: conditionFor(d.axis, d.evidence), instead: d.winner });
    if (switchIf.length >= 3) break;
  }

  // A directly-reusable runner-up is worth naming when the winner needs adaptation.
  if (winner.reuse && REUSE_MODE_RANK[winner.reuse.mode] < 3) {
    const direct = usable.find((c) => c.reuse?.mode === "DIRECT_REUSE" && c !== winner);
    if (direct && !switchIf.some((s) => s.instead === direct.ref.fullName)) {
      switchIf.push({
        condition: "you need to vendor or depend on code directly, without adaptation work",
        instead: direct.ref.fullName,
      });
    }
  }

  return {
    feature: input.feature,
    recommendation: winner.ref.fullName,
    reasoning,
    switchIf,
    differentiators: differentiators.slice(0, 6),
    tied,
    blockers,
    candidates: candidates.map((c) => ({
      repository: c.ref.fullName,
      score: c.score?.total ?? 0,
      confidence: c.score?.confidence ?? 0,
      reuseMode: c.reuse?.mode ?? "unassessed",
      license: c.license?.spdx ?? "unknown",
      completeness: c.completeness && c.completeness.total
        ? `${c.completeness.satisfied}/${c.completeness.total - c.completeness.undetermined.length}`
        : "not assessed",
      integrationDifficulty: c.integrationSurface?.difficulty ?? "unknown",
      tests: c.quality?.hasTests ? `${c.quality.testFileCount} file(s)` : "none found",
    })),
  };
}

/** Turn an axis into the circumstance in which it decides the choice. */
function conditionFor(axis: EvidenceAxis, evidence: string): string {
  switch (axis) {
    case "maintenance": return `active maintenance matters more than the other differences (${evidence})`;
    case "testEvidence": return `you need strong existing test coverage to trust the behaviour (${evidence})`;
    case "completeness": return `covering more of your requirement list matters most (${evidence})`;
    case "integrationSurface": return `you want the smallest possible integration footprint (${evidence})`;
    case "dependencySimplicity": return `adding dependencies is costly in your project (${evidence})`;
    case "licenseCompatibility": return `licence terms are the binding constraint (${evidence})`;
    case "stackMatch": return `you cannot afford any cross-stack porting (${evidence})`;
    case "architectureMatch": return `you want the architecture to match yours as-is (${evidence})`;
    case "documentation": return `your team needs strong documentation to adopt it (${evidence})`;
    case "popularity": return `you need the option with the largest user base (${evidence})`;
    case "reusability": return `you need something you can depend on rather than copy from (${evidence})`;
    default: return `${AXIS_LABELS[axis]} is your priority (${evidence})`;
  }
}

/** Compact rendering (spec §24). */
export function renderComparison(r: ComparisonResult): string {
  const out: string[] = [`FEATURE:\n${r.feature}`];

  if (r.blockers.length) {
    // Blockers first: they can disqualify a candidate regardless of its score.
    out.push(`\nBLOCKERS:\n${r.blockers.map((b) => `• ${b.repository}: ${b.issue}`).join("\n")}`);
  }

  out.push(`\nRECOMMENDED:\n${r.recommendation}`);
  if (r.reasoning.length) out.push(`\nWHY:\n${r.reasoning.map((x) => `• ${x}`).join("\n")}`);

  if (r.switchIf.length) {
    out.push(`\nCHOOSE DIFFERENTLY IF:\n${r.switchIf.map((s) => `• If ${s.condition}\n    → ${s.instead}`).join("\n")}`);
  }

  if (r.candidates.length) {
    out.push("\nSIDE BY SIDE:");
    const header = ["repository", "score", "reuse", "licence", "reqs", "integration", "tests"];
    const rows = r.candidates.map((c) => [
      c.repository, `${c.score}`, c.reuseMode, c.license, c.completeness, c.integrationDifficulty, c.tests,
    ]);
    out.push(renderTable([header, ...rows]));
  }

  if (r.differentiators.length) {
    out.push(`\nWHERE THEY DIFFER (most discriminating first):`);
    for (const d of r.differentiators) {
      const scores = Object.entries(d.values)
        .sort((a, b) => b[1] - a[1])
        .map(([repo, v]) => `${short(repo)} ${v.toFixed(2)}`)
        .join("  ·  ");
      out.push(`• ${d.label}: ${scores}`);
    }
  }
  if (r.tied.length) {
    // Reported so the caller does not wonder why an axis is missing.
    out.push(`\nEFFECTIVELY TIED:\n${r.tied.join(" · ")}`);
  }

  out.push("\nNOTE:\nLicence verdicts are advisory only — not legal advice.");
  return out.join("\n");
}

function renderTable(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows
    .map((r, ri) => {
      const line = r.map((cell, i) => (cell ?? "").padEnd(widths[i] as number)).join("  ");
      return ri === 0 ? `  ${line}\n  ${widths.map((w) => "-".repeat(w)).join("  ")}` : `  ${line}`;
    })
    .join("\n");
}

function short(repo: string): string {
  const name = repo.split("/")[1] ?? repo;
  return name.length > 22 ? name.slice(0, 21) + "…" : name;
}
