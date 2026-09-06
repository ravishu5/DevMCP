import { describe, it, expect } from "vitest";
import { detectHostFramework, hostFrameworkPenalty } from "../../src/analyzers/host-framework.js";
import { collectEvidence } from "../../src/ranking/evidence.js";
import { refFromFullName } from "../../src/providers/github/types.js";
import type { Dependency, RepoMetadata } from "../../src/types/index.js";

const md = (fullName: string, over: Partial<RepoMetadata> = {}): RepoMetadata => ({
  ref: refFromFullName(fullName), topics: [], stars: 100, forks: 10, watchers: 5,
  openIssues: 2, isFork: false, archived: false, language: "Kotlin",
  pushedAt: new Date().toISOString(), ...over,
});

const dep = (name: string, scope: Dependency["scope"] = "runtime"): Dependency =>
  ({ name, ecosystem: "npm", scope, declaredIn: "package.json" });

describe("host framework detection", () => {
  it("detects React Native despite a Kotlin primary language", () => {
    /*
     * The bug this exists for: GitHub reports `react-native-blob-courier` as **Kotlin**,
     * because 47% of its bytes are the Android native shim. It therefore scored a perfect
     * 1.00 stack match against a native Kotlin/Android target and was recommended as a
     * file-upload implementation — despite being unusable without React Native.
     */
    const a = detectHostFramework({
      metadata: md("edeckers/react-native-blob-courier", {
        language: "Kotlin",
        description: "Use this library to efficiently download and upload blobs in React Native",
        topics: ["android", "ios", "kotlin", "react-native", "upload"],
      }),
    });
    expect(a.framework).toBe("react-native");
    expect(a.confidence).toBeGreaterThan(0.8);
  });

  it("detects Flutter, Cordova, Capacitor, NativeScript and Xamarin", () => {
    const cases: [string, string, string[], string][] = [
      ["someone/flutter_downloader", "A plugin for download tasks", ["flutter", "dart"], "flutter"],
      ["apache/cordova-plugin-camera", "Apache Cordova camera plugin", ["cordova"], "cordova"],
      ["ionic-team/capacitor-filesystem", "Capacitor filesystem plugin", ["capacitor"], "capacitor"],
      ["nstudio/nativescript-camera", "NativeScript camera", ["nativescript"], "nativescript"],
      ["xamarin/Xamarin.Essentials", "Xamarin cross-platform APIs", ["xamarin"], "xamarin"],
    ];
    for (const [name, description, topics, expected] of cases) {
      expect(detectHostFramework({ metadata: md(name, { description, topics }) }).framework, name).toBe(expected);
    }
  });

  it("classifies a genuinely native library as native", () => {
    for (const [name, description, topics] of [
      ["GetStream/stream-chat-android", "Android Chat SDK", ["android", "kotlin", "chat"]],
      ["square/okhttp", "An HTTP client for Android and Java", ["android", "kotlin", "http"]],
      ["gotev/android-upload-service", "Android library to upload files", ["android", "upload"]],
    ] as [string, string, string[]][]) {
      expect(detectHostFramework({ metadata: md(name, { description, topics }) }).framework, name).toBe("native");
    }
  });

  it("refines from dependencies when metadata is thin", () => {
    const a = detectHostFramework({
      metadata: md("someone/blob-thing", { topics: [], description: "" }),
      dependencies: [dep("react-native", "dev"), dep("@react-native/eslint-config", "dev")],
    });
    expect(a.framework).toBe("react-native");
  });

  it("says unknown rather than guessing when there is nothing to go on", () => {
    const a = detectHostFramework({ metadata: md("a/b", { topics: [], description: "", language: undefined }) });
    expect(a.framework).toBe("unknown");
    expect(a.confidence).toBeLessThan(0.3);
  });
});

describe("host framework penalty", () => {
  const rn = detectHostFramework({
    metadata: md("edeckers/react-native-blob-courier", {
      description: "upload blobs in React Native", topics: ["react-native", "kotlin"],
    }),
  });

  it("penalises hard when the target names a different framework", () => {
    const p = hostFrameworkPenalty(rn, ["Android", "Kotlin"]);
    expect(p.multiplier).toBeLessThanOrEqual(0.2);
    expect(p.reason).toMatch(/react-native/);
  });

  it("does not penalise when the target IS that framework", () => {
    expect(hostFrameworkPenalty(rn, ["React Native", "TypeScript"]).multiplier).toBe(1);
    expect(hostFrameworkPenalty(rn, ["Expo"]).multiplier).toBe(1);
  });

  it("softens the penalty when the target stack is vague", () => {
    // Being wrong in this direction hides a usable library, so guess gently.
    const p = hostFrameworkPenalty(rn, ["TypeScript"]);
    expect(p.multiplier).toBeGreaterThan(0.2);
    expect(p.multiplier).toBeLessThan(1);
  });

  it("never penalises a native repository", () => {
    const native = detectHostFramework({
      metadata: md("square/okhttp", { description: "HTTP client", topics: ["android", "kotlin"] }),
    });
    expect(hostFrameworkPenalty(native, ["Android", "Kotlin"]).multiplier).toBe(1);
  });
});

describe("stack match accounts for the host framework", () => {
  const target = { language: "Kotlin", platform: "Android" };

  it("drops a React Native library below the REFERENCE_ONLY threshold", () => {
    const e = collectEvidence({
      metadata: md("edeckers/react-native-blob-courier", {
        language: "Kotlin",
        description: "efficiently download and upload blobs in React Native",
        topics: ["android", "ios", "kotlin", "react-native", "upload"],
      }),
      target, sources: ["github:metadata"],
    });
    // 0.35 is the gate that routes a candidate to REFERENCE_ONLY — exactly right here.
    expect(e.axes.stackMatch.value).toBeLessThan(0.35);
    expect(e.axes.stackMatch.observation).toMatch(/not consumable/i);
  });

  it("leaves a native Android library at full stack match", () => {
    const e = collectEvidence({
      metadata: md("GetStream/stream-chat-android", {
        language: "Kotlin", description: "Android Chat SDK", topics: ["android", "kotlin", "chat"],
      }),
      target, sources: ["github:metadata"],
    });
    expect(e.axes.stackMatch.value).toBeGreaterThan(0.9);
    expect(e.axes.stackMatch.observation).not.toMatch(/not consumable/i);
  });

  it("scores the same React Native library highly for a React Native target", () => {
    const e = collectEvidence({
      metadata: md("edeckers/react-native-blob-courier", {
        language: "TypeScript",
        description: "efficiently download and upload blobs in React Native",
        topics: ["react-native", "upload"],
      }),
      target: { language: "TypeScript", framework: "React Native" },
      sources: ["github:metadata"],
    });
    expect(e.axes.stackMatch.value).toBeGreaterThan(0.8);
  });

  it("works from metadata alone, so it can shape the shortlist", () => {
    // A signal that only exists after deep analysis cannot influence WHO gets analysed.
    const e = collectEvidence({
      metadata: md("someone/flutter_downloader", {
        language: "Dart", description: "download plugin", topics: ["flutter"],
      }),
      target, sources: ["github:metadata"],
    });
    expect(e.axes.stackMatch.value).toBeLessThan(0.35);
  });
});
