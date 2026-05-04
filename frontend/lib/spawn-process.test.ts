import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let TMP: string;
beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "sealdex-spawn-proc-"));
  process.env.SEALDEX_STATE_DIR = TMP;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.SEALDEX_STATE_DIR;
});

async function load() {
  return import("./spawn-process");
}

describe("buildChildEnv", () => {
  it("defaults provider to anthropic and only emits defined inputs", async () => {
    const m = await load();
    const env = m.buildChildEnv({
      llmApiKey: "sk-test",
      perSpawnStateDir: "/tmp/x",
    });
    expect(env.BIDDER_LLM_PROVIDER).toBe("anthropic");
    expect(env.BIDDER_LLM_API_KEY).toBe("sk-test");
    expect(env.SEALDEX_STATE_DIR).toBe("/tmp/x");
    // Optional fields not set → not present (so process.env merge is clean).
    expect(env.BIDDER_LLM_MODEL).toBeUndefined();
    expect(env.BIDDER_LLM_ENDPOINT).toBeUndefined();
    expect(env.SOLANA_RPC_URL).toBeUndefined();
    expect(env.SEALDEX_REGISTRY_URL).toBeUndefined();
    expect(env.SEALDEX_IDL_PATH).toBeUndefined();
    expect(env.LOG_LEVEL).toBeUndefined();
    expect(env.SENTRY_DSN).toBeUndefined();
  });

  it("threads through every optional input when supplied", async () => {
    const m = await load();
    const env = m.buildChildEnv({
      llmApiKey: "sk",
      llmProvider: "openai-compatible",
      llmModel: "gpt-4o-mini",
      llmEndpoint: "https://openrouter.ai/api/v1",
      perSpawnStateDir: "/p",
      solanaRpcUrl: "https://devnet.example",
      sealdexRegistryUrl: "https://sealdex.example/api/auctions",
      sealdexIdlPath: "/idl/sealdex_auction.json",
      logLevel: "debug",
      sentryDsn: "https://k@s/1",
    });
    expect(env).toEqual({
      BIDDER_LLM_PROVIDER: "openai-compatible",
      BIDDER_LLM_API_KEY: "sk",
      BIDDER_LLM_MODEL: "gpt-4o-mini",
      BIDDER_LLM_ENDPOINT: "https://openrouter.ai/api/v1",
      SEALDEX_STATE_DIR: "/p",
      SOLANA_RPC_URL: "https://devnet.example",
      SEALDEX_REGISTRY_URL: "https://sealdex.example/api/auctions",
      SEALDEX_IDL_PATH: "/idl/sealdex_auction.json",
      LOG_LEVEL: "debug",
      SENTRY_DSN: "https://k@s/1",
    });
  });

  it("treats null model/endpoint as omitted (worker passes nulls when unset)", async () => {
    const m = await load();
    const env = m.buildChildEnv({
      llmApiKey: "sk",
      llmProvider: "anthropic",
      llmModel: null,
      llmEndpoint: null,
      perSpawnStateDir: "/p",
    });
    expect(env.BIDDER_LLM_MODEL).toBeUndefined();
    expect(env.BIDDER_LLM_ENDPOINT).toBeUndefined();
  });

  it("does NOT read process.env (purity contract)", async () => {
    process.env.BIDDER_LLM_API_KEY = "should-not-leak";
    process.env.ANTHROPIC_API_KEY = "should-not-leak-2";
    const m = await load();
    const env = m.buildChildEnv({
      llmApiKey: "explicit-key",
      perSpawnStateDir: "/p",
    });
    expect(env.BIDDER_LLM_API_KEY).toBe("explicit-key");
    delete process.env.BIDDER_LLM_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });
});

describe("perSpawnStateDir", () => {
  it("places state under the spawn's own dir for cleanup-with-spawn", async () => {
    const m = await load();
    const ssd = m.perSpawnStateDir("abc-123");
    expect(ssd).toBe(`${TMP}/spawns/abc-123/state`);
  });
});

describe("materializeRuntimeKeypair", () => {
  it("writes keypair JSON with mode 0600", async () => {
    const m = await load();
    const bytes = Array.from({ length: 64 }, (_, i) => i & 0xff);
    const target = m.materializeRuntimeKeypair("kp-spawn-1", bytes);
    expect(target).toBe(`${TMP}/spawns/kp-spawn-1/creds-runtime/keypair.json`);

    const onDisk = JSON.parse(readFileSync(target, "utf8"));
    expect(onDisk).toEqual(bytes);

    // POSIX mode bits — only the low 9 matter for permissions.
    const mode = statSync(target).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("rejects keypairBytes of the wrong length", async () => {
    const m = await load();
    expect(() => m.materializeRuntimeKeypair("k", [1, 2, 3])).toThrow();
    expect(() => m.materializeRuntimeKeypair("k", new Array(63).fill(0))).toThrow();
    expect(() => m.materializeRuntimeKeypair("k", new Array(65).fill(0))).toThrow();
  });

  it("rejects non-array input defensively", async () => {
    const m = await load();
    expect(() => m.materializeRuntimeKeypair("k", "abc" as any)).toThrow();
    expect(() => m.materializeRuntimeKeypair("k", null as any)).toThrow();
  });

  it("overwrites an existing runtime keypair (idempotent worker reattach)", async () => {
    const m = await load();
    const a = new Array(64).fill(1);
    const b = new Array(64).fill(2);
    m.materializeRuntimeKeypair("kp-spawn-2", a);
    m.materializeRuntimeKeypair("kp-spawn-2", b);
    const target = `${TMP}/spawns/kp-spawn-2/creds-runtime/keypair.json`;
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(b);
  });
});

describe("teardownSpawnRuntime", () => {
  it("removes only the creds-runtime dir, leaves state intact", async () => {
    const m = await load();
    const bytes = new Array(64).fill(0);
    m.materializeRuntimeKeypair("kp-spawn-3", bytes);
    // Pretend the bidder wrote a stream file under state/.
    const stateDir = m.perSpawnStateDir("kp-spawn-3");
    require("node:fs").mkdirSync(stateDir, { recursive: true });
    require("node:fs").writeFileSync(`${stateDir}/bidder-stream.jsonl`, "{}\n");

    m.teardownSpawnRuntime("kp-spawn-3");

    expect(
      require("node:fs").existsSync(
        `${TMP}/spawns/kp-spawn-3/creds-runtime`
      )
    ).toBe(false);
    expect(require("node:fs").existsSync(`${stateDir}/bidder-stream.jsonl`)).toBe(true);
  });

  it("is idempotent when the runtime dir doesn't exist yet", async () => {
    const m = await load();
    expect(() => m.teardownSpawnRuntime("never-spawned")).not.toThrow();
  });
});

describe("isPidAlive", () => {
  it("returns true for our own process", async () => {
    const m = await load();
    expect(m.isPidAlive(process.pid)).toBe(true);
  });

  it("returns false for null / undefined / negative / zero", async () => {
    const m = await load();
    expect(m.isPidAlive(null)).toBe(false);
    expect(m.isPidAlive(undefined)).toBe(false);
    expect(m.isPidAlive(0)).toBe(false);
    expect(m.isPidAlive(-1)).toBe(false);
  });

  it("returns false for a definitely-dead pid", async () => {
    const m = await load();
    // PID 0x7fff_ffff is the max for a 32-bit signed int — extremely
    // unlikely to be in use on any system. ESRCH expected.
    expect(m.isPidAlive(0x7fffffff)).toBe(false);
  });
});
