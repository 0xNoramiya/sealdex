// Bidder agent — discovers open auctions, evaluates each lot via an LLM with
// tool-use, and places sealed bids when the model decides the lot matches the
// principal's want-list.
//
// Deployment:
//   BIDDER_LLM_PROVIDER    "anthropic" (default) or "openai-compatible".
//                          When unset, falls back to anthropic if
//                          ANTHROPIC_API_KEY is present (back-compat).
//   BIDDER_LLM_API_KEY     Provider API key. Falls back to ANTHROPIC_API_KEY
//                          when provider is anthropic.
//   BIDDER_LLM_MODEL       Provider model id. Required for openai-compatible;
//                          defaults to claude-sonnet-4-6 for anthropic.
//   BIDDER_LLM_ENDPOINT    Required for openai-compatible. Base URL of the
//                          /v1/chat/completions API (with or without the
//                          path suffix — normalised on the way in).
//   ANTHROPIC_API_KEY      Legacy alias accepted when provider=anthropic.
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
import { Keypair } from "@solana/web3.js";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { atomicWriteJsonSync } from "../../mcp-server/src/atomic-write.js";
import {
  verifyAuctionPdaDerives,
  verifyRegistryEntry,
  type SignedRegistryEntry,
} from "../../mcp-server/src/registry-sign.js";
import { getLogger, type Logger } from "../../mcp-server/src/logger.js";
import {
  captureException,
  isEnabled as sentryEnabled,
} from "../../mcp-server/src/sentry.js";
import { PROGRAM_ID } from "../../mcp-server/src/client.js";
import { PublicKey } from "@solana/web3.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { placeBid } from "../../mcp-server/src/ops.js";
import {
  BIDDER_MODEL,
  BIDDER_SYSTEM_PROMPT,
  PLACE_BID_TOOL,
} from "./prompts.js";
import {
  makeLLMClient,
  resolveLLMRuntime,
  type LLMClient,
  type LLMToolUseBlock,
} from "./llm.js";
import {
  buildLotContext as pureBuildLotContext,
  checkBidCeiling,
  lotMatchesWantList,
  remainingBudget as pureRemainingBudget,
  slug as pureSlug,
  type BidderConfig as PureBidderConfig,
  type BidState as PureBidState,
  type RegistryEntry as PureRegistryEntry,
} from "./lib.js";

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
  /**
   * Optional. Base58 pubkey of the auctioneer that publishes the registry
   * feed. When set, every fetched entry must carry a `feed_signature`
   * verifiable against this pubkey or the entry is skipped — this defends
   * against tampered feeds (compromised CDN, MITM on a non-TLS link, or a
   * rogue mirror). When unset, signatures are still verified opportunistically
   * but missing-or-invalid signatures only log a warning.
   */
  trusted_publisher_pubkey?: string;
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

const slug = pureSlug;

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
  // Atomic rename so a crash mid-write can't leave a torn JSON file —
  // the bidder loop reads this on every iteration to compute remaining
  // budget, and a corrupt read would make us either skip lots or
  // double-spend.
  atomicWriteJsonSync(statePath, state);
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

const remainingBudget = (cfg: BidderConfig, state: BidState) =>
  pureRemainingBudget(cfg as PureBidderConfig, state as PureBidState);

const buildLotContext = (
  cfg: BidderConfig,
  state: BidState,
  entry: RegistryEntry,
  clusterUnixTime: number
) =>
  pureBuildLotContext(
    cfg as PureBidderConfig,
    state as PureBidState,
    entry as PureRegistryEntry,
    clusterUnixTime
  );

async function evaluateLot(
  client: LLMClient,
  model: string,
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

  // For Anthropic: render order is tools → system → messages and a cache
  // breakpoint on the last system block caches both tools AND system
  // together. The per-lot context sits AFTER the breakpoint and is
  // uncached, which is what we want — only the lot context varies.
  // For OpenAI-compatible: no caching, but the wire shape is the same.
  const response = await client.evaluate({
    systemPrompt: BIDDER_SYSTEM_PROMPT,
    userMessage: userContext,
    tools: [PLACE_BID_TOOL],
    model,
    maxTokens: 1024,
  });

  const cacheRead = response.usage.cacheReadTokens;
  const cacheCreation = response.usage.cacheCreationTokens;
  streamLog(streamPath, {
    kind: "agent_response",
    provider: client.providerName,
    auctionId: entry.auctionId,
    stop_reason: response.stopReason,
    usage: response.usage,
  });

  // Extract any text reasoning from the response (when the model skips
  // it emits text only; when it bids, it emits a tool_use block).
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
    (b): b is LLMToolUseBlock =>
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

const REGISTRY_FETCH_TIMEOUT_MS = 10_000;

async function fetchRegistry(localPath: string): Promise<RegistryEntry[]> {
  if (REGISTRY_URL) {
    // Guard against a stalled or unreachable registry host. Without this the
    // bidder loop can hang indefinitely on a single fetch() call.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REGISTRY_FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(REGISTRY_URL, {
        cache: "no-store",
        signal: ctrl.signal,
      });
    } catch (err) {
      if ((err as any)?.name === "AbortError") {
        throw new Error(
          `registry fetch timeout after ${REGISTRY_FETCH_TIMEOUT_MS}ms: ${REGISTRY_URL}`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
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
  const baseLog = getLogger("bidder");
  const configPath = process.argv[2];
  if (!configPath) {
    baseLog.fatal("missing config path argument", { usage: "tsx index.ts <config-path>" });
    process.exit(1);
  }
  const cfg = loadConfig(resolve(configPath));
  const tag = slug(cfg.name);
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  const statePath = resolve(STATE_DIR, `bidder-${tag}-state.json`);
  const streamPath = resolve(STATE_DIR, `bidder-${tag}-stream.jsonl`);
  const registryPath = resolve(STATE_DIR, "auction-registry.json");
  const state = loadOrInitState(statePath);

  let llmCfg;
  try {
    llmCfg = resolveLLMRuntime(process.env, { anthropicModel: BIDDER_MODEL });
  } catch (err) {
    baseLog.fatal("LLM runtime config invalid", {
      err: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
  const client = makeLLMClient(llmCfg);

  const myPubkey = bidderPubkey(cfg);
  const trustedPublisher = cfg.trusted_publisher_pubkey
    ? new PublicKey(cfg.trusted_publisher_pubkey)
    : null;
  // Per-process child logger keyed on the bidder's name + pubkey so
  // every line in this run is grep-friendly. Sentry shares the same
  // env (SENTRY_DSN) and is a no-op when unset.
  const log: Logger = baseLog.child({
    bidder: cfg.name,
    pubkey: myPubkey,
    sentry: sentryEnabled(),
  });
  log.info("bidder loop starting", {
    keypair: cfg.keypair_path,
    stream: streamPath,
    state: statePath,
    registry: REGISTRY_URL ?? `file://${registryPath}`,
    trustedPublisher: trustedPublisher?.toBase58() ?? null,
    llmProvider: llmCfg.provider,
    llmModel: llmCfg.model,
    llmEndpoint: llmCfg.endpoint ?? null,
  });
  if (!trustedPublisher) {
    log.warn(
      "trusted_publisher_pubkey not set — feed signatures verified opportunistically only"
    );
  }
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

      // When trustedPublisher is set, every entry must verify. The helper
      // short-circuits to ok=true when trustedPublisher is null so opt-out
      // bidders aren't gated.
      if (trustedPublisher) {
        const verification = verifyRegistryEntry(
          entry as unknown as Partial<SignedRegistryEntry>,
          trustedPublisher
        );
        if (!verification.ok) {
          streamLog(streamPath, {
            kind: "feed_verification_failed",
            auctionId: entry.auctionId,
            reason: verification.reason,
          });
          log.warn("skipping entry: feed signature failed", {
            auctionId: entry.auctionId,
            reason: verification.reason,
          });
          continue;
        }
      }

      // Independent of feed signing: verify the entry's claimed
      // auctionPda is the deterministic PDA derivation of its auctionId.
      // Catches a malicious-but-signed entry that lies about which PDA
      // an auctionId resolves to — without this check the bidder would
      // mis-derive its own bid PDA and place a bid that settle later
      // orphans.
      if (!verifyAuctionPdaDerives(entry, PROGRAM_ID)) {
        streamLog(streamPath, {
          kind: "auction_pda_mismatch",
          auctionId: entry.auctionId,
          claimedPda: entry.auctionPda,
        });
        log.warn("skipping entry: auctionPda derivation mismatch", {
          auctionId: entry.auctionId,
          claimedPda: entry.auctionPda,
        });
        continue;
      }

      // Pre-Claude lot filter: skip the API call entirely when no
      // want-list entry can match. Saves tokens (and money) at scale —
      // a 100-entry registry with a 2-line want_list is mostly noise to
      // Claude, and the cache only helps the system-prompt prefix, not
      // the per-lot context. We deliberately do NOT memoize the skip in
      // state.bidsPlaced — operators may update their want_list mid-run,
      // and re-checking is cheap (~microseconds per entry).
      const md = entry.lot.lot_metadata as { category?: string; grade?: number };
      if (
        !lotMatchesWantList(cfg.want_list, {
          category: md.category,
          grade: md.grade,
        })
      ) {
        streamLog(streamPath, {
          kind: "lot_skipped_pre_claude",
          auctionId: entry.auctionId,
          category: md.category,
          grade: md.grade,
        });
        continue;
      }

      try {
        const decision = await evaluateLot(
          client,
          llmCfg.model,
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
          log.warn("guardrail: amount exceeds remaining budget", {
            auctionId: entry.auctionId,
            amountUsdc,
            remaining,
          });
          continue;
        }

        // Last line of defense before signing: validate Claude's amount
        // against the principal's want_list ceiling AND the
        // risk-appetite multiplier. A compromised Claude or a
        // prompt-injection in lot_metadata could push a bid far above
        // the principal's stated max — this hard-rejects (rather than
        // clamps) so the operator sees the violation in the stream and
        // Sentry rather than silently winning at the wrong price.
        const md = entry.lot.lot_metadata as { category?: string; grade?: number };
        const ceiling = checkBidCeiling(cfg, md, amountUsdc);
        if (!ceiling.ok) {
          streamLog(streamPath, {
            kind: "ceiling_violation",
            auctionId: entry.auctionId,
            amountUsdc,
            reason: ceiling.reason,
            match: ceiling.match,
            hardCeiling: ceiling.hardCeiling,
          });
          log.error("ceiling violation: refusing to place bid", {
            auctionId: entry.auctionId,
            amountUsdc,
            reason: ceiling.reason,
            hardCeiling: ceiling.hardCeiling,
            maxValueUsdc: ceiling.match?.max_value_usdc,
          });
          captureException(
            new Error(`bidder ceiling violation: ${ceiling.reason}`),
            {
              op: "bidder.ceiling_check",
              bidder: cfg.name,
              auctionId: entry.auctionId,
              amountUsdc,
              reason: ceiling.reason,
            }
          );
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
        log.info("bid placed", {
          auctionId: entry.auctionId,
          amountUsdc,
          signature: result.signature,
          bidPda: result.bidPda,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        streamLog(streamPath, {
          kind: "evaluate_error",
          auctionId: entry.auctionId,
          error: msg,
        });
        log.error("evaluate / placeBid threw", {
          auctionId: entry.auctionId,
          err,
        });
        captureException(err, {
          op: "bidder.evaluate",
          bidder: cfg.name,
          auctionId: entry.auctionId,
        });
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  // Top-level catch: log + report + exit. Process manager (Fly,
  // systemd, etc.) restarts us, but we want the original failure
  // surfaced before the supervisor sees only the exit code.
  const log = getLogger("bidder");
  log.fatal("bidder fatal", { err: e });
  captureException(e, { op: "bidder.main" });
  process.exit(1);
});
