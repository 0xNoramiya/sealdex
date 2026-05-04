// Disk-backed registry of spawned BYOK bidders. The single index file
// is small (one JSON record per spawn) and rewritten atomically on
// every change — racing writes from concurrent spawn / stop calls
// can't tear it.
//
// Storage layout under SEALDEX_STATE_DIR:
//
//   spawns/
//     index.json              ← canonical list of spawns
//     <spawn-id>/
//       config.json           ← BidderConfig (public-ish; no secrets)
//       creds.enc.json        ← EncryptedRecord{ llmApiKey, keypair }
//       creds-runtime/        ← created at process start, cleared on stop
//         keypair.json        ← chmod 0600, plaintext, only readable by spawn
//
// Why disk-backed and not just in-memory: a Next.js `next start` can
// be restarted (deploy, OOM, container reboot) and we want existing
// spawns surfaced afterwards. The index lets us re-attach (or at
// least display) them.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import path from "node:path";

export type SpawnStatus = "running" | "stopped" | "errored";

export interface SpawnRecord {
  /** UUID assigned at spawn time. Used as the on-disk dir name. */
  spawnId: string;
  /** URL-safe slug for the agent (derived from name). */
  slug: string;
  /** Wallet pubkey of the user who owns this spawn (from session cookie). */
  ownerPubkey: string;
  /** Agent display name from the BYOK config. */
  name: string;
  /** unix-seconds when the spawn was created. */
  startedAt: number;
  /** unix-seconds of the most recent status transition. */
  updatedAt: number;
  status: SpawnStatus;
  /** OS process id of the running child. Null after stop. */
  pid: number | null;
  /** Optional reason set on `errored` / `stopped` transitions. */
  message?: string;
}

export interface PersistedIndex {
  /** Bumped when the on-disk format changes. */
  v: 1;
  spawns: SpawnRecord[];
}

const STATE_DIR =
  process.env.SEALDEX_STATE_DIR && process.env.SEALDEX_STATE_DIR.trim().length > 0
    ? path.resolve(process.env.SEALDEX_STATE_DIR)
    : path.resolve(process.cwd(), "..", "scripts");

const SPAWNS_DIR = path.join(STATE_DIR, "spawns");
const INDEX_PATH = path.join(SPAWNS_DIR, "index.json");

function ensureDirs(): void {
  if (!existsSync(SPAWNS_DIR)) {
    mkdirSync(SPAWNS_DIR, { recursive: true });
  }
}

/** Compose the per-spawn working dir without creating it. */
export function spawnDir(spawnId: string): string {
  return path.join(SPAWNS_DIR, spawnId);
}

export function spawnConfigPath(spawnId: string): string {
  return path.join(spawnDir(spawnId), "config.json");
}

export function spawnEncCredsPath(spawnId: string): string {
  return path.join(spawnDir(spawnId), "creds.enc.json");
}

export function spawnRuntimeKeypairPath(spawnId: string): string {
  return path.join(spawnDir(spawnId), "creds-runtime", "keypair.json");
}

function atomicWriteJson(target: string, data: unknown): void {
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  const buf = Buffer.from(JSON.stringify(data, null, 2), "utf8");
  const fd = openSync(tmp, "w", 0o644);
  try {
    writeSync(fd, buf, 0, buf.length, 0);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
}

function readIndex(): PersistedIndex {
  ensureDirs();
  if (!existsSync(INDEX_PATH)) {
    return { v: 1, spawns: [] };
  }
  try {
    const raw = readFileSync(INDEX_PATH, "utf8");
    const parsed = JSON.parse(raw) as PersistedIndex;
    if (parsed?.v !== 1 || !Array.isArray(parsed.spawns)) {
      return { v: 1, spawns: [] };
    }
    return parsed;
  } catch {
    return { v: 1, spawns: [] };
  }
}

function writeIndex(index: PersistedIndex): void {
  ensureDirs();
  atomicWriteJson(INDEX_PATH, index);
}

export function listAllSpawns(): SpawnRecord[] {
  return readIndex().spawns;
}

export function listOwnedBy(ownerPubkey: string): SpawnRecord[] {
  if (!ownerPubkey) return [];
  return readIndex().spawns.filter((s) => s.ownerPubkey === ownerPubkey);
}

export function getSpawn(spawnId: string): SpawnRecord | null {
  return readIndex().spawns.find((s) => s.spawnId === spawnId) ?? null;
}

export function getSpawnBySlug(slug: string): SpawnRecord | null {
  return readIndex().spawns.find((s) => s.slug === slug) ?? null;
}

export function appendSpawn(record: SpawnRecord): void {
  const index = readIndex();
  // Reject id collisions defensively. UUIDv4 makes this near-impossible
  // but the cost of the check is zero relative to the dangers of
  // overwriting another spawn's record.
  if (index.spawns.some((s) => s.spawnId === record.spawnId)) {
    throw new Error(`spawn ${record.spawnId} already exists`);
  }
  if (index.spawns.some((s) => s.slug === record.slug)) {
    throw new Error(`spawn slug ${record.slug} already in use`);
  }
  index.spawns.push(record);
  writeIndex(index);
}

export function updateSpawn(
  spawnId: string,
  patch: Partial<Omit<SpawnRecord, "spawnId">>
): SpawnRecord {
  const index = readIndex();
  const idx = index.spawns.findIndex((s) => s.spawnId === spawnId);
  if (idx < 0) throw new Error(`spawn ${spawnId} not found`);
  const merged: SpawnRecord = {
    ...index.spawns[idx],
    ...patch,
    spawnId,
    updatedAt: Math.floor(Date.now() / 1000),
  };
  index.spawns[idx] = merged;
  writeIndex(index);
  return merged;
}

/** Slug uniqueness check before assigning. */
export function slugInUse(slug: string): boolean {
  return readIndex().spawns.some((s) => s.slug === slug);
}

/** Make a unique slug from a freeform name, suffixing -2/-3 if needed. */
export function uniqueSlugFor(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "agent";
  if (!slugInUse(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!slugInUse(candidate)) return candidate;
  }
  // Pathological case: 1000+ collisions. Append a high-entropy tail.
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Test-only: in-memory reset for vitest. Drops the on-disk index too. */
export function _resetForTests(): void {
  if (existsSync(INDEX_PATH)) {
    writeIndex({ v: 1, spawns: [] });
  }
}

/** Module-level constant exposed for callers that need it (e.g.
 *  the spawn route writing config.json + creds.enc.json). */
export { SPAWNS_DIR, STATE_DIR };
