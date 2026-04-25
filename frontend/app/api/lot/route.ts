import { NextResponse } from "next/server";
import {
  readAuction,
  clusterUnixTime,
  type AuctionView,
} from "@/lib/onchain";
import {
  readBidderStates,
  readBidderStream,
  readBidderIdentity,
  readRegistry,
  type BidderStreamEntry,
} from "@/lib/registry";

export const dynamic = "force-dynamic";

export interface LotResponse {
  hasLiveData: boolean;
  auctionId: string | null;
  auctionPda: string | null;
  // Signature of the create_auction transaction. Useful for surfacing an
  // Explorer link to the on-chain proof that the auction exists.
  signature: string | null;
  endTimeUnix: number | null;
  status: AuctionView["status"] | null;
  winner: string | null;
  winningBidNative: string | null;
  clusterUnix: number;
  lot: Record<string, any> | null;
  bidders: Array<{
    name: string;
    pubkey: string;       // Display string (shortened)
    pubkeyFull: string;   // Full base58 pubkey for Explorer links
    tag: string;
    agentSlug: string;
    bidPlaced: boolean;
    amountUsdc: number | null; // null if not yet revealed
    reasoning: string | null;
    isWinner: boolean;
  }>;
  reasoning: BidderStreamEntry[];
}

function shortPubkey(pk: string): string {
  if (!pk || pk.length < 12) return pk;
  return `${pk.slice(0, 4)}…${pk.slice(-4)}`;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const queryAuctionId = url.searchParams.get("auctionId");

  const registry = readRegistry();
  const states = readBidderStates();

  // Pick the auction: explicit query, else most recent registry entry.
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
    return NextResponse.json<LotResponse>({
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
    });
  }

  // Pull live state in parallel.
  const [auction, clusterUnix] = await Promise.all([
    readAuction(entry.auctionId).catch(() => null),
    clusterUnixTime().catch(() => Math.floor(Date.now() / 1000)),
  ]);

  // Build bidder views: every state file with a bid for this auction.
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
      // Reveal amount only post-settle. Pre-settle, hide.
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
    .filter((b) => b.bidPlaced || b.reasoning); // only show bidders that have engaged

  // Reasoning ticker pulls the most recent text/bid entries across all bidder streams.
  const reasoning: BidderStreamEntry[] = [];
  for (const s of states) {
    const stream = readBidderStream(s.agentSlug, 80);
    for (const e of stream) {
      if (
        e.auctionId === entry.auctionId &&
        (e.kind === "bid_attempt" || e.kind === "agent_text")
      ) {
        reasoning.push({
          ...e,
          agentSlug: s.agentSlug,
        });
      }
    }
  }
  reasoning.sort((a, b) => a.ts - b.ts);

  return NextResponse.json<LotResponse>({
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
  });
}
