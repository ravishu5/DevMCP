#!/usr/bin/env node
/**
 * MCP server entry point.
 *
 * Kept minimal on purpose: everything real lives in `src/mcp/server.ts` and the pipeline,
 * so this file is only the process boundary — start, and fail loudly enough to be
 * debuggable when the process cannot start at all.
 */

import { startMcpServer } from "./mcp/server.js";
import { FatalConfigError } from "./core/errors.js";

startMcpServer().catch((err: unknown) => {
  // stderr, never stdout: stdout is the MCP protocol channel and writing to it here would
  // corrupt the handshake in a way that is genuinely hard to diagnose.
  if (err instanceof FatalConfigError) {
    process.stderr.write(`Configuration error: ${err.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`Failed to start MCP server: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
