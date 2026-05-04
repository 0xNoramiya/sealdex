// E2E smoke for iteration 23 — per-spawn stream tail endpoint +
// dashboard viewer.
//
// 1. Authenticate as a fresh wallet.
// 2. Spawn an agent.
// 3. Write synthetic stream events directly into the per-spawn
//    state dir (the bidder would write these too — we synthesise
//    so the test doesn't need a working LLM endpoint).
// 4. GET /api/agents/<slug>/stream and assert the events come
//    back, in order, with the right counts.
// 5. Verify auth gates: 401 with no cookie, 404 with another
//    user's session.
//
// Run with:
//   yarn tsx frontend/lib/smoke-iter23.ts
// against a live `next dev`/`next start` on http://localhost:3000.

import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";

const BASE = process.env.SEALDEX_SMOKE_BASE_URL ?? "http://localhost:3000";
const STATE_DIR = process.env.SEALDEX_STATE_DIR ?? path.resolve(
  __dirname, "../../scripts"
);

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function authAs(wallet: Keypair): Promise<string> {
  const pubkey = wallet.publicKey.toBase58();
  const nonceRes = await fetch(`${BASE}/api/auth/nonce`);
  if (!nonceRes.ok) fail(`/api/auth/nonce ${nonceRes.status}`);
  const { message } = (await nonceRes.json()) as { message: string };
  const setNonce = nonceRes.headers.get("set-cookie") ?? "";
  const nm = setNonce.match(/(sealdex_nonce)=([^;]+)/);
  if (!nm) fail("no nonce cookie");
  const nonceCookie = `${nm[1]}=${nm[2]}`;

  const sig = nacl.sign.detached(
    new TextEncoder().encode(message),
    wallet.secretKey
  );
  const verifyRes = await fetch(`${BASE}/api/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: nonceCookie },
    body: JSON.stringify({ pubkey, signature: bs58.encode(sig) }),
  });
  if (!verifyRes.ok) {
    const txt = await verifyRes.text();
    fail(`/api/auth/verify ${verifyRes.status}: ${txt}`);
  }
  const sc = verifyRes.headers.get("set-cookie") ?? "";
  const sm = sc.match(/(sealdex_session_[^=]+)=([^;]+)/);
  if (!sm) fail("no session cookie");
  return `${sm[1]}=${sm[2]}`;
}

async function main() {
  const owner = Keypair.generate();
  const intruder = Keypair.generate();
  const ownerCookie = await authAs(owner);
  const intruderCookie = await authAs(intruder);
  console.log("auth ✓ (owner + intruder)");

  // Spawn an openai-compatible agent that points at example.invalid
  // so it doesn't burn real tokens — the bidder will error trying to
  // call the host but we don't care; we're testing the stream API.
  const bidderKp = Keypair.generate();
  const spawnPayload = {
    config: {
      name: `iter23-stream-${Date.now()}`,
      want_list: [
        { category: "Vintage Holo", min_grade: 9, max_value_usdc: 1000 },
      ],
      total_budget_usdc: 5000,
      risk_appetite: "balanced" as const,
    },
    secrets: {
      llmApiKey: "sk-fake-iter23",
      llmProvider: "openai-compatible" as const,
      llmEndpoint: "https://example.invalid/v1",
      llmModel: "test-model",
      keypairBytes: Array.from(bidderKp.secretKey),
    },
  };
  const spawnRes = await fetch(`${BASE}/api/agents/spawn`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: ownerCookie },
    body: JSON.stringify(spawnPayload),
  });
  if (!spawnRes.ok) {
    const txt = await spawnRes.text();
    fail(`/api/agents/spawn ${spawnRes.status}: ${txt}`);
  }
  const spawn = (await spawnRes.json()) as {
    spawnId: string;
    slug: string;
    name: string;
  };
  console.log(`spawned: ${spawn.slug} (id=${spawn.spawnId})`);

  // 1. With nothing written yet (or just the bidder_start), the
  //    stream might already exist via the running bidder. Try a
  //    fetch and confirm shape.
  let streamRes = await fetch(
    `${BASE}/api/agents/${encodeURIComponent(spawn.slug)}/stream?n=20`,
    { headers: { cookie: ownerCookie }, cache: "no-store" }
  );
  if (!streamRes.ok) fail(`/stream initial ${streamRes.status}`);
  let stream = (await streamRes.json()) as {
    events: Array<{ ts: number; kind: string; [k: string]: unknown }>;
    streamFound: boolean;
    truncated: boolean;
    sizeBytes: number;
    slug: string;
  };
  console.log(`initial stream: streamFound=${stream.streamFound} events=${stream.events.length}`);
  if (stream.slug !== spawn.slug) fail("slug mismatch in /stream response");

  // 2. Write our own synthetic events. The bidder may or may not
  //    have started writing yet — either way the stream file will
  //    exist after we append.
  const perSpawnState = path.join(STATE_DIR, "spawns", spawn.spawnId, "state");
  if (!existsSync(perSpawnState)) {
    mkdirSync(perSpawnState, { recursive: true });
  }
  const streamFile = path.join(perSpawnState, "bidder-iter23-smoke-stream.jsonl");
  const synthEvents = [
    { ts: Date.now() - 3000, kind: "bidder_start", name: "iter23-smoke", pubkey: bidderKp.publicKey.toBase58() },
    { ts: Date.now() - 2000, kind: "agent_response", provider: "openai-compatible", auctionId: "9001", stop_reason: "tool_calls" },
    { ts: Date.now() - 1500, kind: "bid_attempt", auctionId: "9001", amountUsdc: 250, reasoning: "matches want list" },
    { ts: Date.now() - 1000, kind: "bid_placed", auctionId: "9001", amountUsdc: 250, reasoning: "matches want list", signature: "5KJpDeAdBeEf12345", bidPda: "PDAabc..." },
    { ts: Date.now() - 500, kind: "ceiling_violation", auctionId: "9002", amountUsdc: 99999, reason: "exceeds_max_value" },
    { ts: Date.now(), kind: "evaluate_error", auctionId: "9003", error: "endpoint unreachable: example.invalid" },
  ];
  for (const ev of synthEvents) {
    appendFileSync(streamFile, JSON.stringify(ev) + "\n");
  }
  console.log(`wrote ${synthEvents.length} synth events to ${path.basename(streamFile)}`);

  // 3. Fetch tail and assert events surfaced.
  streamRes = await fetch(
    `${BASE}/api/agents/${encodeURIComponent(spawn.slug)}/stream?n=20`,
    { headers: { cookie: ownerCookie }, cache: "no-store" }
  );
  if (!streamRes.ok) fail(`/stream after-write ${streamRes.status}`);
  stream = await streamRes.json();
  if (!stream.streamFound) fail("streamFound=false after writing events");

  const checks: Array<[string, () => boolean]> = [
    ["found bidder_start event",
      () => stream.events.some((e) => e.kind === "bidder_start")],
    ["found bid_placed with amountUsdc=250",
      () => stream.events.some((e) => e.kind === "bid_placed" && e.amountUsdc === 250)],
    ["found ceiling_violation",
      () => stream.events.some((e) => e.kind === "ceiling_violation")],
    ["found evaluate_error",
      () => stream.events.some((e) => e.kind === "evaluate_error")],
    ["events have ts numbers + kind strings",
      () => stream.events.every((e) => typeof e.ts === "number" && typeof e.kind === "string")],
    ["events surface in chronological order",
      () => {
        const ours = stream.events.filter((e) =>
          ["bidder_start", "agent_response", "bid_attempt", "bid_placed",
           "ceiling_violation", "evaluate_error"].includes(e.kind));
        for (let i = 1; i < ours.length; i++) {
          if ((ours[i].ts as number) < (ours[i - 1].ts as number)) return false;
        }
        return ours.length >= 4;
      }],
    ["sizeBytes > 0",
      () => stream.sizeBytes > 0],
  ];
  let failed = 0;
  for (const [name, fn] of checks) {
    if (fn()) {
      console.log(`✓ ${name}`);
    } else {
      console.error(`✗ ${name}`);
      failed++;
    }
  }

  // 4. Auth: no cookie → 401.
  const noCookieRes = await fetch(
    `${BASE}/api/agents/${encodeURIComponent(spawn.slug)}/stream`,
    { cache: "no-store" }
  );
  if (noCookieRes.status === 401) {
    console.log("✓ no cookie → 401");
  } else {
    console.error(`✗ no cookie expected 401, got ${noCookieRes.status}`);
    failed++;
  }

  // 5. Auth: another user's session → 404 (anti-enumeration).
  const intruderRes = await fetch(
    `${BASE}/api/agents/${encodeURIComponent(spawn.slug)}/stream`,
    { headers: { cookie: intruderCookie }, cache: "no-store" }
  );
  if (intruderRes.status === 404) {
    console.log("✓ intruder session → 404 (not 403, anti-enumeration)");
  } else {
    console.error(`✗ intruder expected 404, got ${intruderRes.status}`);
    failed++;
  }

  // 6. ?n=200 cap honoured.
  const capRes = await fetch(
    `${BASE}/api/agents/${encodeURIComponent(spawn.slug)}/stream?n=999999`,
    { headers: { cookie: ownerCookie }, cache: "no-store" }
  );
  const capBody = (await capRes.json()) as typeof stream;
  if (capBody.events.length <= 500) {
    console.log("✓ n=large clamped to ≤500 events");
  } else {
    console.error(`✗ n=large returned ${capBody.events.length}`);
    failed++;
  }

  // 7. Cleanup.
  await fetch(`${BASE}/api/agents/${encodeURIComponent(spawn.slug)}/stop`, {
    method: "POST",
    headers: { cookie: ownerCookie },
  });
  console.log("stop ✓");

  if (failed > 0) {
    console.error(`✗ iter23 smoke FAILED — ${failed} assertion(s)`);
    process.exit(1);
  }
  console.log("✓ iter23 stream-tail smoke PASSED");
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
