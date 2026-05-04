// Solana sign-in-with-wallet session primitives. Pure crypto only —
// the API routes import these and add cookie / request glue.
//
// Why hand-rolled instead of next-auth or jose: the session payload
// is two fields (pubkey + exp), the tx volume is low, and the project
// already vendors tweetnacl + bs58. A 60-line HMAC-signed cookie is
// vastly less surface than a full auth library and avoids dragging in
// another dep tree.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";

/** ------------------------- Nonce ------------------------- */

/** 32 bytes of entropy, base58-encoded — matches Phantom's signMessage shape. */
export function generateNonce(): string {
  return bs58.encode(randomBytes(32));
}

/** The exact bytes the wallet should sign. Domain-prefixed so a nonce
 * issued by sealdex.fly.dev can't be replayed against another origin
 * that happens to use the same nonce. */
export function buildSignInMessage(domain: string, nonce: string): string {
  return [
    `${domain} wants you to sign in with your Solana account.`,
    "",
    `Nonce: ${nonce}`,
  ].join("\n");
}

/** ------------------------- Signature verification ------------------------- */

/**
 * Verifies an ed25519 signature over `buildSignInMessage(domain, nonce)`
 * by the holder of `pubkeyBase58`. Returns true on a clean match,
 * false on any failure (malformed input, wrong signer, replay).
 */
export function verifySignInSignature(args: {
  domain: string;
  nonce: string;
  pubkeyBase58: string;
  signatureBase58: string;
}): boolean {
  const { domain, nonce, pubkeyBase58, signatureBase58 } = args;
  let pubkeyBytes: Uint8Array;
  let signatureBytes: Uint8Array;
  try {
    pubkeyBytes = bs58.decode(pubkeyBase58);
    signatureBytes = bs58.decode(signatureBase58);
  } catch {
    return false;
  }
  if (pubkeyBytes.length !== 32) return false;
  if (signatureBytes.length !== 64) return false;
  const message = new TextEncoder().encode(buildSignInMessage(domain, nonce));
  return nacl.sign.detached.verify(message, signatureBytes, pubkeyBytes);
}

/** ------------------------- Session token ------------------------- */

export interface SessionPayload {
  /** base58 wallet pubkey of the authenticated user. */
  pubkey: string;
  /** unix-seconds expiry. */
  exp: number;
}

/** Default session lifetime — 7 days. Picked to match common BYOK flows
 * where the user comes back later to manage their spawned agents. */
export const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function base64url(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, "utf8");
  return b
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function fromBase64url(s: string): Buffer {
  // Length-restore + standard alphabet.
  const padLen = (4 - (s.length % 4)) % 4;
  const padded = (s + "=".repeat(padLen)).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

function hmac(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

/**
 * Sign a session payload into a `<base64url(json)>.<base64url(hmac)>`
 * token. The signing key MUST come from a non-public env (SESSION_SECRET).
 */
export function signSessionToken(payload: SessionPayload, secret: string): string {
  if (!secret) throw new Error("SESSION_SECRET is required to sign tokens");
  const body = base64url(JSON.stringify(payload));
  const sig = base64url(hmac(secret, body));
  return `${body}.${sig}`;
}

/**
 * Parse + verify a session token. Returns the payload if the HMAC is
 * intact AND the token isn't expired; null otherwise. Constant-time
 * signature comparison so a leaky timing oracle can't be brute-forced.
 */
export function verifySessionToken(
  token: string,
  secret: string,
  nowUnix: number = Math.floor(Date.now() / 1000)
): SessionPayload | null {
  if (!secret) return null;
  if (!token || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot < 1 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = hmac(secret, body);
  let provided: Buffer;
  try {
    provided = fromBase64url(sig);
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(fromBase64url(body).toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof payload.pubkey !== "string" ||
    typeof payload.exp !== "number" ||
    payload.exp <= nowUnix
  ) {
    return null;
  }
  return payload;
}

/** ------------------------- Helpers ------------------------- */

/** SHA-256 of the session secret — useful for cookie-name disambiguation
 * when secrets rotate (cookies signed by old secret become invalid). */
export function secretFingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 8);
}
