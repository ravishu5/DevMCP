/**
 * Secret detection and redaction (spec §22).
 *
 * Two distinct duties, often conflated:
 *
 *   1. **Outbound protection.** Our own GitHub token must never appear in a log line, an
 *      error message or a tool result. Errors are the usual leak: a failed request helpfully
 *      includes the URL, and someone put the token in a query parameter.
 *
 *   2. **Inbound protection.** Repositories contain committed secrets — AWS keys, private
 *      keys, `.env` files. If we extract a file and hand it to the agent, we have
 *      republished someone's leaked credential into a model context and possibly into the
 *      user's new codebase. We redact before that can happen.
 *
 * Redaction preserves *shape* (`AKIA…REDACTED…`) rather than deleting, so the agent can
 * still see "this code expects an AWS key here" — which is the technically useful part —
 * without receiving the key itself.
 */

export interface SecretFinding {
  kind: string;
  /** Never the secret. A stable, non-reversible fingerprint for deduplication. */
  fingerprint: string;
  offset: number;
}

export interface RedactionResult {
  text: string;
  findings: SecretFinding[];
  redactedCount: number;
}

interface SecretRule {
  kind: string;
  re: RegExp;
  /** Keep this many leading chars so the *type* stays visible. */
  keepPrefix: number;
}

const RULES: SecretRule[] = [
  { kind: "github-token", re: /\b(gh[pousr]_[A-Za-z0-9]{16,255})\b/g, keepPrefix: 4 },
  { kind: "github-fine-grained", re: /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g, keepPrefix: 11 },
  { kind: "aws-access-key", re: /\b((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})\b/g, keepPrefix: 4 },
  { kind: "aws-secret-key", re: /\baws_secret_access_key\s*[=:]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi, keepPrefix: 0 },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, keepPrefix: 4 },
  { kind: "slack-token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, keepPrefix: 5 },
  { kind: "stripe-key", re: /\b[sr]k_(live|test)_[0-9A-Za-z]{16,}\b/g, keepPrefix: 8 },
  { kind: "openai-key", re: /\bsk-(proj-)?[A-Za-z0-9_-]{20,}\b/g, keepPrefix: 3 },
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, keepPrefix: 7 },
  { kind: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/g, keepPrefix: 4 },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, keepPrefix: 3 },
  { kind: "private-key-block", re: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g, keepPrefix: 0 },
  { kind: "generic-bearer", re: /\b[Bb]earer\s+[A-Za-z0-9._-]{20,}/g, keepPrefix: 7 },
  // Assignment-shaped secrets in config/env files: the most common real-world case.
  { kind: "assigned-secret", re: /\b([A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET))\s*[=:]\s*['"]?([^\s'"#,;)}\]]{8,})['"]?/g, keepPrefix: 0 },
];

/** Values that look like secrets but are placeholders. Redacting them adds noise. */
/**
 * Values that look like secrets but are placeholders. Redacting them is pure noise.
 *
 * Every alternative is anchored and separator-bounded on purpose. An earlier version used
 * bare prefixes like `a[\w-]*`, which — case-insensitively — swallowed `AKIAIOSFODNN7EXAMPLE`
 * and silently disabled AWS key detection. Placeholder words must therefore be whole
 * separator-delimited tokens, never prefixes of arbitrary text.
 */
const PLACEHOLDER_WORDS =
  "your|yours|my|our|the|some|example|examples|sample|placeholder|changeme|change|dummy|fake|" +
  "demo|test|testing|here|value|goes|insert|replace|enter|add|put|xxx|todo|fixme|tbd|redacted";

const PLACEHOLDER = new RegExp(
  "^(?:" +
    "x{3,}|\\*{3,}|\\.{3,}|-{3,}|_{3,}" +                       // xxxx **** .... ---- ____
    "|<[^>]*>|\\$\\{[^}]*\\}?|\\{\\{[^}]*\\}\\}|%[A-Za-z0-9_]+%" +  // <key> ${VAR} {{v}} %VAR%
    "|none|null|nil|undefined|n/?a|true|false" +
    // A separator-joined phrase built ONLY from placeholder words plus generic secret
    // nouns: "your-api-key-here", "changeme", "my_secret_token", "test-value".
    "|(?:" + PLACEHOLDER_WORDS + "|api|key|apikey|secret|token|password|passwd|pass|auth|" +
      "credential|credentials|id|client)" +
      "(?:[-_. ](?:" + PLACEHOLDER_WORDS + "|api|key|apikey|secret|token|password|passwd|pass|auth|" +
      "credential|credentials|id|client))*" +
  ")$",
  "i",
);

export function redactSecrets(text: string): RedactionResult {
  if (!text) return { text: "", findings: [], redactedCount: 0 };

  const findings: SecretFinding[] = [];
  let out = text;

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, (match, ...rest) => {
      // replace() passes (match, ...captures, offset, wholeString) — and `wholeString` is
      // itself a string, so filtering by typeof would treat the ENTIRE input as the last
      // capture. That bug silently defeated every placeholder check. Drop the trailing two
      // positional args explicitly instead.
      const captures = rest.slice(0, Math.max(0, rest.length - 2)) as (string | undefined)[];
      const value = rule.kind === "assigned-secret" ? captures[captures.length - 1] : match;
      if (value && PLACEHOLDER.test(value.trim())) return match;

      findings.push({ kind: rule.kind, fingerprint: fingerprint(value ?? match), offset: 0 });

      if (rule.kind === "assigned-secret" && captures.length >= 2) {
        const name = captures[0] as string;
        return `${name}=⟦REDACTED:${rule.kind}⟧`;
      }
      if (rule.kind === "private-key-block") return "⟦REDACTED:private-key-block⟧";
      const prefix = match.slice(0, rule.keepPrefix);
      return `${prefix}⟦REDACTED:${rule.kind}⟧`;
    });
  }

  return { text: out, findings, redactedCount: findings.length };
}

/**
 * Scrub known-sensitive values (our own token) from any string before it is logged or
 * returned. Called on every error message and log field.
 *
 * This is separate from `redactSecrets` because it targets *values we hold*, which pattern
 * matching would not necessarily catch — a token from a GitHub Enterprise instance may have
 * a shape we have no rule for.
 */
export class SecretScrubber {
  private readonly values: string[] = [];

  /** Register a secret. Short values are ignored to avoid mangling ordinary text. */
  register(secret: string | undefined): void {
    if (secret && secret.length >= 12 && !this.values.includes(secret)) this.values.push(secret);
  }

  scrub(text: string): string {
    let out = text;
    for (const v of this.values) out = out.split(v).join("⟦REDACTED:configured-secret⟧");
    return redactSecrets(out).text;
  }

  /** Deep-scrub a structure destined for a log line or tool result. */
  scrubDeep<T>(value: T, depth = 0): T {
    if (depth > 6) return value;
    if (typeof value === "string") return this.scrub(value) as unknown as T;
    if (Array.isArray(value)) return value.map((v) => this.scrubDeep(v, depth + 1)) as unknown as T;
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, this.scrubDeep(v, depth + 1)]),
      ) as unknown as T;
    }
    return value;
  }
}

/** Non-reversible short fingerprint, safe to log for deduplication. */
function fingerprint(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Files whose contents are almost always secrets. Never retrieve these as "source". */
const SENSITIVE_PATHS = [
  /(^|\/)\.env(\.|$)/i, /(^|\/)\.npmrc$/i, /(^|\/)\.netrc$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i, /\.pem$/i, /\.p12$/i, /\.pfx$/i, /\.keystore$/i, /\.jks$/i,
  /(^|\/)credentials$/i, /(^|\/)secrets?\.(ya?ml|json|toml)$/i,
  /(^|\/)\.aws\//i, /(^|\/)\.ssh\//i,
];

export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATHS.some((re) => re.test(path));
}
