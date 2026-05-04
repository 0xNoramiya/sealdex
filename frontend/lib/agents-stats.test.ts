import { describe, expect, it } from "vitest";
import { aggregateAgentStats } from "./agents-stats";
import type { BidderState } from "./registry";
import type { EnrichedEntry } from "./history";

function bidderState(
  slug: string,
  bids: Record<string, { amountUsdc: number; ts: number }>
): BidderState {
  return {
    agentSlug: slug,
    bidsPlaced: Object.fromEntries(
      Object.entries(bids).map(([id, v]) => [
        id,
        {
          amountUsdc: v.amountUsdc,
          reasoning: "",
          signature: "",
          ts: v.ts,
        },
      ])
    ),
  };
}

function enriched(
  auctionId: string,
  winner: string | null,
  winningBidNative: string | null
): EnrichedEntry {
  return {
    auctionId,
    auctionPda: "Pda" + auctionId,
    signature: "sig" + auctionId,
    endTimeUnix: 1_000,
    lot: {
      lot_id: Number(auctionId) || 1,
      duration_seconds: 60,
      lot_metadata: { title: `Lot ${auctionId}`, category: "Test" },
    },
    status: winner ? "Settled" : null,
    winner,
    winningBidNative,
    bidDepositLamports: null,
    kind: null,
  } as EnrichedEntry;
}

const identityFor = (slug: string) =>
  ({
    alpha: { name: "Alpha", pubkey: "ALPHA1pkA1pkA1pkA1pkA1pkA1pkA1pkA1pkA1pk", tag: "A" },
    beta:  { name: "Beta",  pubkey: "BETA22pkB1pkB1pkB1pkB1pkB1pkB1pkB1pkB1pk",  tag: "B" },
    gamma: { name: "Gamma", pubkey: "GAMMA3pkG1pkG1pkG1pkG1pkG1pkG1pkG1pkG1pk", tag: "G" },
  } as Record<string, { name: string; pubkey: string; tag: string }>)[slug] ?? null;

describe("aggregateAgentStats", () => {
  it("returns zero-stats rows for bidders with no bidsPlaced", () => {
    const states = [bidderState("alpha", {})];
    const out = aggregateAgentStats(states, new Map(), identityFor);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      bidsAttempted: 0,
      bidsPlaced: 0,
      wins: 0,
      totalWinningBidNative: "0",
      totalAttemptedUsdc: 0,
      winRate: 0,
    });
  });

  it("excludes sentinel skip records (amountUsdc=0) from bidsPlaced count", () => {
    const states = [
      bidderState("alpha", {
        "1": { amountUsdc: 100, ts: 100 },
        "2": { amountUsdc: 0, ts: 200 }, // skipped
        "3": { amountUsdc: 250, ts: 300 },
      }),
    ];
    const out = aggregateAgentStats(states, new Map(), identityFor);
    expect(out[0].bidsAttempted).toBe(3);
    expect(out[0].bidsPlaced).toBe(2);
    expect(out[0].totalAttemptedUsdc).toBe(350);
    expect(out[0].lastActivity).toBe(300);
  });

  it("counts wins where auction.winner matches bidder pubkey", () => {
    const alphaPubkey = identityFor("alpha")!.pubkey;
    const states = [
      bidderState("alpha", {
        "1": { amountUsdc: 100, ts: 1 },
        "2": { amountUsdc: 200, ts: 2 },
      }),
    ];
    const byId = new Map<string, EnrichedEntry>([
      ["1", enriched("1", alphaPubkey, "100000000")],
      ["2", enriched("2", "OTHER1pkO1pkO1pkO1pkO1pkO1pkO1pkO1pkO1pkO", "200000000")],
    ]);
    const out = aggregateAgentStats(states, byId, identityFor);
    expect(out[0].wins).toBe(1);
    expect(out[0].totalWinningBidNative).toBe("100000000");
    expect(out[0].winRate).toBe(0.5);
  });

  it("uses bigint sums so u64 native winning bids don't overflow", () => {
    const alphaPubkey = identityFor("alpha")!.pubkey;
    const states = [
      bidderState("alpha", {
        "1": { amountUsdc: 1, ts: 1 },
        "2": { amountUsdc: 2, ts: 2 },
      }),
    ];
    // Two near-MAX u64 winning bids — JS numbers would overflow.
    const big = "9000000000000000000"; // 9e18, just under u64 max
    const byId = new Map<string, EnrichedEntry>([
      ["1", enriched("1", alphaPubkey, big)],
      ["2", enriched("2", alphaPubkey, big)],
    ]);
    const out = aggregateAgentStats(states, byId, identityFor);
    expect(out[0].wins).toBe(2);
    expect(out[0].totalWinningBidNative).toBe(
      (BigInt(big) + BigInt(big)).toString()
    );
  });

  it("ranks: more wins first, then bigger volume, then more recent activity", () => {
    const alphaPk = identityFor("alpha")!.pubkey;
    const betaPk = identityFor("beta")!.pubkey;
    const gammaPk = identityFor("gamma")!.pubkey;
    const states = [
      bidderState("alpha", {
        "1": { amountUsdc: 100, ts: 100 },
        "2": { amountUsdc: 100, ts: 200 },
      }),
      bidderState("beta", {
        "3": { amountUsdc: 500, ts: 300 },
        "4": { amountUsdc: 500, ts: 400 },
      }),
      bidderState("gamma", {
        "5": { amountUsdc: 1, ts: 500 },
      }),
    ];
    const byId = new Map<string, EnrichedEntry>([
      ["1", enriched("1", alphaPk, "100")], // alpha wins
      ["2", enriched("2", alphaPk, "100")], // alpha wins
      ["3", enriched("3", betaPk, "999")], // beta wins (higher volume)
      ["4", enriched("4", betaPk, "999")], // beta wins
      ["5", enriched("5", gammaPk, "1")], // gamma wins (most recent only)
    ]);
    const out = aggregateAgentStats(states, byId, identityFor);
    // Beta (2 wins, big volume) > Alpha (2 wins, small volume) > Gamma (1 win).
    expect(out.map((r) => r.agentSlug)).toEqual(["beta", "alpha", "gamma"]);
  });

  it("falls back to slug-based name when identity is missing", () => {
    const states = [bidderState("orphan", { "1": { amountUsdc: 50, ts: 1 } })];
    const out = aggregateAgentStats(states, new Map(), identityFor);
    expect(out[0].name).toBe("Bidder orphan");
    expect(out[0].pubkey).toBe("");
    expect(out[0].pubkeyShort).toBe("");
    // Tag falls back to first letter, uppercased.
    expect(out[0].tag).toBe("O");
  });

  it("ignores wins on auctions where pubkey is empty (mis-identified bidder)", () => {
    // Bidder with no identity → empty pubkey. Even if some auction's
    // winner happens to be empty string (impossible but defensive),
    // we should NOT credit a "win".
    const states = [bidderState("orphan", { "1": { amountUsdc: 50, ts: 1 } })];
    const byId = new Map<string, EnrichedEntry>([
      ["1", enriched("1", "" as any, "50")],
    ]);
    const out = aggregateAgentStats(states, byId, identityFor);
    expect(out[0].wins).toBe(0);
  });

  it("handles missing winningBidNative gracefully", () => {
    const alphaPk = identityFor("alpha")!.pubkey;
    const states = [bidderState("alpha", { "1": { amountUsdc: 100, ts: 1 } })];
    const byId = new Map<string, EnrichedEntry>([
      ["1", enriched("1", alphaPk, null)], // winner set but no bid amount
    ]);
    const out = aggregateAgentStats(states, byId, identityFor);
    // No win credited because winningBidNative is null.
    expect(out[0].wins).toBe(0);
    expect(out[0].totalWinningBidNative).toBe("0");
  });

  it("rounds winRate to 4 decimal places", () => {
    const alphaPk = identityFor("alpha")!.pubkey;
    const states = [
      bidderState("alpha", {
        "1": { amountUsdc: 1, ts: 1 },
        "2": { amountUsdc: 1, ts: 2 },
        "3": { amountUsdc: 1, ts: 3 },
      }),
    ];
    const byId = new Map<string, EnrichedEntry>([
      ["1", enriched("1", alphaPk, "10")],
      ["2", enriched("2", "X" as any, "10")],
      ["3", enriched("3", "Y" as any, "10")],
    ]);
    const out = aggregateAgentStats(states, byId, identityFor);
    // 1/3 = 0.3333... → 0.3333 after rounding.
    expect(out[0].winRate).toBe(0.3333);
  });
});
