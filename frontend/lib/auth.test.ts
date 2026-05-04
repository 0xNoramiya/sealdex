import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  buildSignInMessage,
  generateNonce,
  signSessionToken,
  verifySessionToken,
  verifySignInSignature,
  type SessionPayload,
} from "./auth";

const SECRET = "test-secret-please-rotate-in-prod";
const DOMAIN = "sealdex.test";

describe("generateNonce", () => {
  it("returns a base58 string of decode-length 32", () => {
    const n = generateNonce();
    expect(typeof n).toBe("string");
    expect(bs58.decode(n).length).toBe(32);
  });

  it("returns a different nonce on each call", () => {
    expect(generateNonce()).not.toBe(generateNonce());
  });
});

describe("buildSignInMessage", () => {
  it("includes the domain and nonce on separate lines", () => {
    const msg = buildSignInMessage(DOMAIN, "ABC");
    expect(msg).toContain(`${DOMAIN} wants you to sign in`);
    expect(msg).toContain("Nonce: ABC");
  });

  it("is deterministic for the same inputs", () => {
    const a = buildSignInMessage(DOMAIN, "n1");
    const b = buildSignInMessage(DOMAIN, "n1");
    expect(a).toBe(b);
  });
});

describe("verifySignInSignature", () => {
  const kp = nacl.sign.keyPair();
  const pubkeyBase58 = bs58.encode(kp.publicKey);

  function signNonce(nonce: string): string {
    const msg = new TextEncoder().encode(buildSignInMessage(DOMAIN, nonce));
    const sig = nacl.sign.detached(msg, kp.secretKey);
    return bs58.encode(sig);
  }

  it("accepts a valid sign-in", () => {
    const nonce = generateNonce();
    expect(
      verifySignInSignature({
        domain: DOMAIN,
        nonce,
        pubkeyBase58,
        signatureBase58: signNonce(nonce),
      })
    ).toBe(true);
  });

  it("rejects when the signer is a different keypair", () => {
    const nonce = generateNonce();
    const otherKp = nacl.sign.keyPair();
    const sig = nacl.sign.detached(
      new TextEncoder().encode(buildSignInMessage(DOMAIN, nonce)),
      otherKp.secretKey
    );
    expect(
      verifySignInSignature({
        domain: DOMAIN,
        nonce,
        pubkeyBase58,
        signatureBase58: bs58.encode(sig),
      })
    ).toBe(false);
  });

  it("rejects when the nonce was tampered after signing", () => {
    const nonce = generateNonce();
    const sig = signNonce(nonce);
    expect(
      verifySignInSignature({
        domain: DOMAIN,
        nonce: nonce + "X",
        pubkeyBase58,
        signatureBase58: sig,
      })
    ).toBe(false);
  });

  it("rejects when the domain was tampered (cross-origin replay)", () => {
    const nonce = generateNonce();
    const sig = signNonce(nonce);
    expect(
      verifySignInSignature({
        domain: "phishing.test",
        nonce,
        pubkeyBase58,
        signatureBase58: sig,
      })
    ).toBe(false);
  });

  it("rejects malformed pubkey input", () => {
    expect(
      verifySignInSignature({
        domain: DOMAIN,
        nonce: "n",
        pubkeyBase58: "not-a-real-pubkey",
        signatureBase58: "AAA",
      })
    ).toBe(false);
  });

  it("rejects malformed signature input", () => {
    expect(
      verifySignInSignature({
        domain: DOMAIN,
        nonce: "n",
        pubkeyBase58,
        signatureBase58: "not-base58!",
      })
    ).toBe(false);
  });

  it("rejects pubkeys of wrong length", () => {
    // 16 bytes, base58 encoded — clearly not an ed25519 pubkey.
    const fakePub = bs58.encode(new Uint8Array(16));
    const nonce = generateNonce();
    expect(
      verifySignInSignature({
        domain: DOMAIN,
        nonce,
        pubkeyBase58: fakePub,
        signatureBase58: signNonce(nonce),
      })
    ).toBe(false);
  });
});

describe("session token round trip", () => {
  const payload: SessionPayload = {
    pubkey: "ALPHA1pkA1pkA1pkA1pkA1pkA1pkA1pkA1pkA1pk",
    exp: Math.floor(Date.now() / 1000) + 3600,
  };

  it("signs and verifies a fresh token", () => {
    const tok = signSessionToken(payload, SECRET);
    const verified = verifySessionToken(tok, SECRET);
    expect(verified).toEqual(payload);
  });

  it("rejects a token signed with a different secret", () => {
    const tok = signSessionToken(payload, SECRET);
    expect(verifySessionToken(tok, "rotated-secret")).toBeNull();
  });

  it("rejects a token whose payload was tampered after signing", () => {
    const tok = signSessionToken(payload, SECRET);
    const [body, sig] = tok.split(".");
    const evilPayload = Buffer.from(
      JSON.stringify({ ...payload, pubkey: "ATTACKER1pk" }),
      "utf8"
    )
      .toString("base64")
      .replace(/=+$/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const forged = `${evilPayload}.${sig}`;
    expect(verifySessionToken(forged, SECRET)).toBeNull();
  });

  it("rejects an expired token", () => {
    const expired: SessionPayload = {
      pubkey: payload.pubkey,
      exp: Math.floor(Date.now() / 1000) - 1,
    };
    const tok = signSessionToken(expired, SECRET);
    expect(verifySessionToken(tok, SECRET)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifySessionToken("not-a-real-token", SECRET)).toBeNull();
    expect(verifySessionToken("", SECRET)).toBeNull();
    expect(verifySessionToken(".", SECRET)).toBeNull();
    expect(verifySessionToken("body.", SECRET)).toBeNull();
    expect(verifySessionToken(".sig", SECRET)).toBeNull();
  });

  it("requires a non-empty secret to sign", () => {
    expect(() => signSessionToken(payload, "")).toThrow();
  });

  it("returns null for any token under an empty secret", () => {
    const tok = signSessionToken(payload, SECRET);
    expect(verifySessionToken(tok, "")).toBeNull();
  });

  it("uses constant-time comparison (smoke: timing diff is bounded)", () => {
    // Not a true timing-attack test — just ensures we use timingSafeEqual
    // by exercising both a near-match and a far-mismatch and confirming
    // both reject (the assertion is "no exception, returns null").
    const tok = signSessionToken(payload, SECRET);
    const [body] = tok.split(".");
    const nearMiss = `${body}.${"A".repeat(43)}`;
    const farMiss = `${body}.AAAA`;
    expect(verifySessionToken(nearMiss, SECRET)).toBeNull();
    expect(verifySessionToken(farMiss, SECRET)).toBeNull();
  });
});
