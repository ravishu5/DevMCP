/**
 * The single sanitisation boundary.
 *
 * Everything upstream (GitHub, jCodeMunch) passes through here before it can appear in a
 * tool result. Having exactly one boundary is the point: a second, ad-hoc path is how
 * unsanitised text eventually ships. Providers depend on `Sanitizer`, never on the
 * individual modules, so the composition order (redact → neutralise → truncate → frame)
 * is decided once and cannot be got wrong at a call site.
 *
 * Order matters and is deliberate:
 *   1. redact secrets FIRST — before truncation could split a key in half and defeat the
 *      pattern, and before any excerpt of the text is captured into a finding;
 *   2. neutralise injection mechanisms;
 *   3. truncate to budget;
 *   4. frame in an untrusted envelope when the content is prose (README, comments).
 */

import {
  detectInjection, injectionRisk, sanitizeField as neutraliseField, sanitizeUntrusted,
  wrapUntrusted, type InjectionFinding,
} from "./injection.js";
import { isSensitivePath, redactSecrets, SecretScrubber, type SecretFinding } from "./secrets.js";
import { safeRepoPath } from "./paths.js";
import { estimateTokens, type ContentKind } from "../core/tokens.js";

export interface SanitizeOptions {
  /** What this text is, for the envelope label and token estimation. */
  kind: "readme" | "source" | "comment" | "commit-message" | "issue" | "description" | "doc" | "manifest";
  /** Where it came from, e.g. "github:owner/repo@sha:README.md". */
  source: string;
  /** Hard ceiling in estimated tokens. Content is truncated at a line boundary. */
  maxTokens?: number;
  /** Wrap in the untrusted-content envelope. Default: true for prose, false for source. */
  frame?: boolean;
}

export interface SanitizeResult {
  text: string;
  injectionFindings: InjectionFinding[];
  secretFindings: SecretFinding[];
  risk: "none" | "low" | "medium" | "high";
  truncated: boolean;
  estimatedTokens: number;
  /** True when the content was withheld entirely because it was too hostile to quote. */
  withheld: boolean;
}

export class Sanitizer {
  private readonly scrubber = new SecretScrubber();

  /** Register our own secrets so they can never be echoed back. */
  registerSecret(secret: string | undefined): void {
    this.scrubber.register(secret);
  }

  /**
   * Full pipeline for a block of upstream text.
   *
   * High-risk prose is **withheld rather than quoted**: a README carrying two or more
   * high-severity injection patterns has no technical content valuable enough to justify
   * putting it in front of the agent. We report the finding instead, which is what the
   * operator actually needs to know.
   */
  sanitize(raw: string, opts: SanitizeOptions): SanitizeResult {
    if (!raw) {
      return { text: "", injectionFindings: [], secretFindings: [], risk: "none", truncated: false, estimatedTokens: 0, withheld: false };
    }

    // 1. Secrets first — truncation must never split a key and defeat detection.
    const redacted = redactSecrets(this.scrubber.scrub(raw));

    // 2. Injection detection + neutralisation.
    const findings = detectInjection(redacted.text);
    const risk = injectionRisk(findings);

    const isProse = opts.kind !== "source" && opts.kind !== "manifest";
    if (risk === "high" && isProse) {
      const patterns = [...new Set(findings.map((f) => f.pattern))].join(", ");
      return {
        text: `[content withheld: ${opts.kind} from ${opts.source} contains ${findings.length} prompt-injection pattern(s) (${patterns}) and was not quoted]`,
        injectionFindings: findings,
        secretFindings: redacted.findings,
        risk,
        truncated: false,
        estimatedTokens: 40,
        withheld: true,
      };
    }

    const neutralised = sanitizeUntrusted(redacted.text);

    // 3. Truncate to budget at a line boundary.
    const contentKind: ContentKind = opts.kind === "source" ? "code" : "prose";
    const { text: capped, truncated } = truncateToTokens(neutralised.text, opts.maxTokens, contentKind);

    // 4. Frame. Source is not framed by default: it is normally rendered inside a fenced
    //    code block with its own provenance header, and double-wrapping wastes tokens.
    const shouldFrame = opts.frame ?? isProse;
    const framed = shouldFrame
      ? wrapUntrusted(capped, { source: opts.source, kind: opts.kind, findings })
      : capped;

    return {
      text: framed,
      injectionFindings: findings,
      secretFindings: redacted.findings,
      risk,
      truncated,
      estimatedTokens: estimateTokens(framed, contentKind),
      withheld: false,
    };
  }

  /**
   * Short single-line fields (repo descriptions, topics, commit subjects).
   * Framing a 12-word description would cost more tokens than the description itself, so
   * these are neutralised and length-capped instead.
   */
  sanitizeField(raw: string | null | undefined, maxChars = 300): string {
    if (!raw) return "";
    const scrubbed = redactSecrets(this.scrubber.scrub(raw)).text;
    // Field-level neutralisation REPLACES a high-severity match rather than quoting it —
    // see the note on `neutraliseField`. Short metadata has no documentation value to
    // preserve, so echoing the attacker's phrasing buys nothing.
    const clean = neutraliseField(scrubbed).text.replace(/[\r\n]+/g, " ").trim();
    return clean.length > maxChars ? clean.slice(0, maxChars - 1) + "…" : clean;
  }

  /** Scrub a value destined for a log line or an error message. */
  scrubForLog<T>(value: T): T {
    return this.scrubber.scrubDeep(value);
  }

  /**
   * Whether a file may be retrieved as source at all.
   *
   * Rejects traversal-shaped paths and files that are definitionally secrets (`.env`,
   * private keys). Returning a reason lets the caller report *why* a file was skipped,
   * which matters: silently omitting a file the agent asked for looks like a bug.
   */
  checkFilePath(path: string): { ok: true; path: string } | { ok: false; reason: string } {
    const norm = safeRepoPath(path);
    if (!norm) return { ok: false, reason: "path traversal or malformed path rejected" };
    if (isSensitivePath(norm)) return { ok: false, reason: "sensitive file type; contents are not retrieved" };
    return { ok: true, path: norm };
  }
}

/** Truncate at a line boundary so code and prose stay readable. */
export function truncateToTokens(
  text: string,
  maxTokens: number | undefined,
  kind: ContentKind = "prose",
): { text: string; truncated: boolean } {
  if (!maxTokens || maxTokens <= 0) return { text, truncated: false };
  if (estimateTokens(text, kind) <= maxTokens) return { text, truncated: false };

  const lines = text.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = estimateTokens(line + "\n", kind);
    if (used + cost > maxTokens) break;
    kept.push(line);
    used += cost;
  }
  // A single enormous line: hard-cut by characters rather than returning nothing.
  if (kept.length === 0) {
    const chars = Math.max(1, maxTokens * (kind === "code" ? 3 : 4));
    return { text: text.slice(0, chars) + "\n… [truncated]", truncated: true };
  }
  return { text: kept.join("\n") + "\n… [truncated]", truncated: true };
}
