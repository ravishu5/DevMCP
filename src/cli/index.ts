#!/usr/bin/env node
/**
 * CLI (spec §29).
 *
 * "The CLI should use the same internal services as the MCP. Do not implement separate
 * business logic for the CLI." Every command here is a thin wrapper over
 * `src/orchestration/pipeline.ts` — argument parsing and printing, nothing else. If a
 * command ever needs logic of its own, that logic belongs in the pipeline.
 */

import { Command } from "commander";
import { createServices } from "../core/services.js";
import {
  runAnalyzeRepository, runAnalyzeTargetProject, runCompare, runDecomposition,
  runDiscovery, runFindAlternative, runGetImplementation, runPlan, runVerify,
} from "../orchestration/pipeline.js";
import { redactedConfig } from "../core/config.js";
import { FatalConfigError } from "../core/errors.js";

const program = new Command();

program
  .name("implementation-mcp")
  .description("Discover, evaluate and package proven open-source implementations for coding agents.")
  .version("0.1.0");

program
  .command("search")
  .description("Find existing implementations of a feature")
  .argument("<feature>", 'e.g. "resumable Android downloader"')
  .option("-l, --language <lang>", "target language, e.g. Kotlin")
  .option("-f, --framework <framework>", "target framework, e.g. Android")
  .option("-p, --platform <platform>", "target platform")
  .option("-r, --requirement <req...>", "specific requirements the implementation must satisfy")
  .option("--license <spdx>", "your project's licence, for compatibility checking")
  .option("--distribution <kind>", "proprietary | open-source | internal", "unknown")
  .option("-n, --max-repos <n>", "maximum repositories to consider", "40")
  .option("-d, --deep <n>", "repositories to analyse deeply", "5")
  .option("--json", "emit structured JSON instead of the compact report")
  .option("--diagnostics", "append the token-efficiency metrics block")
  .action(async (feature: string, opts) => {
    await withServices(async (services) => {
      const result = await runDiscovery(services, {
        feature,
        language: opts.language,
        framework: opts.framework,
        platform: opts.platform,
        requirements: opts.requirement,
        projectLicense: opts.license,
        distribution: opts.distribution,
        maxRepositories: Number(opts.maxRepos),
        maxDeepAnalysis: Number(opts.deep),
        diagnostics: Boolean(opts.diagnostics),
      });
      if (opts.json) {
        process.stdout.write(JSON.stringify({ ...result.data, metrics: result.metrics }, null, 2) + "\n");
      } else {
        process.stdout.write(result.text + "\n");
      }
    });
  });

program
  .command("decompose")
  .description("Break an application requirement into reusable implementation units")
  .argument("<requirement>", 'e.g. "a social app with auth, feeds and messaging"')
  .option("-l, --language <lang>", "target language")
  .option("-f, --framework <framework>", "target framework")
  .option("-p, --platform <platform>", "target platform")
  .option("--json", "emit structured JSON")
  .action(async (requirement: string, opts) => {
    // Decomposition is deterministic and offline, so it needs no services or quota.
    const result = runDecomposition({
      requirement,
      language: opts.language,
      framework: opts.framework,
      platform: opts.platform,
    });
    process.stdout.write((opts.json ? JSON.stringify(result.data, null, 2) : result.text) + "\n");
  });

program
  .command("analyze")
  .description("Analyse one repository: architecture, symbols, dependencies, tests, licence")
  .argument("<repository>", "owner/name, or a GitHub URL")
  .option("--feature <feature>", "focus symbol selection on this capability")
  .option("-i, --include <facet...>", "architecture | symbols | dependencies | tests | license | quality")
  .option("-l, --language <lang>")
  .option("-f, --framework <framework>")
  .option("--distribution <kind>", "proprietary | open-source | internal", "unknown")
  .option("--json")
  .option("--diagnostics")
  .action(async (repository: string, opts) => {
    await withServices(async (services) => {
      const r = await runAnalyzeRepository(services, {
        repository, feature: opts.feature, include: opts.include,
        language: opts.language, framework: opts.framework,
        distribution: opts.distribution, diagnostics: Boolean(opts.diagnostics),
      });
      emit(opts.json ? JSON.stringify({ ...r.data, metrics: r.metrics }, null, 2) : r.text);
    });
  });

program
  .command("extract")
  .description("Extract the minimal implementation bundle from one repository")
  .argument("<repository>", "owner/name, or a GitHub URL")
  .requiredOption("--feature <feature>", "the capability to extract")
  .option("-l, --language <lang>")
  .option("-f, --framework <framework>")
  .option("-p, --platform <platform>")
  .option("-r, --requirement <req...>", "requirements to score completeness against")
  .option("--target <path>", "your project root, for project-specific integration points")
  .option("--source", "include actual source for the core symbols (Layer 3)")
  .option("--distribution <kind>", "proprietary | open-source | internal", "unknown")
  .option("--max-tokens <n>", "ceiling for the returned bundle")
  .option("--json")
  .option("--diagnostics")
  .action(async (repository: string, opts) => {
    await withServices(async (services) => {
      const targetProfile = opts.target
        ? (await runAnalyzeTargetProject(services, { path: opts.target })).data
        : undefined;
      const r = await runGetImplementation(services, {
        repository, feature: opts.feature,
        language: opts.language ?? targetProfile?.language,
        framework: opts.framework ?? targetProfile?.frameworks[0],
        platform: opts.platform,
        requirements: opts.requirement,
        projectLicense: targetProfile?.projectLicense,
        distribution: opts.distribution,
        targetProfile,
        includeSource: Boolean(opts.source),
        maxTokens: opts.maxTokens ? Number(opts.maxTokens) : undefined,
        diagnostics: Boolean(opts.diagnostics),
      });
      emit(opts.json ? JSON.stringify(r.bundle, null, 2) : r.text);
    });
  });

program
  .command("compare")
  .description("Compare 2-6 repositories for one feature")
  .requiredOption("--feature <feature>")
  .argument("<repositories...>", "repositories as owner/name")
  .option("-l, --language <lang>")
  .option("-f, --framework <framework>")
  .option("-r, --requirement <req...>")
  .option("--distribution <kind>", "proprietary | open-source | internal", "unknown")
  .option("--json")
  .option("--diagnostics")
  .action(async (repositories: string[], opts) => {
    await withServices(async (services) => {
      const r = await runCompare(services, {
        feature: opts.feature, repositories,
        language: opts.language, framework: opts.framework,
        requirements: opts.requirement, distribution: opts.distribution,
        diagnostics: Boolean(opts.diagnostics),
      });
      emit(opts.json ? JSON.stringify(r.data, null, 2) : r.text);
    });
  });

program
  .command("plan")
  .description("Turn an application requirement into an ordered build plan with real implementations")
  .argument("<requirement>")
  .option("-l, --language <lang>")
  .option("-f, --framework <framework>")
  .option("-p, --platform <platform>")
  .option("--distribution <kind>", "proprietary | open-source | internal", "unknown")
  .option("-n, --max-features <n>", "features to discover implementations for", "4")
  .option("--json")
  .option("--diagnostics")
  .action(async (requirement: string, opts) => {
    await withServices(async (services) => {
      const r = await runPlan(services, {
        requirement, language: opts.language, framework: opts.framework,
        platform: opts.platform, distribution: opts.distribution,
        maxFeatures: Number(opts.maxFeatures), diagnostics: Boolean(opts.diagnostics),
      });
      emit(opts.json ? JSON.stringify(r.data, null, 2) : r.text);
    });
  });

program
  .command("project")
  .description("Analyse a local project: language, frameworks, architecture, conventions")
  .argument("[path]", "project root", process.cwd())
  .option("--json")
  .action(async (path: string, opts) => {
    await withServices(async (services) => {
      const r = await runAnalyzeTargetProject(services, { path });
      emit(opts.json ? JSON.stringify(r.data, null, 2) : r.text);
    });
  });

program
  .command("alternative")
  .description("Find an alternative after a recommendation did not work out")
  .requiredOption("--feature <feature>")
  .requiredOption("--reason <reason>", 'what went wrong, e.g. "requires Room but we use SQLDelight"')
  .option("--current <repository>", "the repository that did not work")
  .option("-x, --exclude <repository...>", "repositories already ruled out")
  .option("-l, --language <lang>")
  .option("-f, --framework <framework>")
  .option("--distribution <kind>", "proprietary | open-source | internal", "unknown")
  .option("--json")
  .option("--diagnostics")
  .action(async (opts) => {
    await withServices(async (services) => {
      const r = await runFindAlternative(services, {
        feature: opts.feature, reason: opts.reason,
        currentCandidate: opts.current, exclude: opts.exclude,
        language: opts.language, framework: opts.framework,
        distribution: opts.distribution, diagnostics: Boolean(opts.diagnostics),
      });
      emit(opts.json ? JSON.stringify(r.data, null, 2) : r.text);
    });
  });

program
  .command("verify")
  .description("Statically check whether an adapted implementation landed in your project")
  .requiredOption("--repository <repository>", "the repository it came from")
  .requiredOption("--feature <feature>")
  .argument("[path]", "your project root", process.cwd())
  .option("-r, --requirement <req...>")
  .option("--json")
  .action(async (path: string, opts) => {
    await withServices(async (services) => {
      const r = await runVerify(services, {
        repository: opts.repository, feature: opts.feature,
        targetProjectPath: path, requirements: opts.requirement,
      });
      emit(opts.json ? JSON.stringify(r.data, null, 2) : r.text);
    });
  });

program
  .command("serve")
  .description("Run the MCP server over stdio (the same thing `implementation-mcp-server` does)")
  .action(async () => {
    const { startMcpServer } = await import("../mcp/server.js");
    await startMcpServer();
  });

program
  .command("config")
  .description("Show the effective configuration (secrets redacted)")
  .action(async () => {
    await withServices(async (services) => {
      process.stdout.write(JSON.stringify(redactedConfig(services.config), null, 2) + "\n");
    });
  });

program
  .command("cache")
  .description("Inspect or clear the local cache and knowledge base")
  .option("--clear", "delete every cached entry")
  .action(async (opts) => {
    await withServices(async (services) => {
      if (opts.clear) {
        services.cache.clear();
        process.stdout.write("Cache cleared.\n");
      }
      process.stdout.write(JSON.stringify(services.cache.stats(), null, 2) + "\n");
    });
  });

/** Write to stdout with a trailing newline. Kept in one place so `--json` stays pipeable. */
function emit(text: string): void {
  process.stdout.write(text + "\n");
}

/**
 * Run a command with services, guaranteeing the SQLite handle is closed.
 *
 * Exit codes matter for scripting: 2 for a configuration error the user can fix, 1 for a
 * runtime failure. Errors are printed to stderr so `--json` output stays pipeable.
 */
async function withServices(fn: (services: ReturnType<typeof createServices>) => Promise<void>): Promise<void> {
  let services: ReturnType<typeof createServices> | undefined;
  try {
    services = createServices();
    await fn(services);
  } catch (err) {
    if (err instanceof FatalConfigError) {
      process.stderr.write(`Configuration error: ${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    // Scrub through the sanitizer when we have one, so a token can never reach the terminal.
    process.stderr.write(`Error: ${services?.sanitizer.scrubForLog(message) ?? message}\n`);
    process.exitCode = 1;
  } finally {
    await services?.close();
  }
}

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
