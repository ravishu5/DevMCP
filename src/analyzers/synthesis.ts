/**
 * Cross-repository synthesis (spec §13).
 *
 * "A major feature should be the ability to combine implementations from different
 * repositories… Do not simply concatenate code from repositories."
 *
 * When a plan draws OAuth from repo A, a downloader from repo B and a notification
 * architecture from repo C, the interesting problems are all at the seams:
 *
 *   overlapping dependencies · version conflicts · incompatible architectures
 *   duplicate abstractions · naming conflicts · framework differences · licence conflicts
 *
 * Each finding here is one the coding agent would otherwise discover at compile time, or
 * worse, at run time. Detecting them statically is the entire value.
 */

import type { Candidate, Dependency, LicenseCategory } from "../types/index.js";
import type { LicenseSummary, SynthesisReport } from "../types/bundle.js";
import { LICENSE_DISCLAIMER } from "./license.js";

export interface SynthesisInput {
  /** One selected candidate per feature. */
  selections: { feature: string; candidate: Candidate }[];
  targetLanguage?: string;
}

/**
 * Identity keys for a dependency — a SET, not a single string.
 *
 * `androidx.room:room-runtime`, `room-ktx` and `room-compiler` are modules of one library.
 * `org.slf4j:slf4j-api` and `slf4j-simple` are an API and its binding. `libs.okhttp` and
 * `com.squareup.okhttp3:okhttp` are the same dependency written two ways. Treating each
 * artifact as a competing implementation produced four false "duplicate" findings in one
 * live plan — and a conflict list that is mostly false positives gets skimmed past, which
 * costs more than the feature is worth.
 *
 * A single key cannot bridge these, because a Maven coordinate carries a group id while a
 * version-catalog reference carries only an artifact name. So each dependency yields
 * several keys, and two dependencies are the same family when their key sets INTERSECT:
 *
 *   com.squareup.okhttp3:okhttp  ->  { com.squareup.okhttp3, okhttp }
 *   libs.okhttp                  ->  { okhttp }                        ∩ ⇒ same
 *   io.ktor:ktor-client-core     ->  { io.ktor, ktor }                 ∩ ⇒ different
 */
/**
 * Libraries that are complementary by design, not competing.
 *
 * The clearest case is the SLF4J façade and its bindings: `org.slf4j:slf4j-api` plus
 * `ch.qos.logback:logback-classic` is the *recommended* JVM setup, not a conflict. They
 * live under different group ids with different artifact stems, so key intersection alone
 * cannot see it — the relationship is semantic, and short enough to enumerate.
 *
 * Each entry maps a family key to the keys it is designed to be paired with.
 */
const COMPLEMENTARY: Record<string, string[]> = {
  slf4j: ["logback", "log4j", "ch.qos.logback", "org.apache.logging.log4j"],
  logback: ["slf4j", "org.slf4j"],
  log4j: ["slf4j", "org.slf4j"],
  "org.slf4j": ["logback", "log4j", "ch.qos.logback"],
  "ch.qos.logback": ["slf4j", "org.slf4j"],
};

function identityKeys(name: string): Set<string> {
  const n = name.toLowerCase().trim();
  const keys = new Set<string>();

  if (n.startsWith("libs.")) {
    // Version-catalog reference: libs.okhttp, libs.androidx.core.ktx
    const tail = n.slice(5).split(".");
    keys.add(tail[0] as string);
    if (tail.length > 1) keys.add(tail.join("."));
    return keys;
  }

  if (n.includes(":")) {
    const [group = "", artifact = ""] = n.split(":");
    keys.add(group);
    // Group families: androidx.room and androidx.room.ktx are one library.
    const gParts = group.split(".");
    if (gParts.length > 2) keys.add(gParts.slice(0, 3).join("."));
    // Artifact stem: room-runtime -> room, slf4j-api -> slf4j, ktor-client-core -> ktor
    const stem = artifact.split(/[-_]/)[0] as string;
    if (stem.length >= 3) keys.add(stem);
    return keys;
  }

  if (n.startsWith("@")) {
    keys.add(n.split("/")[0] as string);
    return keys;
  }

  keys.add((n.split(/[-_]/)[0] as string) || n);
  return keys;
}

/** Merge dependencies whose identity keys intersect into one family per group. */
function groupByFamily(
  entries: { name: string; repository: string }[],
): { artifacts: Set<string>; repos: Set<string> }[] {
  const families: { keys: Set<string>; artifacts: Set<string>; repos: Set<string> }[] = [];

  for (const entry of entries) {
    const keys = identityKeys(entry.name);
    // Pull in the keys of anything this library is designed to be paired with, so a façade
    // and its binding land in one family rather than being reported as competitors.
    for (const k of [...keys]) {
      for (const partner of COMPLEMENTARY[k] ?? []) keys.add(partner);
    }
    const matches = families.filter((f) => [...keys].some((k) => f.keys.has(k)));

    if (matches.length === 0) {
      families.push({ keys, artifacts: new Set([entry.name]), repos: new Set([entry.repository]) });
      continue;
    }
    // Fold this entry, and any families it transitively joins, into the first match.
    const target = matches[0] as (typeof families)[number];
    for (const k of keys) target.keys.add(k);
    target.artifacts.add(entry.name);
    target.repos.add(entry.repository);
    for (const other of matches.slice(1)) {
      for (const k of other.keys) target.keys.add(k);
      for (const a of other.artifacts) target.artifacts.add(a);
      for (const r of other.repos) target.repos.add(r);
      families.splice(families.indexOf(other), 1);
    }
  }
  return families.map(({ artifacts, repos }) => ({ artifacts, repos }));
}




export function synthesise(input: SynthesisInput): SynthesisReport {
  const sels = input.selections.filter((s) => s.candidate);

  return {
    overlappingDependencies: findOverlaps(sels),
    versionConflicts: findVersionConflicts(sels),
    incompatibleArchitectures: findArchitectureConflicts(sels),
    duplicateAbstractions: findDuplicateAbstractions(sels),
    namingConflicts: findNamingConflicts(sels),
    frameworkDifferences: findFrameworkDifferences(sels, input.targetLanguage),
    licenseConflicts: findLicenseConflicts(sels),
    unificationStrategy: buildStrategy(sels),
  };
}

/**
 * Dependencies pulled in by more than one selection.
 *
 * Usually good news — shared dependencies mean less total weight — so this is reported as
 * information rather than a problem, and it is what makes the version-conflict check
 * meaningful.
 */
function findOverlaps(sels: SynthesisInput["selections"]): SynthesisReport["overlappingDependencies"] {
  const byName = new Map<string, { usedBy: Set<string>; versions: Set<string> }>();
  for (const { candidate } of sels) {
    for (const d of runtimeDeps(candidate)) {
      const key = normaliseDepName(d);
      const entry = byName.get(key) ?? { usedBy: new Set(), versions: new Set() };
      entry.usedBy.add(candidate.ref.fullName);
      if (d.version) entry.versions.add(d.version);
      byName.set(key, entry);
    }
  }
  return [...byName.entries()]
    .filter(([, v]) => v.usedBy.size > 1)
    .map(([name, v]) => ({ name, usedBy: [...v.usedBy], versions: [...v.versions] }))
    .sort((a, b) => b.usedBy.length - a.usedBy.length)
    .slice(0, 20);
}

/**
 * The same dependency at incompatible versions.
 *
 * Only MAJOR-version differences are reported. Minor and patch differences resolve
 * automatically in every ecosystem we support, so flagging them would bury the one conflict
 * that will actually break the build.
 */
function findVersionConflicts(sels: SynthesisInput["selections"]): SynthesisReport["versionConflicts"] {
  const byName = new Map<string, { repository: string; version: string }[]>();
  for (const { candidate } of sels) {
    for (const d of runtimeDeps(candidate)) {
      if (!d.version || d.inferred) continue;   // unresolved versions cannot conflict
      const key = normaliseDepName(d);
      byName.set(key, [...(byName.get(key) ?? []), { repository: candidate.ref.fullName, version: d.version }]);
    }
  }

  const conflicts: SynthesisReport["versionConflicts"] = [];
  for (const [name, entries] of byName) {
    if (entries.length < 2) continue;
    const majors = new Set(entries.map((e) => majorOf(e.version)).filter(Boolean));
    if (majors.size > 1) conflicts.push({ name, conflicting: entries });
  }
  return conflicts.slice(0, 15);
}

function findArchitectureConflicts(sels: SynthesisInput["selections"]): SynthesisReport["incompatibleArchitectures"] {
  const out: SynthesisReport["incompatibleArchitectures"] = [];
  const patterns = sels
    .map((s) => ({ repo: s.candidate.ref.fullName, pattern: s.candidate.architecture?.pattern }))
    .filter((x): x is { repo: string; pattern: string } => Boolean(x.pattern) && x.pattern !== "unrecognised / bespoke");

  // Async models are the classic incompatibility: mixing RxJava with coroutines, or
  // callbacks with promises, produces code that compiles and then deadlocks.
  const asyncModels = new Map<string, string[]>();
  for (const { candidate } of sels) {
    const model = detectAsyncModel(runtimeDeps(candidate));
    if (!model) continue;
    asyncModels.set(model, [...(asyncModels.get(model) ?? []), candidate.ref.fullName]);
  }
  if (asyncModels.size > 1) {
    out.push({
      repositories: [...asyncModels.values()].flat(),
      issue: `Different concurrency models in play (${[...asyncModels.keys()].join(" vs ")}). ` +
             "Bridging them is possible but the boundaries must be explicit, or you will get subtle deadlocks and lost cancellation.",
    });
  }

  // Layered architectures and monolithic/bespoke ones do not compose without a decision.
  const layered = patterns.filter((p) => /clean architecture|layered/i.test(p.pattern));
  const flat = patterns.filter((p) => /queue|client|event-driven|state machine/i.test(p.pattern));
  if (layered.length && flat.length) {
    out.push({
      repositories: [...layered.map((p) => p.repo), ...flat.map((p) => p.repo)],
      issue: `Mixing a layered architecture (${layered[0]!.pattern}) with a component-shaped one (${flat[0]!.pattern}). ` +
             "Decide which layer owns the component-shaped piece rather than letting both structures coexist.",
    });
  }
  return out;
}

/**
 * Two selections providing the same concept.
 *
 * This is the most common real problem in multi-repository synthesis: repo A brings its own
 * HTTP client, repo B brings a different one, and the project ends up with both. Nobody
 * decides this; it just happens.
 */
const CONCEPTS: { concept: string; re: RegExp }[] = [
  { concept: "HTTP client", re: /okhttp|retrofit|ktor-client|axios|got|^ky$|httpx|requests|aiohttp|alamofire|reqwest|^dio$/i },
  { concept: "local database", re: /room|realm|sqldelight|core-?data|prisma|drizzle|typeorm|sequelize|sqlalchemy|gorm|diesel/i },
  { concept: "dependency injection", re: /dagger|hilt|koin|guice|inversify|tsyringe|spring-context/i },
  { concept: "JSON serialisation", re: /gson|moshi|jackson|kotlinx-serialization|serde_json|pydantic/i },
  { concept: "logging", re: /timber|slf4j|logback|winston|pino|log4j|zap|tracing/i },
  { concept: "background scheduling", re: /workmanager|celery|bullmq|asynq|quartz|sidekiq/i },
  { concept: "image loading", re: /coil|glide|picasso|kingfisher|sdwebimage/i },
  { concept: "reactive streams", re: /rxjava|rxjs|rxswift|reactor-core/i },
  // NOTE: test frameworks are deliberately absent. A project legitimately runs JUnit for
  // unit tests, Espresso for instrumentation and an assertion library alongside both;
  // reporting that as a "duplicate" is noise, and noise in this list makes the real
  // findings easier to ignore.
];


function findDuplicateAbstractions(sels: SynthesisInput["selections"]): SynthesisReport["duplicateAbstractions"] {
  const out: SynthesisReport["duplicateAbstractions"] = [];
  for (const { concept, re } of CONCEPTS) {
    // Grouped by FAMILY, so sibling artifacts of one library count once.
    const matching: { name: string; repository: string }[] = [];
    for (const { candidate } of sels) {
      for (const d of runtimeDeps(candidate)) {
        if (re.test(d.name)) matching.push({ name: d.name, repository: candidate.ref.fullName });
      }
    }
    const families = groupByFamily(matching);
    if (families.length <= 1) continue;
    // Name one representative artifact per family, not every module of each.
    const libs = families.map((f) => [...f.artifacts][0] as string);
    out.push({
      concept,
      repositories: [...new Set(families.flatMap((f) => [...f.repos]))],
      recommendation:
        `Pick one ${concept} for the whole project (candidates: ${libs.slice(0, 3).join(", ")}) and adapt the others ` +
        `behind it. Shipping two ${concept} libraries doubles the dependency weight and splits behaviour ` +
        `(timeouts, retries, interceptors) across two configurations.`,
    });
  }
  return out;
}

/** Symbols with the same name from different repositories. */
function findNamingConflicts(sels: SynthesisInput["selections"]): SynthesisReport["namingConflicts"] {
  const byName = new Map<string, Set<string>>();
  for (const { candidate } of sels) {
    for (const s of candidate.minimalSet?.core ?? candidate.symbols ?? []) {
      const set = byName.get(s.name) ?? new Set<string>();
      set.add(candidate.ref.fullName);
      byName.set(s.name, set);
    }
  }
  return [...byName.entries()]
    .filter(([, repos]) => repos.size > 1)
    .map(([symbol, repos]) => ({ symbol, repositories: [...repos] }))
    .slice(0, 12);
}

function findFrameworkDifferences(
  sels: SynthesisInput["selections"], targetLanguage?: string,
): string[] {
  const out: string[] = [];
  const languages = new Map<string, string[]>();
  for (const { candidate } of sels) {
    const lang = candidate.metadata.language;
    if (!lang) continue;
    languages.set(lang, [...(languages.get(lang) ?? []), candidate.ref.fullName]);
  }
  if (languages.size > 1) {
    out.push(
      `Selections span ${languages.size} languages (${[...languages.keys()].join(", ")}). ` +
      `Only ${targetLanguage ?? "the target language"} implementations can be reused directly; the rest must be ported.`,
    );
  }
  for (const [lang, repos] of languages) {
    if (targetLanguage && lang.toLowerCase() !== targetLanguage.toLowerCase()) {
      out.push(`${repos.join(", ")}: ${lang}, not ${targetLanguage} — reference only unless ported.`);
    }
  }
  return out.slice(0, 8);
}

/**
 * Licence conflicts across the combination.
 *
 * The important case is that combining is *strictly worse* than any single choice: the
 * strictest licence in the set governs the combined work. A plan that mixes MIT and GPL-3.0
 * is a GPL-3.0 plan, and an agent that does not know this will not find out until much later.
 */
function findLicenseConflicts(sels: SynthesisInput["selections"]): SynthesisReport["licenseConflicts"] {
  const out: SynthesisReport["licenseConflicts"] = [];
  const byCategory = new Map<LicenseCategory, string[]>();
  for (const { candidate } of sels) {
    const cat = candidate.license?.category;
    if (!cat) continue;
    byCategory.set(cat, [...(byCategory.get(cat) ?? []), candidate.ref.fullName]);
  }

  const copyleft = [
    ...(byCategory.get("strong-copyleft") ?? []),
    ...(byCategory.get("network-copyleft") ?? []),
  ];
  const permissive = [
    ...(byCategory.get("permissive") ?? []),
    ...(byCategory.get("public-domain") ?? []),
  ];

  if (copyleft.length && permissive.length) {
    out.push({
      repositories: [...copyleft, ...permissive],
      severity: "high",
      issue:
        `Combining copyleft (${copyleft.join(", ")}) with permissive code means the STRICTEST licence governs the ` +
        `combined work. The permissive parts do not dilute it. Either drop the copyleft selections, or accept that the ` +
        `whole result carries their obligations.`,
    });
  }
  if ((byCategory.get("proprietary") ?? []).length) {
    out.push({
      repositories: byCategory.get("proprietary") as string[],
      severity: "high",
      issue: "One or more selections are source-available but not open source; production use may be restricted regardless of the rest.",
    });
  }
  const unknown = byCategory.get("unknown") ?? [];
  if (unknown.length) {
    out.push({
      repositories: unknown,
      severity: "caution",
      issue: `Unlicensed selections (${unknown.join(", ")}) make the combined licence position unresolvable. Treat them as reference only.`,
    });
  }
  return out;
}

/** The concrete plan for reconciling everything above into one target architecture. */
function buildStrategy(sels: SynthesisInput["selections"]): string[] {
  const strategy: string[] = [];
  if (!sels.length) return strategy;

  strategy.push(
    "Define your project's own interfaces FIRST, then adapt each implementation behind them. " +
    "Importing each repository's shape directly is how projects end up with three competing architectures.",
  );

  const duplicates = findDuplicateAbstractions(sels);
  if (duplicates.length) {
    strategy.push(
      `Choose one library per concept before writing code — ${duplicates.map((d) => d.concept).join(", ")} ` +
      `${duplicates.length === 1 ? "is" : "are"} currently provided by more than one selection.`,
    );
  }

  const naming = findNamingConflicts(sels);
  if (naming.length) {
    strategy.push(
      `Namespace or rename on the way in: ${naming.slice(0, 3).map((n: { symbol: string }) => n.symbol).join(", ")} ` +
      `${naming.length === 1 ? "appears" : "appear"} in more than one source repository.`,
    );
  }

  const licenceIssues = findLicenseConflicts(sels);
  if (licenceIssues.some((l) => l.severity === "high")) {
    strategy.push("Resolve the licence conflicts before writing any code — they may remove a selection entirely, which changes the plan.");
  }

  strategy.push(
    "Integrate one feature at a time, with its tests, before starting the next. " +
    "Adapting several implementations simultaneously makes it impossible to tell which one broke.",
  );
  return strategy;
}

/** Licence roll-up across the whole plan. */
export function summariseLicenses(sels: SynthesisInput["selections"]): LicenseSummary {
  // One repository selected for two features is one licence obligation, not two. Listing
  // it twice makes the roll-up look like there are more distinct dependencies than there are.
  const seen = new Set<string>();
  const licenses = sels
    .filter(({ candidate }) => {
      const k = candidate.ref.fullName.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map(({ candidate }) => ({
      repository: candidate.ref.fullName,
      spdx: candidate.license?.spdx ?? "UNKNOWN",
      category: candidate.license?.category ?? "unknown",
    }));

  // Strictness order — the governing licence of a combined work is the strictest in it.
  const RANK: Record<string, number> = {
    "public-domain": 0, permissive: 1, "weak-copyleft": 2,
    "strong-copyleft": 3, "network-copyleft": 4, proprietary: 5, unknown: 4.5, none: 4.5,
  };
  const strictest = licenses.reduce(
    (worst, l) => ((RANK[l.category] ?? 0) > (RANK[worst.category] ?? 0) ? l : worst),
    licenses[0] ?? { repository: "", spdx: "UNKNOWN", category: "unknown" },
  );

  const warnings: string[] = [];
  const conflicts = findLicenseConflicts(sels);
  for (const c of conflicts) warnings.push(c.issue);

  const rank = RANK[strictest.category] ?? 0;
  const overallRisk: LicenseSummary["overallRisk"] =
    rank >= 4 ? "high" : rank >= 2 ? "medium" : licenses.length ? "low" : "unknown";

  return {
    licenses,
    strictest: `${strictest.spdx} (${strictest.category})`,
    overallRisk,
    warnings,
    disclaimer: LICENSE_DISCLAIMER,
  };
}

// ---------------------------------------------------------------------------

function runtimeDeps(c: Candidate): Dependency[] {
  return (c.dependencies?.direct ?? []).filter((d) => d.scope === "runtime" || d.scope === "peer");
}

/** Compare on artifact identity, so `group:artifact` and `artifact` unify. */
function normaliseDepName(d: Dependency): string {
  const name = d.name.toLowerCase();
  if (name.includes(":")) return name;                    // Maven/Gradle coordinates are already unique
  return name.startsWith("@") ? name : name.split("/").pop() ?? name;
}

function majorOf(version: string): string {
  const m = /(\d+)/.exec(version.replace(/^[^\d]*/, ""));
  return m?.[1] ?? "";
}

function detectAsyncModel(deps: Dependency[]): string | undefined {
  const names = deps.map((d) => d.name.toLowerCase()).join(" ");
  if (/rxjava|rxandroid|rxkotlin/.test(names)) return "RxJava";
  if (/kotlinx-coroutines/.test(names)) return "Kotlin coroutines";
  if (/rxjs/.test(names)) return "RxJS";
  if (/reactor-core|webflux/.test(names)) return "Project Reactor";
  if (/asyncio|anyio|trio/.test(names)) return "asyncio";
  if (/tokio|async-std/.test(names)) return "Tokio";
  if (/combine/.test(names)) return "Combine";
  return undefined;
}
