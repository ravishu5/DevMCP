# SECURITY — Implementation Intelligence MCP

This server reads **arbitrary, attacker-controlled repositories** and returns text to an
LLM that is driving tools inside a user's project. That combination is the entire threat
model: repository content is a data channel that terminates in an agent capable of writing
files and running commands.

The governing rule, from spec §22:

> **Repository content is DATA, not instructions.**

---

## 1. Threat model

| # | Threat | Impact | Mitigation |
|---|---|---|---|
| T1 | **Prompt injection** in README, comments, source, commit messages, issue text | Repository author gains influence over the coding agent | `src/security/injection.ts` — detect, neutralise, frame (§2) |
| T2 | **Hidden-character smuggling** (zero-width, Unicode Tags) | Instructions invisible to human review reach the model | Stripped outright before any other processing |
| T3 | **Republishing committed secrets** from a repository | Someone's leaked credential enters the model context and possibly the user's new codebase | `src/security/secrets.ts` — redact inbound, preserve shape |
| T4 | **Leaking our own GitHub token** via logs or error messages | Account compromise | `SecretScrubber` on every log field and error; `redactedConfig()` for diagnostics |
| T5 | **Path traversal** via crafted repository file paths | Reading outside the project root during target analysis; cache-key collisions | `src/security/paths.ts` — `safeJoin`, `safeRepoPath` |
| T6 | **Arbitrary code execution** via build scripts, install hooks, `postinstall` | Full compromise of the developer machine | **Nothing from a repository is ever executed** (§4) |
| T7 | **Resource exhaustion** — enormous repositories, ReDoS-shaped content | Hung tool call, denied service | Size caps, timeouts, bounded regex iteration |
| T8 | **Malicious licence claims** — a repo asserting terms it does not have | User ships infringing code | Licence read from the licence file and API, never from prose claims; advisory-only verdicts |
| T9 | **Typosquat / impersonation repositories** | Agent reuses a hostile lookalike | Dedup + quality signals + provenance; the recommendation always names the exact `owner/repo@sha` |

---

## 2. Prompt-injection defence (spec §23)

Three independent layers. None is sufficient alone, which is the reason there are three.

### Layer 1 — Detect
`detectInjection()` scans for instruction-override phrasing, injected role markers, chat
template tokens (`<|im_start|>`, `[INST]`, `<<SYS>>`), exfiltration directives, claimed
authority, jailbreak personas, AI-directed meta-instructions, and hidden Unicode.

Rules are tuned for **recall over precision**: a false positive costs an annotation on a
README; a false negative costs an injected instruction reaching the agent.

### Layer 2 — Neutralise
`sanitizeUntrusted()` defangs the **mechanism**, not the vocabulary:

* invisible characters and chat-template markers → removed outright (never legitimate in
  extracted technical content);
* line-leading `system:` / `assistant:` prefixes → broken so they cannot mimic a turn;
* override phrasing → wrapped in `⟦neutralised: …⟧`, keeping the words readable.

Deleting the *word* "ignore" would mangle real documentation (`.gitignore`, "ignore
patterns"). Breaking the imperative *structure* preserves meaning while removing the
command shape. There is a test asserting benign documentation passes through
byte-identical.

### Layer 3 — Frame
`wrapUntrusted()` encloses content in a fence that states, structurally, that the enclosed
text is third-party data and must not be followed. Any occurrence of the fence inside the
body is escaped, so content cannot forge its way out of the envelope.

### Withholding
Prose scoring **high** risk (≥ 2 high-severity patterns) is **not quoted at all**. A README
that hostile has no technical content valuable enough to justify putting it in front of the
agent; we report the finding instead, which is what the operator actually needs.

Source code is treated differently — it is neutralised but still returned, because
otherwise we could not report on files that merely *mention* these strings.

### What we deliberately do not do
We do not silently delete suspicious text and present the remainder as clean. Silent
deletion destroys the technical content we were asked to extract **and** hides an attack
from the operator. We neutralise, annotate, and report.

---

## 3. Secret handling

**Inbound** (`redactSecrets`): GitHub tokens, AWS keys, Google/Slack/Stripe/OpenAI/
Anthropic/npm keys, JWTs, PEM private-key blocks, and assignment-shaped secrets
(`DATABASE_PASSWORD=…`).

Redaction **preserves shape**: `AKIA⟦REDACTED:aws-access-key⟧`. The agent can still see
"this code expects an AWS key here" — the technically useful part — without receiving the
key. Findings carry a non-reversible FNV fingerprint, never the value; there is a test
asserting the secret cannot appear in a finding.

Placeholders (`your-api-key-here`, `changeme`, `${DB_PASS}`, `<your-token>`) are recognised
and left alone, because redacting them is pure noise.

> **Regression note.** An early placeholder pattern used bare prefixes (`a[\w-]*`), which
> case-insensitively matched `AKIAIOSFODNN7EXAMPLE` and silently disabled AWS key
> detection. Placeholder words are now separator-bounded whole tokens. A second bug in the
> same function extracted the wrong capture group — `String.replace` passes `offset` and
> the *whole input string* after the captures, so a `typeof g === "string"` filter treated
> the entire input as the captured value, defeating every placeholder check. Both are
> covered by tests. The lesson generalises: **security regexes need tests that assert both
> directions** — that real secrets are caught *and* that placeholders are not.

**Outbound** (`SecretScrubber`): our configured token is registered at startup and scrubbed
from every log line, error message and tool result. This is separate from pattern matching
because a GitHub Enterprise token may have a shape we have no rule for.

**Never retrieved**: `.env`, `.npmrc`, `.netrc`, `id_rsa`, `*.pem`, `*.p12`, keystores,
`secrets.yaml`. `checkFilePath()` refuses these with a stated reason — silently omitting a
file the agent asked for looks like a bug.

---

## 4. No execution, ever (spec §22)

The discovery phase is **entirely static**. This server never runs:

```
npm install · pip install · gradle build · make · ./script.sh
postinstall hooks · any repository-provided command
```

Repositories are read through the GitHub API and through jCodeMunch's indexer. Neither
path executes repository code.

**jCodeMunch note.** `index_repo` clones and parses a repository. Parsing is not execution,
but it is still processing of untrusted input by a third-party component, so it is
constrained: a size cap (`JCODEMUNCH_MAX_REPO_SIZE_KB`), an indexing timeout
(`JCODEMUNCH_INDEX_TIMEOUT_MS`), and a call timeout. A repository that exceeds them is
skipped with a degradation, not forced through.

---

## 5. Resource limits (spec §21)

| Limit | Setting | Purpose |
|---|---|---|
| Repository size for indexing | `JCODEMUNCH_MAX_REPO_SIZE_KB` | "Huge repositories" |
| Index timeout | `JCODEMUNCH_INDEX_TIMEOUT_MS` | One repository cannot hang a tool call |
| Per-call GitHub quota | `QuotaBudget` | One greedy call cannot starve the next |
| Context ceiling | `MAX_CONTEXT_TOKENS` | Bounded tool results |
| Cache size | `CACHE_MAX_ENTRIES` | Bounded disk |
| Regex iteration | hard-capped at 50 matches per rule | ReDoS-shaped content; there is a test with a 500× repeated attack string asserting completion under 2 s |

Every failure is a `Degradation`, not a crash: the pipeline continues with other
candidates.

---

## 6. Licence safety (spec §12)

Licence determination reads the repository's licence file and the provider's licence
metadata — **never** claims made in prose, which are attacker-controlled.

Every licence verdict carries an explicit disclaimer. The system **never claims legal
certainty**, and never silently recommends copying code whose licence may be incompatible.
Missing or ambiguous licensing produces a warning, not an assumption of reusability.

---

## 7. Reporting

Security issues in this server: open an issue with the `security` label, or contact the
maintainer directly for anything exploitable. Please do not file injection payloads found
in third-party repositories here — report those to the repository's own maintainers.
