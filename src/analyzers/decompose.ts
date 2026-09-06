/**
 * Feature Decomposer — "what features does this app contain?"
 *
 * Deliberately NOT an application designer. Spec §4 is explicit: "Do NOT attempt to fully
 * design the application yourself. The purpose is to identify reusable implementation
 * units." So this produces *units of reuse*, not an architecture.
 *
 * Entirely deterministic — this server performs no LLM inference of its own. The
 * mechanism is capability recognition
 * against the curated vocabulary, plus implication closure: a requirement mentioning
 * "resume" implies persistence, because you cannot resume without remembering an offset.
 * That closure is where non-obvious features come from — the ones a user forgets to ask
 * for and an agent discovers only after building the wrong thing.
 */

import type { FeatureCategory, FeatureUnit, TargetStack } from "../types/index.js";
import { CAPABILITIES, CAPABILITY_BY_ID, findStackIdioms, type Capability } from "../knowledge/vocabulary.js";

export interface DecomposeInput {
  requirement: string;
  stack?: TargetStack;
  /** Caller-supplied explicit requirements, merged with what we detect. */
  requirements?: string[];
}

export interface DecomposeResult {
  units: FeatureUnit[];
  /** Capabilities detected directly in the text. */
  explicit: string[];
  /** Capabilities added by implication closure. Reported so the caller can reject them. */
  implied: string[];
  /**
   * The capability the requirement is primarily ABOUT.
   *
   * Distinct from the highest-priority unit. Priority encodes build order — foundational
   * capabilities like persistence rank highest because everything integrates against them.
   * But "resumable background downloader" is *about* downloading, even though it implies
   * persistence, and a discovery request that searched for the foundational capability
   * would return a database library. Undefined when nothing was recognised.
   */
  primary?: string;
  /**
   * Phrases we could not map to any known capability.
   *
   * This is a first-class output, not an error. When a requirement
   * is genuinely ambiguous we do NOT guess and we do NOT call a model — we hand the
   * ambiguity back to the calling agent, which has a model in the loop and far more context
   * about the user's intent than we do.
   */
  unrecognised: string[];
  stackDetected?: string;
}

export function decomposeRequirement(input: DecomposeInput): DecomposeResult {
  const headlinePosition = new Map<string, number>();
  const text = normalise(input.requirement + " " + (input.requirements ?? []).join(" "));
  const idioms = findStackIdioms(input.stack?.language, input.stack?.framework, input.stack?.platform, input.requirement);

  // 1. Direct capability detection.
  //
  // Detection in the REQUIREMENT SENTENCE is tracked separately from detection in the
  // caller's `requirements[]` list. The sentence says what is being built; the list says
  // what it must do. "persistent queue" in the requirements list should not make a
  // downloader request into a database request.
  const headlineText = normalise(input.requirement);
  const explicit = new Map<string, number>();
  const inHeadline = new Map<string, number>();
  for (const cap of CAPABILITIES) {
    const hits = cap.triggers.filter((t) => containsPhrase(text, t));
    if (hits.length) explicit.set(cap.id, hits.length);
    const headlineHits = cap.triggers.filter((t) => containsPhrase(headlineText, t));
    if (headlineHits.length) {
      inHeadline.set(cap.id, headlineHits.length);
      // Also record the earliest position, so the head of the phrase can win ties.
      const pos = earliestPosition(headlineText, cap.triggers);
      if (pos >= 0) headlinePosition.set(cap.id, pos);
    }
  }

  // 2. Implication closure. Breadth-first with a visited set — the graph is authored by
  //    hand and could contain a cycle, and a cycle must not hang the server.
  const implied = new Set<string>();
  const frontier = [...explicit.keys()];
  const seen = new Set(frontier);
  while (frontier.length) {
    const id = frontier.shift() as string;
    for (const dep of CAPABILITY_BY_ID.get(id)?.implies ?? []) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      implied.add(dep);
      frontier.push(dep);
    }
  }

  // 3. Build units.
  const units: FeatureUnit[] = [];
  const order = [...explicit.keys(), ...implied];
  for (const id of order) {
    const cap = CAPABILITY_BY_ID.get(id);
    if (!cap) continue;
    units.push(toUnit(cap, {
      isImplied: implied.has(id),
      triggerHits: explicit.get(id) ?? 0,
      idiomTerms: idioms?.idioms[id] ?? [],
      callerRequirements: (input.requirements ?? []).filter((r) =>
        cap.triggers.some((t) => containsPhrase(normalise(r), t))),
    }));
  }

  // 4. Dependency edges between units we actually produced.
  const present = new Set(units.map((u) => u.id));
  for (const u of units) {
    u.dependsOn = (CAPABILITY_BY_ID.get(u.id)?.implies ?? []).filter((d) => present.has(d));
  }

  units.sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));

  return {
    units,
    explicit: [...explicit.keys()],
    implied: [...implied],
    primary: choosePrimary(inHeadline, headlinePosition, explicit, headClauseEndIndex(input.requirement)),
    unrecognised: findUnrecognised(input.requirement, input.requirements ?? [], present),
    stackDetected: idioms?.language,
  };
}

/**
 * Which capability is the requirement primarily about?
 *
 * Three rules, applied in order:
 *
 *   1. **Head clause.** English attaches qualifiers after "with", "that", "supporting",
 *      "including", or a comma. "resumable background file downloader WITH pause and
 *      retry" is about a downloader; everything after "with" modifies it. So the search
 *      for the subject happens in the head clause only.
 *   2. **Narrower wins.** "OAuth login" matches both `oauth` and the general
 *      `auth-session`; `oauth` declares `narrows: ["auth-session"]`, so it takes it.
 *   3. **Last mentioned wins.** English compounds put the head noun last
 *      ("resumable background file *downloader*"), so among the survivors the latest
 *      match is the subject and earlier ones are modifiers.
 *
 * This is position-based rather than priority-based on purpose: build priority ranks
 * foundational capabilities first, which would resolve a downloader request to
 * `persistence` and return a database library. It did exactly that before this was fixed.
 */
function choosePrimary(
  inHeadline: Map<string, number>,
  positions: Map<string, number>,
  explicit: Map<string, number>,
  headClauseEnd: number,
): string | undefined {
  if (inHeadline.size === 0) return [...explicit.keys()][0];

  // Rule 1 — restrict to the head clause, unless that would leave nothing.
  let pool = [...inHeadline.keys()].filter((id) => (positions.get(id) ?? Infinity) < headClauseEnd);
  if (pool.length === 0) pool = [...inHeadline.keys()];

  // Rule 2 — drop capabilities that a present, narrower capability supersedes.
  const superseded = new Set<string>();
  for (const id of pool) {
    for (const broader of CAPABILITY_BY_ID.get(id)?.narrows ?? []) {
      if (pool.includes(broader)) superseded.add(broader);
    }
  }
  const survivors = pool.filter((id) => !superseded.has(id));
  const finalPool = survivors.length ? survivors : pool;

  // Rule 3 — last mentioned, then most trigger hits.
  return finalPool.sort((a, b) => {
    const posDelta = (positions.get(b) ?? -1) - (positions.get(a) ?? -1);
    if (posDelta !== 0) return posDelta;
    return (inHeadline.get(b) ?? 0) - (inHeadline.get(a) ?? 0);
  })[0];
}

/**
 * Token index where the head clause ends.
 *
 * Qualifier markers: "with", "that", "which", "supporting", "including", "featuring",
 * "using", "for", and punctuation. Everything after the first one modifies the subject
 * rather than being it.
 */
const QUALIFIER_MARKERS = new Set([
  "with", "that", "which", "supporting", "support", "including", "include",
  "featuring", "having", "plus", "and", "or",
]);

function headClauseEndIndex(headline: string): number {
  const tokens = stemPhrase(headline).split(" ").filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    if (QUALIFIER_MARKERS.has(tokens[i] as string)) return i;
  }
  return tokens.length;
}

/** Earliest token index at which any of `triggers` matches, or -1. */
function earliestPosition(haystack: string, triggers: string[]): number {
  const hTokens = stemPhrase(haystack).split(" ").filter(Boolean);
  let best = -1;
  for (const trigger of triggers) {
    const nTokens = stemPhrase(trigger).split(" ").filter(Boolean);
    if (!nTokens.length) continue;
    for (let i = 0; i <= hTokens.length - nTokens.length; i++) {
      let ok = true;
      for (let j = 0; j < nTokens.length; j++) {
        if (hTokens[i + j] !== nTokens[j]) { ok = false; break; }
      }
      if (ok) { if (best === -1 || i < best) best = i; break; }
    }
  }
  return best;
}

function toUnit(
  cap: Capability,
  ctx: { isImplied: boolean; triggerHits: number; idiomTerms: string[]; callerRequirements: string[] },
): FeatureUnit {
  // Priority ordering drives both build order and discovery budget. Foundational
  // capabilities rank highest because everything else integrates against them, and
  // discovering them late means re-adapting work already done.
  let priority = 50;
  if (cap.foundational) priority += 25;
  if (cap.reuseValue === "high") priority += 15;
  else if (cap.reuseValue === "low") priority -= 15;
  if (ctx.isImplied) priority -= 20;          // explicit asks outrank inferred ones
  priority += Math.min(10, ctx.triggerHits * 3);

  return {
    id: cap.id,
    name: cap.label,
    description: ctx.isImplied
      ? `${cap.label} — required by another requested feature`
      : cap.label,
    // Caller-supplied requirements come first: they are ground truth about this specific
    // project, where our checklist is a generic expectation.
    requirements: dedupe([...ctx.callerRequirements, ...cap.checklist]),
    priority: Math.max(0, Math.min(100, priority)),
    dependsOn: [],
    reusePotential: cap.reuseValue,
    // Stack idioms first — "WorkManager" finds implementations where "background worker"
    // finds tutorials.
    searchTerms: dedupe([...ctx.idiomTerms, ...cap.searchTerms]),
    category: cap.category as FeatureCategory,
  };
}

/**
 * Phrases that look like feature requests but matched no known capability.
 *
 * The point of this list is to say honestly "we did not plan for this". That only works if
 * it is accurate in BOTH directions, and it was accurate in neither:
 *
 *   - It reported "migrations", "adaptive streaming", "deep linking" and "automatic
 *     reconnection" as unrecognised. Every one of those is a CHECKLIST ITEM of a
 *     capability that was detected — they are planned for, just not as separate features.
 *     A list of eight items where six are wrong is noise, and noise hides the two that
 *     matter.
 *   - It missed "CSV and PDF import" and "internationalisation", the two genuine gaps.
 *
 * So a fragment is only reported when it matches neither a capability TRIGGER nor any
 * checklist item of a capability we detected. Checklists are the record of what a
 * capability actually covers, so consulting them is what makes the answer honest.
 */
function findUnrecognised(requirement: string, extra: string[], covered: Set<string>): string[] {
  // Everything the detected capabilities already account for.
  const coveredText = normalise(
    [...covered]
      .map((id) => {
        const cap = CAPABILITY_BY_ID.get(id);
        return cap ? [cap.label, ...cap.checklist, ...cap.searchTerms, ...cap.triggers].join(" ") : "";
      })
      .join(" "),
  );
  const coveredTokens = new Set(stemPhrase(coveredText).split(" ").filter(Boolean));

  const out = new Set<string>();
  for (const src of [requirement, ...extra]) {
    for (const frag of src.split(/[,;\n·•]|\band\b|\bwith\b|\bplus\b/i)) {
      const t = frag
        .trim().toLowerCase()
        .replace(/^(build|create|add|implement|support|need|want|it needs|a|an|the)\s+/g, "")
        .trim();
      if (t.length < 4 || t.length > 60) continue;
      if (!/^[a-z][a-z0-9 /_-]*$/.test(t)) continue;

      // Already a known capability, under any phrasing?
      if (CAPABILITIES.some((c) => c.triggers.some((tr) => containsPhrase(t, tr)))) continue;

      // Already covered by a detected capability's checklist or vocabulary? A fragment is
      // considered covered when MOST of its distinctive words already appear there —
      // requiring all of them would let one stray adjective resurrect a covered item.
      const words = stemPhrase(t).split(" ").filter((w) => w.length >= 3);
      if (words.length) {
        const known = words.filter((w) => coveredTokens.has(w)).length;
        if (known * 2 >= words.length) continue;
      }

      out.add(t);
    }
  }
  return [...out].slice(0, 8);
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Light morphological stemming, applied identically to triggers and requirement text.
 *
 * This exists because of a real miss: the requirement "downloads media … background
 * downloads … download queue" did NOT match the trigger `download`, because every
 * occurrence was plural and the boundary check rejected the trailing "s". The single most
 * important capability in the requirement was silently dropped, and nothing failed — the
 * plan simply came back without it. Morphological variation is the norm in prose
 * requirements, not the exception.
 *
 * Deliberately crude (suffix stripping, no dictionary): it only has to make the two sides
 * agree, not to be linguistically correct. "class" → "clas" is fine, because the trigger
 * side is stemmed the same way. Guarded by a minimum stem length so short words
 * ("is", "was", "des") are left alone.
 */
function stemWord(w: string): string {
  let x = w;
  // "ies" -> "y" first and as a whole: stripping it bare gives "retries" -> "retr" while
  // "retry" -> "retry", so the two sides would never converge.
  if (x.length >= 5 && x.endsWith("ies")) {
    x = x.slice(0, -3) + "y";
  } else {
    for (const suffix of ["ings", "ing", "ers", "er", "ed", "es", "s"]) {
      if (x.length - suffix.length >= 4 && x.endsWith(suffix)) {
        x = x.slice(0, -suffix.length);
        break;
      }
    }
  }
  // "cache"/"caching" only converge once the silent trailing "e" also goes.
  if (x.length >= 5 && x.endsWith("e")) x = x.slice(0, -1);
  return x;
}

function stemPhrase(s: string): string {
  return normalise(s).split(" ").filter(Boolean).map(stemWord).join(" ");
}

/**
 * Phrase containment on stemmed tokens, with word boundaries.
 *
 * Boundaries still matter after stemming: substring matching would fire "auth" inside
 * "author" and "sync" inside "asynchronous", polluting decomposition with capabilities
 * nobody asked for. So we match whole stemmed tokens, not substrings.
 */
function containsPhrase(haystack: string, needle: string): boolean {
  const hTokens = stemPhrase(haystack).split(" ").filter(Boolean);
  const nTokens = stemPhrase(needle).split(" ").filter(Boolean);
  if (nTokens.length === 0 || hTokens.length < nTokens.length) return false;

  for (let i = 0; i <= hTokens.length - nTokens.length; i++) {
    let ok = true;
    for (let j = 0; j < nTokens.length; j++) {
      if (hTokens[i + j] !== nTokens[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}
