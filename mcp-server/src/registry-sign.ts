// Cryptographic signatures for registry feed entries. The auctioneer signs
// each entry with its keypair; bidders verify against a configured trusted
// publisher pubkey. Closes a real attack: if `sealdex.fly.dev/api/auctions`
// (or any mirror) is tampered with — by a CDN edge cache poisoning, a man
// in the middle on a non-TLS connection, or a compromised host — the
// signatures break and downstream bidders refuse those entries instead of
// silently bidding on lies.
//
// Why ed25519 + tweetnacl: same primitive Solana keypairs already use, so
// the auctioneer can sign with its existing seller keypair without
// generating a separate signing key. Verification is fast (no zk).
//
// Canonicalization: JSON.stringify with recursive key sort and exclusion of
// the feed_signature + feed_pubkey fields themselves. `stableStringify`
// gives us a deterministic byte sequence so signer and verifier always
// hash the same input.

import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import BN from "bn.js";

export interface RegistryEntryUnsigned {
  auctionId: string;
  auctionPda: string;
  lot: Record<string, unknown>;
  endTimeUnix: number;
  signature: string; // tx sig from create_auction — NOT the feed signature
  [k: string]: unknown;
}

export interface SignedRegistryEntry extends RegistryEntryUnsigned {
  /** base58-encoded ed25519 signature over `stableStringify(entry without feed_*)`. */
  feed_signature: string;
  /** base58-encoded ed25519 public key that produced the signature. */
  feed_pubkey: string;
  /**
   * Signature scheme version. Bumped when canonicalization or covered fields
   * change so old verifiers fail-closed instead of silently accepting.
   */
  feed_version: 1;
}

/** Deterministic JSON: keys sorted recursively, no whitespace, no NaN/Inf. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(
      JSON.stringify(k) +
        ":" +
        stableStringify((value as Record<string, unknown>)[k])
    );
  }
  return "{" + parts.join(",") + "}";
}

/** Strip feed_* fields so signer and verifier hash the same surface. */
function bareEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const { feed_signature, feed_pubkey, feed_version, ...rest } = entry;
  return rest;
}

/**
 * Sign a registry entry with an ed25519 secret key. Returns the entry with
 * `feed_signature` + `feed_pubkey` + `feed_version` attached.
 */
export function signRegistryEntry(
  entry: RegistryEntryUnsigned,
  signerSecretKey: Uint8Array
): SignedRegistryEntry {
  // tweetnacl secret keys are 64 bytes (seed + pubkey). Derive the pubkey
  // from the secret key for stamping into feed_pubkey.
  if (signerSecretKey.length !== 64) {
    throw new Error(
      `signer secret key must be 64 bytes (got ${signerSecretKey.length})`
    );
  }
  const pubkeyBytes = signerSecretKey.slice(32);
  const message = new TextEncoder().encode(stableStringify(bareEntry(entry)));
  const sig = nacl.sign.detached(message, signerSecretKey);
  return {
    ...entry,
    feed_signature: bs58.encode(sig),
    feed_pubkey: new PublicKey(pubkeyBytes).toBase58(),
    feed_version: 1,
  };
}

export interface VerifyResult {
  ok: boolean;
  reason?:
    | "missing_signature"
    | "missing_pubkey"
    | "version_mismatch"
    | "untrusted_publisher"
    | "bad_signature";
}

/**
 * Verify an entry's signature against an expected publisher pubkey. Returns
 * a structured result so the caller can log or branch on the failure mode.
 *
 * `trustedPubkey: null` short-circuits to ok=true — useful in dev where
 * verification is opt-in. Production bidders should always pass a pubkey.
 */
export function verifyRegistryEntry(
  entry: Partial<SignedRegistryEntry>,
  trustedPubkey: PublicKey | null
): VerifyResult {
  if (trustedPubkey === null) return { ok: true };
  if (!entry.feed_signature) return { ok: false, reason: "missing_signature" };
  if (!entry.feed_pubkey) return { ok: false, reason: "missing_pubkey" };
  if (entry.feed_version !== 1) return { ok: false, reason: "version_mismatch" };
  if (entry.feed_pubkey !== trustedPubkey.toBase58()) {
    return { ok: false, reason: "untrusted_publisher" };
  }
  const message = new TextEncoder().encode(
    stableStringify(bareEntry(entry as Record<string, unknown>))
  );
  let sigBytes: Uint8Array;
  try {
    sigBytes = bs58.decode(entry.feed_signature);
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  const ok = nacl.sign.detached.verify(message, sigBytes, trustedPubkey.toBytes());
  return ok ? { ok: true } : { ok: false, reason: "bad_signature" };
}

const AUCTION_SEED = Buffer.from("auction");

/**
 * Verify that the registry entry's `auctionPda` is the deterministic PDA
 * derivation of `[b"auction", auctionId.le_bytes()]` against the program
 * id. Closes a complementary attack to A8: even if the publisher signed
 * an entry, they could have signed `(auctionId=42, auctionPda=garbage)`
 * — the signature alone doesn't bind the two fields together. Bidders
 * that derive PDAs locally before signing place_bid catch this; without
 * the check they'd mis-derive their own bid PDA and place a bid that
 * settle would later orphan.
 */
export function verifyAuctionPdaDerives(
  entry: { auctionId: string; auctionPda: string },
  programId: PublicKey
): boolean {
  let expected: PublicKey;
  try {
    const idBytes = new BN(entry.auctionId).toArrayLike(Buffer, "le", 8);
    [expected] = PublicKey.findProgramAddressSync(
      [AUCTION_SEED, idBytes],
      programId
    );
  } catch {
    return false;
  }
  return expected.toBase58() === entry.auctionPda;
}
