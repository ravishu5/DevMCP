/**
 * Implementation completeness.
 *
 * The question this answers: **how much of the REQUESTED checklist does this candidate
 * actually implement?** Not "how popular is it".
 *
 *   Requested            Evidenced
 *   ✓ Download           ✓ (symbol DownloadManager)
 *   ✓ Resume             ✓ (code hit: Range header)
 *   ✓ Pause              ✗
 *   ✓ Retry              ✓ (dependency + symbol RetryPolicy)
 *   ✓ Queue              ✓
 *   ✓ Persistence        ✗
 *   ✓ Background         ✓                       →  5/7 = 0.71
 *
 * A 400-star repository implementing 7/7 beats a 40 000-star one implementing 3/7, and no
 * amount of popularity weighting recovers that. This is the signal that makes the ranking
 * about *implementations* rather than about GitHub.
 *
 * Evidence sources, in descending strength:
 *   1. symbol names from the code index   (strongest — the code demonstrably exists)
 *   2. code-search fragments              (strong — the technique appears in source)
 *   3. dependency names                   (medium — a capability is pulled in)
 *   4. file paths in the tree             (medium)
 *   5. README / description / topics      (weak — a claim, not a demonstration)
 *
 * Distinguishing "absent" from "unknown" matters: a repository we only saw metadata for
 * has *unknown* coverage, not zero. Scoring those the same would systematically punish
 * candidates we simply had no budget to analyse deeply.
 */

import type { CodeSymbol, CompletenessItem, CompletenessReport, Dependency } from "../types/index.js";

export interface CompletenessInput {
  /** The requirement checklist to score against. */
  checklist: string[];
  /** Extra capability keywords worth crediting (from the ImplementationTask). */
  capabilityTerms?: string[];
  symbols?: CodeSymbol[];
  filePaths?: string[];
  dependencies?: Dependency[];
  codeSearchFragments?: string[];
  readme?: string;
  description?: string;
  topics?: string[];
  /** True when only metadata was available — turns "absent" into "unknown". */
  metadataOnly?: boolean;
}

interface EvidenceHit { text: string; weight: number; source: string; }

export function assessCompleteness(input: CompletenessInput): CompletenessReport {
  const items: CompletenessItem[] = [];

  // Build the searchable corpora once, each with its own evidential weight.
  const corpora: { text: string; weight: number; source: string }[] = [];
  if (input.symbols?.length) {
    corpora.push({
      text: input.symbols.map((s) => `${s.name} ${s.signature ?? ""} ${s.filePath} ${s.purpose ?? ""}`).join(" \n"),
      weight: 1.0, source: "symbols",
    });
  }
  if (input.codeSearchFragments?.length) {
    corpora.push({ text: input.codeSearchFragments.join(" \n"), weight: 0.9, source: "code-search" });
  }
  if (input.dependencies?.length) {
    corpora.push({ text: input.dependencies.map((d) => d.name).join(" "), weight: 0.6, source: "dependencies" });
  }
  if (input.filePaths?.length) {
    corpora.push({ text: input.filePaths.join(" "), weight: 0.55, source: "files" });
  }
  if (input.readme) corpora.push({ text: input.readme, weight: 0.35, source: "readme" });
  if (input.description || input.topics?.length) {
    corpora.push({ text: `${input.description ?? ""} ${(input.topics ?? []).join(" ")}`, weight: 0.3, source: "metadata" });
  }

  const haveStrongSource = corpora.some((c) => c.weight >= 0.55);

  for (const requirement of input.checklist) {
    const terms = extractTerms(requirement);
    const hits: EvidenceHit[] = [];

    for (const corpus of corpora) {
      const lower = corpus.text.toLowerCase();
      for (const term of terms) {
        if (matches(lower, term)) {
          hits.push({ text: term, weight: corpus.weight, source: corpus.source });
        }
      }
    }

    // A requirement is evidenced when enough of its distinctive terms are found. Requiring
    // ALL terms would fail on paraphrase; requiring ANY would fire on a single common word.
    const distinctTerms = new Set(hits.map((h) => h.text));
    const coverage = terms.length ? distinctTerms.size / terms.length : 0;
    const bestWeight = hits.reduce((a, h) => Math.max(a, h.weight), 0);

    /**
     * Distinctive-term rule.
     *
     * Plain coverage is too brittle against how code is actually named. "sends Range
     * header" scores 1/3 against a symbol called `RangeRequestBuilder` — because `sends`
     * and `header` are prose, not identifiers — yet that symbol is unambiguous evidence.
     *
     * So a single *distinctive* term (long, and not a generic requirement verb) found in a
     * *strong* source (symbols or code search) is sufficient on its own. Short or generic
     * terms never qualify, which is what stops "handles" or "data" from carrying a
     * requirement by themselves.
     */
    const distinctiveHit = hits.some((h) => h.weight >= 0.85 && isDistinctive(h.text));
    const confidence = round2(Math.min(1, Math.max(coverage, distinctiveHit ? 0.6 : 0) * bestWeight * 1.4));

    let status: CompletenessItem["status"];
    if ((coverage >= 0.5 && bestWeight >= 0.3) || distinctiveHit) status = "evidenced";
    else if (!haveStrongSource) status = "unknown";        // we never looked properly
    else if (input.metadataOnly) status = "unknown";
    else status = "absent";

    items.push({
      requirement,
      status,
      evidence: [...new Set(hits.map((h) => `${h.source}:${h.text}`))].slice(0, 5),
      confidence,
    });
  }

  const satisfied = items.filter((i) => i.status === "evidenced").length;
  const undetermined = items.filter((i) => i.status === "unknown").map((i) => i.requirement);
  const decidable = items.length - undetermined.length;

  return {
    items,
    satisfied,
    total: items.length,
    // Ratio is over DECIDABLE items. Dividing by the full total would conflate "we found
    // it missing" with "we never checked", punishing shallow analysis rather than reporting it.
    ratio: decidable > 0 ? round2(satisfied / decidable) : 0,
    undetermined,
  };
}

/**
 * Requirement verbs and generic nouns that appear in prose but essentially never in
 * identifiers. They may still count toward coverage, but never on their own.
 */
const GENERIC_TERMS = new Set([
  "send", "sends", "sent", "persist", "persists", "handle", "handles", "report", "reports",
  "support", "supports", "provide", "provides", "validate", "validates", "write", "writes",
  "read", "reads", "emit", "emits", "initiate", "initiates", "configure", "configures",
  "manage", "manages", "allow", "allows", "ensure", "ensures", "use", "uses", "used",
  "data", "value", "values", "item", "items", "thing", "things", "state", "info",
  "after", "before", "during", "large", "small", "files", "file",
]);

function isDistinctive(term: string): boolean {
  return term.length >= 5 && !GENERIC_TERMS.has(term);
}

/** Distinctive terms from a requirement sentence. Stop-words removed; short words dropped. */
function extractTerms(requirement: string): string[] {
  const stop = new Set([
    "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "with", "is", "are", "be",
    "it", "its", "when", "where", "that", "this", "supports", "support", "handles", "handle",
    "provides", "provide", "must", "should", "can", "has", "have", "from", "into", "per",
    "after", "before", "each", "any", "all", "not", "no",
  ]);
  const words = requirement.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/)
    .filter((w) => w.length >= 3 && !stop.has(w));
  return [...new Set(words)].slice(0, 6);
}

/**
 * Term matching that tolerates the naming conventions code actually uses.
 *
 * "byte offset" must match `byteOffset`, `byte_offset` and `BYTE_OFFSET`; "retry" must
 * match `RetryPolicy`. So we compare against a de-cased, separator-stripped form as well as
 * the raw text. Terms of four characters or more also match as substrings, because symbol
 * names concatenate words with no separator at all.
 */
function matches(haystackLower: string, term: string): boolean {
  if (haystackLower.includes(term)) return true;
  const squashedHay = haystackLower.replace(/[_\-\s]/g, "");
  const squashedTerm = term.replace(/[_\-\s]/g, "");
  if (squashedTerm.length >= 4 && squashedHay.includes(squashedTerm)) return true;
  // Singular/plural tolerance without a full stemmer.
  if (term.endsWith("s") && term.length > 4 && squashedHay.includes(squashedTerm.slice(0, -1))) return true;
  return false;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
