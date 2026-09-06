/**
 * Implementation Planner — the layer between decomposition and discovery.
 *
 * The distinction that makes this worth having:
 *
 *   Decomposer:  "what features does this app contain?"
 *   Planner:     "which features are worth REUSING, and what KIND of existing
 *                 implementation should we go looking for?"
 *
 * Those are different questions with different answers. For "a Telegram-like media
 * downloader" the decomposer yields Authentication, Messaging, Media downloading,
 * Background service, Queue, Notifications, Storage, UI. The planner yields:
 *
 *   Media downloading  → search for mature download engines
 *   Background service → WorkManager / foreground-service patterns
 *   Queue              → persistent job queue implementations
 *   Resume             → HTTP Range / resumable download implementations
 *   Notifications      → foreground service notification patterns
 *   Storage            → scoped storage implementations
 *   UI                 → build from scratch, spend no quota
 *
 * The second list is actionable; the first is just an inventory. Producing the second is
 * what makes discovery precise instead of generic, and it is where the scarce GitHub
 * search budget is actually allocated.
 */

import type { FeatureUnit, ImplementationTask, ReuseStrategy, TargetStack } from "../types/index.js";
import { CAPABILITY_BY_ID, findStackIdioms } from "../knowledge/vocabulary.js";
import { generateQueries } from "./query.js";

export interface PlanInput {
  units: FeatureUnit[];
  stack?: TargetStack;
  /** Total search budget to distribute across tasks. */
  totalQueryBudget?: number;
}

export interface PlanResult {
  tasks: ImplementationTask[];
  /** Units deliberately not searched for, with the reason. */
  skipped: { feature: string; reason: string }[];
  /** How the query budget was allocated, for diagnostics. */
  budgetAllocation: { feature: string; share: number; queries: number }[];
}

/**
 * What kind of artefact is worth finding, per capability.
 *
 * This is the "lookingFor" phrasing that sharpens discovery. It is deliberately about the
 * *shape of the artefact* ("mature download engines with pause/resume") rather than the
 * feature name ("downloading"), because that is what distinguishes a library from a
 * tutorial in a search result.
 */
const LOOKING_FOR: Record<string, string[]> = {
  download: ["mature download engines", "libraries with progress and cancellation", "chunked transfer implementations"],
  resume: ["HTTP Range / resumable transfer implementations", "byte-offset persistence patterns"],
  upload: ["resumable upload clients", "multipart upload implementations"],
  "http-client": ["production HTTP client wrappers", "interceptor/middleware architectures"],
  websocket: ["reconnection state machines", "heartbeat and backoff implementations"],
  retry: ["retry policy implementations", "circuit breaker libraries"],
  "background-execution": ["platform background-work patterns", "foreground service implementations"],
  queue: ["persistent job queue implementations", "durable worker pool patterns"],
  persistence: ["ORM/DAO layers with migrations", "repository pattern implementations"],
  caching: ["multi-level cache implementations", "eviction and invalidation strategies"],
  oauth: ["OAuth2 PKCE client implementations", "token refresh and storage patterns"],
  "auth-session": ["session/JWT auth implementations", "auth middleware patterns"],
  "secure-storage": ["platform keystore wrappers", "encrypted credential stores"],
  messaging: ["chat data-layer implementations", "message ordering and dedup patterns"],
  notifications: ["push notification handling implementations", "notification channel patterns"],
  "media-playback": ["player wrappers with lifecycle handling", "adaptive streaming integrations"],
  "image-loading": ["image loading and caching libraries"],
  "offline-sync": ["offline-first sync engines", "conflict resolution implementations"],
  "realtime-collab": ["CRDT/OT implementations", "presence protocols"],
  payments: ["payment integration implementations", "webhook verification patterns"],
  "search-indexing": ["search index implementations", "ranking and query parsing"],
  "rate-limiting": ["rate limiter implementations", "token bucket algorithms"],
  "state-management": ["state container implementations", "unidirectional data flow patterns"],
  "file-storage": ["scoped/permissioned storage wrappers"],
  "file-parsing": ["streaming format parsers", "robust malformed-input handling"],
  "progress-reporting": ["throttled progress reporting patterns"],
  analytics: ["batched event pipelines", "offline-buffering telemetry clients"],
  validation: ["schema validation libraries"],
  i18n: ["i18n runtime implementations", "pluralisation rule engines"],
  authorization: ["policy/RBAC engines", "permission middleware"],
  "media-processing": ["transcoding pipeline implementations"],
  feed: ["paginated feed implementations", "cursor pagination patterns"],
  "testing-infra": ["test fixture and mock-server harnesses"],
};

export function planImplementations(input: PlanInput): PlanResult {
  const idioms = findStackIdioms(input.stack?.language, input.stack?.framework, input.stack?.platform);
  const tasks: ImplementationTask[] = [];
  const skipped: { feature: string; reason: string }[] = [];

  for (const unit of input.units) {
    const strategy = chooseStrategy(unit);
    if (strategy === "build-from-scratch") {
      skipped.push({
        feature: unit.name,
        reason: reasonForSkipping(unit),
      });
      continue;
    }

    const cap = CAPABILITY_BY_ID.get(unit.id);
    tasks.push({
      featureId: unit.id,
      feature: unit.name,
      strategy,
      lookingFor: LOOKING_FOR[unit.id] ?? [`existing ${unit.name.toLowerCase()} implementations`],
      capabilities: [unit.id, ...(cap?.implies ?? [])],
      requirementChecklist: unit.requirements,
      searchQueries: [],           // filled below, once budget shares are known
      rationale: rationaleFor(unit, strategy),
      budgetShare: 0,
      priority: unit.priority,
      dependsOn: unit.dependsOn,
    });
  }

  // Allocate the query budget by priority x reuse value. A foundational, high-reuse
  // capability deserves more of a 30/min search quota than a peripheral one — spending it
  // evenly would under-search the features that determine the architecture.
  const weights = tasks.map((t) => weightOf(t));
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
  const totalQueries = input.totalQueryBudget ?? tasks.length * 3;

  const budgetAllocation: PlanResult["budgetAllocation"] = [];
  tasks.forEach((task, i) => {
    const share = (weights[i] ?? 1) / totalWeight;
    task.budgetShare = round2(share);
    // At least one query per task: a task worth planning is worth one search.
    const queries = Math.max(1, Math.round(share * totalQueries));
    task.searchQueries = generateQueries({
      feature: task.feature,
      capabilityId: task.featureId,
      stack: input.stack,
      idioms,
      requirements: task.requirementChecklist,
      limit: queries,
    });
    budgetAllocation.push({ feature: task.feature, share: task.budgetShare, queries: task.searchQueries.length });
  });

  // Build order: dependencies first, then priority. A stable topological sort means the
  // agent can follow the plan top-to-bottom without discovering an ordering problem
  // halfway through.
  return { tasks: topoSort(tasks), skipped, budgetAllocation };
}

/**
 * Strategy selection — the planner's core judgement.
 *
 * The question is not "is this feature important?" but "is searching GitHub for it a good
 * use of a scarce quota?". App-specific glue is important and worth zero search budget.
 */
function chooseStrategy(unit: FeatureUnit): ReuseStrategy {
  const cap = CAPABILITY_BY_ID.get(unit.id);
  if (!cap) return "build-from-scratch";

  // Low reuse value means many implementations exist but none will fit — the shape is too
  // application-specific for someone else's version to be worth adapting.
  if (cap.reuseValue === "low") return "build-from-scratch";

  // Well-solved problems with mature libraries: expect to depend on one outright.
  const libraryShaped = new Set([
    "http-client", "persistence", "image-loading", "media-playback", "oauth",
    "secure-storage", "payments", "search-indexing", "validation", "i18n", "file-parsing",
  ]);
  if (libraryShaped.has(cap.id)) return "reuse-library";

  // Algorithmically tricky and usually deeply coupled to its host codebase: study the
  // approach rather than lifting the code.
  const algorithmShaped = new Set(["realtime-collab", "offline-sync", "search-indexing"]);
  if (algorithmShaped.has(cap.id)) return "study-reference";

  return "reuse-pattern";
}

function reasonForSkipping(unit: FeatureUnit): string {
  const cap = CAPABILITY_BY_ID.get(unit.id);
  if (!cap) return "no known reusable implementation category; likely application-specific";
  return `low reuse value — ${unit.name.toLowerCase()} is usually too application-specific for an existing implementation to fit; building it directly is cheaper than adapting one`;
}

function rationaleFor(unit: FeatureUnit, strategy: ReuseStrategy): string {
  switch (strategy) {
    case "reuse-library":
      return `${unit.name} is a well-solved problem with mature libraries; depending on one is almost always better than reimplementing it.`;
    case "study-reference":
      return `${unit.name} is algorithmically subtle and usually tightly coupled to its host codebase; study a proven implementation rather than lifting it.`;
    case "reuse-pattern":
      return `${unit.name} has many existing implementations following a common pattern; adapt the pattern to the target architecture.`;
    default:
      return "";
  }
}

function weightOf(t: ImplementationTask): number {
  const base = t.priority / 100;
  const strategyBoost =
    t.strategy === "reuse-library" ? 1.3 :
    t.strategy === "reuse-pattern" ? 1.1 :
    0.8; // study-reference needs fewer candidates — we want one good example, not ten
  return Math.max(0.05, base * strategyBoost);
}

/** Stable topological sort; falls back to priority order if the graph has a cycle. */
function topoSort(tasks: ImplementationTask[]): ImplementationTask[] {
  const byId = new Map(tasks.map((t) => [t.featureId, t]));
  const out: ImplementationTask[] = [];
  const state = new Map<string, "visiting" | "done">();

  const visit = (t: ImplementationTask): void => {
    const s = state.get(t.featureId);
    if (s === "done") return;
    if (s === "visiting") return;   // cycle: break rather than recurse forever
    state.set(t.featureId, "visiting");
    for (const dep of t.dependsOn) {
      const d = byId.get(dep);
      if (d) visit(d);
    }
    state.set(t.featureId, "done");
    out.push(t);
  };

  for (const t of [...tasks].sort((a, b) => b.priority - a.priority)) visit(t);
  return out;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
