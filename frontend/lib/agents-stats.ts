// Per-bidder leaderboard aggregator. Crosses bidder state files
// (what each agent attempted) with the enriched auction history
// (who actually won what) to produce a per-agent performance row.
//
// The aggregation is split into a pure function `aggregateAgentStats`
// that takes pre-fetched data and returns the leaderboard, and a
// thin wrapper `getAgentStats` that handles the I/O. This keeps the
// math testable without filesystem or network mocks.
//
// Reasonable to assume that every bidder state file lives next to
// every other one — the demo deploys all bidders into the same
// SEALDEX_STATE_DIR. Multi-tenant deployments would partition states
// per tenant; that's a larger refactor that can come later.

import {
  readBidderIdentity,
  readBidderStates,
  type BidderState,
} from "./registry";
import {
  getHistory,
  type EnrichedEntry,
  type HistoryFilter,
} from "./history";

export interface AgentStat {
  /** Display name (from bidder config). */
  name: string;
  /** Filename slug (canonical key in registry endpoints). */
  agentSlug: string;
  /** Full base58 pubkey. Empty when identity isn't readable yet. */
  pubkey: string;
  /** Shortened display form. */
  pubkeyShort: string;
  /** Single-character tag the catalog UI uses. */
  tag: string;
  /** Total entries in this bidder's bidsPlaced map. */
  bidsAttempted: number;
  /** Bids with non-zero amount (skipped/no-bid sentinels excluded). */
  bidsPlaced: number;
  /** Auctions where auction.winner == this bidder's pubkey. */
  wins: number;
  /** Sum of winning_bid (native units) across won auctions. String for u64 safety. */
  totalWinningBidNative: string;
  /** Sum of self-attempted USDC across `bidsPlaced` (>0 amounts only). */
  totalAttemptedUsdc: number;
  /** max(ts) across this bidder's bidsPlaced records. 0 if none. */
  lastActivity: number;
  /** wins / bidsPlaced, rounded to 4 decimals. 0 when bidsPlaced=0. */
  winRate: number;
}

export interface AgentsLeaderboard {
  agents: AgentStat[];
  /** Total auctions considered (bound by the history feed cap). */
  totalAuctions: number;
}

/** Pure aggregator. Both inputs come from caller — no I/O. */
export function aggregateAgentStats(
  states: BidderState[],
  enrichedById: Map<string, EnrichedEntry>,
  identityForSlug: (slug: string) => {
    name: string;
    pubkey: string;
    tag: string;
  } | null
): AgentStat[] {
  const rows = states.map((state): AgentStat => {
    const identity = identityForSlug(state.agentSlug);
    const name = identity?.name ?? `Bidder ${state.agentSlug}`;
    const pubkey = identity?.pubkey ?? "";
    const tag = identity?.tag ?? state.agentSlug.charAt(0).toUpperCase();

    let bidsPlaced = 0;
    let wins = 0;
    let totalAttemptedUsdc = 0;
    let lastActivity = 0;
    // u64 sums via bigint to dodge JS number precision loss for any
    // production-scale auction (winning_bid is u64 native units).
    let winningBidSum: bigint = 0n;

    for (const [auctionId, entry] of Object.entries(state.bidsPlaced)) {
      const ts = entry.ts ?? 0;
      if (ts > lastActivity) lastActivity = ts;
      if (!entry.amountUsdc || entry.amountUsdc <= 0) {
        // Sentinel record (skipped lot) — count as attempt-not-placed.
        continue;
      }
      bidsPlaced += 1;
      totalAttemptedUsdc += entry.amountUsdc;
      const enriched = enrichedById.get(auctionId);
      if (
        enriched &&
        enriched.winner &&
        pubkey &&
        enriched.winner === pubkey &&
        enriched.winningBidNative
      ) {
        wins += 1;
        try {
          winningBidSum += BigInt(enriched.winningBidNative);
        } catch {
          /* malformed string — skip; very defensive */
        }
      }
    }

    const bidsAttempted = Object.keys(state.bidsPlaced).length;
    const winRate = bidsPlaced > 0 ? Math.round((wins / bidsPlaced) * 10_000) / 10_000 : 0;
    return {
      name,
      agentSlug: state.agentSlug,
      pubkey,
      pubkeyShort: shortPubkey(pubkey),
      tag,
      bidsAttempted,
      bidsPlaced,
      wins,
      totalWinningBidNative: winningBidSum.toString(),
      totalAttemptedUsdc,
      lastActivity,
      winRate,
    };
  });

  // Sort: most wins first, then biggest volume, then most recent activity.
  rows.sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    const va = BigInt(a.totalWinningBidNative);
    const vb = BigInt(b.totalWinningBidNative);
    if (vb !== va) return vb > va ? 1 : -1;
    return b.lastActivity - a.lastActivity;
  });

  return rows;
}

function shortPubkey(pk: string): string {
  if (!pk || pk.length < 12) return pk;
  return `${pk.slice(0, 4)}…${pk.slice(-4)}`;
}

/**
 * Top-level helper. Reads bidder states + enriched history and
 * aggregates. Cache reuse is handled by `getHistory` — we just
 * funnel the data through.
 */
export async function getAgentStats(
  filter: HistoryFilter = {}
): Promise<AgentsLeaderboard> {
  const states = readBidderStates();
  // Pull a wide page of history — leaderboards typically want all
  // historical auctions, capped by what fits in the cache. The
  // 200-pageSize ceiling matches the registry feed's hard cap.
  const history = await getHistory(filter, { pageSize: 100, page: 1 });
  const byId = new Map<string, EnrichedEntry>(
    history.entries.map((e) => [e.auctionId, e])
  );
  const agents = aggregateAgentStats(states, byId, readBidderIdentity);
  return { agents, totalAuctions: history.total };
}
