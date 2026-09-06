import { describe, it, expect } from "vitest";
import { classifyTargetStack, deploymentPenalty, detectDeploymentTarget } from "../../src/analyzers/deployment.js";
import { collectEvidence } from "../../src/ranking/evidence.js";
import { refFromFullName } from "../../src/providers/github/types.js";
import type { Dependency, RepoMetadata } from "../../src/types/index.js";

const md = (fullName: string, description: string, topics: string[] = []): RepoMetadata => ({
  ref: refFromFullName(fullName), topics, description, language: "Kotlin",
  stars: 100, forks: 10, watchers: 5, openIssues: 2, isFork: false, archived: false,
  pushedAt: new Date().toISOString(),
});

const dep = (name: string, scope: Dependency["scope"] = "runtime"): Dependency =>
  ({ name, ecosystem: "gradle", scope, declaredIn: "build.gradle" });

describe("deployment target detection", () => {
  it("classifies a PostgreSQL-backed queue as server-side", () => {
    // vgv/kolbasa scored 78 and won "persistent job queue" for an Android app. It is
    // Kotlin, it is a library, it is unambiguously a job queue — and it needs a database
    // connection. Every other signal said yes.
    const a = detectDeploymentTarget({
      metadata: md("vgv/kolbasa", "A reliable message & job queue for Java & Kotlin, built on PostgreSQL",
        ["postgres", "postgresql", "job-queue", "kotlin"]),
      dependencies: [dep("org.postgresql:postgresql"), dep("io.prometheus:prometheus-metrics-exporter-httpserver")],
    });
    expect(a.target).toBe("server");
    expect(a.confidence).toBeGreaterThan(0.5);
  });

  it("weighs dependencies above topics, because topics say what it TALKS TO", () => {
    /*
     * bloomberg/pushiko is tagged `android` and `ios` — those are the notification
     * DESTINATIONS. It runs on Netty. Weighting topics like dependencies would classify it
     * client-side, which is precisely the mistake: the app needs to RECEIVE push, and this
     * library SENDS it.
     */
    const a = detectDeploymentTarget({
      metadata: md("bloomberg/pushiko", "A JVM library for sending push notifications via APNs and FCM",
        ["android", "apns", "fcm", "ios", "jvm", "kotlin"]),
      dependencies: [dep("io.netty:netty-all"), dep("org.slf4j:slf4j-api")],
    });
    expect(a.target).toBe("server");
  });

  it("classifies Android and iOS libraries as client-side", () => {
    for (const [name, description, topics, deps] of [
      ["gotev/android-upload-service", "Easily upload files in the background", ["android", "upload"], ["androidx.appcompat:appcompat"]],
      ["coil-kt/coil", "Image loading for Android and Compose Multiplatform", ["android", "compose"], ["libs.compose.foundation"]],
    ] as [string, string, string[], string[]][]) {
      const a = detectDeploymentTarget({
        metadata: md(name, description, topics),
        dependencies: deps.map((d) => dep(d)),
      });
      expect(a.target, name).toBe("client");
    }
  });

  it("calls a genuinely multiplatform library universal, not a mismatch", () => {
    const a = detectDeploymentTarget({
      metadata: md("some/kmp-thing", "Kotlin Multiplatform library for client and server", ["kotlin", "android", "backend"]),
      dependencies: [dep("androidx.core:core-ktx"), dep("io.ktor:ktor-server-core")],
    });
    expect(a.target).toBe("universal");
    expect(deploymentPenalty(a, "client").multiplier).toBe(1);
  });

  it("does not let a weak counter-signal flip a strong classification", () => {
    // A runtime dependency on AndroidX says where the code RUNS; a stray "backend" topic
    // does not outweigh it.
    const a = detectDeploymentTarget({
      metadata: md("a/b", "A library", ["kotlin", "backend"]),
      dependencies: [dep("androidx.core:core-ktx")],
    });
    expect(a.target).toBe("client");
    expect(deploymentPenalty(a, "client").multiplier).toBe(1);
  });

  it("never penalises on a single weak signal", () => {
    // One topic is not enough to demote anything.
    const weak = detectDeploymentTarget({ metadata: md("a/b", "A library", ["backend"]) });
    expect(deploymentPenalty(weak, "client").multiplier).toBe(1);
  });

  it("returns unknown with no evidence at all", () => {
    const a = detectDeploymentTarget({ metadata: md("a/b", "", []) });
    expect(a.target).toBe("unknown");
    expect(a.confidence).toBeLessThan(0.2);
  });
});

describe("classifying the consuming project", () => {
  it("recognises mobile and browser targets as client-side", () => {
    for (const t of [["Android", "Kotlin"], ["iOS"], ["React Native"], ["browser"]]) {
      expect(classifyTargetStack(t), t.join(" ")).toBe("client");
    }
  });

  it("recognises server frameworks as server-side", () => {
    for (const t of [["Spring Boot"], ["Django"], ["Express"], ["backend"]]) {
      expect(classifyTargetStack(t), t.join(" ")).toBe("server");
    }
  });

  it("says unknown when the stack is not stated", () => {
    expect(classifyTargetStack([])).toBe("unknown");
    expect(classifyTargetStack(["Kotlin"])).toBe("unknown");
  });
});

describe("the penalty only fires when both sides are known and disagree", () => {
  const server = detectDeploymentTarget({
    metadata: md("vgv/kolbasa", "job queue built on PostgreSQL", ["postgresql"]),
    dependencies: [dep("org.postgresql:postgresql")],
  });

  it("penalises a server library for a client project", () => {
    const p = deploymentPenalty(server, "client");
    expect(p.multiplier).toBeLessThanOrEqual(0.25);
    expect(p.reason).toMatch(/server-side.*client-side/);
  });

  it("does not penalise a server library for a server project", () => {
    expect(deploymentPenalty(server, "server").multiplier).toBe(1);
  });

  it("does not penalise when the target side is unknown", () => {
    expect(deploymentPenalty(server, "unknown").multiplier).toBe(1);
  });
});

describe("stack match applies the deployment gate", () => {
  it("drops a server-side library below the REFERENCE_ONLY threshold for an Android target", () => {
    const e = collectEvidence({
      metadata: md("vgv/kolbasa", "A reliable message & job queue for Java & Kotlin, built on PostgreSQL",
        ["postgres", "job-queue", "kotlin"]),
      dependencies: [dep("org.postgresql:postgresql")],
      target: { language: "Kotlin", platform: "Android" },
      sources: ["github:metadata"],
    });
    expect(e.axes.stackMatch.value).toBeLessThan(0.35);
    expect(e.axes.stackMatch.observation).toMatch(/server-side/);
  });

  it("leaves an Android library at full stack match", () => {
    const e = collectEvidence({
      metadata: md("gotev/android-upload-service", "Easily upload files in the background", ["android", "upload"]),
      dependencies: [dep("androidx.appcompat:appcompat")],
      target: { language: "Kotlin", platform: "Android" },
      sources: ["github:metadata"],
    });
    expect(e.axes.stackMatch.value).toBeGreaterThan(0.9);
    expect(e.axes.stackMatch.observation).not.toMatch(/server-side/);
  });
});
