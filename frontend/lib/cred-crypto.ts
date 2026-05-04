// Symmetric envelope encryption for user-supplied creds (LLM API keys,
// bidder keypairs). Master key derives from SEALDEX_SESSION_SECRET via
// HKDF-SHA256 so the same env var that signs sessions also encrypts
// creds — losing it invalidates everything in a single sweep, which is
// the right blast-radius for this product.
//
// Design goals:
//   - Authenticated encryption (AES-256-GCM): tamper-evident.
//   - Per-record nonce (96 random bits): no nonce reuse even with the
//     same key + same plaintext.
//   - Domain-separated keys: each spawn id derives its own AEAD key
//     from the master so a stolen ciphertext can't be replayed against
//     a different spawn id.
//   - JSON-shaped wire format so persistence is human-inspectable.
//
// Prod NOTE: a real production system should additionally rotate the
// master per quarter and re-encrypt outstanding records. We don't
// implement rotation tooling here — that's a v2 feature.

import { createHmac, randomBytes } from "node:crypto";
import { createCipheriv, createDecipheriv } from "node:crypto";

const AEAD_KEY_LEN = 32; // AES-256
const AEAD_NONCE_LEN = 12; // GCM standard
const AEAD_TAG_LEN = 16;
const HKDF_INFO_PREFIX = "sealdex/cred-crypto/v1";

/**
 * HKDF-SHA256(salt=master, ikm="", info=domain) for `length` bytes.
 * Stripped down from RFC 5869 — we don't need the salt-IKM split, just
 * a key-stretch from one secret + one context label.
 */
function hkdf(master: string, info: string, length: number): Buffer {
  const prk = createHmac("sha256", master).update("").digest();
  const out: Buffer[] = [];
  let prev = Buffer.alloc(0);
  let counter = 1;
  while (Buffer.concat(out).length < length) {
    const t = createHmac("sha256", prk)
      .update(Buffer.concat([prev, Buffer.from(info, "utf8"), Buffer.from([counter])]))
      .digest();
    out.push(t);
    prev = t;
    counter++;
  }
  return Buffer.concat(out).subarray(0, length);
}

/** Derive the AEAD key for a particular spawn id. */
export function deriveSpawnKey(masterSecret: string, spawnId: string): Buffer {
  if (!masterSecret) {
    throw new Error("master secret required for cred encryption");
  }
  if (!spawnId) {
    throw new Error("spawnId required for cred key derivation");
  }
  return hkdf(masterSecret, `${HKDF_INFO_PREFIX}/spawn/${spawnId}`, AEAD_KEY_LEN);
}

export interface EncryptedRecord {
  /** Schema version. Bump this when the AEAD shape changes. */
  v: 1;
  /** base64 96-bit nonce. */
  nonce: string;
  /** base64 ciphertext (does NOT include tag). */
  ct: string;
  /** base64 16-byte GCM tag. */
  tag: string;
  /** Spawn id used for key derivation. Stored alongside so we can
   *  decrypt without remembering it elsewhere. */
  spawnId: string;
}

/**
 * Encrypt a JSON-serializable plaintext with the spawn-derived key.
 * Returns a record safe to write to disk.
 */
export function encryptCreds<T>(
  plaintext: T,
  masterSecret: string,
  spawnId: string
): EncryptedRecord {
  const key = deriveSpawnKey(masterSecret, spawnId);
  const nonce = randomBytes(AEAD_NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const json = Buffer.from(JSON.stringify(plaintext), "utf8");
  const ct = Buffer.concat([cipher.update(json), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    nonce: nonce.toString("base64"),
    ct: ct.toString("base64"),
    tag: tag.toString("base64"),
    spawnId,
  };
}

/**
 * Inverse of `encryptCreds`. Returns the parsed plaintext, or throws
 * if the AEAD tag doesn't verify (tampered ciphertext, wrong key,
 * wrong spawn id, version mismatch, malformed input).
 */
export function decryptCreds<T>(
  record: EncryptedRecord,
  masterSecret: string
): T {
  if (record.v !== 1) {
    throw new Error(`unsupported cred-record version: ${record.v}`);
  }
  if (!record.spawnId) {
    throw new Error("encrypted record missing spawnId");
  }
  const key = deriveSpawnKey(masterSecret, record.spawnId);
  const nonce = Buffer.from(record.nonce, "base64");
  const ct = Buffer.from(record.ct, "base64");
  const tag = Buffer.from(record.tag, "base64");
  if (nonce.length !== AEAD_NONCE_LEN) {
    throw new Error(`bad nonce length: ${nonce.length}`);
  }
  if (tag.length !== AEAD_TAG_LEN) {
    throw new Error(`bad tag length: ${tag.length}`);
  }
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString("utf8")) as T;
}

/**
 * Convenience: generate a v4-shaped UUID without pulling in `uuid`.
 * The spawn id is high-cardinality identifier, not a security boundary
 * (the AEAD is what's secret). 16 bytes of randomness is sufficient.
 */
export function generateSpawnId(): string {
  const buf = randomBytes(16);
  buf[6] = (buf[6] & 0x0f) | 0x40; // version 4
  buf[8] = (buf[8] & 0x3f) | 0x80; // variant 10
  const hex = buf.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
