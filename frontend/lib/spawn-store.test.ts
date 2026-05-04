import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// IMPORTANT: spawn-store reads SEALDEX_STATE_DIR at module import time.
// Each test run gets its own tmpdir → set BEFORE the first import.
let TMP: string;
beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "sealdex-spawn-"));
  process.env.SEALDEX_STATE_DIR = TMP;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.SEALDEX_STATE_DIR;
});

async function load() {
  return import("./spawn-store");
}

describe("uniqueSlugFor", () => {
  it("returns a slug from a freeform name", async () => {
    const m = await load();
    expect(m.uniqueSlugFor("My Bidder!")).toBe("my-bidder");
  });

  it("appends -2/-3 on collisions", async () => {
    const m = await load();
    m.appendSpawn(record("a", "alpha"));
    expect(m.uniqueSlugFor("alpha")).toBe("alpha-2");
    m.appendSpawn(record("b", "alpha-2"));
    expect(m.uniqueSlugFor("alpha")).toBe("alpha-3");
  });

  it("falls back to 'agent' for fully non-alphanumeric input", async () => {
    const m = await load();
    expect(m.uniqueSlugFor("!!!")).toBe("agent");
  });

  it("clamps slug length to 32 chars", async () => {
    const m = await load();
    const slug = m.uniqueSlugFor("a".repeat(80));
    expect(slug.length).toBeLessThanOrEqual(32);
  });
});

describe("appendSpawn / listOwnedBy / getSpawn", () => {
  it("persists across module reloads (atomic writes hit disk)", async () => {
    {
      const m = await load();
      m.appendSpawn(record("id-1", "alpha", "WALLET_A"));
      m.appendSpawn(record("id-2", "beta", "WALLET_B"));
    }
    vi.resetModules();
    const m2 = await load();
    expect(m2.listAllSpawns()).toHaveLength(2);
    expect(m2.getSpawn("id-1")?.slug).toBe("alpha");
  });

  it("rejects duplicate spawn ids", async () => {
    const m = await load();
    m.appendSpawn(record("id-1", "alpha"));
    expect(() => m.appendSpawn(record("id-1", "beta"))).toThrow(/already exists/);
  });

  it("rejects duplicate slugs", async () => {
    const m = await load();
    m.appendSpawn(record("id-1", "alpha"));
    expect(() => m.appendSpawn(record("id-2", "alpha"))).toThrow(/already in use/);
  });

  it("listOwnedBy returns only the caller's spawns", async () => {
    const m = await load();
    m.appendSpawn(record("id-a", "alpha", "WALLET_A"));
    m.appendSpawn(record("id-b", "beta", "WALLET_B"));
    m.appendSpawn(record("id-c", "gamma", "WALLET_A"));
    const a = m.listOwnedBy("WALLET_A");
    expect(a.map((r) => r.slug).sort()).toEqual(["alpha", "gamma"]);
    expect(m.listOwnedBy("WALLET_B").map((r) => r.slug)).toEqual(["beta"]);
    expect(m.listOwnedBy("UNKNOWN")).toEqual([]);
    expect(m.listOwnedBy("")).toEqual([]);
  });
});

describe("updateSpawn", () => {
  it("merges fields and bumps updatedAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    const m = await load();
    m.appendSpawn(record("id-1", "alpha"));
    vi.setSystemTime(new Date(1_700_000_999_000));
    const updated = m.updateSpawn("id-1", { status: "stopped", message: "owner stop" });
    expect(updated.status).toBe("stopped");
    expect(updated.message).toBe("owner stop");
    expect(updated.updatedAt).toBe(1_700_000_999);
    vi.useRealTimers();
  });

  it("throws on unknown spawnId", async () => {
    const m = await load();
    expect(() => m.updateSpawn("not-real", {})).toThrow(/not found/);
  });

  it("ignores attempts to overwrite spawnId", async () => {
    const m = await load();
    m.appendSpawn(record("id-1", "alpha"));
    const r = m.updateSpawn("id-1", { spawnId: "OTHER" } as any);
    expect(r.spawnId).toBe("id-1");
  });
});

describe("path helpers", () => {
  it("spawnDir/configPath/credsPath/runtimeKeypairPath are stable for the same id", async () => {
    const m = await load();
    expect(m.spawnConfigPath("abc")).toBe(`${m.spawnDir("abc")}/config.json`);
    expect(m.spawnEncCredsPath("abc")).toBe(`${m.spawnDir("abc")}/creds.enc.json`);
    expect(m.spawnRuntimeKeypairPath("abc")).toBe(
      `${m.spawnDir("abc")}/creds-runtime/keypair.json`
    );
  });
});

function record(
  spawnId: string,
  slug: string,
  ownerPubkey = "OWNER_DEFAULT"
) {
  const now = Math.floor(Date.now() / 1000);
  return {
    spawnId,
    slug,
    ownerPubkey,
    name: slug,
    startedAt: now,
    updatedAt: now,
    status: "running" as const,
    pid: null,
  };
}
