/**
 * Structured logger.
 *
 * Critical constraint: this server speaks MCP over **stdio**, so stdout is the protocol
 * channel. Anything written to stdout corrupts the session. All logging therefore goes to
 * **stderr**, unconditionally — there is deliberately no way to configure it onto stdout.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10, info: 20, warn: 30, error: 40, silent: 100,
};

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Derive a logger that stamps every line with extra fields. */
  child(fields: Record<string, unknown>): Logger;
}

class StderrLogger implements Logger {
  constructor(
    private readonly level: LogLevel,
    private readonly json: boolean,
    private readonly bound: Record<string, unknown> = {},
  ) {}

  private write(level: Exclude<LogLevel, "silent">, msg: string, fields?: Record<string, unknown>) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const all = { ...this.bound, ...fields };
    if (this.json) {
      process.stderr.write(
        JSON.stringify({ ts: new Date().toISOString(), level, msg, ...all }) + "\n",
      );
    } else {
      const suffix = Object.keys(all).length ? " " + JSON.stringify(all) : "";
      process.stderr.write(`[${level}] ${msg}${suffix}\n`);
    }
  }

  debug(m: string, f?: Record<string, unknown>) { this.write("debug", m, f); }
  info(m: string, f?: Record<string, unknown>) { this.write("info", m, f); }
  warn(m: string, f?: Record<string, unknown>) { this.write("warn", m, f); }
  error(m: string, f?: Record<string, unknown>) { this.write("error", m, f); }
  child(fields: Record<string, unknown>): Logger {
    return new StderrLogger(this.level, this.json, { ...this.bound, ...fields });
  }
}

export function createLogger(level: LogLevel = "info", json = false): Logger {
  return new StderrLogger(level, json);
}

/** Logger that discards everything. Used in tests. */
export const nullLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return nullLogger; },
};
