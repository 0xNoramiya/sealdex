// E2E smoke for iteration 22 — LLM endpoint pluggability.
//
// Spawns a BYOK agent in OpenAI-compatible mode pointed at a known
// host (we never actually call the host — we only assert that the
// worker forked the bidder with the correct BIDDER_LLM_* env vars).
//
// Run with:
//   yarn tsx lib/smoke-iter22.ts
// against a live `next dev`/`next start` on http://localhost:3000
// AND a running spawn-worker.

import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { readFileSync } from "node:fs";

const BASE = process.env.SEALDEX_SMOKE_BASE_URL ?? "http://localhost:3000";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function main() {
  const wallet = Keypair.generate();
  const pubkey = wallet.publicKey.toBase58();

  // 1a. GET /api/auth/nonce — server stamps a sealdex_nonce cookie.
  const nonceRes = await fetch(`${BASE}/api/auth/nonce`);
  if (!nonceRes.ok) fail(`/api/auth/nonce ${nonceRes.status}`);
  const { message } = (await nonceRes.json()) as {
    message: string;
    nonce: string;
    domain: string;
  };
  const nonceSetCookie = nonceRes.headers.get("set-cookie") ?? "";
  const nonceCookieMatch = nonceSetCookie.match(/(sealdex_nonce)=([^;]+)/);
  if (!nonceCookieMatch) fail("no nonce cookie returned");
  const nonceCookie = `${nonceCookieMatch[1]}=${nonceCookieMatch[2]}`;

  // 1b. Sign the message and POST /api/auth/verify with the nonce cookie.
  const sig = nacl.sign.detached(
    new TextEncoder().encode(message),
    wallet.secretKey
  );
  const verifyRes = await fetch(`${BASE}/api/auth/verify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: nonceCookie,
    },
    body: JSON.stringify({
      pubkey,
      signature: bs58.encode(sig),
    }),
  });
  if (!verifyRes.ok) {
    const txt = await verifyRes.text();
    fail(`/api/auth/verify ${verifyRes.status}: ${txt}`);
  }
  const setCookie = verifyRes.headers.get("set-cookie") ?? "";
  const cookieMatch = setCookie.match(/(sealdex_session_[^=]+)=([^;]+)/);
  if (!cookieMatch) fail("no session cookie set");
  const cookie = `${cookieMatch[1]}=${cookieMatch[2]}`;
  console.log("auth ✓");

  // 2. Spawn an openai-compatible agent.
  const bidderKp = Keypair.generate();
  const keypairBytes = Array.from(bidderKp.secretKey);

  const spawnPayload = {
    config: {
      name: `iter22-smoke-${Date.now()}`,
      want_list: [
        { category: "Vintage Holo", min_grade: 9, max_value_usdc: 1000 },
      ],
      total_budget_usdc: 5000,
      risk_appetite: "balanced" as const,
    },
    secrets: {
      llmApiKey: "sk-fake-test-key-do-not-call",
      llmProvider: "openai-compatible" as const,
      llmEndpoint: "https://example.invalid/v1",
      llmModel: "test-model-id",
      keypairBytes,
    },
  };
  const spawnRes = await fetch(`${BASE}/api/agents/spawn`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(spawnPayload),
  });
  if (!spawnRes.ok) {
    const body = await spawnRes.text();
    fail(`/api/agents/spawn ${spawnRes.status}: ${body}`);
  }
  const spawned = (await spawnRes.json()) as {
    spawnId: string;
    slug: string;
    name: string;
    status: string;
  };
  console.log(`spawned: ${spawned.slug} (id=${spawned.spawnId})`);

  // 3. Poll /api/agents/me for our pid.
  let pid: number | null = null;
  let lastStatus = "";
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const meRes = await fetch(`${BASE}/api/agents/me`, {
      headers: { cookie },
      cache: "no-store",
    });
    if (!meRes.ok) fail(`/api/agents/me ${meRes.status}`);
    const me = (await meRes.json()) as {
      spawns: Array<{
        spawnId: string;
        pid: number | null;
        status: string;
        message?: string | null;
      }>;
    };
    const ours = me.spawns.find((s) => s.spawnId === spawned.spawnId);
    if (!ours) fail("spawn missing from /me");
    pid = ours.pid;
    lastStatus = ours.status;
    if (ours.status === "errored") {
      fail(`spawn errored before we could read env: ${ours.message ?? "(none)"}`);
    }
    if (pid && Number.isFinite(pid) && pid > 0) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!pid) fail(`spawn never got a pid (last status: ${lastStatus})`);
  console.log(`bidder pid=${pid} status=${lastStatus}`);

  // 4. Read /proc/<pid>/environ — Linux-only.
  let environRaw: Buffer;
  try {
    environRaw = readFileSync(`/proc/${pid}/environ`);
  } catch (err) {
    fail(`could not read /proc/${pid}/environ — Linux required: ${(err as Error).message}`);
  }
  const env: Record<string, string> = {};
  for (const entry of environRaw.toString("utf8").split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  console.log("read /proc/<pid>/environ ✓");

  // 5. Assertions.
  const assertions: Array<[string, () => boolean]> = [
    ["BIDDER_LLM_PROVIDER === openai-compatible",
      () => env.BIDDER_LLM_PROVIDER === "openai-compatible"],
    ["BIDDER_LLM_ENDPOINT === https://example.invalid/v1",
      () => env.BIDDER_LLM_ENDPOINT === "https://example.invalid/v1"],
    ["BIDDER_LLM_MODEL === test-model-id",
      () => env.BIDDER_LLM_MODEL === "test-model-id"],
    ["BIDDER_LLM_API_KEY === sk-fake-test-key-do-not-call",
      () => env.BIDDER_LLM_API_KEY === "sk-fake-test-key-do-not-call"],
    ["SEALDEX_STATE_DIR includes spawnId",
      () => env.SEALDEX_STATE_DIR?.includes(spawned.spawnId) ?? false],
    ["legacy ANTHROPIC_API_KEY NOT inherited as the bidder's key",
      () => env.BIDDER_LLM_API_KEY !== env.ANTHROPIC_API_KEY ||
            env.BIDDER_LLM_API_KEY === "sk-fake-test-key-do-not-call"],
  ];
  let failed = 0;
  for (const [name, fn] of assertions) {
    if (fn()) {
      console.log(`✓ ${name}`);
    } else {
      console.error(`✗ ${name} (got ${JSON.stringify({
        provider: env.BIDDER_LLM_PROVIDER,
        endpoint: env.BIDDER_LLM_ENDPOINT,
        model: env.BIDDER_LLM_MODEL,
      })})`);
      failed++;
    }
  }

  // 6. Stop the spawn so the worker cleans up.
  await fetch(`${BASE}/api/agents/${encodeURIComponent(spawned.slug)}/stop`, {
    method: "POST",
    headers: { cookie },
  });
  console.log("stop ✓");

  if (failed > 0) {
    console.error(`✗ iter22 smoke FAILED — ${failed} assertion(s)`);
    process.exit(1);
  }
  console.log("✓ iter22 LLM-endpoint pluggability smoke PASSED");
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
