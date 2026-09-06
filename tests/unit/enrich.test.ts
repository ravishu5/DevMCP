import { describe, it, expect } from "vitest";
import { enrichAgentFeatures } from "../../src/analyzers/enrich.js";
import type { AgentFeature } from "../../src/types/index.js";

const stack = { language: "Kotlin", platform: "Android" };

describe("agent-supplied decomposition", () => {
  it("pursues a feature the vocabulary has never heard of", () => {
    /*
     * The property the rule-based decomposer could never offer. "Voice note recording"
     * matches no capability, and under the old design it was silently dropped — as
     * "end-to-end encryption" and "internationalisation" were. Now it is searched using
     * the agent's own words, and the caller is told enrichment was unavailable.
     */
    const r = enrichAgentFeatures({
      features: [{
        name: "Voice note recording and playback",
        requirements: ["records compressed audio", "waveform rendering"],
        searchHints: ["Android audio recorder opus", "waveform view Android"],
      }],
      stack,
    });
    expect(r.tasks).toHaveLength(1);
    expect(r.enrichment[0]!.enriched).toBe(false);
    expect(r.tasks[0]!.searchQueries).toContain("Android audio recorder opus");
    expect(r.tasks[0]!.requirementChecklist).toContain("records compressed audio");
    expect(r.tasks[0]!.rationale).toMatch(/not dropped/i);
  });

  it("issues the agent's hints BEFORE the vocabulary's own terms", () => {
    // Our vocabulary has been wrong often enough — "Tink Android" matching a bank,
    // topic:resume matching CV builders — that its output must not outrank the agent's.
    const r = enrichAgentFeatures({
      features: [{
        name: "Encrypted messaging", capability: "encryption",
        searchHints: ["Signal protocol Kotlin", "double ratchet"],
      }],
      stack,
    });
    const q = r.tasks[0]!.searchQueries;
    expect(q[0]).toBe("Signal protocol Kotlin");
    expect(q[1]).toBe("double ratchet");
    // …and the vocabulary still contributes further down.
    expect(q.length).toBeGreaterThan(2);
  });

  it("enriches with platform idioms when the capability is recognised", () => {
    const r = enrichAgentFeatures({
      features: [{ name: "Background job queue", capability: "queue" }],
      stack,
    });
    expect(r.enrichment[0]!.enriched).toBe(true);
    expect(r.tasks[0]!.searchQueries.join(" | ")).toMatch(/WorkManager/);
  });

  it("resolves a capability from the feature name without an explicit id", () => {
    const r = enrichAgentFeatures({
      features: [{ name: "Push notifications" }, { name: "OAuth login" }],
      stack,
    });
    expect(r.enrichment[0]!.capability).toBe("notifications");
    expect(r.enrichment[1]!.capability).toBe("oauth");
  });

  it("honours an explicit capability id over name matching", () => {
    const r = enrichAgentFeatures({
      features: [{ name: "Secret keeping", capability: "encryption" }],
      stack,
    });
    expect(r.enrichment[0]!.capability).toBe("encryption");
  });

  it("ignores an unknown capability id rather than failing", () => {
    const r = enrichAgentFeatures({
      features: [{ name: "Quantum entanglement sync", capability: "not-a-real-capability" }],
      stack,
    });
    expect(r.tasks).toHaveLength(1);
    expect(r.enrichment[0]!.enriched).toBe(false);
  });

  it("puts the agent's requirements ahead of the generic checklist", () => {
    const r = enrichAgentFeatures({
      features: [{
        name: "Resumable downloads", capability: "resume",
        requirements: ["must survive a device reboot"],
      }],
      stack,
    });
    // Ground truth for THIS project comes first; the capability's generic list fills gaps.
    expect(r.tasks[0]!.requirementChecklist[0]).toBe("must survive a device reboot");
    expect(r.tasks[0]!.requirementChecklist.length).toBeGreaterThan(1);
  });

  it("respects a build-from-scratch judgement without spending quota", () => {
    const r = enrichAgentFeatures({
      features: [
        { name: "Company-specific pricing rules", reuse: "build-from-scratch" },
        { name: "Push notifications" },
      ],
      stack,
    });
    expect(r.tasks).toHaveLength(1);
    expect(r.skipped[0]!.feature).toBe("Company-specific pricing rules");
    expect(r.skipped[0]!.reason).toMatch(/calling agent/i);
  });

  it("orders features so declared dependencies come first", () => {
    const features: AgentFeature[] = [
      { name: "Chat", dependsOn: ["Local database", "WebSocket transport"] },
      { name: "WebSocket transport", dependsOn: ["Local database"] },
      { name: "Local database" },
    ];
    const order = enrichAgentFeatures({ features, stack }).tasks.map((t) => t.feature);
    expect(order.indexOf("Local database")).toBeLessThan(order.indexOf("WebSocket transport"));
    expect(order.indexOf("WebSocket transport")).toBeLessThan(order.indexOf("Chat"));
  });

  it("does not hang on a circular dependency declaration", () => {
    const features: AgentFeature[] = [
      { name: "A", dependsOn: ["B"] },
      { name: "B", dependsOn: ["A"] },
    ];
    expect(enrichAgentFeatures({ features, stack }).tasks).toHaveLength(2);
  });

  it("always searches the agent's own feature name", () => {
    const r = enrichAgentFeatures({
      features: [{ name: "Right-to-left internationalisation", capability: "i18n" }],
      stack,
    });
    // The agent's words are never replaced by a taxonomy label.
    expect(r.tasks[0]!.searchQueries.join(" | ")).toMatch(/Right-to-left internationalisation/i);
  });

  it("handles an empty feature list", () => {
    const r = enrichAgentFeatures({ features: [], stack });
    expect(r.tasks).toEqual([]);
    expect(r.skipped).toEqual([]);
  });
});
