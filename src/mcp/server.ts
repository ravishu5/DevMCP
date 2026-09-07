/**
 * MCP server — the 8-tool surface.
 *
 * Deliberately narrow. Internal components are not tools: exposing
 * every analyzer inflates tool-selection difficulty for the model and leaks our internals
 * into its context. The spec's `find_tests`, `find_dependencies` and `check_license` are
 * reachable as `analyze_repository(include: [...])`; `decompose_application` is
 * `build_implementation_plan(mode: "decompose")`.
 *
 * Every tool description here is written for a model that has never read our docs, and
 * says **when to use it** rather than only what it does — tool selection is the failure
 * mode that costs the most.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema, ListToolsRequestSchema, type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Services } from "../core/services.js";
import { createServices } from "../core/services.js";
import {
  runAnalyzeRepository, runAnalyzeTargetProject, runCompare, runDecomposition,
  runDiscovery, runFindAlternative, runGetImplementation, runPlan, runVerify,
} from "../orchestration/pipeline.js";
import { IntelligenceError } from "../core/errors.js";

// ---------------------------------------------------------------------------
// Shared argument fragments
// ---------------------------------------------------------------------------

const STACK_PROPS = {
  language: { type: "string", description: "Target language, e.g. Kotlin, TypeScript, Python. Strongly improves results." },
  framework: { type: "string", description: "Target framework, e.g. Android, Next.js, Django." },
  platform: { type: "string", description: "Target platform, e.g. Android, iOS, web, server." },
  distribution: {
    type: "string",
    enum: ["proprietary", "open-source", "internal", "unknown"],
    description:
      "How your project is distributed. This changes licence verdicts materially: GPL code is " +
      "incompatible with a proprietary product but usually fine in an internal tool. Say 'unknown' only if you truly do not know.",
  },
} as const;

const TOOLS: Tool[] = [
  {
    name: "discover_implementations",
    description:
      "Find and rank existing open-source implementations of a feature. Use this BEFORE writing any non-trivial " +
      "feature from scratch — it answers 'what already exists, which is best, and why'. Returns ranked repositories " +
      "with a reuse verdict (may you copy it?), a requirement-by-requirement completeness scorecard, licence analysis, " +
      "dependencies and an explanation of the score. Costs GitHub search quota; results are cached.",
    inputSchema: {
      type: "object",
      properties: {
        feature: {
          type: "string",
          description:
            "The capability you need, in plain words, e.g. 'resumable background file downloader with pause and retry'. " +
            "Describe the CAPABILITY, not a library name.",
        },
        search_hints: {
          type: "array", items: { type: "string" },
          description:
            "Terms YOU think practitioners search for, e.g. ['WorkManager','HTTP Range request','foreground service']. " +
            "These are issued first, ahead of the server's own vocabulary. You understand the requirement and the " +
            "domain; supply them whenever you can name the technique, the platform API, or the well-known library.",
        },
        capability: {
          type: "string",
          description:
            "Optional canonical capability id if you recognise one (e.g. 'download', 'oauth', 'encryption'). " +
            "Sharpens vocabulary lookup and keeps the knowledge base keyed consistently. Omit if unsure.",
        },
        must_mention: {
          type: "array", items: { type: "string" },
          description:
            "Vendors or products a candidate MUST reference, e.g. ['Stripe']. Hard requirements, not preferences — " +
            "without this, asking for Stripe payments returns Adyen and Braintree.",
        },
        exclude_terms: {
          type: "array", items: { type: "string" },
          description:
            "Terms that DISQUALIFY a candidate when they appear in its name, description or topics, "
            + "e.g. ['inspector','debugging tool','tutorial']. The counterpart to must_mention: asking for a "
            + "WebSocket transport returns network-inspection tools first, because they genuinely declare "
            + "websocket topics. Use it to separate 'library that does X' from 'tool that observes X'.",
        },
        requirements: {
          type: "array", items: { type: "string" },
          description:
            "Specific things the implementation must do, e.g. ['pause/resume','survives reboot','retry with backoff']. " +
            "Each becomes a checklist item that candidates are scored against — this is what makes ranking meaningful.",
        },
        ...STACK_PROPS,
        max_repositories: { type: "number", description: "Candidates to consider (default 40). Lowering this materially hurts result quality." },
        max_deep_analysis: { type: "number", description: "Candidates to analyse deeply (default 5). Each costs several API calls." },
        diagnostics: { type: "boolean", description: "Append token-efficiency metrics." },
      },
      required: ["feature"],
    },
  },
  {
    name: "get_implementation",
    description:
      "Extract the minimal useful set of symbols, dependencies, tests and adaptation steps from ONE repository. " +
      "Use after discover_implementations has chosen a repository, or when you already know which one you want. " +
      "Returns the smallest connected set of symbols that explains the feature — not the whole repository — plus " +
      "licence obligations, an adaptation plan and provenance. Set include_source only when you need actual code.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string", description: "owner/name, or a GitHub URL." },
        feature: { type: "string", description: "The capability you want to extract, e.g. 'resumable download'." },
        requirements: { type: "array", items: { type: "string" }, description: "Specific requirements to score against." },
        ...STACK_PROPS,
        search_hints: {
          type: "array", items: { type: "string" },
          description:
            "Terms YOU believe practitioners use, e.g. ['WorkManager','HTTP Range request']. Issued ahead of the " +
            "server's own vocabulary — you read the requirement and know the domain.",
        },
        capability: {
          type: "string",
          description: "Canonical capability id if you recognise one (e.g. 'download', 'encryption'). Omit if unsure.",
        },
        include_source: {
          type: "boolean",
          description: "Include actual source for the core symbols (Layer 3). Off by default — request it only when the symbol map is not enough.",
        },
        target_project_path: {
          type: "string",
          description: "Absolute path to YOUR project. Supply it to get integration points naming real directories instead of generic advice.",
        },
        max_tokens: { type: "number", description: "Ceiling for the returned bundle." },
        diagnostics: { type: "boolean" },
      },
      required: ["repository", "feature"],
    },
  },
  {
    name: "analyze_repository",
    description:
      "Everything known about one repository: architecture, modules, important symbols, dependencies, tests " +
      "(including which edge cases they cover), licence with obligations, quality signals and reuse concerns. " +
      "Use `include` to narrow it — include:['license'] answers 'can I legally use this?', include:['tests'] answers " +
      "'is this actually tested?'. Use this when evaluating a specific repository rather than searching.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string", description: "owner/name, or a GitHub URL." },
        feature: { type: "string", description: "Optional: the capability you care about, which focuses symbol selection." },
        include: {
          type: "array",
          items: { type: "string", enum: ["architecture", "symbols", "dependencies", "tests", "license", "quality"] },
          description: "Facets to report. Omit for all.",
        },
        ...STACK_PROPS,
        diagnostics: { type: "boolean" },
      },
      required: ["repository"],
    },
  },
  {
    name: "compare_implementations",
    description:
      "Compare 2-6 named repositories for one feature and get a recommendation with reasoning. Reports only the axes " +
      "on which they genuinely DIFFER (a tied axis is noise), states the specific conditions under which a different " +
      "candidate is the better pick, and surfaces blockers — licence problems and abandonment — ahead of any score. " +
      "Use when you have shortlisted candidates and must choose.",
    inputSchema: {
      type: "object",
      properties: {
        feature: { type: "string", description: "The capability being compared for." },
        repositories: {
          type: "array", items: { type: "string" }, minItems: 2, maxItems: 6,
          description: "Repositories to compare, as owner/name.",
        },
        search_hints: {
          type: "array", items: { type: "string" },
          description:
            "Terms YOU believe practitioners use, e.g. ['WorkManager','HTTP Range request']. Issued ahead of the " +
            "server's own vocabulary — you read the requirement and know the domain.",
        },
        capability: {
          type: "string",
          description: "Canonical capability id if you recognise one (e.g. 'download', 'encryption'). Omit if unsure.",
        },
        requirements: { type: "array", items: { type: "string" }, description: "Requirements to score completeness against." },
        ...STACK_PROPS,
        diagnostics: { type: "boolean" },
      },
      required: ["feature", "repositories"],
    },
  },
  {
    name: "build_implementation_plan",
    description:
      "Turn a whole application requirement into an ordered build plan. Start here for 'build me an app that…'.\n\n" +
      "DECOMPOSE THE REQUIREMENT YOURSELF and pass it as `features`. You have read the requirement; the server's " +
      "built-in decomposer is a keyword table, and it loses things silently — it has absorbed 'end-to-end " +
      "encryption' into 'messaging' and failed to recognise 'internationalisation'. Split the requirement into " +
      "features, give each its concrete requirements, and add search hints where you know the domain terms. The " +
      "server then enriches what you supply with platform idioms, ranks candidates, and reports cross-repository " +
      "conflicts.\n\n" +
      "mode='decompose' is fast, offline and uses no quota. mode='full' additionally discovers a concrete " +
      "implementation per feature and reports overlapping dependencies, version clashes, duplicate abstractions, " +
      "naming collisions and licence conflicts. If you omit `features`, the built-in decomposer runs as a fallback " +
      "and the result says so.",
    inputSchema: {
      type: "object",
      properties: {
        requirement: {
          type: "string",
          description: "The application requirement, verbatim, e.g. 'a social app with auth, feeds and messaging'.",
        },
        features: {
          type: "array",
          description:
            "YOUR decomposition of the requirement — strongly preferred over letting the server guess. " +
            "One entry per reusable feature. Omit features that are application-specific glue, or mark them " +
            "reuse='build-from-scratch'.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Short feature name, e.g. 'Resumable background downloads'." },
              description: { type: "string", description: "One line on what it must do." },
              requirements: {
                type: "array", items: { type: "string" },
                description:
                  "Concrete things it must do, e.g. ['pause/resume','survives reboot','retry with backoff']. " +
                  "Each becomes a checklist item candidates are scored against — the highest-leverage field here.",
              },
              searchHints: {
                type: "array", items: { type: "string" },
                description: "Terms practitioners use, e.g. ['WorkManager','HTTP Range request'].",
              },
              capability: { type: "string", description: "Canonical capability id if you recognise one." },
              mustMention: {
                type: "array", items: { type: "string" },
                description:
                  "Vendors, products or platform APIs a candidate MUST reference, e.g. ['Stripe'] or ['Firebase']. " +
                  "Hard requirements, not preferences — without this, asking for Stripe payments returns Adyen and " +
                  "Braintree, which are about payments but are not what was asked for.",
              },
              excludeTerms: {
                type: "array", items: { type: "string" },
                description:
                  "Terms that DISQUALIFY a candidate when they appear in its name, description or topics, "
            + "e.g. ['inspector','debugging tool','tutorial']. The counterpart to must_mention: asking for a "
            + "WebSocket transport returns network-inspection tools first, because they genuinely declare "
            + "websocket topics. Use it to separate 'library that does X' from 'tool that observes X'.",
              },
              dependsOn: { type: "array", items: { type: "string" }, description: "Names of features this one builds on." },
              reuse: { type: "string", enum: ["search", "build-from-scratch"], description: "Whether searching is worthwhile." },
            },
            required: ["name"],
          },
        },
        mode: {
          type: "string", enum: ["decompose", "full"],
          description: "'decompose' is instant and free. 'full' also discovers implementations — slower, uses search quota.",
        },
        ...STACK_PROPS,
        max_features: { type: "number", description: "In full mode, how many features to discover implementations for (default 4, max 20). Each costs a few GitHub searches against a 30/min limit, so large plans take minutes." },
        diagnostics: { type: "boolean" },
      },
      required: ["requirement"],
    },
  },
  {
    name: "analyze_target_project",
    description:
      "Analyse YOUR local project: language, frameworks, architecture, dependency managers, existing libraries, " +
      "state/networking/database layers, testing frameworks, directory structure and coding conventions. Offline — " +
      "no network, no quota. Run this FIRST when integrating into an existing codebase: every later tool gives " +
      "project-specific integration points instead of generic advice.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the project root." },
      },
      required: ["path"],
    },
  },
  {
    name: "find_alternative",
    description:
      "You tried a recommended implementation and hit a wall — incompatible dependency, wrong licence, too complex, " +
      "unmaintained, missing a capability. Describe what went wrong in plain words; this parses it into a constraint, " +
      "re-ranks candidates against it, and returns alternatives that do not have the same problem. It also lists which " +
      "other candidates were rejected for the same reason, so you know they were considered. Usually costs no new search quota.",
    inputSchema: {
      type: "object",
      properties: {
        feature: { type: "string", description: "The capability you are still trying to satisfy." },
        current_candidate: { type: "string", description: "The repository that did not work out." },
        reason: {
          type: "string",
          description:
            "What went wrong, in your own words, e.g. 'requires Room but this project uses SQLDelight', " +
            "'licence is AGPL and we ship a proprietary app', 'too many dependencies'.",
        },
        exclude: { type: "array", items: { type: "string" }, description: "Repositories already ruled out." },
        requirements: { type: "array", items: { type: "string" } },
        ...STACK_PROPS,
        diagnostics: { type: "boolean" },
      },
      required: ["feature", "reason"],
    },
  },
  {
    name: "verify_implementation",
    description:
      "Use this AFTER adapting an implementation into your project, before considering the work done. " +
      "Checks statically whether the expected pieces are present: " +
      "architectural components, key concepts (matched loosely, since renaming is expected), declared dependencies, " +
      "tests for the feature, edge cases the source handled, and licence attribution. Returns confidence capped at 80% " +
      "and an explicit risk list — this compiles and runs nothing, and cannot establish correctness.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string", description: "The repository the implementation came from." },
        feature: { type: "string", description: "The capability that was implemented." },
        target_project_path: { type: "string", description: "Absolute path to your project." },
        requirements: { type: "array", items: { type: "string" } },
        ...STACK_PROPS,
      },
      required: ["repository", "feature", "target_project_path"],
    },
  },
];

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

const stackSchema = {
  language: z.string().optional(),
  framework: z.string().optional(),
  platform: z.string().optional(),
  distribution: z.enum(["proprietary", "open-source", "internal", "unknown"]).optional(),
};

const SCHEMAS = {
  discover_implementations: z.object({
    feature: z.string().min(1),
    requirements: z.array(z.string()).optional(),
    search_hints: z.array(z.string()).optional(),
    capability: z.string().optional(),
    must_mention: z.array(z.string()).optional(),
    exclude_terms: z.array(z.string()).optional(),
    ...stackSchema,
    max_repositories: z.number().int().positive().max(100).optional(),
    max_deep_analysis: z.number().int().positive().max(20).optional(),
    diagnostics: z.boolean().optional(),
  }),
  get_implementation: z.object({
    repository: z.string().min(1),
    feature: z.string().min(1),
    requirements: z.array(z.string()).optional(),
    search_hints: z.array(z.string()).optional(),
    capability: z.string().optional(),
    ...stackSchema,
    include_source: z.boolean().optional(),
    target_project_path: z.string().optional(),
    max_tokens: z.number().int().positive().max(50_000).optional(),
    diagnostics: z.boolean().optional(),
  }),
  analyze_repository: z.object({
    repository: z.string().min(1),
    feature: z.string().optional(),
    include: z.array(z.enum(["architecture", "symbols", "dependencies", "tests", "license", "quality"])).optional(),
    ...stackSchema,
    diagnostics: z.boolean().optional(),
  }),
  compare_implementations: z.object({
    feature: z.string().min(1),
    repositories: z.array(z.string()).min(2).max(6),
    requirements: z.array(z.string()).optional(),
    search_hints: z.array(z.string()).optional(),
    capability: z.string().optional(),
    ...stackSchema,
    diagnostics: z.boolean().optional(),
  }),
  build_implementation_plan: z.object({
    requirement: z.string().min(1),
    features: z.array(z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      requirements: z.array(z.string()).optional(),
      searchHints: z.array(z.string()).optional(),
      capability: z.string().optional(),
      mustMention: z.array(z.string()).optional(),
      excludeTerms: z.array(z.string()).optional(),
      dependsOn: z.array(z.string()).optional(),
      reuse: z.enum(["search", "build-from-scratch"]).optional(),
    })).max(30).optional(),
    mode: z.enum(["decompose", "full"]).optional(),
    ...stackSchema,
    max_features: z.number().int().positive().max(20).optional(),
    diagnostics: z.boolean().optional(),
  }),
  analyze_target_project: z.object({ path: z.string().min(1) }),
  find_alternative: z.object({
    feature: z.string().min(1),
    current_candidate: z.string().optional(),
    reason: z.string().min(1),
    exclude: z.array(z.string()).optional(),
    requirements: z.array(z.string()).optional(),
    ...stackSchema,
    diagnostics: z.boolean().optional(),
  }),
  verify_implementation: z.object({
    repository: z.string().min(1),
    feature: z.string().min(1),
    target_project_path: z.string().min(1),
    requirements: z.array(z.string()).optional(),
    ...stackSchema,
  }),
} as const;

// ---------------------------------------------------------------------------

export function createMcpServer(services: Services): Server {
  const server = new Server(
    { name: "implementation-intelligence", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const schema = SCHEMAS[name as keyof typeof SCHEMAS];
    if (!schema) {
      return errorResult(`Unknown tool "${name}". Available: ${Object.keys(SCHEMAS).join(", ")}.`);
    }

    const parsed = schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      // Return the validation failure as a RESULT, not a protocol error: the model can act
      // on "language must be a string" and retry, whereas a transport error just fails.
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      return errorResult(`Invalid arguments for ${name}:\n${issues.map((i) => `• ${i}`).join("\n")}`);
    }

    try {
      const text = await dispatch(services, name, parsed.data as Record<string, unknown>);
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      // Scrub before anything reaches the model — an error message can carry a URL with a
      // token in it (SECURITY.md T4).
      const message = services.sanitizer.scrubForLog(
        err instanceof Error ? err.message : String(err),
      );
      const guidance = err instanceof IntelligenceError ? guidanceFor(err) : "";
      services.logger.warn("tool call failed", { tool: name, error: message });
      return errorResult(`${name} failed: ${message}${guidance ? `\n\n${guidance}` : ""}`);
    }
  });

  return server;
}

async function dispatch(
  services: Services, name: string, args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "discover_implementations": {
      const r = await runDiscovery(services, {
        feature: args.feature as string,
        requirements: args.requirements as string[] | undefined,
        searchHints: args.search_hints as string[] | undefined,
        capability: args.capability as string | undefined,
        mustMention: args.must_mention as string[] | undefined,
        excludeTerms: args.exclude_terms as string[] | undefined,
        language: args.language as string | undefined,
        framework: args.framework as string | undefined,
        platform: args.platform as string | undefined,
        distribution: args.distribution as never,
        maxRepositories: args.max_repositories as number | undefined,
        maxDeepAnalysis: args.max_deep_analysis as number | undefined,
        diagnostics: args.diagnostics as boolean | undefined,
      });
      return r.text;
    }

    case "get_implementation": {
      // Analysing the target project first is what turns generic integration advice into
      // "add this under app/src/main/kotlin/data".
      const targetProfile = args.target_project_path
        ? (await runAnalyzeTargetProject(services, { path: args.target_project_path as string })).data
        : undefined;
      const r = await runGetImplementation(services, {
        repository: args.repository as string,
        feature: args.feature as string,
        requirements: args.requirements as string[] | undefined,
        searchHints: args.search_hints as string[] | undefined,
        capability: args.capability as string | undefined,
        language: (args.language as string | undefined) ?? targetProfile?.language,
        framework: (args.framework as string | undefined) ?? targetProfile?.frameworks[0],
        platform: args.platform as string | undefined,
        projectLicense: targetProfile?.projectLicense,
        distribution: args.distribution as never,
        targetProfile,
        includeSource: args.include_source as boolean | undefined,
        maxTokens: args.max_tokens as number | undefined,
        diagnostics: args.diagnostics as boolean | undefined,
      });
      return r.text;
    }

    case "analyze_repository":
      return (await runAnalyzeRepository(services, {
        repository: args.repository as string,
        feature: args.feature as string | undefined,
        include: args.include as never,
        language: args.language as string | undefined,
        framework: args.framework as string | undefined,
        distribution: args.distribution as never,
        diagnostics: args.diagnostics as boolean | undefined,
      })).text;

    case "compare_implementations":
      return (await runCompare(services, {
        feature: args.feature as string,
        repositories: args.repositories as string[],
        requirements: args.requirements as string[] | undefined,
        searchHints: args.search_hints as string[] | undefined,
        capability: args.capability as string | undefined,
        language: args.language as string | undefined,
        framework: args.framework as string | undefined,
        platform: args.platform as string | undefined,
        distribution: args.distribution as never,
        diagnostics: args.diagnostics as boolean | undefined,
      })).text;

    case "build_implementation_plan": {
      if ((args.mode ?? "decompose") === "decompose") {
        return runDecomposition({
          requirement: args.requirement as string,
          language: args.language as string | undefined,
          framework: args.framework as string | undefined,
          platform: args.platform as string | undefined,
        }).text;
      }
      return (await runPlan(services, {
        requirement: args.requirement as string,
        features: args.features as never,
        language: args.language as string | undefined,
        framework: args.framework as string | undefined,
        platform: args.platform as string | undefined,
        distribution: args.distribution as never,
        maxFeatures: args.max_features as number | undefined,
        diagnostics: args.diagnostics as boolean | undefined,
      })).text;
    }

    case "analyze_target_project":
      return (await runAnalyzeTargetProject(services, { path: args.path as string })).text;

    case "find_alternative":
      return (await runFindAlternative(services, {
        feature: args.feature as string,
        currentCandidate: args.current_candidate as string | undefined,
        reason: args.reason as string,
        exclude: args.exclude as string[] | undefined,
        requirements: args.requirements as string[] | undefined,
        language: args.language as string | undefined,
        framework: args.framework as string | undefined,
        platform: args.platform as string | undefined,
        distribution: args.distribution as never,
        diagnostics: args.diagnostics as boolean | undefined,
      })).text;

    case "verify_implementation":
      return (await runVerify(services, {
        repository: args.repository as string,
        feature: args.feature as string,
        targetProjectPath: args.target_project_path as string,
        requirements: args.requirements as string[] | undefined,
        language: args.language as string | undefined,
        framework: args.framework as string | undefined,
        platform: args.platform as string | undefined,
        distribution: args.distribution as never,
      })).text;

    default:
      throw new IntelligenceError(`Unhandled tool: ${name}`, { kind: "internal", stage: "mcp.dispatch" });
  }
}

/** Actionable next step for a typed failure — a bare error message leaves the model stuck. */
function guidanceFor(err: IntelligenceError): string {
  switch (err.kind) {
    case "auth":
      return "Set GITHUB_TOKEN, or run `gh auth login`. The server also works unauthenticated at 60 requests/hour.";
    case "rate-limit":
      return `GitHub quota is exhausted${err.retryAfterMs ? `; it resets in about ${Math.ceil(err.retryAfterMs / 1000)}s` : ""}. Cached results still work in the meantime.`;
    case "not-found":
      return "Check the owner/name spelling. The repository may also be private or renamed.";
    case "budget-exhausted":
      return "This call's search budget is spent. Narrow the feature description, or lower max_repositories.";
    case "timeout":
    case "network":
      return "A transient network problem. Retrying usually works.";
    default:
      return "";
  }
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/** Entry point: wire the server to stdio and keep it alive. */
export async function startMcpServer(): Promise<void> {
  const services = createServices();
  const server = createMcpServer(services);

  // stdout is the protocol channel — the logger writes only to stderr (see core/logger.ts).
  services.logger.info("implementation-intelligence MCP starting", {
    githubAuthenticated: Boolean(services.config.github.token),
    codeIndexEnabled: services.config.codeIndex.enabled,
    cache: services.config.cache.enabled ? services.config.cache.path : "disabled",
  });

  const shutdown = async () => {
    try { await services.close(); } catch { /* best effort */ }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(new StdioServerTransport());
}

export { TOOLS };
