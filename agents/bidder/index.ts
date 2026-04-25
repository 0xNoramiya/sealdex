// Bidder agent — discovers open auctions, evaluates each lot via Claude with
// tool-use, and places sealed bids when Claude decides the lot matches the
// principal's want-list.
//
// Deployment:
//   ANTHROPIC_API_KEY      Required. Operator's Claude API key.
//   SOLANA_RPC_URL         Base layer RPC. Helius recommended for production:
//                          https://devnet.helius-rpc.com/?api-key=<key>
//   SEALDEX_REGISTRY_URL   HTTP endpoint that returns the auction registry as
//                          a JSON array. When unset, falls back to a local
//                          file at <state-dir>/auction-registry.json (used
//                          when the bidder runs alongside the auctioneer).
//   SEALDEX_STATE_DIR      Where bidder state + stream JSONL files live.
//                          Default: <repo>/scripts.
//
// Usage: tsx index.ts <config-path>
//   e.g. tsx index.ts configs/alpha.json
import Anthropic from "@anthropic-ai/sdk";
import { Keypair } from "@solana/web3.js";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { placeBid } from "../../mcp-server/src/ops.js";
import {
  BIDDER_MODEL,
  BIDDER_SYSTEM_PROMPT,
  PLACE_BID_TOOL,
} from "./prompts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const REGISTRY_URL = process.env.SEALDEX_REGISTRY_URL?.trim() || null;
const STATE_DIR = process.env.SEALDEX_STATE_DIR
  ? resolve(process.env.SEALDEX_STATE_DIR)
  : resolve(ROOT, "scripts");

interface BidderConfig {
  name: string;
  keypair_path: string;
  want_list: Array<{
    category: string;
    min_grade: number;
    max_value_usdc: number;
  }>;
  total_budget_usdc: number;
  risk_appetite: "conservative" | "balanced" | "aggressive";
}

interface RegistryEntry {
  auctionId: string;
  auctionPda: string;
  lot: {
    lot_id: number;
    lot_metadata: Record<string, any>;
    duration_seconds: number;
  };
  endTimeUnix: number;
  signature: string;
}

interface BidState {
  bidsPlaced: Record<
    string,
    { amountUsdc: number; reasoning: string; signature: string; ts: number }
  >;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadConfig(configPath: string): BidderConfig {
  const cfg = loadJson<BidderConfig>(configPath);
  if (!cfg.keypair_path.startsWith("/")) {
    cfg.keypair_path = resolve(ROOT, cfg.keypair_path);
  }
  return cfg;
}

function loadOrInitState(statePath: string): BidState {
  try {
    return loadJson<BidState>(statePath);
  } catch {
    return { bidsPlaced: {} };
  }
}

function saveState(statePath: string, state: BidState) {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function streamLog(streamPath: string, record: Record<string, unknown>) {
  appendFileSync(
    streamPath,
    JSON.stringify({ ts: Date.now(), ...record }) + "\n"
  );
}

function bidderPubkey(cfg: BidderConfig): string {
  const raw = JSON.parse(readFileSync(cfg.keypair_path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw)).publicKey.toBase58();
}

function remainingBudget(cfg: BidderConfig, state: BidState): number {
  let spent = 0;
  for (const v of Object.values(state.bidsPlaced)) spent += v.amountUsdc;
  return cfg.total_budget_usdc - spent;
}

function buildLotContext(
  cfg: BidderConfig,
  state: BidState,
  entry: RegistryEntry,
  clusterUnixTime: number
): string {
  const md = entry.lot.lot_metadata;
  const timeLeftSeconds = Math.max(0, entry.endTimeUnix - clusterUnixTime);
  return [
    `# CURRENT LOT EVALUATION`,
    ``,
    `auction_id: ${entry.auctionId}`,
    `time_left_seconds: ${timeLeftSeconds}`,
    `risk_appetite: ${cfg.risk_appetite}`,
    `remaining_budget: ${remainingBudget(cfg, state)}`,
    ``,
    `want_list: ${JSON.stringify(cfg.want_list)}`,
    ``,
    `lot:`,
    `  category: ${md.category}`,
    `  grade: ${md.grade}`,
    `  year: ${md.year ?? "n/a"}`,
    `  serial: ${md.serial ?? "n/a"}`,
    `  estimate_low_usdc: ${md.estimate_low_usdc ?? "n/a"}`,
    `  estimate_high_usdc: ${md.estimate_high_usdc ?? "n/a"}`,
    `  cert_number: ${md.cert_number ?? "n/a"}`,
    ``,
    `Decide: bid via place_bid, or skip with a short text reply.`,
  ].join("\n");
}

async function evaluateLot(
  client: Anthropic,
  cfg: BidderConfig,
  state: BidState,
  entry: RegistryEntry,
  clusterUnixTime: number,
  streamPath: string
): Promise<{
  toolCalled: boolean;
  amountUsdc?: number;
  reasoning?: string;
  cacheReadTokens: number;
  cacheCreationTokens: number;
} | null> {
  const userContext = buildLotContext(cfg, state, entry, clusterUnixTime);

  // Render order is tools → system → messages. A cache breakpoint on the
  // last system block caches both tools AND system together. The user
  // message (per-lot context) sits AFTER the breakpoint and is uncached,
  // which is what we want — only the lot context varies per call.
  const response = await client.messages.create({
    model: BIDDER_MODEL,
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: BIDDER_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [PLACE_BID_TOOL],
    messages: [{ role: "user", content: userContext }],
  });

  const cacheRead = response.usage.cache_read_input_tokens ?? 0;
  const cacheCreation = response.usage.cache_creation_input_tokens ?? 0;
  streamLog(streamPath, {
    kind: "claude_response",
    auctionId: entry.auctionId,
    stop_reason: response.stop_reason,
    usage: response.usage,
  });

  // Extract any text reasoning from the response (when Claude skips, it
  // emits text only; when Claude bids, it emits a tool_use block).
  for (const block of response.content) {
    if (block.type === "text" && block.text.trim().length > 0) {
      streamLog(streamPath, {
        kind: "agent_text",
        auctionId: entry.auctionId,
        text: block.text,
      });
    }
  }

  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock =>
      b.type === "tool_use" && b.name === "place_bid"
  );
  if (!toolBlock) {
    return {
      toolCalled: false,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
    };
  }
  const input = toolBlock.input as { amount_usdc?: number; reasoning?: string };
  if (!input?.amount_usdc || !input?.reasoning) {
    streamLog(streamPath, {
      kind: "agent_error",
      auctionId: entry.auctionId,
      error: "place_bid called without required fields",
      input,
    });
    return {
      toolCalled: false,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
    };
  }

  return {
    toolCalled: true,
    amountUsdc: Math.floor(input.amount_usdc),
    reasoning: input.reasoning,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
  };
}

async function fetchRegistry(localPath: string): Promise<RegistryEntry[]> {
  if (REGISTRY_URL) {
    const res = await fetch(REGISTRY_URL, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`registry fetch ${res.status}: ${REGISTRY_URL}`);
    }
    const data = (await res.json()) as RegistryEntry[];
    if (!Array.isArray(data)) {
      throw new Error(`registry url returned non-array: ${typeof data}`);
    }
    return data;
  }
  return loadJson<RegistryEntry[]>(localPath);
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error("Usage: tsx index.ts <config-path>");
    process.exit(1);
  }
  const cfg = loadConfig(resolve(configPath));
  const tag = slug(cfg.name);
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  const statePath = resolve(STATE_DIR, `bidder-${tag}-state.json`);
  const streamPath = resolve(STATE_DIR, `bidder-${tag}-stream.jsonl`);
  const registryPath = resolve(STATE_DIR, "auction-registry.json");
  const state = loadOrInitState(statePath);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY env var is required");
    process.exit(1);
  }
  const client = new Anthropic();

  const myPubkey = bidderPubkey(cfg);
  console.log(`🤖 ${cfg.name} (${myPubkey.slice(0, 8)}…) starting bidder loop`);
  console.log(`   keypair:  ${cfg.keypair_path}`);
  console.log(`   stream:   ${streamPath}`);
  console.log(`   state:    ${statePath}`);
  console.log(
    `   registry: ${REGISTRY_URL ?? `file://${registryPath}`}`,
  );
  streamLog(streamPath, {
    kind: "bidder_start",
    name: cfg.name,
    pubkey: myPubkey,
    config: { ...cfg, keypair_path: undefined },
  });

  const POLL_MS = 5000;
  while (true) {
    let registry: RegistryEntry[] = [];
    try {
      registry = await fetchRegistry(registryPath);
    } catch {
      // No registry available yet — either auctioneer hasn't run, or the
      // remote URL isn't serving entries yet. Sleep and retry.
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }

    // Cluster time once per cycle is enough for time_left_seconds estimates.
    const clusterUnixTime = Math.floor(Date.now() / 1000);

    for (const entry of registry) {
      if (state.bidsPlaced[entry.auctionId]) continue;
      if (entry.endTimeUnix <= clusterUnixTime - 60) continue; // expired well past

      try {
        const decision = await evaluateLot(
          client,
          cfg,
          state,
          entry,
          clusterUnixTime,
          streamPath
        );
        if (!decision) continue;

        if (!decision.toolCalled) {
          // Skipped — no bid submitted. Mark as evaluated so we don't re-evaluate
          // every cycle (saves Claude tokens). Use a sentinel record.
          state.bidsPlaced[entry.auctionId] = {
            amountUsdc: 0,
            reasoning: "skipped",
            signature: "",
            ts: Date.now(),
          };
          saveState(statePath, state);
          continue;
        }

        const amountUsdc = decision.amountUsdc!;
        const remaining = remainingBudget(cfg, state);
        if (amountUsdc > remaining) {
          streamLog(streamPath, {
            kind: "guardrail_block",
            auctionId: entry.auctionId,
            reason: `bid ${amountUsdc} > remaining ${remaining}`,
          });
          continue;
        }

        // Convert USDC whole units → micro-USDC (6 decimals) for the program.
        const amountNative = (BigInt(amountUsdc) * 1_000_000n).toString();
        streamLog(streamPath, {
          kind: "bid_attempt",
          auctionId: entry.auctionId,
          amountUsdc,
          reasoning: decision.reasoning,
        });

        const result = await placeBid({
          auctionId: entry.auctionId,
          amount: amountNative,
          bidderKeypairPath: cfg.keypair_path,
        });
        state.bidsPlaced[entry.auctionId] = {
          amountUsdc,
          reasoning: decision.reasoning!,
          signature: result.signature,
          ts: Date.now(),
        };
        saveState(statePath, state);
        streamLog(streamPath, {
          kind: "bid_placed",
          auctionId: entry.auctionId,
          amountUsdc,
          reasoning: decision.reasoning,
          signature: result.signature,
          bidPda: result.bidPda,
        });
        console.log(
          `🟢 ${cfg.name} bid $${amountUsdc} on auction ${entry.auctionId} (sig ${result.signature.slice(0, 8)}…)`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        streamLog(streamPath, {
          kind: "evaluate_error",
          auctionId: entry.auctionId,
          error: msg,
        });
        console.error(
          `❌ ${cfg.name} failed evaluating auction ${entry.auctionId}: ${msg}`
        );
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.error("bidder fatal:", e);
  process.exit(1);
});
