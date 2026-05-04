// BYOK spawn worker. Long-lived process that polls the spawn registry
// and reconciles each record's desired state with the actual running
// children:
//
//   record.status === "running", no tracked child   → start it
//   record.status === "stopped", tracked child       → SIGTERM, untrack
//   tracked child exits unexpectedly                 → mark "errored"
//
// This script lives outside the Next.js process on purpose. Forking
// long-lived children from inside a route handler is fragile (route
// timeouts, hot reload, deploy churn). Putting it in a sibling
// process keeps Next.js stateless w.r.t. the bidder children.
//
// Usage:
//   tsx worker/spawn-worker.ts
//
// Env:
//   SEALDEX_STATE_DIR        same one Next.js + auctioneer use
//   SEALDEX_SESSION_SECRET   AEAD master, must match the frontend's
//   SEALDEX_BIDDER_ENTRY     absolute path to agents/bidder/index.ts
//                            default: ../agents/bidder/index.ts
//   SEALDEX_TSX_PATH         absolute path to the tsx CLI
//                            default: ../node_modules/.bin/tsx
//   SEALDEX_WORKER_TICK_MS   poll interval (default 2000)
//   SOLANA_RPC_URL / SEALDEX_REGISTRY_URL / SEALDEX_IDL_PATH /
//     LOG_LEVEL / SENTRY_DSN  passed through to each child bidder

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";

import { decryptCreds, type EncryptedRecord } from "../lib/cred-crypto";
import { getSessionSecret } from "../lib/auth-env";
import {
  buildChildEnv,
  forkBidder,
  isPidAlive,
  materializeRuntimeKeypair,
  perSpawnStateDir,
  teardownSpawnRuntime,
} from "../lib/spawn-process";
import {
  getSpawn,
  listAllSpawns,
  spawnConfigPath,
  spawnEncCredsPath,
  updateSpawn,
} from "../lib/spawn-store";

interface DecryptedCreds {
  llmApiKey: string;
  llmEndpoint: string | null;
  keypairBytes: number[];
}

const TICK_MS = Number(process.env.SEALDEX_WORKER_TICK_MS ?? 2000);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const FRONTEND_DIR = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(FRONTEND_DIR, "..");

const BIDDER_ENTRY =
  process.env.SEALDEX_BIDDER_ENTRY ??
  path.join(REPO_ROOT, "agents/bidder/index.ts");

const TSX_PATH =
  process.env.SEALDEX_TSX_PATH ??
  path.join(REPO_ROOT, "node_modules/.bin/tsx");

const tracked = new Map<string, ChildProcess>();

function logLine(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}) {
  process.stderr.write(
    JSON.stringify({
      time: new Date().toISOString(),
      level,
      msg,
      service: "spawn-worker",
      ...fields,
    }) + "\n"
  );
}

function loadEncryptedCreds(spawnId: string): DecryptedCreds {
  const path_ = spawnEncCredsPath(spawnId);
  if (!existsSync(path_)) {
    throw new Error(`creds file missing: ${path_}`);
  }
  const enc = JSON.parse(readFileSync(path_, "utf8")) as EncryptedRecord;
  return decryptCreds<DecryptedCreds>(enc, getSessionSecret());
}

function startSpawn(spawnId: string) {
  let creds: DecryptedCreds;
  try {
    creds = loadEncryptedCreds(spawnId);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    logLine("error", "decrypt failed", { spawnId, err: message });
    updateSpawn(spawnId, { status: "errored", message: `decrypt: ${message}` });
    return;
  }

  let child: ChildProcess;
  try {
    materializeRuntimeKeypair(spawnId, creds.keypairBytes);
    const env = buildChildEnv({
      llmApiKey: creds.llmApiKey,
      perSpawnStateDir: perSpawnStateDir(spawnId),
      solanaRpcUrl: process.env.SOLANA_RPC_URL,
      sealdexRegistryUrl: process.env.SEALDEX_REGISTRY_URL,
      sealdexIdlPath: process.env.SEALDEX_IDL_PATH,
      logLevel: process.env.LOG_LEVEL,
      sentryDsn: process.env.SENTRY_DSN,
    });
    child = forkBidder({
      bidderEntryPath: BIDDER_ENTRY,
      configPath: spawnConfigPath(spawnId),
      tsxPath: TSX_PATH,
      childEnv: env,
    });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    logLine("error", "fork failed", { spawnId, err: message });
    updateSpawn(spawnId, { status: "errored", message: `fork: ${message}` });
    teardownSpawnRuntime(spawnId);
    return;
  }

  tracked.set(spawnId, child);
  updateSpawn(spawnId, { status: "running", pid: child.pid ?? null });
  logLine("info", "spawn started", { spawnId, pid: child.pid });

  child.on("exit", (code, signal) => {
    tracked.delete(spawnId);
    teardownSpawnRuntime(spawnId);
    // The worker may have asked for the stop already (status=stopped).
    // In that case don't downgrade to errored.
    const current = getSpawn(spawnId);
    if (current?.status === "stopped") {
      logLine("info", "spawn stopped cleanly", { spawnId, code, signal });
      updateSpawn(spawnId, { pid: null });
      return;
    }
    const reason = signal ? `signal:${signal}` : `exit:${code}`;
    logLine("warn", "spawn exited unexpectedly", { spawnId, reason });
    updateSpawn(spawnId, {
      status: "errored",
      message: `child exited ${reason}`,
      pid: null,
    });
  });
}

function stopSpawn(spawnId: string) {
  const child = tracked.get(spawnId);
  if (!child) {
    // Worker restarted between user's stop click and reconcile? No
    // tracked child means we never started it OR we lost track on
    // a prior crash. Either way, ensure runtime cleared.
    teardownSpawnRuntime(spawnId);
    updateSpawn(spawnId, { pid: null });
    return;
  }
  // Graceful first.
  try {
    child.kill("SIGTERM");
  } catch {
    /* already dead */
  }
  // Escalate if it doesn't exit within 5s.
  const escalate = setTimeout(() => {
    if (tracked.has(spawnId)) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }
  }, 5_000);
  child.on("exit", () => clearTimeout(escalate));
  logLine("info", "stopping spawn", { spawnId, pid: child.pid });
}

function tick() {
  let all;
  try {
    all = listAllSpawns();
  } catch (err) {
    logLine("error", "listAllSpawns failed", { err: (err as Error).message });
    return;
  }
  for (const r of all) {
    if (r.status === "running" && !tracked.has(r.spawnId)) {
      // Either it's truly new, or worker restarted while child kept
      // running. If a pid is recorded and the OS confirms it alive,
      // adopt it without restarting (avoids killing a working bidder
      // on worker restart). Otherwise (new or pid-gone) start fresh.
      if (r.pid && isPidAlive(r.pid)) {
        // We don't have the ChildProcess handle, but we know the pid
        // is alive. Best-effort: leave it running, don't track. The
        // worker will only act when status changes.
        continue;
      }
      startSpawn(r.spawnId);
    } else if (r.status === "stopped" && tracked.has(r.spawnId)) {
      stopSpawn(r.spawnId);
    }
  }
}

function shutdown() {
  logLine("info", "worker shutting down — terminating tracked children");
  for (const [spawnId, child] of tracked.entries()) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    teardownSpawnRuntime(spawnId);
  }
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

logLine("info", "spawn-worker starting", {
  tickMs: TICK_MS,
  bidderEntry: BIDDER_ENTRY,
  tsxPath: TSX_PATH,
  stateDir: process.env.SEALDEX_STATE_DIR ?? "(default)",
});
tick();
setInterval(tick, TICK_MS);
