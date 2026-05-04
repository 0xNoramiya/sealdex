// Lightweight structured logger shared by mcp-server, agents, and the
// frontend. Pino-shaped output so existing log pipelines (LogQL, GCP
// Cloud Logging, etc.) can ingest without a translation step.
//
// Why hand-rolled instead of importing pino: the project ships across
// Next.js (server + edge), Node 22 ESM agents, and the MCP stdio
// server. A single dependency-free emitter keeps installs simple and
// guarantees identical field shape across every entry point. Swap to
// pino later by replacing this module's body — the public surface
// matches.

const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LEVELS)[number];

const LEVEL_INDEX: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

function envLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL || "info").toLowerCase();
  return (LEVELS as readonly string[]).includes(raw)
    ? (raw as LogLevel)
    : "info";
}

interface LoggerInternal {
  base: Record<string, unknown>;
  threshold: number;
  sink: (line: string) => void;
}

export interface Logger {
  child(extra: Record<string, unknown>): Logger;
  trace(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  fatal(msg: string, fields?: Record<string, unknown>): void;
}

function emit(
  state: LoggerInternal,
  level: LogLevel,
  msg: string,
  fields?: Record<string, unknown>
) {
  if (LEVEL_INDEX[level] < state.threshold) return;
  const entry = {
    time: new Date().toISOString(),
    level,
    msg,
    ...state.base,
    ...(fields ?? {}),
  };
  // Errors don't survive JSON.stringify by default; flatten common shapes.
  const out: Record<string, unknown> = entry;
  for (const [k, v] of Object.entries(out)) {
    if (v instanceof Error) {
      out[k] = { name: v.name, message: v.message, stack: v.stack };
    }
  }
  state.sink(JSON.stringify(out));
}

function build(state: LoggerInternal): Logger {
  return {
    child(extra) {
      return build({ ...state, base: { ...state.base, ...extra } });
    },
    trace: (m, f) => emit(state, "trace", m, f),
    debug: (m, f) => emit(state, "debug", m, f),
    info: (m, f) => emit(state, "info", m, f),
    warn: (m, f) => emit(state, "warn", m, f),
    error: (m, f) => emit(state, "error", m, f),
    fatal: (m, f) => emit(state, "fatal", m, f),
  };
}

export function createLogger(
  base: Record<string, unknown> = {},
  opts: { level?: LogLevel; sink?: (line: string) => void } = {}
): Logger {
  const lvl = opts.level ?? envLevel();
  return build({
    base,
    threshold: LEVEL_INDEX[lvl],
    sink: opts.sink ?? ((line) => process.stderr.write(line + "\n")),
  });
}

/** Default singleton logger keyed off LOG_LEVEL + service name from caller. */
export function getLogger(service: string): Logger {
  return createLogger({ service });
}
