/**
 * Host framework detection: WHICH RUNTIME can consume this repository?
 *
 * A dimension distinct from both language and library-vs-application, and one that
 * `metadata.language` actively misleads about.
 *
 * `edeckers/react-native-blob-courier` is a React Native module. GitHub reports its
 * primary language as **Kotlin** — truthfully, because 47% of its bytes are the Android
 * native shim. So it scored a perfect 1.00 stack match against a native Kotlin/Android
 * target, and was recommended as a file-upload implementation. But you cannot call it from
 * a native Android project at all: its API surface is TypeScript, reached through the React
 * Native bridge. The language matched; the runtime did not.
 *
 * The same trap applies to Flutter plugins (Dart + Kotlin + Swift), Cordova and Capacitor
 * plugins, NativeScript modules, Xamarin bindings and Unity packages. In every case a
 * native-language shim makes the repository look native to a byte-counting classifier.
 *
 * Detection deliberately uses **metadata only** — name, topics, description — because the
 * shortlist for deep analysis is chosen from cheap signals. A signal that arrives after
 * deep analysis cannot influence who gets analysed, which is how three demo repositories
 * once took every deep-analysis slot. Manifests and dependencies refine the verdict when
 * available, but are never required.
 */

import type { Dependency, RepoMetadata } from "../types/index.js";

export type HostFramework =
  | "react-native" | "flutter" | "cordova" | "capacitor" | "nativescript"
  | "xamarin" | "unity" | "electron" | "native" | "unknown";

export interface HostFrameworkAssessment {
  framework: HostFramework;
  /** 0–1 confidence in the classification. */
  confidence: number;
  /** What the verdict was based on. Rendered in the stack-match observation. */
  signals: string[];
}

interface FrameworkRule {
  framework: Exclude<HostFramework, "native" | "unknown">;
  /** Repository-name patterns. The strongest single signal: naming is a convention here. */
  name: RegExp;
  /** Topic or description mentions. */
  mention: RegExp;
  /** Dependency names that only a plugin for this framework would declare. */
  dependency?: RegExp;
  /** Files that only this framework's plugins carry. */
  file?: RegExp;
  /** Aliases the TARGET stack might use to say "I am this framework". */
  targetAliases: RegExp;
}

const FRAMEWORKS: FrameworkRule[] = [
  {
    framework: "react-native",
    name: /(^|\/)(react-native-|rn-)|(-react-native)$/i,
    mention: /\breact[\s-]?native\b/i,
    dependency: /^react-native($|[-/])|@react-native\//i,
    file: /(^|\/)react-native\.config\.js$/i,
    targetAliases: /\breact[\s-]?native\b|\brn\b|\bexpo\b/i,
  },
  {
    framework: "flutter",
    name: /(^|\/)flutter[_-]|[_-]flutter$/i,
    mention: /\bflutter\b|\bdart\s+package\b/i,
    dependency: /^flutter($|[-_/])/i,
    file: /(^|\/)pubspec\.ya?ml$/i,
    targetAliases: /\bflutter\b|\bdart\b/i,
  },
  {
    framework: "cordova",
    name: /(^|\/)cordova-plugin-|(^|\/)phonegap-/i,
    mention: /\bcordova\b|\bphonegap\b/i,
    dependency: /^cordova($|[-/])/i,
    file: /(^|\/)plugin\.xml$/i,
    targetAliases: /\bcordova\b|\bphonegap\b|\bionic\b/i,
  },
  {
    framework: "capacitor",
    name: /(^|\/)capacitor-|@capacitor\//i,
    mention: /\bcapacitor\b/i,
    dependency: /^@capacitor\//i,
    targetAliases: /\bcapacitor\b|\bionic\b/i,
  },
  {
    framework: "nativescript",
    name: /(^|\/)nativescript-|@nativescript\//i,
    mention: /\bnativescript\b/i,
    dependency: /^@?nativescript($|[-/])/i,
    targetAliases: /\bnativescript\b/i,
  },
  {
    framework: "xamarin",
    name: /(^|\/)xamarin[.-]|\.forms$/i,
    mention: /\bxamarin\b|\bmaui\b/i,
    dependency: /^Xamarin\./i,
    targetAliases: /\bxamarin\b|\bmaui\b|\bdotnet\b|\b\.net\b/i,
  },
  {
    framework: "unity",
    name: /(^|\/)unity-|-unity$/i,
    mention: /\bunity\s?(3d|engine|package|plugin)\b/i,
    file: /(^|\/)Assets\/.*\.unity$/i,
    targetAliases: /\bunity\b/i,
  },
  {
    framework: "electron",
    name: /(^|\/)electron-/i,
    mention: /\belectron\b/i,
    dependency: /^electron($|[-/])/i,
    targetAliases: /\belectron\b/i,
  },
];

export interface HostFrameworkInput {
  metadata: RepoMetadata;
  /** Optional refinement — never required. */
  dependencies?: Dependency[];
  filePaths?: string[];
}

export function detectHostFramework(input: HostFrameworkInput): HostFrameworkAssessment {
  const md = input.metadata;
  const name = md.ref.name.toLowerCase();
  const topics = md.topics.map((t) => t.toLowerCase());
  const description = (md.description ?? "").toLowerCase();
  const depNames = (input.dependencies ?? []).map((d) => d.name);
  const files = input.filePaths ?? [];

  let best: { rule: FrameworkRule; score: number; signals: string[] } | undefined;

  for (const rule of FRAMEWORKS) {
    const signals: string[] = [];
    let score = 0;

    // Naming convention is near-conclusive: `react-native-blob-courier` is not accidental.
    if (rule.name.test(name)) { score += 3; signals.push(`repository name follows the ${rule.framework} convention`); }
    if (topics.some((t) => rule.mention.test(t))) { score += 2; signals.push(`topic mentions ${rule.framework}`); }
    if (rule.mention.test(description)) { score += 1.5; signals.push(`description mentions ${rule.framework}`); }
    if (rule.dependency && depNames.some((d) => rule.dependency!.test(d))) {
      score += 2; signals.push(`declares a ${rule.framework} dependency`);
    }
    if (rule.file && files.some((f) => rule.file!.test(f))) {
      score += 2; signals.push(`contains ${rule.framework} plugin files`);
    }

    if (score > 0 && (!best || score > best.score)) best = { rule, score, signals };
  }

  if (!best || best.score < 2) {
    // No cross-platform framework detected. "native" only when we have enough to say so.
    const confident = Boolean(md.language) && md.topics.length > 0;
    return {
      framework: confident ? "native" : "unknown",
      confidence: confident ? 0.6 : 0.15,
      signals: confident ? ["no cross-platform framework markers"] : [],
    };
  }

  return {
    framework: best.rule.framework,
    confidence: Math.min(0.95, 0.4 + best.score * 0.12),
    signals: best.signals.slice(0, 3),
  };
}

/**
 * Can a project on `targetStack` consume a repository built for `framework`?
 *
 * Returns a multiplier for the stack-match score, and a reason when it is not 1.
 *
 * The asymmetry is deliberate. A React Native module in a native Android project is
 * unusable — the multiplier is severe enough to push stack match below the 0.35 threshold
 * that already routes candidates to REFERENCE_ONLY, which is exactly the right verdict:
 * read it for the approach, then write native code. But when the target does not declare
 * any framework we are guessing, so the penalty is softened rather than applied at full
 * force: being wrong in that direction hides a usable library.
 */
export function hostFrameworkPenalty(
  assessment: HostFrameworkAssessment,
  targetDescriptors: (string | undefined)[],
): { multiplier: number; reason?: string } {
  const fw = assessment.framework;
  if (fw === "native" || fw === "unknown") return { multiplier: 1 };

  const rule = FRAMEWORKS.find((r) => r.framework === fw);
  if (!rule) return { multiplier: 1 };

  const target = targetDescriptors.filter(Boolean).join(" ").toLowerCase();
  if (!target) return { multiplier: 1 };

  // The target IS this framework — a match, not a mismatch.
  if (rule.targetAliases.test(target)) {
    return { multiplier: 1 };
  }

  // The target named a framework, and it is not this one.
  const targetNamedAFramework = FRAMEWORKS.some(
    (r) => r.framework !== fw && r.targetAliases.test(target),
  ) || /\b(android|ios|swiftui|jetpack|compose|spring|django|rails|next|nuxt|laravel)\b/i.test(target);

  if (targetNamedAFramework) {
    return {
      multiplier: 0.2,
      reason: `built for ${fw}; not consumable from a ${target.split(/\s+/).slice(0, 2).join(" ")} project`,
    };
  }

  // Target stack is vague. Reduce, but do not bury it — we may simply not have been told.
  return {
    multiplier: 0.55,
    reason: `built for ${fw}; verify your project can consume it`,
  };
}
