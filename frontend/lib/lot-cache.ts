// In-process cache for /api/lot responses. The frontend polls the
// endpoint every 2s; without a cache, each visitor produces an
// independent stack of RPC reads + filesystem walks. The cache
// coalesces concurrent requests into a single computation per ~1s
// window per auction.
//
// Designed to be safe across the Next.js dev → prod transition: a Map
// is fine on a single process, and Fly currently runs one instance.
// If we ever scale horizontally, swap this for Redis with the same
// interface.

import {
  readAuction,
  clusterUnixTime,
  type AuctionView,
} from "./onchain";
import {
  readBidderStates,
  readBidderStream,
  readBidderIdentity,
  readRegistry,
  type BidderStreamEntry,
} from "./registry";

export interface LotPayload {
  hasLiveData: boolean;
  auctionId: string | null;
  auctionPda: string | null;
  signature: string | null;
  endTimeUnix: number | null;
  status: AuctionView["status"] | null;
  winner: string | null;
  winningBidNative: string | null;
  clusterUnix: number;
  lot: Record<string, any> | null;
  bidders: Array<{
    name: string;
    pubkey: string;
    pubkeyFull: string;
    tag: string;
    agentSlug: string;
    bidPlaced: boolean;
    amountUsdc: number | null;
    reasoning: string | null;
    isWinner: boolean;
  }>;
  reasoning: BidderStreamEntry[];
}

const TTL_MS = 750; // < client poll period (2000ms) — coalesces neighbours.

interface Entry {
  expiresAt: number;
  payload: LotPayload;
  /** Hash of the payload's mutable surface — used to dedupe SSE pushes. */
  fingerprint: string;
}

const cache = new Map<string, Entry>();

function shortPubkey(pk: string): string {
  if (!pk || pk.length < 12) return pk;
  return `${pk.slice(0, 4)}…${pk.slice(-4)}`;
}

async function compute(queryAuctionId: string | null): Promise<LotPayload> {
  const registry = readRegistry();
  const states = readBidderStates();

  const entry =
    (queryAuctionId &&
      registry.find((r) => r.auctionId === queryAuctionId)) ||
    registry[registry.length - 1];

  if (!entry) {
    let clusterUnix = Math.floor(Date.now() / 1000);
    try {
      clusterUnix = await clusterUnixTime();
    } catch {
      /* fall through */
    }
    return {
      hasLiveData: false,
      auctionId: null,
      auctionPda: null,
      signature: null,
      endTimeUnix: null,
      status: null,
      winner: null,
      winningBidNative: null,
      clusterUnix,
      lot: null,
      bidders: [],
      reasoning: [],
    };
  }

  const [auction, clusterUnix] = await Promise.all([
    readAuction(entry.auctionId).catch(() => null),
    clusterUnixTime().catch(() => Math.floor(Date.now() / 1000)),
  ]);

  const bidders = states
    .map((s) => {
      const placed = s.bidsPlaced[entry.auctionId];
      const identity = readBidderIdentity(s.agentSlug);
      const stream = readBidderStream(s.agentSlug, 200);
      const lastReasoning =
        stream
          .filter(
            (e) =>
              e.auctionId === entry.auctionId &&
              (e.kind === "bid_attempt" || e.kind === "agent_text")
          )
          .map((e) => (e as any).reasoning ?? (e as any).text)
          .filter((t): t is string => typeof t === "string" && t.length > 0)
          .slice(-1)[0] ?? null;
      const name = identity?.name ?? `Bidder ${s.agentSlug}`;
      const pubkey = identity?.pubkey ?? "";
      const tag = identity?.tag ?? s.agentSlug.charAt(0).toUpperCase();
      const winnerMatch =
        auction?.winner && pubkey && auction.winner === pubkey;
      const amountUsdc =
        auction?.status === "Settled" && placed && placed.amountUsdc > 0
          ? placed.amountUsdc
          : null;
      return {
        name,
        pubkey: pubkey ? shortPubkey(pubkey) : "—",
        pubkeyFull: pubkey ?? "",
        tag,
        agentSlug: s.agentSlug,
        bidPlaced: !!placed && placed.amountUsdc > 0,
        amountUsdc,
        reasoning: lastReasoning,
        isWinner: !!winnerMatch,
      };
    })
    .filter((b) => b.bidPlaced || b.reasoning);

  const reasoning: BidderStreamEntry[] = [];
  for (const s of states) {
    const stream = readBidderStream(s.agentSlug, 80);
    for (const e of stream) {
      if (
        e.auctionId === entry.auctionId &&
        (e.kind === "bid_attempt" || e.kind === "agent_text")
      ) {
        reasoning.push({ ...e, agentSlug: s.agentSlug });
      }
    }
  }
  reasoning.sort((a, b) => a.ts - b.ts);

  return {
    hasLiveData: true,
    auctionId: entry.auctionId,
    auctionPda: entry.auctionPda,
    signature: entry.signature ?? null,
    endTimeUnix: auction?.endTimeUnix ?? entry.endTimeUnix,
    status: auction?.status ?? "Open",
    winner: auction?.winner ?? null,
    winningBidNative: auction?.winningBidNative ?? null,
    clusterUnix,
    lot: entry.lot,
    bidders,
    reasoning: reasoning.slice(-30),
  };
}

function fingerprint(p: LotPayload): string {
  // Compact stringification of the fields that drive UI updates. clusterUnix
  // is excluded so it doesn't tick the fingerprint every second.
  return JSON.stringify({
    auctionId: p.auctionId,
    status: p.status,
    winner: p.winner,
    winningBidNative: p.winningBidNative,
    bidders: p.bidders.map((b) => ({
      slug: b.agentSlug,
      placed: b.bidPlaced,
      amount: b.amountUsdc,
      reasoning: b.reasoning,
      isWinner: b.isWinner,
    })),
    reasoning: p.reasoning.length,
  });
}

const inflight = new Map<string, Promise<LotPayload>>();

/**
 * Get a cached LotPayload for the given auctionId. Concurrent callers
 * coalesce onto the same promise during recompute, so a thundering herd
 * results in one computation, not N.
 */
export async function getLotPayload(
  queryAuctionId: string | null
): Promise<LotPayload> {
  const key = queryAuctionId ?? "__latest__";
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.payload;

  const existing = inflight.get(key);
  if (existing) return existing;

  const p = compute(queryAuctionId)
    .then((payload) => {
      cache.set(key, {
        payload,
        expiresAt: Date.now() + TTL_MS,
        fingerprint: fingerprint(payload),
      });
      return payload;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}

/** Hash for SSE diffing — returns null when the cache hasn't been primed. */
export function lotFingerprint(queryAuctionId: string | null): string | null {
  const key = queryAuctionId ?? "__latest__";
  return cache.get(key)?.fingerprint ?? null;
}

/** Test-only — wipe the cache between runs. */
export function _clearLotCache(): void {
  cache.clear();
  inflight.clear();
}
