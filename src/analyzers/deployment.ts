/**
 * Deployment target: does this code run on the CLIENT or on a SERVER?
 *
 * The third axis of "can I actually use this", after language and host framework — and the
 * one that a Kotlin/Android target is most often fooled by, because a JVM server library
 * and an Android library are both "Kotlin".
 *
 * Two real misses motivated this:
 *
 *   vgv/kolbasa      "A reliable message & job queue for Java & Kotlin, built on
 *                     PostgreSQL" — scored 78 and won "persistent job queue" for an
 *                     Android app. It requires a PostgreSQL connection.
 *   bloomberg/pushiko "A JVM library for SENDING push notifications via APNs/FCM" — the
 *                     app needs to RECEIVE them. Opposite side of the wire.
 *
 * Both are Kotlin, both are libraries, both are unambiguously about the right domain.
 * Every existing signal said yes.
 *
 * The discriminator is where the code RUNS, and dependencies say that far more reliably
 * than topics do. `pushiko` is tagged `android` and `ios` because those are what it sends
 * notifications TO; it depends on Netty because that is what it runs ON. So dependency
 * evidence outweighs topic evidence — and the classification stays `unknown` unless one
 * side clearly dominates, because a wrong penalty here silently buries a correct library.
 */

import type { Dependency, RepoMetadata } from "../types/index.js";

export type DeploymentTarget = "client" | "server" | "universal" | "unknown";

export interface DeploymentAssessment {
  target: DeploymentTarget;
  confidence: number;
  signals: string[];
}

/** Dependencies that only client-side code carries. */
const CLIENT_DEPS: [RegExp, string][] = [
  [/^androidx[.:]|^com\.google\.android|^com\.android\.tools/i, "AndroidX / Android SDK"],
  [/compose[.-]?(ui|foundation|material|runtime)|jetbrains\.compose/i, "Jetpack/Multiplatform Compose"],
  [/^com\.google\.firebase:firebase-(messaging|analytics|crashlytics)/i, "Firebase client SDK"],
  [/\b(swiftui|uikit|alamofire|kingfisher|snapkit)\b/i, "iOS UI frameworks"],
  [/^react($|[-/])|^react-dom$|^vue$|^@angular\//i, "browser UI frameworks"],
  [/^(coil|glide|picasso)\b/i, "mobile image loading"],
];

/** Dependencies that only server-side code carries. */
const SERVER_DEPS: [RegExp, string][] = [
  [/\bnetty\b|\bundertow\b|\btomcat\b|\bjetty\b/i, "a server networking stack"],
  [/^org\.postgresql|\bpostgresql\b|\bmysql-connector\b|\bjdbc\b|\bhikari\b/i, "a database driver"],
  [/spring-boot|spring-web|\bmicronaut\b|\bquarkus\b|\bvertx\b|\bjavalin\b|\bhttp4k\b/i, "a server framework"],
  [/ktor-server|\bexposed-core\b/i, "a server framework"],
  [/\bkafka-clients\b|\brabbitmq\b|\bjedis\b|\blettuce-core\b|\bmongodb-driver\b/i, "server infrastructure clients"],
  [/prometheus-metrics-exporter|opentelemetry-exporter/i, "server metrics exporters"],
  [/^express$|^fastify$|^koa$|^nestjs\//i, "a Node server framework"],
  [/^django$|^flask$|^fastapi$|^gunicorn$|^celery$/i, "a Python server framework"],
];

/** Phrases that place a repository on one side of the wire. */
const CLIENT_PHRASES = /\b(for android|android library|ios library|mobile app|on-device|client.?side|in your app)\b/i;
const SERVER_PHRASES = /\b(jvm library|server.?side|backend|micro.?service|self.?hosted|for your server|server library)\b/i;

const CLIENT_TOPICS = /\b(android|androidx|ios|swiftui|jetpack-compose|mobile|flutter|react-native|browser|frontend)\b/i;
const SERVER_TOPICS = /\b(backend|server|microservice|microservices|spring-boot|postgres|postgresql|mysql|kafka|redis|jvm-server)\b/i;

export interface DeploymentInput {
  metadata: RepoMetadata;
  dependencies?: Dependency[];
  filePaths?: string[];
}

export function detectDeploymentTarget(input: DeploymentInput): DeploymentAssessment {
  const md = input.metadata;
  // Phrases are matched against name and description ONLY. Including topics here double-
  // counted them — a lone `backend` topic scored once as a phrase and once as a topic,
  // reaching the threshold on a single weak signal and demoting the repository.
  const prose = `${md.ref.name} ${md.description ?? ""}`;
  const topics = md.topics.join(" ");
  const deps = (input.dependencies ?? [])
    .filter((d) => d.scope === "runtime" || d.scope === "peer")
    .map((d) => d.name);
  const files = input.filePaths ?? [];

  const signals: string[] = [];
  let client = 0;
  let server = 0;

  // --- dependencies: where the code RUNS. Weighted highest. ------------------
  for (const [re, label] of CLIENT_DEPS) {
    if (deps.some((d) => re.test(d))) { client += 3; signals.push(`+ depends on ${label}`); break; }
  }
  for (const [re, label] of SERVER_DEPS) {
    if (deps.some((d) => re.test(d))) { server += 3; signals.push(`- depends on ${label}`); break; }
  }

  // --- files ----------------------------------------------------------------
  if (files.some((f) => /AndroidManifest\.xml$|\.xcodeproj\/|Info\.plist$/i.test(f))) {
    client += 2; signals.push("+ platform manifest present");
  }
  if (files.some((f) => /(^|\/)src\/main\/resources\/application\.(ya?ml|properties)$/i.test(f))) {
    server += 2; signals.push("- Spring-style server configuration");
  }

  // --- description phrases --------------------------------------------------
  if (CLIENT_PHRASES.test(prose)) { client += 2; signals.push("+ described as client-side"); }
  if (SERVER_PHRASES.test(prose)) { server += 2; signals.push("- described as server-side"); }

  // --- topics: what it TALKS TO. Weakest, and deliberately so. ---------------
  //
  // `pushiko` is tagged android and ios because those are its notification *destinations*;
  // it runs on Netty. Weighting topics like dependencies would classify it as a client
  // library, which is exactly the mistake being fixed.
  if (CLIENT_TOPICS.test(topics)) { client += 1; }
  if (SERVER_TOPICS.test(topics)) { server += 1; }

  const total = client + server;
  if (total === 0) return { target: "unknown", confidence: 0.1, signals: [] };

  // Both sides well-evidenced: a multiplatform or full-stack library. Not a mismatch.
  if (client >= 3 && server >= 3) {
    return { target: "universal", confidence: 0.5, signals: signals.slice(0, 4) };
  }

  // Require clear dominance. A near-tie is not evidence, and a wrong penalty here silently
  // buries a correct library — worse than the miss it would prevent.
  if (client >= server * 2 && client >= 2) {
    return { target: "client", confidence: Math.min(0.9, 0.4 + client * 0.1), signals: signals.slice(0, 4) };
  }
  if (server >= client * 2 && server >= 2) {
    return { target: "server", confidence: Math.min(0.9, 0.4 + server * 0.1), signals: signals.slice(0, 4) };
  }
  return { target: "unknown", confidence: 0.2, signals: signals.slice(0, 4) };
}

/** Which side is the CONSUMING project on? */
export function classifyTargetStack(descriptors: (string | undefined)[]): DeploymentTarget {
  const text = descriptors.filter(Boolean).join(" ").toLowerCase();
  if (!text) return "unknown";
  if (/\b(android|ios|swiftui|jetpack|compose|mobile|react native|flutter|browser|frontend|web app)\b/.test(text)) {
    return "client";
  }
  if (/\b(spring|django|flask|fastapi|express|nestjs|rails|laravel|ktor server|backend|server|microservice)\b/.test(text)) {
    return "server";
  }
  return "unknown";
}

/**
 * Multiplier for the stack-match score.
 *
 * Only applied when BOTH sides are known and they disagree. "universal" and "unknown"
 * never penalise: a Kotlin Multiplatform library that runs in both places is a legitimate
 * answer, and an unclassifiable repository has not been shown to be wrong.
 */
export function deploymentPenalty(
  assessment: DeploymentAssessment,
  targetSide: DeploymentTarget,
): { multiplier: number; reason?: string } {
  if (assessment.target === "unknown" || assessment.target === "universal") return { multiplier: 1 };
  if (targetSide === "unknown") return { multiplier: 1 };
  if (assessment.target === targetSide) return { multiplier: 1 };
  if (assessment.confidence < 0.5) return { multiplier: 1 };

  return {
    multiplier: 0.25,
    reason: `runs ${assessment.target}-side, but your project is ${targetSide}-side`,
  };
}
