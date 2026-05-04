import { describe, expect, it } from "vitest";
import {
  decryptCreds,
  deriveSpawnKey,
  encryptCreds,
  generateSpawnId,
  type EncryptedRecord,
} from "./cred-crypto";

const MASTER = "test-master-secret-with-enough-bytes-to-be-realistic";

describe("generateSpawnId", () => {
  it("returns a v4-shaped uuid", () => {
    const id = generateSpawnId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("is unique across calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(generateSpawnId());
    expect(ids.size).toBe(100);
  });
});

describe("deriveSpawnKey", () => {
  it("returns 32 bytes", () => {
    expect(deriveSpawnKey(MASTER, "abc").length).toBe(32);
  });

  it("is deterministic for the same (master, spawnId) pair", () => {
    const a = deriveSpawnKey(MASTER, "spawn-x");
    const b = deriveSpawnKey(MASTER, "spawn-x");
    expect(a.equals(b)).toBe(true);
  });

  it("diverges on different spawn ids", () => {
    const a = deriveSpawnKey(MASTER, "spawn-x");
    const b = deriveSpawnKey(MASTER, "spawn-y");
    expect(a.equals(b)).toBe(false);
  });

  it("diverges on different master secrets", () => {
    const a = deriveSpawnKey(MASTER, "spawn-x");
    const b = deriveSpawnKey(MASTER + "rotation", "spawn-x");
    expect(a.equals(b)).toBe(false);
  });

  it("rejects empty inputs", () => {
    expect(() => deriveSpawnKey("", "spawn")).toThrow();
    expect(() => deriveSpawnKey(MASTER, "")).toThrow();
  });
});

describe("encryptCreds / decryptCreds round trip", () => {
  it("encrypts then decrypts arbitrary JSON", () => {
    const plain = {
      llmApiKey: "sk-ant-secret-...",
      keypair: [1, 2, 3, 4, 5],
      meta: { name: "alpha", risk: "balanced" },
    };
    const enc = encryptCreds(plain, MASTER, generateSpawnId());
    const out = decryptCreds<typeof plain>(enc, MASTER);
    expect(out).toEqual(plain);
  });

  it("each encryption uses a fresh nonce (no reuse on same plaintext)", () => {
    const plain = { x: 1 };
    const sid = generateSpawnId();
    const a = encryptCreds(plain, MASTER, sid);
    const b = encryptCreds(plain, MASTER, sid);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ct).not.toBe(b.ct);
    // Both still decrypt correctly under the same key.
    expect(decryptCreds(a, MASTER)).toEqual(plain);
    expect(decryptCreds(b, MASTER)).toEqual(plain);
  });

  it("rejects ciphertext under a different master secret", () => {
    const enc = encryptCreds({ x: 1 }, MASTER, generateSpawnId());
    expect(() => decryptCreds(enc, "rotated-master")).toThrow();
  });

  it("rejects ciphertext whose spawnId was tampered after encryption", () => {
    const enc = encryptCreds({ x: 1 }, MASTER, generateSpawnId());
    const tampered: EncryptedRecord = { ...enc, spawnId: "different-id" };
    expect(() => decryptCreds(tampered, MASTER)).toThrow();
  });

  it("rejects ciphertext whose ct bytes were tampered", () => {
    const enc = encryptCreds({ x: 1 }, MASTER, generateSpawnId());
    // Flip a byte in the middle of the ciphertext.
    const ctBuf = Buffer.from(enc.ct, "base64");
    ctBuf[Math.floor(ctBuf.length / 2)] ^= 0xff;
    const tampered: EncryptedRecord = {
      ...enc,
      ct: ctBuf.toString("base64"),
    };
    expect(() => decryptCreds(tampered, MASTER)).toThrow();
  });

  it("rejects ciphertext whose tag was tampered", () => {
    const enc = encryptCreds({ x: 1 }, MASTER, generateSpawnId());
    const tagBuf = Buffer.from(enc.tag, "base64");
    tagBuf[0] ^= 0xff;
    const tampered: EncryptedRecord = {
      ...enc,
      tag: tagBuf.toString("base64"),
    };
    expect(() => decryptCreds(tampered, MASTER)).toThrow();
  });

  it("rejects an unsupported version", () => {
    const enc = encryptCreds({ x: 1 }, MASTER, generateSpawnId());
    const bumped = { ...enc, v: 99 as unknown as 1 };
    expect(() => decryptCreds(bumped, MASTER)).toThrow();
  });

  it("rejects records missing spawnId", () => {
    const enc = encryptCreds({ x: 1 }, MASTER, generateSpawnId());
    const stripped = { ...enc, spawnId: "" };
    expect(() => decryptCreds(stripped, MASTER)).toThrow();
  });

  it("rejects bad nonce / tag lengths defensively", () => {
    const enc = encryptCreds({ x: 1 }, MASTER, generateSpawnId());
    expect(() =>
      decryptCreds({ ...enc, nonce: Buffer.alloc(8).toString("base64") }, MASTER)
    ).toThrow();
    expect(() =>
      decryptCreds({ ...enc, tag: Buffer.alloc(8).toString("base64") }, MASTER)
    ).toThrow();
  });

  it("preserves nested binary-shaped data (Uint8Array as number[])", () => {
    // Solana keypairs are 64-byte Uint8Arrays; we serialize as number[].
    const keypair = Array.from({ length: 64 }, (_, i) => (i * 7) & 0xff);
    const enc = encryptCreds({ keypair }, MASTER, generateSpawnId());
    const out = decryptCreds<{ keypair: number[] }>(enc, MASTER);
    expect(out.keypair).toEqual(keypair);
  });
});
