import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSpawn, validateSpawnPayload } from "./spawn-create";
import { decryptCreds, type EncryptedRecord } from "./cred-crypto";
import { spawnEncCredsPath } from "./spawn-store";

const SECRET = "test-master-secret-32-bytes-long-padding-padding";

const validKeypair = () => Array.from({ length: 64 }, (_, i) => i & 0xff);

const baseConfig = () => ({
  name: "Bidder Alpha",
  want_list: [{ category: "Vintage Holo", min_grade: 9, max_value_usdc: 5000 }],
  total_budget_usdc: 5000,
  risk_appetite: "balanced" as const,
});

let TMP: string;
beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "sealdex-spawn-create-"));
  process.env.SEALDEX_STATE_DIR = TMP;
});
afterEach(() => {
  delete process.env.SEALDEX_STATE_DIR;
});

describe("validateSpawnPayload (LLM provider rules)", () => {
  it("accepts a payload with no provider (defaults to anthropic)", () => {
    expect(
      validateSpawnPayload({
        ownerPubkey: "P".repeat(43),
        config: baseConfig(),
        secrets: {
          llmApiKey: "sk-ant-x",
          keypairBytes: validKeypair(),
        },
      })
    ).toBeNull();
  });

  it("rejects an unknown provider string", () => {
    expect(
      validateSpawnPayload({
        ownerPubkey: "P".repeat(43),
        config: baseConfig(),
        secrets: {
          llmApiKey: "x",
          llmProvider: "cohere" as any,
          keypairBytes: validKeypair(),
        },
      })?.code
    ).toBe("invalid_secrets");
  });

  it("requires llmEndpoint for openai-compatible", () => {
    const r = validateSpawnPayload({
      ownerPubkey: "P".repeat(43),
      config: baseConfig(),
      secrets: {
        llmApiKey: "k",
        llmProvider: "openai-compatible",
        llmModel: "gpt-4o-mini",
        keypairBytes: validKeypair(),
      },
    });
    expect(r?.code).toBe("invalid_secrets");
    expect(r?.message).toMatch(/llmEndpoint/);
  });

  it("requires llmModel for openai-compatible", () => {
    const r = validateSpawnPayload({
      ownerPubkey: "P".repeat(43),
      config: baseConfig(),
      secrets: {
        llmApiKey: "k",
        llmProvider: "openai-compatible",
        llmEndpoint: "https://api.openai.com/v1",
        keypairBytes: validKeypair(),
      },
    });
    expect(r?.code).toBe("invalid_secrets");
    expect(r?.message).toMatch(/llmModel/);
  });

  it("requires http(s) URL for llmEndpoint", () => {
    const r = validateSpawnPayload({
      ownerPubkey: "P".repeat(43),
      config: baseConfig(),
      secrets: {
        llmApiKey: "k",
        llmProvider: "openai-compatible",
        llmEndpoint: "javascript:alert(1)",
        llmModel: "x",
        keypairBytes: validKeypair(),
      },
    });
    expect(r?.code).toBe("invalid_secrets");
    expect(r?.message).toMatch(/http\(s\)/);
  });

  it("accepts a complete openai-compatible payload", () => {
    expect(
      validateSpawnPayload({
        ownerPubkey: "P".repeat(43),
        config: baseConfig(),
        secrets: {
          llmApiKey: "sk",
          llmProvider: "openai-compatible",
          llmEndpoint: "https://openrouter.ai/api/v1",
          llmModel: "anthropic/claude-3.5-sonnet",
          keypairBytes: validKeypair(),
        },
      })
    ).toBeNull();
  });
});

describe("createSpawn (encryption round-trip preserves provider)", () => {
  it("persists llmProvider/llmModel/llmEndpoint inside the encrypted blob", () => {
    const r = createSpawn(
      {
        ownerPubkey: "P".repeat(43),
        config: baseConfig(),
        secrets: {
          llmApiKey: "sk-x",
          llmProvider: "openai-compatible",
          llmEndpoint: "https://openrouter.ai/api/v1",
          llmModel: "anthropic/claude-3.5-sonnet",
          keypairBytes: validKeypair(),
        },
      },
      SECRET
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    const enc = JSON.parse(
      readFileSync(spawnEncCredsPath(r.record.spawnId), "utf8")
    ) as EncryptedRecord;
    const dec = decryptCreds<{
      llmApiKey: string;
      llmProvider: string;
      llmModel: string | null;
      llmEndpoint: string | null;
      keypairBytes: number[];
    }>(enc, SECRET);
    expect(dec.llmApiKey).toBe("sk-x");
    expect(dec.llmProvider).toBe("openai-compatible");
    expect(dec.llmModel).toBe("anthropic/claude-3.5-sonnet");
    expect(dec.llmEndpoint).toBe("https://openrouter.ai/api/v1");
    expect(dec.keypairBytes).toHaveLength(64);
  });

  it("defaults llmProvider to anthropic when omitted", () => {
    const r = createSpawn(
      {
        ownerPubkey: "P".repeat(43),
        config: baseConfig(),
        secrets: {
          llmApiKey: "sk-ant",
          keypairBytes: validKeypair(),
        },
      },
      SECRET
    );
    if (r.ok !== true) throw new Error("expected ok");
    const enc = JSON.parse(
      readFileSync(spawnEncCredsPath(r.record.spawnId), "utf8")
    ) as EncryptedRecord;
    const dec = decryptCreds<{ llmProvider: string }>(enc, SECRET);
    expect(dec.llmProvider).toBe("anthropic");
  });
});
