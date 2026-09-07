import { describe, it, expect } from "vitest";
import { decomposeRequirement } from "../../src/analyzers/decompose.js";
import { planImplementations } from "../../src/analyzers/planner.js";
import { generateQueriesDetailed, generateQueries } from "../../src/analyzers/query.js";
import { CAPABILITIES, CAPABILITY_BY_ID, findStackIdioms, STACK_IDIOMS } from "../../src/knowledge/vocabulary.js";

describe("vocabulary integrity", () => {
  it("has unique, stable capability ids", () => {
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it("every `implies` target exists", () => {
    for (const c of CAPABILITIES) {
      for (const dep of c.implies ?? []) {
        expect(CAPABILITY_BY_ID.has(dep), `${c.id} implies unknown ${dep}`).toBe(true);
      }
    }
  });

  it("every capability carries search terms and a checklist", () => {
    for (const c of CAPABILITIES) {
      expect(c.searchTerms.length, `${c.id} has no search terms`).toBeGreaterThan(0);
      expect(c.checklist.length, `${c.id} has no checklist`).toBeGreaterThan(0);
      expect(c.triggers.length).toBeGreaterThan(0);
    }
  });

  it("every stack idiom references a real capability", () => {
    for (const s of STACK_IDIOMS) {
      for (const capId of Object.keys(s.idioms)) {
        expect(CAPABILITY_BY_ID.has(capId), `${s.match[0]} idiom for unknown ${capId}`).toBe(true);
      }
    }
  });

  it("matches stacks from loose hints", () => {
    expect(findStackIdioms("Kotlin", "Android")?.language).toBe("Kotlin");
    expect(findStackIdioms(undefined, "Next.js")?.language).toBe("TypeScript");
    expect(findStackIdioms("Swift")?.language).toBe("Swift");
    expect(findStackIdioms("COBOL")).toBeUndefined();
  });
});

describe("decomposition", () => {
  const ANDROID_REQ =
    "Build an Android app that downloads media from a messaging service with background downloads, " +
    "pause/resume, a download queue, progress notification, retry and persistent state";

  it("detects every capability in a realistic sentence with punctuation", () => {
    const d = decomposeRequirement({ requirement: ANDROID_REQ, stack: { language: "Kotlin", platform: "Android" } });
    // Regression: punctuation used to leave tokens like "queue," that matched nothing.
    for (const expected of ["download", "resume", "queue", "retry", "background-execution", "notifications", "persistence"]) {
      expect(d.explicit, `missing ${expected}`).toContain(expected);
    }
  });

  it("matches morphological variants consistently in both directions", () => {
    for (const [a, b] of [
      ["retries failed requests", "retry failed requests"],
      ["caching layer", "cache layer"],
      ["queues jobs", "queue jobs"],
      ["downloads files", "download files"],
    ]) {
      expect(decomposeRequirement({ requirement: a }).explicit)
        .toEqual(decomposeRequirement({ requirement: b }).explicit);
    }
  });

  it("does not match capability names inside unrelated words", () => {
    for (const text of ["the author wrote a book", "asynchronous processing", "classroom management"]) {
      expect(decomposeRequirement({ requirement: text }).explicit).toEqual([]);
    }
  });

  it("adds implied capabilities and reports them separately", () => {
    const d = decomposeRequirement({ requirement: "I need pause and resume for transfers" });
    expect(d.explicit).toContain("resume");
    expect(d.implied).toContain("persistence"); // cannot resume without remembering an offset
    expect(d.explicit).not.toContain("persistence");
  });

  it("resolves multi-hop implication closure without looping", () => {
    // realtime-collab -> websocket + offline-sync -> retry + persistence: two hops deep.
    // "realtime" also triggers websocket directly, so the closure must reach further:
    // offline-sync and persistence are only reachable transitively.
    const d = decomposeRequirement({ requirement: "realtime collaborative editing with presence" });
    expect(d.explicit).toContain("realtime-collab");
    expect(d.implied).toContain("offline-sync");
    expect(d.implied).toContain("persistence");
    // An id may be explicit or implied, never both.
    expect(d.explicit.filter((e) => d.implied.includes(e))).toEqual([]);
  });

  it("returns ambiguity rather than guessing", () => {
    const d = decomposeRequirement({ requirement: "build a widget frobnicator with quantum resonance" });
    expect(d.units).toHaveLength(0);
    expect(d.unrecognised.length).toBeGreaterThan(0);
  });

  it("ranks foundational capabilities above peripheral ones", () => {
    const d = decomposeRequirement({ requirement: "app with login, a database, and analytics tracking" });
    const byId = new Map(d.units.map((u) => [u.id, u]));
    expect(byId.get("persistence")!.priority).toBeGreaterThan(byId.get("analytics")!.priority);
  });

  it("merges caller-supplied requirements ahead of the generic checklist", () => {
    const d = decomposeRequirement({
      requirement: "resumable downloads",
      requirements: ["must resume after device reboot"],
    });
    const resume = d.units.find((u) => u.id === "resume")!;
    expect(resume.requirements[0]).toBe("must resume after device reboot");
  });

  it("prefers stack idioms in search terms", () => {
    const d = decomposeRequirement({
      requirement: "background processing", stack: { language: "Kotlin", platform: "Android" },
    });
    const unit = d.units.find((u) => u.id === "background-execution")!;
    expect(unit.searchTerms[0]).toBe("WorkManager");
  });

  it("gives a different vocabulary for a different stack", () => {
    const android = decomposeRequirement({ requirement: "background processing", stack: { language: "Kotlin", platform: "Android" } });
    const node = decomposeRequirement({ requirement: "background processing", stack: { language: "TypeScript", framework: "Next.js" } });
    expect(android.units[0]!.searchTerms[0]).not.toBe(node.units[0]!.searchTerms[0]);
    expect(node.units.find((u) => u.id === "background-execution")!.searchTerms).toContain("BullMQ");
  });
});

describe("primary capability detection", () => {
  /**
   * Regression suite for the Phase 6 bug: a discovery request for a downloader returned a
   * Room *database* library, because the pipeline pursued the highest-BUILD-priority
   * capability (persistence, foundational) instead of the subject of the sentence.
   */
  const cases: [string, string][] = [
    ["resumable background file downloader with pause and retry", "download"],
    ["background downloads", "download"],
    ["OAuth login with Google", "oauth"],
    ["WebSocket reconnection with exponential backoff", "websocket"],
    ["persistent job queue", "queue"],
    ["a caching layer for API responses", "caching"],
    ["push notifications with deep linking", "notifications"],
    ["image loading library with disk cache", "image-loading"],
    ["realtime collaborative editing", "realtime-collab"],
    ["chat messaging with offline support", "messaging"],
  ];

  for (const [requirement, expected] of cases) {
    it(`"${requirement}" → ${expected}`, () => {
      expect(decomposeRequirement({ requirement, stack: { language: "Kotlin" } }).primary).toBe(expected);
    });
  }

  it("ignores capabilities that appear only in the requirements list", () => {
    // "persistent queue" as a REQUIREMENT must not make a downloader request into a
    // database request — this is the exact shape of the original bug.
    const d = decomposeRequirement({
      requirement: "resumable background file downloader",
      requirements: ["persistent queue", "retry"],
      stack: { language: "Kotlin" },
    });
    expect(d.primary).toBe("download");
    expect(d.explicit).toContain("persistence");   // still detected, just not the subject
  });

  it("prefers the narrower capability when two overlap", () => {
    expect(decomposeRequirement({ requirement: "OAuth login" }).primary).toBe("oauth");
    expect(decomposeRequirement({ requirement: "user login and sessions" }).primary).toBe("auth-session");
  });

  it("treats everything after a qualifier as a modifier, not the subject", () => {
    expect(decomposeRequirement({ requirement: "downloader with retry" }).primary).toBe("download");
    expect(decomposeRequirement({ requirement: "retry with downloads" }).primary).toBe("retry");
  });

  it("returns undefined when nothing is recognised", () => {
    expect(decomposeRequirement({ requirement: "frobnicate the widgets" }).primary).toBeUndefined();
  });
});

describe("implementation planner", () => {
  const plan = (req: string, stack = { language: "Kotlin", platform: "Android" }) => {
    const d = decomposeRequirement({ requirement: req, stack });
    return planImplementations({ units: d.units, stack, totalQueryBudget: 18 });
  };

  it("turns features into what KIND of implementation to look for", () => {
    const p = plan("resumable background downloads with a queue");
    const resume = p.tasks.find((t) => t.featureId === "resume")!;
    expect(resume.lookingFor.join(" ")).toMatch(/Range|resumable transfer/i);
    const queue = p.tasks.find((t) => t.featureId === "queue")!;
    expect(queue.lookingFor.join(" ")).toMatch(/persistent job queue/i);
  });

  it("assigns a strategy per feature, not one policy for all", () => {
    const p = plan("app with a database, oauth login, and realtime collaboration");
    const strategies = new Set(p.tasks.map((t) => t.strategy));
    expect(strategies.size).toBeGreaterThan(1);
    expect(p.tasks.find((t) => t.featureId === "persistence")?.strategy).toBe("reuse-library");
    expect(p.tasks.find((t) => t.featureId === "realtime-collab")?.strategy).toBe("study-reference");
  });

  it("allocates more query budget to foundational, high-reuse features", () => {
    const p = plan("app with a database and analytics tracking");
    const db = p.tasks.find((t) => t.featureId === "persistence")!;
    const an = p.tasks.find((t) => t.featureId === "analytics")!;
    expect(db.budgetShare).toBeGreaterThan(an.budgetShare);
  });

  it("budget shares sum to approximately 1", () => {
    const p = plan("downloads, queue, retry, notifications, database, oauth");
    const sum = p.tasks.reduce((a, t) => a + t.budgetShare, 0);
    expect(sum).toBeGreaterThan(0.9);
    expect(sum).toBeLessThan(1.1);
  });

  it("gives every planned task at least one query", () => {
    const p = plan("downloads, queue, retry, notifications, database, oauth, payments, search, i18n");
    for (const t of p.tasks) expect(t.searchQueries.length).toBeGreaterThan(0);
  });

  it("orders tasks so dependencies come first", () => {
    const p = plan("messaging with offline support");
    const index = new Map(p.tasks.map((t, i) => [t.featureId, i]));
    for (const t of p.tasks) {
      for (const dep of t.dependsOn) {
        if (index.has(dep)) expect(index.get(dep)!).toBeLessThan(index.get(t.featureId)!);
      }
    }
  });

  it("respects a small total query budget", () => {
    const d = decomposeRequirement({ requirement: "downloads, queue, retry, notifications, database" });
    const p = planImplementations({ units: d.units, totalQueryBudget: 5 });
    const total = p.tasks.reduce((a, t) => a + t.searchQueries.length, 0);
    // Every task gets a floor of 1, so the total cannot be below the task count.
    expect(total).toBeLessThanOrEqual(Math.max(5, p.tasks.length) + 2);
  });

  it("explains its reasoning for every task", () => {
    for (const t of plan("downloads with retry").tasks) {
      expect(t.rationale.length).toBeGreaterThan(20);
    }
  });
});

describe("feature selection under a budget", () => {
  /**
   * Regression: `runPlan` with maxFeatures=3 took the first three tasks in BUILD order —
   * persistence, resume, retry — and skipped "File downloading" and "Job / task queue"
   * entirely, for a request that was explicitly about downloading. Build order is correct
   * for building; it is the wrong axis for deciding what to spend search quota on.
   */
  it("selects by priority, then restores build order", () => {
    const d = decomposeRequirement({
      requirement: "Android app that downloads media with background downloads, pause/resume, a download queue and progress notifications",
      stack: { language: "Kotlin", platform: "Android" },
    });
    const p = planImplementations({ units: d.units, stack: { language: "Kotlin" }, totalQueryBudget: 20 });

    const chosen = [...p.tasks].sort((a, b) => b.priority - a.priority).slice(0, 3);
    const chosenIds = new Set(chosen.map((t) => t.featureId));
    const ordered = p.tasks.filter((t) => chosenIds.has(t.featureId));

    // The subject of the sentence must survive a tight budget.
    expect(chosenIds.has("download")).toBe(true);
    // And the survivors must still be in dependency order.
    const index = new Map(ordered.map((t, i) => [t.featureId, i]));
    for (const t of ordered) {
      for (const dep of t.dependsOn) {
        if (index.has(dep)) expect(index.get(dep)!).toBeLessThan(index.get(t.featureId)!);
      }
    }
  });

  it("build order alone would have dropped the primary feature", () => {
    // Demonstrates the bug this guards against, so the guard cannot be removed casually.
    const d = decomposeRequirement({
      requirement: "Android app that downloads media with background downloads, pause/resume, a download queue and progress notifications",
      stack: { language: "Kotlin", platform: "Android" },
    });
    const p = planImplementations({ units: d.units, stack: { language: "Kotlin" }, totalQueryBudget: 20 });
    const firstThreeByBuildOrder = p.tasks.slice(0, 3).map((t) => t.featureId);
    const topThreeByPriority = [...p.tasks].sort((a, b) => b.priority - a.priority).slice(0, 3).map((t) => t.featureId);
    expect(topThreeByPriority).toContain("download");
    expect(firstThreeByBuildOrder).not.toEqual(topThreeByPriority);
  });
});

describe("query generation", () => {
  const idioms = findStackIdioms("Kotlin", "Android");

  it("puts stack idioms first — they find implementations, not tutorials", () => {
    const qs = generateQueriesDetailed({
      feature: "Background execution", capabilityId: "background-execution",
      stack: { language: "Kotlin" }, idioms, limit: 4,
    });
    expect(qs[0]!.shape).toBe("stack-idiom");
    expect(qs[0]!.query).toBe("WorkManager");
  });

  it("surfaces domain terms the user would not have known to search for", () => {
    const qs = generateQueries({ feature: "Resumable transfer", capabilityId: "resume", limit: 4 });
    expect(qs.join(" | ")).toContain("HTTP Range request");
  });

  it("maximises shape diversity rather than taking top-N precision", () => {
    const qs = generateQueriesDetailed({
      feature: "Background execution", capabilityId: "background-execution",
      idioms, stack: { language: "Kotlin" }, limit: 4,
    });
    // Three high-precision idioms exist, but the mix must cover other shapes too.
    expect(new Set(qs.map((q) => q.shape)).size).toBeGreaterThanOrEqual(3);
  });

  it("never returns duplicates", () => {
    const qs = generateQueries({ feature: "caching", capabilityId: "caching", limit: 10 });
    expect(new Set(qs).size).toBe(qs.length);
  });

  it("always returns at least one query, even for an unknown capability", () => {
    expect(generateQueries({ feature: "frobnicator", limit: 3 }).length).toBeGreaterThan(0);
  });

  it("respects the limit", () => {
    for (const limit of [1, 2, 5]) {
      expect(generateQueries({ feature: "downloads", capabilityId: "download", idioms, limit }).length)
        .toBeLessThanOrEqual(limit);
    }
  });

  it("emits well-formed topic qualifiers", () => {
    const qs = generateQueriesDetailed({ feature: "Job / task queue", capabilityId: "queue", limit: 6 });
    const topic = qs.find((q) => q.shape === "topic");
    expect(topic?.query).toMatch(/^topic:[a-z0-9-]+$/);
  });
});

describe("a declared vendor gets its own SDK query", () => {
  /*
   * A feature query cannot find the library that implements it. stripe/stripe-node is
   * described "Node.js library for the Stripe API." -- no "webhook", no "subscription",
   * no "billing" in its name, description or topics. Searching "Stripe webhooks Node" and
   * "stripe subscriptions TypeScript" returned 58 candidates without it.
   */
  it("emits the BARE vendor name, because every added word narrows it away", () => {
    const qs = generateQueriesDetailed({
      feature: "Stripe subscription billing with webhook handling",
      capabilityId: "payments",
      stack: { language: "TypeScript" },
      mustMention: ["Stripe"],
      limit: 6,
    });
    const vendor = qs.filter((q) => q.shape === "vendor-sdk").map((q) => q.query);
    /*
     * GitHub ANDs every term and the provider already appends `language:`. "Stripe
     * TypeScript sdk" therefore requires "typescript" AND "sdk" in the name, description or
     * topics -- which stripe-node has in neither. `stripe language:TypeScript` returns it
     * first.
     */
    expect(vendor).toContain("Stripe");
    expect(vendor.join(" ")).not.toMatch(/typescript/i);
  });

  it("ranks the vendor query ahead of the generic feature-name query", () => {
    // Ordering alone decided this: with two agent hints plus the generic query filling a
    // budget of three, the vendor query was generated and then sliced off the end.
    const qs = generateQueriesDetailed({
      feature: "Stripe subscription billing with webhook handling",
      capabilityId: "payments",
      stack: { language: "TypeScript" },
      mustMention: ["Stripe"],
      limit: 3,
    }).map((q) => q.shape);
    expect(qs).toContain("vendor-sdk");
  });

  it("emits nothing when no vendor was declared", () => {
    const qs = generateQueriesDetailed({
      feature: "Background job queue", capabilityId: "queue",
      stack: { language: "TypeScript" }, limit: 6,
    });
    expect(qs.some((q) => q.shape === "vendor-sdk")).toBe(false);
  });
});
