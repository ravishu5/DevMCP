/**
 * Architecture inference and adaptation analysis (spec §4 analyze_repository, §16).
 *
 * Spec §16 makes the case plainly: telling an agent
 *
 *     Source: Repository pattern + Room        Target: Clean Architecture + SQLite
 *     1. Extract persistence logic  2. Replace Room DAO  3. Keep domain interfaces …
 *
 * is "much more valuable than copying source files". This module produces that.
 *
 * Everything is inferred from **structure** — directory layout, symbol role names,
 * dependencies — never from prose claims in a README, which are attacker-controlled and
 * frequently aspirational anyway.
 */

import type {
  AdaptationPlan, AdaptationStep, ArchitectureSummary, CodeSymbol, Dependency,
  IntegrationDifficulty, TargetProjectProfile, TargetStack,
} from "../types/index.js";

export interface ArchitectureInput {
  filePaths: string[];
  symbols?: CodeSymbol[];
  dependencies?: Dependency[];
  language?: string;
}

/** Architectural patterns, recognised from the shapes their implementations leave behind. */
const PATTERNS: {
  name: string;
  /** Directory or symbol-name markers. All `requires` must be present. */
  requires: RegExp[];
  /** Any of these strengthens the match. */
  supports?: RegExp[];
  components: string[];
}[] = [
  {
    name: "queue + worker + persistent state",
    requires: [/\b(queue|scheduler)\b/i, /\b(worker|job|task|executor)\b/i],
    supports: [/\b(repository|dao|store|database|persist)\b/i, /\b(retry|backoff)\b/i],
    components: ["Queue", "Worker", "Persistence", "Retry policy"],
  },
  {
    name: "clean architecture (domain / data / presentation)",
    requires: [/(^|\/)(domain)\//i, /(^|\/)(data)\//i],
    supports: [/(^|\/)(presentation|ui|app)\//i, /\b(usecase|use_case|interactor)\b/i],
    components: ["Domain layer", "Data layer", "Presentation layer", "Use cases"],
  },
  {
    name: "repository pattern over a local database",
    requires: [/\b(repository|repositories)\b/i],
    supports: [/\b(dao|entity|room|realm|coredata|sqlite|orm)\b/i],
    components: ["Repository", "DAO / data source", "Entity models"],
  },
  {
    name: "MVVM / unidirectional state",
    requires: [/\b(viewmodel|view_model)\b/i],
    supports: [/\b(state|uistate|reducer|intent|action)\b/i, /\b(flow|livedata|observable|publisher)\b/i],
    components: ["ViewModel", "UI state", "State reducer"],
  },
  {
    name: "layered service architecture",
    requires: [/\b(service|services)\b/i, /\b(controller|handler|resource|route)\b/i],
    supports: [/\b(repository|dao|model)\b/i, /(^|\/)(middleware)\//i],
    components: ["Controller / route layer", "Service layer", "Data access layer"],
  },
  {
    name: "client + interceptor pipeline",
    requires: [/\b(client)\b/i, /\b(interceptor|middleware|filter|plugin)\b/i],
    supports: [/\b(request|response)\b/i, /\b(auth|retry|logging)\b/i],
    components: ["Client", "Interceptor chain", "Request/response models"],
  },
  {
    name: "event-driven / observer",
    requires: [/\b(event|events)\b/i, /\b(listener|observer|subscriber|handler|emitter)\b/i],
    supports: [/\b(bus|dispatcher|publisher|channel)\b/i],
    components: ["Event bus", "Publishers", "Subscribers"],
  },
  {
    name: "plugin / strategy registry",
    requires: [/\b(plugin|strategy|provider)\b/i, /\b(registry|factory|resolver)\b/i],
    components: ["Registry", "Strategy interface", "Concrete strategies"],
  },
  {
    name: "state machine",
    requires: [/\b(state.?machine|statemachine)\b/i],
    supports: [/\b(transition|state|event)\b/i],
    components: ["State definitions", "Transitions", "Machine driver"],
  },
];

/** Directory roles, for the module map. */
const DIRECTORY_ROLES: [RegExp, string][] = [
  [/^(src|lib|source)$/i, "source root"],
  [/^(domain|core|model|models|entity|entities)$/i, "domain model"],
  [/^(data|repository|repositories|persistence|db|database|storage)$/i, "data access"],
  [/^(ui|presentation|view|views|screen|screens|components?)$/i, "presentation"],
  [/^(network|net|api|http|remote|client)$/i, "networking"],
  [/^(di|inject|injection|module|modules)$/i, "dependency injection"],
  [/^(util|utils|common|shared|helpers?)$/i, "shared utilities"],
  [/^(worker|workers|job|jobs|task|tasks|background)$/i, "background work"],
  [/^(service|services|usecase|usecases|interactor)$/i, "business logic"],
  [/^(config|configuration|settings)$/i, "configuration"],
  [/^(test|tests|spec)$/i, "tests"],
];

export function inferArchitecture(input: ArchitectureInput): ArchitectureSummary {
  const pathText = input.filePaths.join("\n").toLowerCase();
  const symbolText = (input.symbols ?? []).map((s) => humanise(s.name)).join(" ");
  const haystack = `${pathText}\n${symbolText}`;

  // --- pattern matching ----------------------------------------------------
  let best: { name: string; components: string[]; score: number } | undefined;
  for (const p of PATTERNS) {
    if (!p.requires.every((re) => re.test(haystack))) continue;
    const supportHits = (p.supports ?? []).filter((re) => re.test(haystack)).length;
    const score = 1 + supportHits * 0.25;
    if (!best || score > best.score) best = { name: p.name, components: p.components, score };
  }

  // --- module map ----------------------------------------------------------
  const topDirs = new Map<string, number>();
  for (const p of input.filePaths) {
    const parts = p.split("/");
    // Look one level below a generic source root, where the real structure lives.
    const dir = parts.length > 2 && /^(src|lib|source)$/i.test(parts[0] ?? "")
      ? parts[1] as string
      : parts[0] as string;
    if (!dir || dir.includes(".")) continue;
    // Sample/demo modules are the repository advertising itself, not its architecture.
    // Left in, they show up as "components" and then as integration points, telling the
    // agent to integrate a sample app.
    if (/^(sample|samples|sampleapp|demo|demos|example|examples|playground|docs?|website|benchmarks?|fixtures?)$/i.test(dir)) continue;
    topDirs.set(dir, (topDirs.get(dir) ?? 0) + 1);
  }
  const modules = [...topDirs.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([path, count]) => ({ path, role: roleOf(path) ?? `${count} files` }));

  // --- layers --------------------------------------------------------------
  const layers = modules
    .map((m) => roleOf(m.path))
    .filter((r): r is string => Boolean(r) && r !== "tests" && r !== "configuration");

  const entryPoints = input.filePaths
    .filter((p) => /(^|\/)(main|index|app|application|server|cli)\.\w+$/i.test(p))
    .slice(0, 6);

  const notes: string[] = [];
  if (!best) notes.push("No well-known architectural pattern recognised; treat the structure as bespoke.");
  if (!input.symbols?.length) notes.push("Inferred from file paths only — no symbol-level data available.");

  // Confidence reflects how much evidence we actually had. Pattern matching on paths alone
  // is a much weaker claim than pattern matching corroborated by symbol names.
  const confidence = Math.min(1, Math.round((
    (best ? 0.4 + Math.min(0.25, (best.score - 1) * 0.25) : 0.15) +
    (input.symbols?.length ? 0.25 : 0) +
    (modules.length >= 3 ? 0.15 : 0)
  ) * 100) / 100);

  return {
    pattern: best?.name ?? "unrecognised / bespoke",
    components: best?.components ?? modules.slice(0, 5).map((m) => m.path),
    layers: layers.length ? [...new Set(layers)] : undefined,
    entryPoints,
    modules,
    notes,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Adaptation (spec §16)
// ---------------------------------------------------------------------------

export interface AdaptationInput {
  source: ArchitectureSummary;
  sourceDependencies?: Dependency[];
  target?: TargetStack;
  targetProfile?: TargetProjectProfile;
  /** 0–1 language/framework fit, from the evidence layer. */
  stackMatch: number;
  /** Symbols the agent will actually work with. */
  coreSymbols?: CodeSymbol[];
}

/**
 * Library substitutions worth calling out explicitly.
 *
 * These are the changes that break a naive copy-paste: the code compiles conceptually but
 * references a persistence or DI library the target does not have.
 */
const SUBSTITUTION_GROUPS: { concept: string; members: RegExp[] }[] = [
  { concept: "local database", members: [/\broom\b/i, /\brealm\b/i, /\bcore.?data\b/i, /\bsqldelight\b/i, /\bsqlite\b/i, /\bprisma\b/i, /\bdrizzle\b/i, /\btypeorm\b/i, /\bsqlalchemy\b/i, /\bhibernate\b/i, /\bgorm\b/i, /\bdiesel\b/i] },
  { concept: "HTTP client", members: [/\bokhttp\b/i, /\bretrofit\b/i, /\bktor\b/i, /\baxios\b/i, /\bhttpx\b/i, /\brequests\b/i, /\breqwest\b/i, /\balamofire\b/i, /\burlsession\b/i] },
  { concept: "dependency injection", members: [/\bdagger\b/i, /\bhilt\b/i, /\bkoin\b/i, /\bguice\b/i, /\binversify\b/i, /\btsyringe\b/i, /\bspring\b/i] },
  { concept: "background scheduling", members: [/\bworkmanager\b/i, /\bcelery\b/i, /\bbullmq\b/i, /\basynq\b/i, /\bquartz\b/i, /\bsidekiq\b/i] },
  { concept: "serialisation", members: [/\bgson\b/i, /\bmoshi\b/i, /\bjackson\b/i, /\bkotlinx.?serialization\b/i, /\bserde\b/i, /\bpydantic\b/i] },
  { concept: "reactive/async", members: [/\brxjava\b/i, /\brxjs\b/i, /\bcoroutines\b/i, /\bcombine\b/i, /\basyncio\b/i, /\btokio\b/i] },
];

export function planAdaptation(input: AdaptationInput): AdaptationPlan {
  const steps: AdaptationStep[] = [];
  const risks: string[] = [];
  const preserve: string[] = [];

  const targetArchitecture = input.targetProfile?.architecture
    ?? [input.target?.framework, input.target?.language].filter(Boolean).join(" / ")
    ?? "unknown target architecture";

  // --- 1. language ---------------------------------------------------------
  if (input.stackMatch < 0.35) {
    steps.push({
      order: steps.length + 1,
      action: `Port the implementation from ${input.source.pattern} into ${input.target?.language ?? "your language"} rather than copying it`,
      rationale: "Different language: the source cannot be compiled into your project at all. What transfers is the design — data structures, state transitions, error handling — not the syntax.",
      affects: input.coreSymbols?.map((s) => s.name).slice(0, 5) ?? [],
      effort: "large",
    });
    risks.push("Cross-language ports lose the original's test suite; budget for rewriting tests from scratch.");
  }

  // --- 2. library substitutions -------------------------------------------
  const sourceDeps = (input.sourceDependencies ?? []).map((d) => d.name.toLowerCase());
  const targetLibs = [
    ...(input.target?.libraries ?? []),
    ...(input.targetProfile?.existingLibraries ?? []).map((d) => d.name),
    input.target?.framework ?? "",
  ].join(" ").toLowerCase();

  for (const group of SUBSTITUTION_GROUPS) {
    const sourceUses = group.members.find((re) => sourceDeps.some((d) => re.test(d)));
    if (!sourceUses) continue;
    const targetUses = group.members.find((re) => re.test(targetLibs));
    if (!targetUses) {
      // Target has no equivalent declared — flag rather than assume.
      steps.push({
        order: steps.length + 1,
        action: `Decide how to satisfy the ${group.concept} dependency the source assumes`,
        rationale: `The source depends on ${article(group.concept)} ${group.concept} library your project does not declare. Either adopt it, or isolate the source's ${group.concept} usage behind an interface you implement.`,
        affects: sourceDeps.filter((d) => sourceUses.test(d)).slice(0, 3),
        effort: "medium",
      });
      continue;
    }
    if (String(sourceUses) !== String(targetUses)) {
      steps.push({
        order: steps.length + 1,
        action: `Replace the source's ${group.concept} with your project's`,
        rationale: `Both projects use a ${group.concept}, but different ones. Swap at the boundary and keep the logic above it intact — that logic is what you came for.`,
        affects: sourceDeps.filter((d) => sourceUses.test(d)).slice(0, 3),
        effort: "medium",
      });
    }
  }

  // --- 3. architectural reshaping -----------------------------------------
  const sourcePattern = input.source.pattern;
  const targetPattern = input.targetProfile?.architecture;
  if (targetPattern && sourcePattern !== "unrecognised / bespoke" && !similarPattern(sourcePattern, targetPattern)) {
    steps.push({
      order: steps.length + 1,
      action: `Reshape from "${sourcePattern}" into "${targetPattern}"`,
      rationale: "The two projects organise responsibilities differently. Move the logic across the boundary rather than importing the source's structure, which would leave two competing architectures in one codebase.",
      affects: input.source.components,
      effort: "medium",
    });
  }

  // --- 4. what to keep -----------------------------------------------------
  // Naming this explicitly matters: agents tend to rewrite the valuable part (the
  // edge-case handling) and faithfully copy the worthless part (the framework glue).
  preserve.push(
    "Business logic and state transitions — this is the part that took the original authors the longest",
    "Edge-case handling, especially error paths and retry/timeout behaviour",
    "Public interface shapes, where they are already idiomatic for your stack",
  );
  if (input.source.components.length) {
    preserve.push(`The component boundaries: ${input.source.components.slice(0, 4).join(", ")}`);
  }

  // --- 5. always verify ----------------------------------------------------
  steps.push({
    order: steps.length + 1,
    action: "Port or write tests for the behaviour you adapted, before relying on it",
    rationale: "Adapted code has not been run in your project. The original's tests encode assumptions that your version may silently break.",
    affects: [],
    effort: "small",
  });

  if (input.source.confidence < 0.5) {
    risks.push("The source architecture was inferred with low confidence; verify the structure before following this plan literally.");
  }
  if (!input.targetProfile) {
    risks.push("No target-project profile supplied, so integration points are generic. Call analyze_target_project for specific guidance.");
  }

  return {
    sourceArchitecture: sourcePattern,
    targetArchitecture,
    requiredChanges: steps,
    preserve,
    integrationDifficulty: difficultyFrom(steps, input.stackMatch),
    risks,
  };
}

function difficultyFrom(steps: AdaptationStep[], stackMatch: number): IntegrationDifficulty {
  const weight = steps.reduce((a, s) =>
    a + (s.effort === "large" ? 4 : s.effort === "medium" ? 2 : s.effort === "small" ? 1 : 0), 0);
  const adjusted = weight + (stackMatch < 0.35 ? 4 : stackMatch < 0.7 ? 2 : 0);
  if (adjusted <= 2) return "trivial";
  if (adjusted <= 4) return "low";
  if (adjusted <= 8) return "medium";
  if (adjusted <= 13) return "high";
  return "very-high";
}

/** "a local database" / "an HTTP client" — small thing, but it is user-facing prose. */
function article(noun: string): string {
  return /^[aeiou]/i.test(noun) || /^(html?|http|ftp|xml|sql)\b/i.test(noun) ? "an" : "a";
}

function similarPattern(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter((w) => w.length > 3);
  const A = new Set(norm(a));
  const shared = norm(b).filter((w) => A.has(w)).length;
  return shared >= 2;
}

function roleOf(dir: string): string | undefined {
  return DIRECTORY_ROLES.find(([re]) => re.test(dir))?.[1];
}

function humanise(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ").toLowerCase();
}
