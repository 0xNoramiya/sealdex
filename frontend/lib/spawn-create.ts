// Persist a new BYOK spawn: encrypt the user's creds, write the
// public config side-by-side, register the spawn in the index. Does
// NOT fork the bidder process — that's the worker's job (iteration 19).
// Splitting the "persist" and "run" sides keeps the API route fast and
// idempotent, and lets a restart of the worker re-attach to existing
// spawns without coordinating with the Next.js process.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  encryptCreds,
  generateSpawnId,
  type EncryptedRecord,
} from "./cred-crypto";
import {
  appendSpawn,
  spawnConfigPath,
  spawnDir,
  spawnEncCredsPath,
  uniqueSlugFor,
  type SpawnRecord,
} from "./spawn-store";

export interface SpawnConfigInput {
  /** Display name. Used as basis for slug. */
  name: string;
  want_list: Array<{
    category: string;
    min_grade: number;
    max_value_usdc: number;
  }>;
  total_budget_usdc: number;
  risk_appetite: "conservative" | "balanced" | "aggressive";
  /** Optional: trusted publisher pubkey for signed registry feeds. */
  trusted_publisher_pubkey?: string;
}

export interface SpawnSecretsInput {
  /** LLM API key (Anthropic, OpenAI-compatible, etc.). */
  llmApiKey: string;
  /** Optional override URL for the LLM endpoint. */
  llmEndpoint?: string;
  /** 64-byte ed25519 secret key (Solana keypair). Encoded as a number[]
   *  matching the on-disk JSON format Solana keygen produces. */
  keypairBytes: number[];
}

export interface SpawnCreatePayload {
  ownerPubkey: string;
  config: SpawnConfigInput;
  secrets: SpawnSecretsInput;
}

export interface SpawnCreateError {
  code:
    | "missing_owner"
    | "invalid_config"
    | "invalid_secrets"
    | "config_too_long";
  message: string;
}

export type SpawnCreateResult =
  | { ok: true; record: SpawnRecord }
  | { ok: false; error: SpawnCreateError };

/** Validate the user-supplied payload. Returns null on OK, error code on bad. */
export function validateSpawnPayload(p: unknown): SpawnCreateError | null {
  if (!p || typeof p !== "object") {
    return { code: "invalid_config", message: "request body must be an object" };
  }
  const payload = p as Partial<SpawnCreatePayload>;
  if (!payload.ownerPubkey || typeof payload.ownerPubkey !== "string") {
    return { code: "missing_owner", message: "ownerPubkey is required" };
  }
  const cfg = payload.config;
  if (!cfg || typeof cfg !== "object") {
    return { code: "invalid_config", message: "config is required" };
  }
  if (!cfg.name || typeof cfg.name !== "string") {
    return { code: "invalid_config", message: "config.name is required" };
  }
  if (cfg.name.length > 64) {
    return { code: "config_too_long", message: "config.name must be <= 64 chars" };
  }
  if (!Array.isArray(cfg.want_list) || cfg.want_list.length === 0) {
    return {
      code: "invalid_config",
      message: "config.want_list must be a non-empty array",
    };
  }
  if (cfg.want_list.length > 32) {
    return { code: "config_too_long", message: "config.want_list capped at 32 entries" };
  }
  for (const w of cfg.want_list) {
    if (!w || typeof w !== "object") {
      return { code: "invalid_config", message: "want_list entry must be object" };
    }
    if (typeof (w as any).category !== "string" || !(w as any).category) {
      return { code: "invalid_config", message: "want_list.category required" };
    }
    if (
      typeof (w as any).min_grade !== "number" ||
      !Number.isFinite((w as any).min_grade) ||
      (w as any).min_grade < 0 ||
      (w as any).min_grade > 100
    ) {
      return { code: "invalid_config", message: "want_list.min_grade must be 0..100" };
    }
    if (
      typeof (w as any).max_value_usdc !== "number" ||
      !Number.isFinite((w as any).max_value_usdc) ||
      (w as any).max_value_usdc <= 0
    ) {
      return { code: "invalid_config", message: "want_list.max_value_usdc must be > 0" };
    }
  }
  if (
    typeof cfg.total_budget_usdc !== "number" ||
    !Number.isFinite(cfg.total_budget_usdc) ||
    cfg.total_budget_usdc <= 0
  ) {
    return { code: "invalid_config", message: "config.total_budget_usdc must be > 0" };
  }
  if (!["conservative", "balanced", "aggressive"].includes(cfg.risk_appetite as string)) {
    return { code: "invalid_config", message: "config.risk_appetite invalid" };
  }
  if (
    cfg.trusted_publisher_pubkey !== undefined &&
    typeof cfg.trusted_publisher_pubkey !== "string"
  ) {
    return { code: "invalid_config", message: "trusted_publisher_pubkey must be string" };
  }
  const secrets = payload.secrets;
  if (!secrets || typeof secrets !== "object") {
    return { code: "invalid_secrets", message: "secrets are required" };
  }
  if (!secrets.llmApiKey || typeof secrets.llmApiKey !== "string") {
    return { code: "invalid_secrets", message: "secrets.llmApiKey required" };
  }
  if (
    secrets.llmEndpoint !== undefined &&
    typeof secrets.llmEndpoint !== "string"
  ) {
    return { code: "invalid_secrets", message: "secrets.llmEndpoint must be string" };
  }
  if (
    !Array.isArray(secrets.keypairBytes) ||
    secrets.keypairBytes.length !== 64 ||
    secrets.keypairBytes.some(
      (n) => typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 255
    )
  ) {
    return {
      code: "invalid_secrets",
      message: "secrets.keypairBytes must be a 64-byte array of 0-255 ints",
    };
  }
  return null;
}

/** Atomically create the on-disk artifacts + index entry for a new spawn. */
export function createSpawn(
  payload: SpawnCreatePayload,
  masterSecret: string
): SpawnCreateResult {
  const err = validateSpawnPayload(payload);
  if (err) return { ok: false, error: err };

  const spawnId = generateSpawnId();
  const slug = uniqueSlugFor(payload.config.name);
  const dir = spawnDir(spawnId);
  mkdirSync(dir, { recursive: true });

  // Write public config (no secrets) — this is what the worker reads
  // to construct the bidder loop. keypair_path points at the runtime
  // path where decrypted bytes will be materialised at start time.
  const publicConfig = {
    name: payload.config.name,
    keypair_path: path.join(dir, "creds-runtime", "keypair.json"),
    want_list: payload.config.want_list,
    total_budget_usdc: payload.config.total_budget_usdc,
    risk_appetite: payload.config.risk_appetite,
    trusted_publisher_pubkey: payload.config.trusted_publisher_pubkey,
  };
  writeFileSync(spawnConfigPath(spawnId), JSON.stringify(publicConfig, null, 2), {
    mode: 0o644,
  });

  // Encrypt secrets at rest. The encrypted blob includes everything
  // the worker needs to start the bidder process: LLM key, optional
  // endpoint URL, raw keypair bytes.
  const enc: EncryptedRecord = encryptCreds(
    {
      llmApiKey: payload.secrets.llmApiKey,
      llmEndpoint: payload.secrets.llmEndpoint ?? null,
      keypairBytes: payload.secrets.keypairBytes,
    },
    masterSecret,
    spawnId
  );
  writeFileSync(spawnEncCredsPath(spawnId), JSON.stringify(enc, null, 2), {
    mode: 0o600,
  });

  const now = Math.floor(Date.now() / 1000);
  const record = {
    spawnId,
    slug,
    ownerPubkey: payload.ownerPubkey,
    name: payload.config.name,
    startedAt: now,
    updatedAt: now,
    status: "running" as const, // worker will set to "errored"+message if start fails
    pid: null,
  };
  appendSpawn(record);

  return { ok: true, record };
}
