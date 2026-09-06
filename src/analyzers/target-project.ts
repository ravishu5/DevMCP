/**
 * Target-project analysis (spec §15).
 *
 * The question this makes answerable is the one that matters:
 *
 *   "How do I integrate this GitHub implementation into THIS project?"
 *
 * rather than merely "here's some code that does the same thing".
 *
 * Two constraints shaped the implementation:
 *
 *   1. **It must work without jCodeMunch.** The measured config on this host has
 *      `trusted_folders_whitelist_mode: true`, so indexing an arbitrary local folder may
 *      simply be refused. A tool that only works when the index cooperates would fail
 *      exactly when a user first tries it. So this is a self-contained static scan, and
 *      the code index only *enriches* it.
 *   2. **It reads, never executes.** Same rule as for remote repositories (spec §22): no
 *      `npm install`, no build, no scripts. Manifests are parsed, not evaluated.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type {
  Dependency, RetrievalMode, TargetProjectProfile,
} from "../types/index.js";
import { findManifests, parseManifest, dedupeDependencies } from "../providers/github/manifests.js";
import { isSensitivePath, redactSecrets } from "../security/secrets.js";
import { isWithin } from "../security/paths.js";
import type { Logger } from "../core/logger.js";

export interface TargetProjectOptions {
  root: string;
  logger?: Logger;
  /** Directory depth to walk. Deep enough to find structure, shallow enough to stay fast. */
  maxDepth?: number;
  maxFiles?: number;
}

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "target", ".next", ".nuxt",
  "vendor", "third_party", "Pods", ".gradle", ".idea", ".vscode", "__pycache__",
  ".venv", "venv", "env", ".tox", "coverage", ".cache", ".terraform", "DerivedData",
]);

const LANGUAGE_BY_EXT: Record<string, string> = {
  kt: "Kotlin", kts: "Kotlin", java: "Java", swift: "Swift", m: "Objective-C",
  ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript",
  py: "Python", go: "Go", rs: "Rust", rb: "Ruby", php: "PHP", cs: "C#",
  scala: "Scala", dart: "Dart", c: "C", cc: "C++", cpp: "C++", h: "C", hpp: "C++",
};

/** Framework markers, detected from dependencies and characteristic files. */
const FRAMEWORK_MARKERS: { name: string; deps?: RegExp; files?: RegExp }[] = [
  { name: "Next.js", deps: /^next$/, files: /^next\.config\./ },
  { name: "React", deps: /^react$/ },
  { name: "Vue", deps: /^vue$/ },
  { name: "Angular", deps: /^@angular\/core$/ },
  { name: "Svelte", deps: /^svelte$/ },
  { name: "Express", deps: /^express$/ },
  { name: "NestJS", deps: /^@nestjs\/core$/ },
  { name: "Android", files: /(^|\/)AndroidManifest\.xml$/ },
  { name: "Jetpack Compose", deps: /androidx\.compose/ },
  { name: "SwiftUI", files: /\.swift$/ },
  { name: "Django", deps: /^django$/i, files: /(^|\/)manage\.py$/ },
  { name: "Flask", deps: /^flask$/i },
  { name: "FastAPI", deps: /^fastapi$/i },
  { name: "Spring Boot", deps: /org\.springframework\.boot/ },
  { name: "Flutter", files: /(^|\/)pubspec\.yaml$/ },
  { name: "Rails", deps: /^rails$/ },
];

const STATE_MARKERS: [RegExp, string][] = [
  [/^redux$|@reduxjs\/toolkit/, "Redux Toolkit"], [/^zustand$/, "Zustand"],
  [/^jotai$/, "Jotai"], [/^mobx$/, "MobX"], [/@tanstack\/react-query|^react-query$/, "TanStack Query"],
  [/androidx\.lifecycle.*viewmodel/i, "ViewModel"], [/io\.insert-koin|dagger|hilt/i, "DI-managed state"],
  [/^riverpod$|flutter_riverpod/, "Riverpod"], [/^flutter_bloc$|^bloc$/, "BLoC"],
];

const NETWORK_MARKERS: [RegExp, string][] = [
  [/^axios$/, "axios"], [/^ky$/, "ky"], [/^got$/, "got"], [/@trpc\//, "tRPC"],
  [/okhttp/i, "OkHttp"], [/retrofit/i, "Retrofit"], [/ktor-client/i, "Ktor"],
  [/^httpx$/i, "httpx"], [/^requests$/i, "requests"], [/^aiohttp$/i, "aiohttp"],
  [/^alamofire$/i, "Alamofire"], [/^dio$/, "dio"], [/^reqwest$/, "reqwest"],
];

const DATABASE_MARKERS: [RegExp, string][] = [
  [/^prisma$|@prisma\/client/, "Prisma"], [/^drizzle-orm$/, "Drizzle"], [/^typeorm$/, "TypeORM"],
  [/^knex$/, "Knex"], [/^mongoose$/, "Mongoose"], [/^sequelize$/, "Sequelize"],
  [/androidx\.room/i, "Room"], [/^realm/i, "Realm"], [/sqldelight/i, "SQLDelight"],
  [/^sqlalchemy$/i, "SQLAlchemy"], [/^psycopg2?$/i, "PostgreSQL"], [/^pymongo$/i, "MongoDB"],
  [/hibernate/i, "Hibernate"], [/^gorm\.io/, "GORM"], [/^diesel$/, "Diesel"],
];

const TEST_MARKERS: [RegExp, string][] = [
  [/^jest$/, "Jest"], [/^vitest$/, "Vitest"], [/^mocha$/, "Mocha"],
  [/@testing-library\//, "Testing Library"], [/^playwright$|@playwright\//, "Playwright"],
  [/^cypress$/, "Cypress"], [/junit/i, "JUnit"], [/mockk/i, "MockK"],
  [/mockito/i, "Mockito"], [/espresso/i, "Espresso"], [/^pytest$/i, "pytest"],
  [/^rspec/, "RSpec"], [/testify/i, "testify"], [/^xctest$/i, "XCTest"],
];

export async function analyzeTargetProject(opts: TargetProjectOptions): Promise<TargetProjectProfile> {
  const root = opts.root;
  const maxDepth = opts.maxDepth ?? 4;
  const maxFiles = opts.maxFiles ?? 4000;
  const gaps: string[] = [];

  let files: string[];
  try {
    files = await walk(root, root, maxDepth, maxFiles);
  } catch (err) {
    return emptyProfile(root, [
      `Could not read the project directory: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }
  if (files.length === 0) {
    return emptyProfile(root, ["No readable source files found under the project root."]);
  }
  if (files.length >= maxFiles) {
    gaps.push(`Scan stopped at ${maxFiles} files; very large projects are analysed partially.`);
  }

  // --- languages -----------------------------------------------------------
  const languages: Record<string, number> = {};
  for (const f of files) {
    const ext = f.slice(f.lastIndexOf(".") + 1).toLowerCase();
    const lang = LANGUAGE_BY_EXT[ext];
    if (lang) languages[lang] = (languages[lang] ?? 0) + 1;
  }
  const primary = Object.entries(languages).sort((a, b) => b[1] - a[1])[0]?.[0];

  // --- dependencies --------------------------------------------------------
  const manifestSpecs = findManifests(files, 3, 8);
  const deps: Dependency[] = [];
  const dependencyManagers: string[] = [];
  for (const spec of manifestSpecs) {
    try {
      const raw = await readFile(join(root, spec.path), "utf8");
      deps.push(...parseManifest(spec, raw));
      if (!dependencyManagers.includes(spec.ecosystem)) dependencyManagers.push(spec.ecosystem);
    } catch {
      gaps.push(`Could not read manifest ${spec.path}.`);
    }
  }
  const existingLibraries = dedupeDependencies(deps);
  if (!existingLibraries.length) {
    gaps.push("No dependency manifests were readable; library detection is unavailable.");
  }

  const depNames = existingLibraries.map((d) => d.name.toLowerCase());
  const fileText = files.join("\n");

  // --- frameworks and layers ----------------------------------------------
  const frameworks = FRAMEWORK_MARKERS
    .filter((m) => (m.deps && depNames.some((d) => m.deps!.test(d))) || (m.files && m.files.test(fileText)))
    .map((m) => m.name);

  const stateManagement = firstMatch(STATE_MARKERS, depNames);
  const networkingLayer = firstMatch(NETWORK_MARKERS, depNames);
  const database = firstMatch(DATABASE_MARKERS, depNames);
  const testingFrameworks = TEST_MARKERS.filter(([re]) => depNames.some((d) => re.test(d))).map(([, n]) => n);
  if (!testingFrameworks.length) {
    gaps.push("No test framework detected; adapted code will need a testing approach chosen.");
  }

  // --- directory structure -------------------------------------------------
  const directoryStructure = inferStructure(files);

  // --- architecture --------------------------------------------------------
  const architecture = inferProjectArchitecture(directoryStructure, frameworks);

  // --- coding patterns -----------------------------------------------------
  const codingPatterns = detectPatterns(files, depNames, directoryStructure);

  // --- licence -------------------------------------------------------------
  let projectLicense: string | undefined;
  const licenseFile = files.find((f) => /^LICEN[CS]E(\.\w+)?$/i.test(f));
  if (licenseFile) {
    try {
      const text = await readFile(join(root, licenseFile), "utf8");
      projectLicense = guessLicense(text);
    } catch { /* not fatal */ }
  } else {
    gaps.push("No LICENSE file found; licence-compatibility checks will assume 'unknown'.");
  }

  return {
    root,
    language: primary,
    languages,
    frameworks,
    architecture,
    dependencyManagers,
    existingLibraries: existingLibraries.slice(0, 60),
    directoryStructure,
    stateManagement,
    networkingLayer,
    database,
    testingFrameworks,
    codingPatterns,
    projectLicense,
    analysisMode: "github-fallback" as RetrievalMode,   // static local scan, no index
    gaps,
  };
}

// ---------------------------------------------------------------------------

/** Walk the tree, skipping ignored directories, sensitive files and symlink escapes. */
async function walk(root: string, dir: string, depthLeft: number, budget: number): Promise<string[]> {
  if (depthLeft < 0 || budget <= 0) return [];
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (out.length >= budget) break;
    if (entry.name.startsWith(".") && entry.name !== ".github") continue;
    const full = join(dir, entry.name);

    // A symlink out of the project is a real way to walk somewhere unintended.
    if (!isWithin(root, full)) continue;

    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      out.push(...await walk(root, full, depthLeft - 1, budget - out.length));
    } else if (entry.isFile()) {
      const rel = relative(root, full).split(sep).join("/");
      // Never read (or even list) files that are definitionally secrets.
      if (isSensitivePath(rel)) continue;
      out.push(rel);
    } else if (entry.isSymbolicLink()) {
      try {
        const s = await stat(full);
        if (s.isFile()) {
          const rel = relative(root, full).split(sep).join("/");
          if (!isSensitivePath(rel)) out.push(rel);
        }
      } catch { /* broken symlink */ }
    }
  }
  return out;
}

/** Directory roles, inferred from names and from what the directories contain. */
function inferStructure(files: string[]): { path: string; role: string }[] {
  const counts = new Map<string, number>();
  for (const f of files) {
    const parts = f.split("/");
    if (parts.length < 2) continue;
    // Two levels: enough to distinguish `src/data` from `src/ui`, which is where the
    // integration decisions actually get made.
    const key = parts.slice(0, Math.min(2, parts.length - 1)).join("/");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const ROLES: [RegExp, string][] = [
    [/(^|\/)(domain|core|model|models|entit)/i, "domain model"],
    [/(^|\/)(data|repositor|persistence|db|database|storage|dao)/i, "data access"],
    [/(^|\/)(ui|presentation|view|screen|component|page|widget)/i, "presentation"],
    [/(^|\/)(network|net|api|http|remote|client|service)/i, "networking"],
    [/(^|\/)(worker|job|task|background|queue)/i, "background work"],
    [/(^|\/)(usecase|interactor|application)/i, "business logic"],
    [/(^|\/)(di|inject|module)/i, "dependency injection"],
    [/(^|\/)(util|common|shared|helper|lib)/i, "shared utilities"],
    [/(^|\/)(test|spec|__tests__)/i, "tests"],
    [/(^|\/)(config|settings)/i, "configuration"],
    [/(^|\/)(migration|schema)/i, "schema and migrations"],
  ];

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14)
    .map(([path, n]) => ({
      path,
      role: ROLES.find(([re]) => re.test(path))?.[1] ?? `${n} file(s)`,
    }));
}

function inferProjectArchitecture(
  structure: { path: string; role: string }[], frameworks: string[],
): string | undefined {
  const roles = new Set(structure.map((s) => s.role));
  if (roles.has("domain model") && roles.has("data access") && roles.has("presentation")) {
    return "clean architecture (domain / data / presentation)";
  }
  if (roles.has("business logic") && roles.has("data access")) return "layered service architecture";
  if (roles.has("data access") && roles.has("presentation")) return "MVVM / layered";
  if (frameworks.includes("Next.js")) return "Next.js app structure";
  if (frameworks.includes("Django")) return "Django MTV";
  if (frameworks.includes("Rails")) return "Rails MVC";
  if (structure.length <= 3) return "flat / single-module";
  return undefined;
}

/**
 * Conventions worth matching when adapting code in.
 *
 * These are what make adapted code look like it belongs — the difference between an
 * integration and a transplant.
 */
function detectPatterns(
  files: string[], depNames: string[], structure: { path: string; role: string }[],
): string[] {
  const patterns: string[] = [];
  const text = files.join("\n");

  if (files.some((f) => /Repository\.\w+$/i.test(f))) patterns.push("Repository pattern");
  if (files.some((f) => /UseCase\.\w+$|Interactor\.\w+$/i.test(f))) patterns.push("Use-case / interactor layer");
  if (files.some((f) => /ViewModel\.\w+$/i.test(f))) patterns.push("ViewModel per screen");
  if (files.some((f) => /\.hooks?\.\w+$|(^|\/)hooks\//i.test(f))) patterns.push("React hooks");
  if (depNames.some((d) => /dagger|hilt|koin|inversify|tsyringe/.test(d))) patterns.push("Constructor DI via container");
  if (/(^|\n)src\/index\.\w+/.test(text)) patterns.push("Barrel exports from src/index");
  if (files.some((f) => /(^|\/)migrations?\//i.test(f))) patterns.push("Versioned schema migrations");
  if (files.some((f) => /\.stories\.\w+$/i.test(f))) patterns.push("Storybook component stories");
  if (structure.some((s) => s.role === "tests")) patterns.push("Tests in a dedicated directory");
  else if (files.some((f) => /\.(test|spec)\.\w+$/i.test(f))) patterns.push("Tests colocated with source");

  return patterns;
}

function guessLicense(text: string): string | undefined {
  const safe = redactSecrets(text).text.slice(0, 4000);
  if (/MIT License/i.test(safe)) return "MIT";
  if (/Apache License\s+Version 2\.0/i.test(safe)) return "Apache-2.0";
  if (/GNU AFFERO/i.test(safe)) return "AGPL-3.0";
  if (/GNU LESSER/i.test(safe)) return "LGPL-3.0";
  if (/GNU GENERAL PUBLIC LICENSE\s+Version 3/i.test(safe)) return "GPL-3.0";
  if (/GNU GENERAL PUBLIC LICENSE\s+Version 2/i.test(safe)) return "GPL-2.0";
  if (/Mozilla Public License/i.test(safe)) return "MPL-2.0";
  if (/BSD/i.test(safe)) return "BSD-3-Clause";
  if (/unencumbered software released into the public domain/i.test(safe)) return "Unlicense";
  return undefined;
}

function firstMatch(markers: [RegExp, string][], names: string[]): string | undefined {
  return markers.find(([re]) => names.some((n) => re.test(n)))?.[1];
}

function emptyProfile(root: string, gaps: string[]): TargetProjectProfile {
  return {
    root, languages: {}, frameworks: [], dependencyManagers: [], existingLibraries: [],
    directoryStructure: [], testingFrameworks: [], codingPatterns: [],
    analysisMode: "unavailable", gaps,
  };
}
