/**
 * Integration surface — how much of the consuming project this will touch.
 *
 * Two implementations can be equally correct and differ by an order of magnitude in cost:
 *
 *   Repo A    5 classes ·  2 dependencies · 1 integration interface
 *   Repo B   32 classes · 14 dependencies · 6 framework-specific abstractions
 *
 * Repo A is dramatically cheaper to adopt. Making this a **measured** signal rather than a
 * hand-waved adjective is what lets the ranker act on it.
 *
 * Framework coupling is the subtlest input and often the decisive one: an implementation
 * welded to Spring or Django cannot be lifted out at any symbol count, whereas a
 * self-contained one can be vendored wholesale.
 */

import type { CodeSymbol, Dependency, IntegrationDifficulty, IntegrationSurface, TargetStack } from "../types/index.js";

export interface IntegrationSurfaceInput {
  symbols?: CodeSymbol[];
  dependencies?: Dependency[];
  /** Distinct places the consuming project must wire something up. */
  integrationPoints?: number;
  /** Env vars, keys, permissions, config files the consumer must supply. */
  configurationRequirements?: string[];
  filePaths?: string[];
  target?: TargetStack;
  /** Repository size in KB, used as a weak proxy when no symbols are available. */
  repoSizeKb?: number;
}

/** Frameworks whose presence implies the implementation is hard to lift out. */
const HEAVY_FRAMEWORKS = [
  "spring", "django", "rails", "laravel", "symfony", "nestjs", "angular",
  "dagger", "hilt", "koin", "guice", "micronaut", "quarkus", "play",
];

export function assessIntegrationSurface(input: IntegrationSurfaceInput): IntegrationSurface {
  const symbolsRequired = input.symbols?.length ?? estimateSymbolsFromSize(input.repoSizeKb);
  const deps = input.dependencies ?? [];
  // Runtime dependencies are what the consumer inherits; dev/test deps cost nothing.
  const runtimeDeps = deps.filter((d) => d.scope === "runtime" || d.scope === "peer");
  const dependencyCount = runtimeDeps.length;
  const integrationPointCount = input.integrationPoints ?? estimateIntegrationPoints(input.symbols);
  const configurationRequirements = input.configurationRequirements?.length ?? 0;

  const frameworkCoupling = assessCoupling(runtimeDeps, input.filePaths, input.target);

  const drivers: string[] = [];

  // Each sub-score is 0–1 where 1 = cheap. Thresholds are calibrated so that a typical
  // small library scores ~0.8 and a framework-coupled monolith ~0.2.
  const symbolScore = scoreDescending(symbolsRequired, 6, 40);
  if (symbolsRequired > 25) drivers.push(`${symbolsRequired} symbols to understand`);
  else if (symbolsRequired <= 8 && input.symbols) drivers.push(`only ${symbolsRequired} symbols involved`);

  const depScore = scoreDescending(dependencyCount, 2, 20);
  if (dependencyCount > 12) drivers.push(`${dependencyCount} runtime dependencies`);
  else if (dependencyCount <= 3) drivers.push(`${dependencyCount} runtime dependencies`);

  const pointScore = scoreDescending(integrationPointCount, 1, 10);
  if (integrationPointCount > 5) drivers.push(`${integrationPointCount} integration points`);

  const configScore = scoreDescending(configurationRequirements, 0, 8);
  if (configurationRequirements > 4) drivers.push(`${configurationRequirements} configuration requirements`);

  const couplingScore = 1 - frameworkCoupling;
  if (frameworkCoupling > 0.6) drivers.push("tightly coupled to its own framework");
  else if (frameworkCoupling < 0.2) drivers.push("self-contained, little framework coupling");

  // Coupling is weighted heaviest because it is the one input that cannot be worked
  // around: a small, framework-welded implementation is still unliftable.
  const score = round2(
    symbolScore * 0.22 + depScore * 0.24 + pointScore * 0.16 + configScore * 0.10 + couplingScore * 0.28,
  );

  return {
    symbolsRequired,
    dependencyCount,
    integrationPointCount,
    configurationRequirements,
    frameworkCoupling: round2(frameworkCoupling),
    score,
    difficulty: toDifficulty(score),
    drivers: drivers.slice(0, 5),
  };
}

export function toDifficulty(score: number): IntegrationDifficulty {
  if (score >= 0.85) return "trivial";
  if (score >= 0.68) return "low";
  if (score >= 0.45) return "medium";
  if (score >= 0.25) return "high";
  return "very-high";
}

/**
 * Coupling, 0 (self-contained) to 1 (welded to its framework).
 *
 * A heavy framework the TARGET already uses is not coupling at all — it is a match. So the
 * target stack is consulted before penalising: recommending a Spring implementation to a
 * Spring project should not be punished for using Spring.
 */
function assessCoupling(deps: Dependency[], filePaths?: string[], target?: TargetStack): number {
  const targetLibs = new Set(
    [target?.framework, ...(target?.libraries ?? [])].filter(Boolean).map((s) => (s as string).toLowerCase()),
  );

  let coupling = 0;
  const depNames = deps.map((d) => d.name.toLowerCase());
  for (const fw of HEAVY_FRAMEWORKS) {
    const used = depNames.some((n) => n.includes(fw));
    if (!used) continue;
    // Already in the target stack ⇒ not a cost.
    if ([...targetLibs].some((t) => t.includes(fw) || fw.includes(t))) continue;
    coupling += 0.3;
  }

  // Dependency-injection wiring and annotation processors are strong coupling signals:
  // they mean the implementation expects a container to assemble it.
  if (depNames.some((n) => /dagger|hilt|guice|inversify|tsyringe/.test(n))) coupling += 0.15;

  // Deep package nesting suggests an implementation embedded in a larger architecture
  // rather than a standalone module.
  if (filePaths?.length) {
    const avgDepth = filePaths.reduce((a, p) => a + p.split("/").length, 0) / filePaths.length;
    if (avgDepth > 6) coupling += 0.15;
  }

  return Math.min(1, coupling);
}

/** Linear 1→0 between `best` and `worst`, clamped. */
function scoreDescending(value: number, best: number, worst: number): number {
  if (value <= best) return 1;
  if (value >= worst) return 0;
  return round2(1 - (value - best) / (worst - best));
}

/** Public entry points ≈ the surface a consumer must wire up. */
function estimateIntegrationPoints(symbols?: CodeSymbol[]): number {
  if (!symbols?.length) return 2;
  const entryish = symbols.filter((s) =>
    s.kind === "interface" ||
    (s.kind === "class" && /manager|service|client|facade|api|provider|factory|builder/i.test(s.name)));
  return Math.max(1, entryish.length);
}

/** Weak fallback when no symbol data exists. Deliberately coarse — it is a prior, not a measurement. */
function estimateSymbolsFromSize(sizeKb?: number): number {
  if (!sizeKb) return 12;
  if (sizeKb < 500) return 8;
  if (sizeKb < 5_000) return 15;
  if (sizeKb < 50_000) return 30;
  return 50;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
