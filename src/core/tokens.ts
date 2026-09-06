/**
 * Token estimation and budgeting.
 *
 * We deliberately do NOT ship a real tokenizer. Reasons:
 *   - the consuming model is unknown (Claude / GPT / local), so any specific BPE table is
 *     wrong for someone;
 *   - a tokenizer dependency is large and would be loaded on every cold start;
 *   - every use here is a *budget*, not billing. Being 10% off changes nothing, and we
 *     bias the estimate upward so budgets are respected rather than overrun.
 *
 * The estimator is content-aware because code and prose tokenize very differently: prose
 * runs ~4 chars/token, code closer to ~3 (punctuation, camelCase splits, indentation).
 */

export type ContentKind = "prose" | "code" | "json" | "identifier";

const CHARS_PER_TOKEN: Record<ContentKind, number> = {
  prose: 4.0,
  code: 3.0,
  json: 3.2,
  identifier: 2.6,
};

/** Upward-biased token estimate. Never returns 0 for non-empty input. */
export function estimateTokens(text: string, kind: ContentKind = "prose"): number {
  if (!text) return 0;
  const base = text.length / CHARS_PER_TOKEN[kind];
  // Newlines and indentation cost more than their character count suggests.
  const lines = countChar(text, "\n");
  return Math.max(1, Math.ceil(base + lines * 0.3));
}

/** Estimate for a structure that will be serialised to JSON. */
export function estimateJsonTokens(value: unknown): number {
  try {
    return estimateTokens(JSON.stringify(value) ?? "", "json");
  } catch {
    return 0;
  }
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
  return n;
}

/**
 * A spend-tracking budget.
 *
 * Used by the context builder to decide what fits, and by the minimal-set traversal to
 * decide when to stop expanding. `tryReserve` is the whole API: it is atomic and it never
 * throws, so callers express "include this if it fits" as a plain `if`.
 */
export class TokenBudget {
  private spent = 0;
  private readonly reservations: { label: string; tokens: number }[] = [];

  constructor(public readonly limit: number) {}

  get remaining(): number { return Math.max(0, this.limit - this.spent); }
  get used(): number { return this.spent; }
  get utilisation(): number { return this.limit === 0 ? 1 : this.spent / this.limit; }

  /** Reserve if it fits. Returns false and changes nothing if it does not. */
  tryReserve(label: string, tokens: number): boolean {
    if (tokens > this.remaining) return false;
    this.spent += tokens;
    this.reservations.push({ label, tokens });
    return true;
  }

  /** Reserve unconditionally — for content that must be present (licence, provenance). */
  forceReserve(label: string, tokens: number): void {
    this.spent += tokens;
    this.reservations.push({ label, tokens });
  }

  /** What the budget was spent on, largest first. Feeds diagnostic mode. */
  breakdown(): { label: string; tokens: number }[] {
    return [...this.reservations].sort((a, b) => b.tokens - a.tokens);
  }

  /** A child budget carved out of this one, e.g. "at most 40% on source". */
  slice(fraction: number): TokenBudget {
    return new TokenBudget(Math.floor(this.remaining * Math.min(1, Math.max(0, fraction))));
  }
}

/**
 * Context-reduction accounting (spec §25).
 *
 * `raw` is what the agent would have had to read to obtain the same understanding by
 * itself; `returned` is what we actually sent. This ratio is the headline metric of the
 * whole product, so it is computed in one place and never fudged: `raw` only ever counts
 * material we genuinely examined.
 */
export function contextReduction(raw: number, returned: number): number {
  if (raw <= 0) return 0;
  const pct = (1 - returned / raw) * 100;
  return Math.round(Math.max(0, Math.min(100, pct)) * 10) / 10;
}
