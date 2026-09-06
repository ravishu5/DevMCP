/**
 * Reusability: is this repository a LIBRARY or an APPLICATION?
 *
 * The single most consequential distinction for a tool whose purpose is finding reusable
 * implementations — and one that popularity, tests, maintenance and even completeness are
 * all blind to.
 *
 * An Android app that uses Room contains schema definitions, DAOs, migrations and
 * transactional writes. It therefore scores *well* on a persistence checklist, and can
 * outrank an actual persistence library. Observed live: a plant-care app ranked first for
 * "local persistence". Nothing was wrong with the measurement; the question being measured
 * was incomplete.
 *
 * An application is not useless — it is a working example, and sometimes the only one —
 * but it is `REFERENCE_ONLY` in practice, because you cannot depend on it. So this is
 * scored, explained, and fed to reuse-mode assessment rather than used as a filter.
 *
 * All signals come from data deep analysis already fetches: the tree, the manifests, the
 * topics and the description. No extra API calls.
 */

import type { Dependency, RepoMetadata } from "../types/index.js";

export type RepositoryKind = "library" | "application" | "example" | "mixed" | "unknown";

export interface ReusabilityAssessment {
  kind: RepositoryKind;
  /** 0–1, higher = more reusable as a dependency. Feeds the ranking axis. */
  score: number;
  /** 0–1 confidence in the classification itself. */
  confidence: number;
  /** Human-readable evidence, both directions. */
  signals: string[];
}

export interface ReusabilityInput {
  metadata: RepoMetadata;
  filePaths?: string[];
  dependencies?: Dependency[];
  /** Raw manifest text, when available — publishing config is the strongest signal. */
  manifestContents?: string[];
  readme?: string;
}

/** Paths that indicate a distributable library. */
const LIBRARY_PATHS: [RegExp, string][] = [
  [/(^|\/)(gradle\/libs\.versions\.toml)$/i, "version catalog"],
  [/(^|\/)(api|public)\/.*\.api$/i, "binary-compatibility API dump"],
  [/(^|\/)\.api\//i, "API surface tracking"],
];

/** Paths that indicate a runnable application. */
const APP_PATHS: [RegExp, string][] = [
  [/(^|\/)Dockerfile$/i, "Dockerfile"],
  [/(^|\/)docker-compose\.ya?ml$/i, "docker-compose"],
  [/(^|\/)(fastlane|Fastfile)/i, "release automation (fastlane)"],
  [/(^|\/)(screenshots?|fastlane\/metadata)\//i, "screenshots"],
  [/(^|\/)\.github\/workflows\/.*(deploy|release-app|publish-app)/i, "deployment workflow"],
  [/(^|\/)(k8s|kubernetes|helm|terraform)\//i, "infrastructure manifests"],
  [/(^|\/)(procfile|vercel\.json|netlify\.toml|app\.yaml)$/i, "hosting configuration"],
];

/** Publishing configuration — the strongest library signal there is. */
const PUBLISH_MARKERS: [RegExp, string][] = [
  [/\bmaven-publish\b|\bcom\.vanniktech\.maven\.publish\b|\bsigning\b.*\bpublish/i, "maven-publish plugin"],
  [/\bpublishing\s*\{/i, "gradle publishing block"],
  [/\bapply\s+plugin:\s*['"]com\.jfrog\.bintray['"]/i, "artifact publishing"],
  [/"private"\s*:\s*false/i, "npm publishable"],
  [/\b(setuptools|poetry|hatchling|flit)\b/i, "python packaging"],
  [/\[project\]|\[tool\.poetry\]/i, "python project metadata"],
  [/\bcrate-type\b|\[lib\]/i, "cargo library target"],
  [/\bs\.summary\b|\bspec\.summary\b/i, "podspec"],
  [/\bproducts:\s*\[[\s\S]{0,200}\.library\(/i, "SwiftPM library product"],
];

/** Application configuration in build files. */
const APP_MARKERS: [RegExp, string][] = [
  [/\bapplicationId\s*[=\s]/i, "Android applicationId"],
  [/\bcom\.android\.application\b/i, "Android application plugin"],
  [/\[\[bin\]\]|\bsrc\/main\.rs\b/i, "cargo binary target"],
  [/\bexecutable\(/i, "SwiftPM executable product"],
  [/"bin"\s*:/i, "npm bin entry"],
];

const LIBRARY_TOPICS = /\b(library|libraries|sdk|framework|toolkit|client|wrapper|binding|plugin|package)\b/i;
const APP_TOPICS = /\b(app|application|android-app|ios-app|demo|sample|example|tutorial|starter|boilerplate|template|clone|portfolio)\b/i;

/** Split identifiers so word-boundary patterns behave: WorkManagerExample -> work manager example. */
function humanise(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function assessReusability(input: ReusabilityInput): ReusabilityAssessment {
  const signals: string[] = [];
  let library = 0;
  let application = 0;
  let evidenceCount = 0;

  const files = input.filePaths ?? [];
  const manifests = (input.manifestContents ?? []).join("\n");
  // Repository names are identifiers, so `\bexample\b` never matches inside
  // "WorkManagerExample" — the same word-boundary trap as
  // symbol-role matching. Split camelCase, kebab and snake before testing.
  const meta = humanise(
    `${input.metadata.ref.name} ${input.metadata.description ?? ""} ${input.metadata.topics.join(" ")}`,
  );

  // --- publishing configuration: the strongest signal in either direction -----
  for (const [re, label] of PUBLISH_MARKERS) {
    if (manifests && re.test(manifests)) {
      library += 3; evidenceCount++;
      signals.push(`+ ${label}`);
      break;
    }
  }
  for (const [re, label] of APP_MARKERS) {
    if (manifests && re.test(manifests)) {
      application += 3; evidenceCount++;
      signals.push(`- ${label}`);
      break;
    }
  }

  // --- structural paths ------------------------------------------------------
  for (const [re, label] of LIBRARY_PATHS) {
    if (files.some((f) => re.test(f))) { library += 1; evidenceCount++; signals.push(`+ ${label}`); }
  }
  for (const [re, label] of APP_PATHS) {
    if (files.some((f) => re.test(f))) { application += 1.5; evidenceCount++; signals.push(`- ${label}`); }
  }

  // An AndroidManifest declaring a launcher activity is an app; a library manifest does not.
  if (files.some((f) => /AndroidManifest\.xml$/i.test(f))) {
    const hasSampleModule = files.some((f) => /^(sample|samples|demo|app|example)[A-Za-z]*\//i.test(f));
    const manifestCount = files.filter((f) => /AndroidManifest\.xml$/i.test(f)).length;
    if (hasSampleModule && manifestCount > 1) {
      // A library that ships a sample app: two manifests, one under a sample module.
      library += 1.5; evidenceCount++;
      signals.push("+ ships a sample app alongside library modules");
    }
  }

  // --- naming and topics -----------------------------------------------------
  if (LIBRARY_TOPICS.test(meta)) { library += 1.5; evidenceCount++; signals.push("+ described as a library/SDK"); }
  if (APP_TOPICS.test(meta)) { application += 1.5; evidenceCount++; signals.push("- described as an app/demo/template"); }

  // README install instructions naming a dependency coordinate are near-conclusive.
  if (input.readme && /(\bimplementation\s*\(?["']|\bnpm i(nstall)?\s+[\w@/-]|\bpip install\s+[\w-]|\badd\s+.+\s+to\s+your\s+(dependencies|Gemfile|Cargo\.toml))/i.test(input.readme)) {
    library += 2; evidenceCount++;
    signals.push("+ README documents installing it as a dependency");
  }

  // --- verdict ---------------------------------------------------------------
  const total = library + application;
  const kind: RepositoryKind =
    evidenceCount === 0 ? "unknown"
      : total === 0 ? "unknown"
      : library >= application * 2 ? "library"
      : application >= library * 2 ? (/\b(demo|sample|example|tutorial|starter|boilerplate|playground)\b/i.test(meta) ? "example" : "application")
      : "mixed";

  // Score: 1.0 a clear library, 0.15 a clear application. An application is not worthless —
  // it is a working example — but you cannot depend on it, so it must not win a search for
  // a reusable implementation.
  const score =
    kind === "library" ? 1
      : kind === "mixed" ? 0.6
      : kind === "example" ? 0.2
      : kind === "application" ? 0.15
      : 0.5;   // unknown: neutral, not penalised

  return {
    kind,
    score,
    confidence: evidenceCount === 0 ? 0.1 : Math.min(0.9, 0.35 + evidenceCount * 0.15),
    signals: signals.slice(0, 5),
  };
}
