# Implementation Intelligence MCP

**An MCP server that finds the best existing implementation for each software problem,
extracts only the necessary knowledge, and packages it for an AI coding agent to integrate.**

Not "GitHub search for LLMs". The differentiated work is the *deciding*: which repositories
are worth reusing, which parts of them matter, **in what mode you may legally use them**,
and what has to change to make them fit your project.

```
FEATURE:      resumable background file downloader with pause and retry   [Kotlin/Android]

RECOMMENDED:  tonyofrancis/Fetch
SCORE:        75/100  (confidence 81%)
REUSE MODE:   DIRECT_REUSE — Apache-2.0, matching stack (100%)
OBLIGATIONS:  Preserve copyright and NOTICE file · State significant changes
KEY SYMBOLS:  canResumeDownload · canRetryDownload · canPauseDownload · FileServerDownloader
COMPLETENESS: 7/10 evidenced   (✗ sends Range header, ✗ bounded retry count)
INTEGRATION:  low — 17 runtime deps; self-contained
SOURCE:       github.com/tonyofrancis/Fetch  commit 11c2c45

Repositories considered 30 · deeply analysed 4
~29,782 raw → ~710 returned tokens · 97.6% reduction
```

---

## Contents

* [What it does](#what-it-does) · [Install](#install) · [Connect to a client](#connect-it-to-an-mcp-client)
* [The 8 tools](#the-8-tools) · [Workflows](#example-workflows) · [CLI](#cli)
* [Architecture](#architecture) · [Token optimisation](#token-optimisation)
* [Configuration](#configuration) · [Limitations](#limitations) · [Licence considerations](#licence-considerations)

---

## What it does

Given *"build an Android app with resumable background downloads"*, a coding agent normally
either reinvents the feature or opens twenty GitHub tabs. This server answers, in one call:

| Question | How |
|---|---|
| What already exists? | Multi-strategy GitHub search from a curated technology vocabulary |
| Which is best, and why? | 12 measured signals → an explainable 0–100 score |
| **May I actually use it?** | Licence × stack × architecture × *your distribution model* → a reuse mode |
| Which exact parts do I need? | The minimal **connected** symbol set, not the repository |
| What does it depend on? | Manifests parsed across 11 ecosystems |
| What tests prove it? | Test discovery, including **which edge cases they cover** |
| How do I adapt it to *my* project? | Source→target adaptation steps, and what to **preserve** |

### Division of labour

| System | Job |
|---|---|
| GitHub | **Find** candidates |
| [jCodeMunch](https://pypi.org/project/jcodemunch-mcp/) | **Understand** candidates |
| This server | **Decide what matters** |

jCodeMunch is optional. Without it the server degrades to GitHub file retrieval and **says
so** on every affected result.

---

## Install

```bash
git clone <this repo> && cd implementation-intelligence-mcp
npm install
npm run build
```

Requires **Node ≥ 20**. Optional but recommended: [`uv`](https://docs.astral.sh/uv/) for the
code index (`uvx jcodemunch-mcp`).

### Authentication

No configuration is required. Token resolution, in order:

```
GITHUB_TOKEN → GITHUB_PERSONAL_ACCESS_TOKEN → GH_TOKEN → `gh auth token` → unauthenticated
```

If you already use the [GitHub CLI](https://cli.github.com/), it works immediately.

| Mode | Core | Search | Code search |
|---|---|---|---|
| Authenticated | 5 000/hr | 30/min | 10/min |
| Unauthenticated | 60/hr | 10/min | — |

Verify with `npx implementation-mcp config` (secrets are redacted).

---

## Connect it to an MCP client

### Claude Code

```bash
claude mcp add implementation-intelligence -- node /absolute/path/to/dist/index.js
```

### Claude Desktop · Cursor · Windsurf

Add to `claude_desktop_config.json` (or your client's equivalent):

```json
{
  "mcpServers": {
    "implementation-intelligence": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    }
  }
}
```

`env` is optional if `gh auth token` works. **Absolute paths** — the client's working
directory is not yours.

### Verify

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' | node dist/index.js
```

Logs go to **stderr only** — stdout is the protocol channel.

---

## The 8 tools

Deliberately 8, not 14. Internal analyzers are not tools: exposing every one of them
inflates tool-selection difficulty and leaks internals into the model's context.

| Tool | Use it when |
|---|---|
| `discover_implementations` | Before writing any non-trivial feature — "what exists, which is best?" |
| `get_implementation` | You have chosen a repository and need the symbols, deps and adaptation steps |
| `analyze_repository` | Evaluating one specific repository (`include:['license']`, `['tests']`, …) |
| `compare_implementations` | You have a shortlist and must choose |
| `build_implementation_plan` | "Build me an app that…" — decomposes, then plans across repositories |
| `analyze_target_project` | **First**, when integrating into an existing codebase |
| `find_alternative` | You tried something and hit a wall |
| `verify_implementation` | After adapting, before calling it done |

Every spec capability remains reachable: `find_tests` / `find_dependencies` / `check_license`
are `analyze_repository(include:[…])`; `decompose_application` is
`build_implementation_plan(mode:"decompose")`.

### `discover_implementations`

```json
{
  "feature": "resumable background file downloader with pause and retry",
  "requirements": ["pause/resume", "background execution", "persistent queue", "retry"],
  "language": "Kotlin",
  "platform": "Android",
  "distribution": "proprietary"
}
```

`requirements` is the highest-leverage field: each entry becomes a checklist item candidates
are scored against. `distribution` changes licence verdicts materially — GPL is incompatible
with a proprietary product but usually fine in an internal tool.

### `get_implementation`

```json
{
  "repository": "tonyofrancis/Fetch",
  "feature": "resumable download",
  "target_project_path": "/Users/me/myapp",
  "include_source": false
}
```

`target_project_path` turns generic advice into *"add this under
`app/src/main/kotlin/data`, which already holds your data access"*.

### `find_alternative`

```json
{
  "feature": "resumable downloader",
  "current_candidate": "owner/repo",
  "reason": "requires Room but this project uses SQLDelight"
}
```

The reason is parsed into a structured constraint and applied to **ranking** — the
alternative is chosen for solving the thing that went wrong, not for being next-best. It
also lists which other candidates fail the same constraint, so you know they were considered.

---

## Example workflows

### A feature inside an existing project

```
1. analyze_target_project { path: "/Users/me/myapp" }
2. discover_implementations { feature: "…", requirements: [...], language: <from step 1> }
3. get_implementation { repository: <winner>, target_project_path: "/Users/me/myapp" }
4. …implement…
5. verify_implementation { repository: <same>, feature: "…", target_project_path: "…" }
```

### A whole application

```
1. build_implementation_plan { requirement: "…", mode: "decompose" }   ← instant, free
2. build_implementation_plan { requirement: "…", mode: "full" }        ← discovers per feature
3. get_implementation for each step, in the order given
```

Step 2 reports cross-repository conflicts before you write a line — verified live on three
independently-chosen Android repositories:

```
CROSS-REPOSITORY CONFLICTS:
• DUPLICATE LOCAL DATABASE: two selections both pull androidx.room…
• DUPLICATE DEPENDENCY INJECTION: hilt-android, hilt-work, hilt-navigation-compose…
• DUPLICATE LOGGING: slf4j-api, slf4j-simple…

LICENCES (overall risk: high):
  strictest, which governs the combined work: UNKNOWN
```

### When it goes wrong

```
find_alternative { feature: "…", current_candidate: "…", reason: "licence is AGPL and we ship proprietary" }
```

---

## Architecture

```
        APP REQUIREMENT
              ↓
     FEATURE DECOMPOSER          "what features does this contain?"
              ↓
     IMPLEMENTATION PLANNER      "which are worth reusing, and what KIND to look for?"
              ↓
     GitHub discovery            quota-budgeted, multi-strategy
              ↓
     CANDIDATE EVIDENCE          12 axes: value + confidence + source + observation
              ↓
     RANKING ENGINE              explainable, reproducible, configurable
              ↓
     jCodeMunch                  symbol-level understanding of finalists
              ↓
     MINIMAL IMPLEMENTATION SET  smallest CONNECTED set that explains the feature
              ↓
     IMPLEMENTATION BUNDLE       + reuse mode, provenance, licence, metrics
              ↓
        CODING AGENT → build/test → (failure) → find_alternative ↺
```

Each stage is a separate module behind an interface, so a GitLab or Bitbucket provider, or
a different code index, can be substituted without touching orchestration, ranking or
context building. The reasoning behind each component is documented in the source.

### Three signals that beat stars

**Completeness** — scored against *your* checklist. A 400-star repo implementing 7/7 beats a
40 000-star one implementing 3/7.

**Integration surface** — measured, not adjectival: symbols × runtime deps × integration
points × configuration × framework coupling.

**Reuse mode** — the most decision-relevant field in the bundle:

| Mode | Meaning |
|---|---|
| `DIRECT_REUSE` | Permissive licence, compatible stack and architecture — vendor or depend on it |
| `ADAPT` | Same language, different architecture — port the logic, replace the boundaries |
| `REFERENCE_ONLY` | Different language, or copyleft, or unmaintained — learn from it, write your own |
| `DO_NOT_USE` | Licence incompatible with your distribution model — with the reason stated |

Licence **gates** everything: a perfect stack match under AGPL is `DO_NOT_USE`, not
`DIRECT_REUSE`. Reuse mode multiplies the score, and the adjustment is recorded explicitly
rather than applied silently.

### No internal LLM calls

The server performs **zero inference of its own**. A model call inside it would move the
token bill rather than remove it, and add latency, cost, non-determinism and a second
failure mode.

Decomposition and query expansion run off a curated, versioned technology vocabulary — 36
capability clusters, 8 stack idiom sets:

```
"background resumable downloads"
        ↓
WorkManager · HTTP Range request · persistent job queue · exponential backoff · foreground service
```

Those are terms you would not have known to search for. A model could generate them; a
curated table generates them **reproducibly, testably, and for free**.

Where a requirement is genuinely ambiguous, the ambiguity is returned rather than guessed —
the calling agent already has a model and far more context about your intent.

---

## Token optimisation

Retrieval is layered. You get L1 by default and ask for more.

| Layer | Content | Cost |
|---|---|---|
| **L1** Metadata | Repo, evidence, reuse mode, licence, confidence, explanation | ~300–800 tok |
| **L2** Implementation map | Minimal symbol set, signatures only | ~500–2 000 tok |
| **L3** Source | Source of *named* symbols, on request | on demand |
| **L4** Tests | Test symbols and files, separately | on demand |

Every bundle declares what it withheld **and the exact call that would fetch it**:

```
AVAILABLE ON REQUEST (not included, to save context):
• Source for 5 core symbol(s) (~1250 tokens) — get_implementation({"include_source":true})
```

### Measured reductions

| Operation | Raw | Returned | Reduction |
|---|---|---|---|
| `discover_implementations` (30 repos) | ~29 782 | ~710 | **97.6%** |
| `get_implementation` (one repo, deep) | ~8 751 | ~1 609 | **81.6%** |
| `build_implementation_plan` (89 repos, 9 deep) | ~29 595 | ~932 | **96.9%** |

`estimatedRawTokens` counts **only material actually retrieved**, so the figure cannot be
inflated by imagining reads that never happened. A test asserts `raw > returned` on live data.

We optimise `useful information / token`, **not** minimum tokens. Three fields bypass the
budget entirely — **reuse mode + licence**, **provenance**, **degradations** — because a
bundle that omits "you may not copy this" to save tokens is not smaller, it is dangerous.

### Caching

```
search:v1:<hash>                short TTL   results legitimately change
repo:v1:owner/name              TTL         stars and pushes move
analysis:v1:owner/name@<sha>    IMMUTABLE   same commit ⇒ same source ⇒ same analysis
fingerprint:v1:owner/name@<sha> IMMUTABLE   which capabilities that source evidences
```

Cold: ~9 s. Warm: **~2 s with zero GitHub search calls.**

**Feature fingerprints** are the seed of a local knowledge base: once a repository has been
analysed, a later query for "download queue implementations" can shortlist it **without
touching GitHub search**. The store is relational and indexed on `(capability, strength)`, so
lookup is an index scan.

---

## CLI

The CLI uses the same services as the MCP server — there is no separate business logic.

```bash
implementation-mcp search "resumable Android downloader" -l Kotlin -p Android --diagnostics
implementation-mcp decompose "a social app with auth, feeds and messaging" -l Kotlin
implementation-mcp analyze square/okhttp --include license tests
implementation-mcp extract tonyofrancis/Fetch --feature "resumable download" --target ~/myapp
implementation-mcp compare --feature "HTTP client" square/okhttp ktorio/ktor
implementation-mcp plan "an app that downloads media in the background" -l Kotlin -n 4
implementation-mcp project ~/myapp
implementation-mcp alternative --feature "downloader" --reason "requires Room but we use SQLDelight"
implementation-mcp verify --repository tonyofrancis/Fetch --feature "resumable download" ~/myapp
implementation-mcp config
implementation-mcp cache --clear
```

`--json` on any command emits structured output for scripting.

---

## Configuration

Every value is optional; see [`.env.example`](.env.example) for all of them with rationale.

| Variable | Default | Notes |
|---|---|---|
| `GITHUB_TOKEN` | — | Falls back to `gh auth token`, then unauthenticated |
| `ENABLE_CODE_INDEX` | `true` | jCodeMunch for symbol-level analysis |
| `CACHE_PATH` | `~/.implementation-mcp/cache.sqlite` | |
| `MAX_REPOSITORIES` | `40` | **Lowering this materially hurts quality** — see Limitations |
| `MAX_DEEP_ANALYSIS` | `5` | Each costs several API calls |
| `MAX_CONTEXT_TOKENS` | `6000` | A ceiling, not a target |
| `RANKING_WEIGHTS` | — | JSON override; merged over defaults and renormalised |
| `ENABLE_DIAGNOSTICS` | `false` | Attach the metrics block to every result |

Ranking weights are configurable and **renormalised**, so `total` stays a true 0–100 across
any weight set:

```bash
RANKING_WEIGHTS='{"licenseCompatibility":0.20,"popularity":0.01}'
```

---

## Limitations

Stated plainly, because a tool that hides these is worse than one that does not exist.

* **Search breadth matters more than ranking.** With `MAX_REPOSITORIES=12` an HTTP-client
  query returned a poor match; at the default 40, aiohttp/urllib3/requests surfaced
  immediately. The ranker was fine; the pool was too small. Do not lower it to save time.
* **Code search is 10/min.** It is a scarce, high-signal channel spent only on finalists.
* **Static analysis only.** Nothing from a repository is ever executed (see
  [SECURITY.md](SECURITY.md)). Dynamically-computed dependencies are missed, and marked
  `inferred` rather than guessed.
* **Architecture inference is pattern-matching**, not comprehension. It reports
  `unrecognised / bespoke` with low confidence rather than inventing a pattern.
* **Completeness matching is lexical.** A capability implemented under wholly unexpected
  naming can be missed — reported as `unknown`, distinct from `absent`.
* **`verify_implementation` caps confidence at 80%** and compiles nothing. It catches the
  boring omissions (missing dependency, missing tests, missing attribution) that cause most
  integration failures. It cannot establish correctness.
* **Quality is inferred from signals, never proven.** Every score ships its explanation so
  you can disagree.
* **The knowledge base starts empty.** Fingerprints accumulate as you use it.

---

## Licence considerations

**Every licence verdict this server emits is advisory and is not legal advice.** That
disclaimer is attached to every licence-bearing response, and it is not decoration.

* Licence is read from the LICENSE file and the provider's SPDX detection — **never** from
  prose claims in a README, which are attacker-controlled.
* Compatibility is evaluated against **your distribution model**, because that is what
  determines real risk:

  | Licence | Proprietary | Internal-only | Open source |
  |---|---|---|---|
  | GPL-3.0 | ✗ incompatible | ? unclear (until you ship) | ✓ compatible |
  | AGPL-3.0 | ✗ incompatible | ? unclear | ? network use = distribution |
  | MPL-2.0 | ✓ (file-level only) | ✓ | ✓ |

* Missing or ambiguous licensing produces a **loud warning**, never an assumption of
  reusability. The exact wording, from the spec: *"Repository does not contain a clearly
  identifiable license. Do not assume the code is freely reusable."*
* Combining repositories is **strictly worse** than any single choice: the strictest licence
  governs the combined work. `build_implementation_plan` reports this explicitly.
* Reusing code this server surfaces means taking on **that code's** obligations, not this
  project's. See [LICENSE.md](LICENSE.md).

---

## Development

```bash
npm run typecheck
npm run test              # unit + security + perf
npm run test:integration  # live GitHub + jCodeMunch (auto-skips without credentials)
npm run build
```

**~400 tests.** The live integration suites are worth their quota: they have caught bugs no
stub could — a repository whose release history is git tags rather than GitHub Releases, a
code index returning YAML config keys as "symbols", a hostile repository description echoing
its payload through a marker the unit tests considered safe.

Contributions should follow the pattern already in the source: state the decision, state the
trade-off, and record the bug that motivated it. Several comments exist specifically because
a subtle failure was expensive to find, and deleting them would invite the same bug back.

---

## Licence

Apache-2.0. See [LICENSE.md](LICENSE.md).
