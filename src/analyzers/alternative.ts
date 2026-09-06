/**
 * Alternative discovery — closing the build/test feedback loop.
 *
 * The scenario this exists for: an agent adopted a recommendation, started building, and
 * hit a wall.
 *
 *     "The recommended implementation requires a dependency incompatible with my project."
 *
 * Without this tool the agent re-runs discovery from zero and very likely gets the same
 * answer, because nothing told the system what went wrong. With it, we parse the rejection
 * into a structured constraint, re-rank the candidates we already have, and only widen the
 * search if that is not enough.
 *
 * The parser is deliberately permissive: an unparseable reason becomes an `"other"`
 * constraint carrying the verbatim text, and the caller is told we could not interpret it.
 * Guessing a constraint would be worse than admitting we did not understand.
 */

import type { RejectionConstraint } from "../types/bundle.js";
import type { Candidate } from "../types/index.js";

interface ConstraintRule {
  kind: RejectionConstraint["kind"];
  /** Group 1, when present, captures the subject (a dependency name, a licence id…). */
  patterns: RegExp[];
}

const RULES: ConstraintRule[] = [
  {
    kind: "license-incompatible",
    patterns: [
      /\b(licen[cs]e|licensing|gpl|agpl|lgpl|copyleft|proprietary)\b[^.]*\b(incompatible|conflict|problem|issue|blocked?|cannot|can't|not allowed|restrict)/i,
      /\b(incompatible|cannot use|can't use|blocked by|rejected)\b[^.]*\b(licen[cs]e|gpl|agpl|lgpl|copyleft)\b/i,
      // A copyleft licence NAME on its own is a complete complaint in practice —
      // "it's GPL-3.0" and "the licence is AGPL" carry no other keyword, and requiring one
      // sent both to the `other` bucket.
      /\b(a?gpl|lgpl|sspl|busl|copyleft)(-?[\d.]+)?\b/i,
      /\blicen[cs]e\b[^.]*\b(and|but)\b[^.]*\b(proprietary|commercial|closed.?source|we ship)\b/i,
    ],
  },
  {
    kind: "dependency-incompatible",
    patterns: [
      /\b(dependency|dependencies|library|package|module)\b[^.]*\b(incompatible|conflicts?|clash(?:es)?|not available|unavailable|cannot|can't|won'?t)\b/i,
      /\b(requires?|needs?|depends on|pulls in)\s+([\w@/.:-]{2,60})[^.]*\b(incompatible|conflicts?|not allowed|cannot|can't|unavailable)\b/i,
      // "requires X but we use Y" is the most natural way people phrase this, and it
      // contains none of the keywords above. Missing it meant the commonest real rejection
      // reason fell through to `other` and constrained nothing.
      /\b(requires?|needs?|uses?|depends on|pulls in)\s+[\w@/.:-]{2,60}\s+(but|however|whereas|while)\b/i,
      /\b(conflicting|duplicate|incompatible)\s+(version|dependency|dependencies)\b/i,
    ],
  },
  {
    kind: "stack-mismatch",
    patterns: [
      /\b(wrong|different|incompatible|mismatched)\s+(language|stack|framework|platform|runtime)\b/i,
      /\bnot\s+(compatible with|written in|available for)\s+([\w.+#-]{2,30})/i,
      /\b(only works|only supports?|requires?)\s+(on\s+)?(android|ios|node|python|java|kotlin|swift|go|rust|browser|jvm)\b/i,
    ],
  },
  {
    kind: "too-complex",
    patterns: [
      /\b(too\s+(complex|complicated|big|large|heavy)|over.?engineered|too many (classes|dependencies|abstractions)|excessive)\b/i,
      /\b(integration|adaptation)\s+(is\s+)?(too\s+)?(hard|difficult|costly|expensive)\b/i,
    ],
  },
  {
    kind: "unmaintained",
    patterns: [
      /\b(unmaintained|abandoned|archived|dead|stale|no longer maintained|last (commit|update|release).{0,20}(years?|ago))\b/i,
      /\b(security|cve|vulnerabilit)\w*\b[^.]*\b(unpatched|unfixed|open)\b/i,
    ],
  },
  {
    kind: "missing-capability",
    patterns: [
      /\b(does\s?n'?o?t|doesn't|lacks?|missing|no)\s+(support|handle|implement|have|provide)\s+([\w\s-]{3,50})/i,
      /\b(missing|absent|not implemented)\b[^.]*\b(feature|capability|requirement|support)\b/i,
    ],
  },
  {
    kind: "build-failure",
    patterns: [
      /\b(build|compile|compilation|gradle|npm|cargo|maven)\s*(error|failure|failed|breaks?)\b/i,
      /\b(does\s?n'?o?t|doesn't|won'?t)\s+(build|compile)\b/i,
    ],
  },
];

/** Named subjects worth extracting: a dependency, a licence, a language. */
const SUBJECT_PATTERNS: [RegExp, RejectionConstraint["kind"][]][] = [
  [/\b(AGPL-?3(?:\.0)?|GPL-?[23](?:\.0)?|LGPL-?[23](?:\.\d)?|SSPL|BUSL|MPL-?2(?:\.0)?)\b/i, ["license-incompatible"]],
  [/\b(AGPL|LGPL|GPL|SSPL|BUSL|copyleft)\b/i, ["license-incompatible"]],
  [/\b((?:@[\w-]+\/)?[\w.-]+(?::[\w.-]+)?)\s+(?:is\s+)?(?:incompatible|conflicts?|not available|unavailable)/i, ["dependency-incompatible"]],
  [/\b(?:requires?|needs?|depends on|pulls in|uses)\s+((?:@[\w-]+\/)?[\w.@/:-]{2,60})/i, ["dependency-incompatible", "stack-mismatch"]],
  [/\b(?:doesn'?t|does not|no)\s+(?:support|handle|implement)\s+([\w\s-]{3,40})/i, ["missing-capability"]],
];

export function parseRejection(reason: string): RejectionConstraint {
  const text = reason.trim();
  if (!text) {
    return { kind: "other", derivedFrom: "empty reason" };
  }

  for (const rule of RULES) {
    for (const re of rule.patterns) {
      const m = re.exec(text);
      if (!m) continue;
      return {
        kind: rule.kind,
        subject: extractSubject(text, rule.kind),
        derivedFrom: m[0].trim().slice(0, 120),
      };
    }
  }

  // Unrecognised. Carry the text through verbatim rather than inventing a category —
  // the caller is told, and the exclusion of the failed candidate still applies.
  return { kind: "other", subject: undefined, derivedFrom: `verbatim: ${text.slice(0, 160)}` };
}

/**
 * Words that can sit where a subject would but name nothing.
 *
 * Without this, "requires okhttp WHICH conflicts with ours" extracted `which` as the
 * offending dependency — and a constraint whose subject is a relative pronoun matches
 * nothing, so it silently degraded to no constraint at all.
 */
const NOT_A_SUBJECT = new Set([
  "which", "that", "this", "it", "they", "them", "we", "our", "ours", "us", "the", "a", "an",
  "and", "but", "or", "is", "are", "was", "were", "be", "been", "to", "of", "in", "on", "with",
  "dependency", "dependencies", "library", "package", "module", "version", "versions", "licence", "license",
]);

function extractSubject(text: string, kind: RejectionConstraint["kind"]): string | undefined {
  for (const [re, kinds] of SUBJECT_PATTERNS) {
    if (!kinds.includes(kind)) continue;
    const captured = re.exec(text)?.[1]?.trim();
    if (!captured || captured.length < 2 || captured.length > 60) continue;
    if (NOT_A_SUBJECT.has(captured.toLowerCase())) continue;
    return captured;
  }
  return undefined;
}

/**
 * Does this candidate satisfy the constraint the previous one violated?
 *
 * Returns a reason when it does NOT, so the caller can explain why an obvious-looking
 * alternative was skipped. Silence there produces "why didn't it suggest X?" every time.
 */
export function violatesConstraint(c: Candidate, constraint: RejectionConstraint): string | null {
  const subject = constraint.subject?.toLowerCase();

  switch (constraint.kind) {
    case "license-incompatible": {
      if (c.reuse?.mode === "DO_NOT_USE") return `licence ${c.license?.spdx ?? "unknown"} is incompatible`;
      const cat = c.license?.category;
      if (cat === "strong-copyleft" || cat === "network-copyleft" || cat === "proprietary") {
        return `licence ${c.license?.spdx} is ${cat}, the same class of problem`;
      }
      if (subject && c.license?.spdx?.toLowerCase().includes(subject)) {
        return `also ${c.license.spdx}`;
      }
      return null;
    }

    case "dependency-incompatible": {
      if (!subject) return null;
      const hit = (c.dependencies?.direct ?? []).find((d) => d.name.toLowerCase().includes(subject));
      return hit ? `also depends on ${hit.name}` : null;
    }

    case "stack-mismatch": {
      const stack = c.evidence?.axes.stackMatch?.value ?? 1;
      return stack < 0.6 ? `stack match is only ${Math.round(stack * 100)}%` : null;
    }

    case "too-complex": {
      const s = c.integrationSurface;
      if (!s) return null;
      return s.difficulty === "high" || s.difficulty === "very-high"
        ? `integration difficulty is ${s.difficulty} (${s.drivers.slice(0, 2).join("; ")})`
        : null;
    }

    case "unmaintained": {
      if (c.metadata.archived) return "also archived";
      const days = c.quality?.daysSinceLastPush;
      return days !== undefined && days > 365 ? `also stale (last activity ${days}d ago)` : null;
    }

    case "missing-capability": {
      if (!subject || !c.completeness) return null;
      const item = c.completeness.items.find((i) =>
        subject.split(/\s+/).some((w) => w.length >= 4 && i.requirement.toLowerCase().includes(w)));
      return item && item.status === "absent" ? `also lacks "${item.requirement}"` : null;
    }

    case "build-failure":
    case "other":
    default:
      // Nothing structural to check — the candidate is not excluded, but nor is it
      // vouched for, and the caller reports that we could not interpret the reason.
      return null;
  }
}

/** Human-readable statement of what we understood, for the response header. */
export function describeConstraint(c: RejectionConstraint): string {
  const base: Record<RejectionConstraint["kind"], string> = {
    "license-incompatible": "licence incompatibility",
    "dependency-incompatible": "an incompatible dependency",
    "stack-mismatch": "a technology-stack mismatch",
    "too-complex": "excessive integration complexity",
    unmaintained: "lack of maintenance",
    "missing-capability": "a missing capability",
    "build-failure": "a build failure",
    other: "an unclassified problem",
  };
  const subject = c.subject ? ` (${c.subject})` : "";
  return `${base[c.kind]}${subject}`;
}
