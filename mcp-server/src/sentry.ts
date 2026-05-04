// Sentry-shaped error reporter that no-ops without SENTRY_DSN. We use a
// thin wrapper instead of @sentry/node to keep the bundle lean and avoid
// a hard dependency for setups that don't ship telemetry.
//
// When SENTRY_DSN is set the wrapper POSTs an envelope to the Sentry
// Store endpoint per the public ingestion API. When unset, every method
// is a no-op so call sites don't need conditional logic.

interface CapturedException {
  type: string;
  value: string;
  stacktrace?: { frames: Array<{ function?: string; filename?: string }> };
}

interface SentryEvent {
  event_id: string;
  timestamp: number;
  platform: "node";
  level: "error" | "warning" | "info";
  exception?: { values: CapturedException[] };
  message?: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  release?: string;
  environment?: string;
}

const DSN = process.env.SENTRY_DSN?.trim() || "";
const RELEASE = process.env.SENTRY_RELEASE?.trim() || undefined;
const ENVIRONMENT =
  process.env.SENTRY_ENVIRONMENT?.trim() ||
  process.env.NODE_ENV ||
  "production";

function parseDsn(dsn: string) {
  // dsn = https://<key>@<host>/<projectId>
  try {
    const u = new URL(dsn);
    return {
      key: u.username,
      host: u.host,
      projectId: u.pathname.replace(/^\//, ""),
      url: `${u.protocol}//${u.host}/api/${u.pathname.replace(/^\//, "")}/store/`,
    };
  } catch {
    return null;
  }
}

const PARSED = DSN ? parseDsn(DSN) : null;

function uuid(): string {
  // Sentry expects 32-char lowercase hex without dashes.
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}

async function sendEvent(event: SentryEvent): Promise<void> {
  if (!PARSED) return;
  const body = JSON.stringify(event);
  const auth =
    `Sentry sentry_version=7,sentry_client=sealdex/0.1,` +
    `sentry_timestamp=${event.timestamp},sentry_key=${PARSED.key}`;
  try {
    await fetch(PARSED.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sentry-Auth": auth,
      },
      body,
    });
  } catch {
    // Telemetry must not break the host. Swallow.
  }
}

export function captureException(
  err: unknown,
  context: Record<string, unknown> = {}
): void {
  if (!PARSED) return;
  const e = err instanceof Error ? err : new Error(String(err));
  const event: SentryEvent = {
    event_id: uuid(),
    timestamp: Math.floor(Date.now() / 1000),
    platform: "node",
    level: "error",
    release: RELEASE,
    environment: ENVIRONMENT,
    exception: {
      values: [
        {
          type: e.name || "Error",
          value: e.message,
          stacktrace: e.stack
            ? {
                frames: e.stack
                  .split("\n")
                  .slice(1, 21) // first 20 frames
                  .map((line) => ({ function: line.trim() })),
              }
            : undefined,
        },
      ],
    },
    extra: context,
  };
  // Fire and forget.
  void sendEvent(event);
}

export function captureMessage(
  message: string,
  level: SentryEvent["level"] = "info",
  context: Record<string, unknown> = {}
): void {
  if (!PARSED) return;
  const event: SentryEvent = {
    event_id: uuid(),
    timestamp: Math.floor(Date.now() / 1000),
    platform: "node",
    level,
    release: RELEASE,
    environment: ENVIRONMENT,
    message,
    extra: context,
  };
  void sendEvent(event);
}

/** True when Sentry is wired up (SENTRY_DSN set + parseable). */
export function isEnabled(): boolean {
  return PARSED !== null;
}
