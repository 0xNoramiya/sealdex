import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import BN from "bn.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  signRegistryEntry,
  verifyAuctionPdaDerives,
  verifyRegistryEntry,
  stableStringify,
  type RegistryEntryUnsigned,
} from "./registry-sign.js";

function entry(): RegistryEntryUnsigned {
  return {
    auctionId: "1234",
    auctionPda: "Pda...",
    lot: {
      lot_id: 1,
      lot_metadata: { category: "Vintage Holo", grade: 10 },
      duration_seconds: 90,
    },
    endTimeUnix: 1_700_000_000,
    signature: "txSig...",
  };
}

describe("stableStringify", () => {
  it("sorts keys recursively", () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(stableStringify({ b: { y: 1, x: 2 }, a: 1 })).toBe(
      '{"a":1,"b":{"x":2,"y":1}}'
    );
  });

  it("preserves array order", () => {
    expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
  });

  it("renders primitives via JSON.stringify", () => {
    expect(stableStringify("x")).toBe('"x"');
    expect(stableStringify(42)).toBe("42");
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(true)).toBe("true");
  });
});

describe("signRegistryEntry / verifyRegistryEntry round trip", () => {
  const kp = Keypair.generate();

  it("a freshly signed entry verifies under the publisher pubkey", () => {
    const signed = signRegistryEntry(entry(), kp.secretKey);
    expect(verifyRegistryEntry(signed, kp.publicKey)).toEqual({ ok: true });
  });

  it("signed entries pin feed_pubkey to the signer", () => {
    const signed = signRegistryEntry(entry(), kp.secretKey);
    expect(signed.feed_pubkey).toBe(kp.publicKey.toBase58());
    expect(signed.feed_version).toBe(1);
    expect(typeof signed.feed_signature).toBe("string");
  });

  it("rejects entries signed by a different publisher", () => {
    const otherKp = Keypair.generate();
    const signed = signRegistryEntry(entry(), kp.secretKey);
    const result = verifyRegistryEntry(signed, otherKp.publicKey);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("untrusted_publisher");
  });

  it("rejects an entry whose lot was tampered after signing", () => {
    const signed = signRegistryEntry(entry(), kp.secretKey);
    const tampered = {
      ...signed,
      lot: { ...signed.lot, lot_metadata: { category: "Cheap Card", grade: 1 } },
    };
    const result = verifyRegistryEntry(tampered, kp.publicKey);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("bad_signature");
  });

  it("rejects an entry whose auctionId was tampered after signing", () => {
    const signed = signRegistryEntry(entry(), kp.secretKey);
    const tampered = { ...signed, auctionId: "9999" };
    const result = verifyRegistryEntry(tampered, kp.publicKey);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("bad_signature");
  });

  it("rejects entries missing the signature field", () => {
    const result = verifyRegistryEntry(entry() as any, kp.publicKey);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_signature");
  });

  it("rejects entries with an unknown version (forward-compat fail-closed)", () => {
    const signed = signRegistryEntry(entry(), kp.secretKey);
    const futureVer = { ...signed, feed_version: 99 as unknown as 1 };
    const result = verifyRegistryEntry(futureVer, kp.publicKey);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("version_mismatch");
  });

  it("trustedPubkey null short-circuits to ok (dev mode)", () => {
    const result = verifyRegistryEntry(entry() as any, null);
    expect(result).toEqual({ ok: true });
  });

  it("rejects malformed base58 signatures", () => {
    const signed = signRegistryEntry(entry(), kp.secretKey);
    const malformed = { ...signed, feed_signature: "!!!not-base58!!!" };
    const result = verifyRegistryEntry(malformed, kp.publicKey);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("bad_signature");
  });

  it("does not include feed_signature in the message it signs", () => {
    // Sanity: sign twice on the same input → identical signatures (ed25519
    // is deterministic), proving feed_signature isn't being self-included.
    const a = signRegistryEntry(entry(), kp.secretKey);
    const b = signRegistryEntry(entry(), kp.secretKey);
    expect(a.feed_signature).toBe(b.feed_signature);
  });

  it("rejects mismatched feed_pubkey even when signature would verify against signer", () => {
    // If an attacker swaps feed_pubkey to their own key, verifyRegistryEntry
    // must compare against trustedPubkey (not feed_pubkey) before any crypto.
    const signed = signRegistryEntry(entry(), kp.secretKey);
    const attacker = Keypair.generate();
    const swapped = { ...signed, feed_pubkey: attacker.publicKey.toBase58() };
    const result = verifyRegistryEntry(swapped, kp.publicKey);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("untrusted_publisher");
  });
});

describe("verifyAuctionPdaDerives", () => {
  // Fix a known program id so the test is deterministic across runs.
  const programId = new PublicKey(
    "4DBEkkdMaW7boAsmEFXLMbEiSnVj1xYQUndWYGzPwEMJ"
  );

  function pdaFor(auctionId: string): string {
    const idBytes = new BN(auctionId).toArrayLike(Buffer, "le", 8);
    return PublicKey.findProgramAddressSync(
      [Buffer.from("auction"), idBytes],
      programId
    )[0].toBase58();
  }

  it("accepts an entry whose auctionPda matches the derivation", () => {
    const auctionId = "1234567890";
    const auctionPda = pdaFor(auctionId);
    expect(
      verifyAuctionPdaDerives({ auctionId, auctionPda }, programId)
    ).toBe(true);
  });

  it("rejects an entry whose auctionPda was forged for a different id", () => {
    const advertised = "1234567890";
    const real = "9999999999";
    expect(
      verifyAuctionPdaDerives(
        { auctionId: advertised, auctionPda: pdaFor(real) },
        programId
      )
    ).toBe(false);
  });

  it("rejects entries with a malformed auctionId", () => {
    const auctionId = "not-a-number";
    const auctionPda = pdaFor("1");
    expect(
      verifyAuctionPdaDerives({ auctionId, auctionPda }, programId)
    ).toBe(false);
  });

  it("rejects entries pointing at a base58-junk auctionPda", () => {
    const auctionId = "42";
    const auctionPda = "not-a-real-pda";
    expect(
      verifyAuctionPdaDerives({ auctionId, auctionPda }, programId)
    ).toBe(false);
  });

  it("is sensitive to the program id", () => {
    const auctionId = "42";
    const otherProgramId = Keypair.generate().publicKey;
    const auctionPda = pdaFor(auctionId);
    // Same id but different program → different PDA → mismatch.
    expect(
      verifyAuctionPdaDerives({ auctionId, auctionPda }, otherProgramId)
    ).toBe(false);
  });
});

describe("signature is order-independent for hash-stable fields", () => {
  it("same content with different key order produces the same signature", () => {
    const kp = Keypair.generate();
    const e1: RegistryEntryUnsigned = entry();
    const e2: RegistryEntryUnsigned = {
      // same fields, deliberately different declaration order
      signature: e1.signature,
      auctionId: e1.auctionId,
      lot: e1.lot,
      endTimeUnix: e1.endTimeUnix,
      auctionPda: e1.auctionPda,
    };
    const s1 = signRegistryEntry(e1, kp.secretKey);
    const s2 = signRegistryEntry(e2, kp.secretKey);
    expect(s1.feed_signature).toBe(s2.feed_signature);
  });
});
