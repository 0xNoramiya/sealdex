// Process-management helpers for the BYOK spawn worker. Split from
// the worker entry point so the pure parts (env construction, path
// derivation, keypair materialization) are unit-testable without
// actually forking a child.
//
// Threat model: the runtime keypair file is the only place a
// decrypted ed25519 secret exists on disk. We chmod it 0600 and
// place it inside the spawn dir (which inherits the state-dir
// permissions). For tighter isolation a tmpfs / memfd path would be
// better, but those are platform-specific and the disk version is
// good-enough for the demo's threat budget.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import {
  spawnDir,
  spawnRuntimeKeypairPath,
} from "./spawn-store";

export interface ChildEnv {
  /** Set as ANTHROPIC_API_KEY for the bidder child. v2 will pluggable
   *  this to support OpenAI-compatible endpoints. */
  ANTHROPIC_API_KEY: string;
  /** Per-spawn state dir — the bidder writes its bidder-state JSON +
   *  JSONL stream here. Isolation prevents one spawn from clobbering
   *  another's state. */
  SEALDEX_STATE_DIR: string;
  /** Inherited from worker — RPC for base-layer reads + tx submission. */
  SOLANA_RPC_URL?: string;
  /** Inherited from worker — public registry feed URL. */
  SEALDEX_REGISTRY_URL?: string;
  /** Inherited from worker — path to the program IDL. */
  SEALDEX_IDL_PATH?: string;
  /** Inherited from worker — log level for the bidder's structured logger. */
  LOG_LEVEL?: string;
  /** Inherited from worker — Sentry DSN, no-op when unset. */
  SENTRY_DSN?: string;
}

export interface BuildChildEnvInput {
  llmApiKey: string;
  perSpawnStateDir: string;
  solanaRpcUrl?: string;
  sealdexRegistryUrl?: string;
  sealdexIdlPath?: string;
  logLevel?: string;
  sentryDsn?: string;
}

/**
 * Build the env object the bidder child will inherit. Pure — does NOT
 * read process.env. The worker passes inherited values explicitly so
 * the child env is auditable from one place.
 */
export function buildChildEnv(input: BuildChildEnvInput): ChildEnv {
  const env: ChildEnv = {
    ANTHROPIC_API_KEY: input.llmApiKey,
    SEALDEX_STATE_DIR: input.perSpawnStateDir,
  };
  if (input.solanaRpcUrl) env.SOLANA_RPC_URL = input.solanaRpcUrl;
  if (input.sealdexRegistryUrl) env.SEALDEX_REGISTRY_URL = input.sealdexRegistryUrl;
  if (input.sealdexIdlPath) env.SEALDEX_IDL_PATH = input.sealdexIdlPath;
  if (input.logLevel) env.LOG_LEVEL = input.logLevel;
  if (input.sentryDsn) env.SENTRY_DSN = input.sentryDsn;
  return env;
}

/**
 * Derive the per-spawn state dir from the spawn id. Lives inside the
 * spawn's own dir so cleaning up the spawn cleans up its state.
 */
export function perSpawnStateDir(spawnId: string): string {
  return path.join(spawnDir(spawnId), "state");
}

/**
 * Write the decrypted keypair to its runtime path with mode 0600.
 * Pure-ish: filesystem effects, but no child processes. Returns the
 * runtime path so the caller can pass it through to the bidder
 * config (which already has it baked in via spawn-create.ts).
 */
export function materializeRuntimeKeypair(
  spawnId: string,
  keypairBytes: number[]
): string {
  if (!Array.isArray(keypairBytes) || keypairBytes.length !== 64) {
    throw new Error("keypairBytes must be a 64-byte number array");
  }
  const target = spawnRuntimeKeypairPath(spawnId);
  mkdirSync(path.dirname(target), { recursive: true });
  // mode 0600 from open. Solana keygen outputs JSON-encoded number[].
  writeFileSync(target, JSON.stringify(keypairBytes), { mode: 0o600 });
  // Belt-and-braces: re-chmod in case fs default mode masking trimmed
  // bits we asked for.
  chmodSync(target, 0o600);
  return target;
}

/**
 * Delete the runtime keypair + per-spawn state dir. Called on stop /
 * on bidder exit. Idempotent — missing files don't throw.
 */
export function teardownSpawnRuntime(spawnId: string): void {
  const runtime = path.dirname(spawnRuntimeKeypairPath(spawnId));
  // Don't blow away the state dir on stop: the bidder's stream and
  // bid history are valuable historical data even after the agent is
  // stopped. Only clear the secret-bearing runtime dir.
  if (existsSync(runtime)) {
    rmSync(runtime, { recursive: true, force: true });
  }
}

export interface ForkArgs {
  /** Absolute path to the bidder entry script (agents/bidder/index.ts). */
  bidderEntryPath: string;
  /** Absolute path to the spawn's config.json. */
  configPath: string;
  /** Path to the tsx CLI to run the TypeScript entry. */
  tsxPath: string;
  /** Env to merge with `process.env` for the child. */
  childEnv: ChildEnv;
}

/**
 * Fork a bidder child process. Returns the ChildProcess. Caller is
 * responsible for tracking the pid + listening to `exit`. Side
 * effect: stdout / stderr inherit from parent so log lines surface
 * directly under the worker's pino-shaped output.
 */
export function forkBidder(args: ForkArgs): ChildProcess {
  // tsx <bidder-entry> <config-path>
  const child = nodeSpawn(args.tsxPath, [args.bidderEntryPath, args.configPath], {
    env: { ...process.env, ...args.childEnv },
    stdio: ["ignore", "inherit", "inherit"],
    detached: false,
  });
  return child;
}

/**
 * Cheap liveness check: signal 0 doesn't actually deliver a signal,
 * just probes existence. Returns false on ESRCH (no such process).
 * Used by the worker to detect orphaned pids in the registry on
 * startup (worker died, child kept running — uncommon but possible).
 */
export function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      // EPERM = process exists, owned by another user. Treat as alive.
      return true;
    }
    return false;
  }
}
