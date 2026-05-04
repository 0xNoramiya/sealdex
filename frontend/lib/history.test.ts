import { describe, expect, it } from "vitest";
import {
  applyFilterSortPaginate,
  summarizeStats,
  type EnrichedEntry,
} from "./history";

function entry(overrides: Partial<EnrichedEntry> = {}): EnrichedEntry {
  return {
    auctionId: overrides.auctionId ?? "1",
    auctionPda: "pda",
    signature: "sig",
    endTimeUnix: overrides.endTimeUnix ?? 1_700_000_000,
    lot: {
      lot_id: 1,
      duration_seconds: 90,
      lot_metadata: {
        title: "Vintage Holo — Lot 001",
        category: "Vintage Holo",
        ...(overrides.lot?.lot_metadata ?? {}),
      },
      ...(overrides.lot ?? {}),
    },
    status: overrides.status ?? "Settled",
    winner: overrides.winner ?? null,
    winningBidNative: overrides.winningBidNative ?? null,
    bidDepositLamports: overrides.bidDepositLamports ?? null,
    kind: overrides.kind ?? null,
    ...overrides,
  } as EnrichedEntry;
}

const fixture: EnrichedEntry[] = [
  entry({
    auctionId: "1",
    endTimeUnix: 1_000,
    status: "Settled",
    lot: { lot_id: 1, duration_seconds: 60, lot_metadata: { title: "Vintage A", category: "Vintage Holo" } },
  }),
  entry({
    auctionId: "2",
    endTimeUnix: 2_000,
    status: "Claimed",
    lot: { lot_id: 2, duration_seconds: 60, lot_metadata: { title: "Modern B", category: "Modern Premium" } },
  }),
  entry({
    auctionId: "3",
    endTimeUnix: 3_000,
    status: "Open",
    lot: { lot_id: 3, duration_seconds: 60, lot_metadata: { title: "Vintage C", category: "Vintage Holo" } },
  }),
  entry({
    auctionId: "4",
    endTimeUnix: 4_000,
    status: "Slashed",
    lot: { lot_id: 4, duration_seconds: 60, lot_metadata: { title: "Modern D", category: "Modern Premium" } },
  }),
  entry({
    auctionId: "5",
    endTimeUnix: 5_000,
    status: null,
    lot: { lot_id: 5, duration_seconds: 60, lot_metadata: { title: "Mystery E", category: "Vintage Holo" } },
  }),
];

describe("applyFilterSortPaginate", () => {
  it("returns all entries when no filter, default desc sort", () => {
    const r = applyFilterSortPaginate(fixture, {}, {});
    expect(r.entries.map((e) => e.auctionId)).toEqual(["5", "4", "3", "2", "1"]);
    expect(r.total).toBe(5);
    expect(r.page).toBe(1);
    expect(r.pageSize).toBe(20);
    expect(r.hasMore).toBe(false);
  });

  it("supports endTimeAsc sort", () => {
    const r = applyFilterSortPaginate(fixture, {}, { sort: "endTimeAsc" });
    expect(r.entries.map((e) => e.auctionId)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("filters by status", () => {
    const r = applyFilterSortPaginate(fixture, { status: "Settled" }, {});
    expect(r.entries.map((e) => e.auctionId)).toEqual(["1"]);
    expect(r.total).toBe(1);
  });

  it("filters by category (case-insensitive)", () => {
    const r = applyFilterSortPaginate(
      fixture,
      { category: "vintage holo" },
      { sort: "endTimeAsc" }
    );
    expect(r.entries.map((e) => e.auctionId)).toEqual(["1", "3", "5"]);
  });

  it("filters by substring q against title + category", () => {
    const r = applyFilterSortPaginate(fixture, { q: "modern" }, { sort: "endTimeAsc" });
    expect(r.entries.map((e) => e.auctionId)).toEqual(["2", "4"]);
  });

  it("filters by endTimeFrom + endTimeTo (inclusive)", () => {
    const r = applyFilterSortPaginate(
      fixture,
      { endTimeFrom: 2000, endTimeTo: 4000 },
      { sort: "endTimeAsc" }
    );
    expect(r.entries.map((e) => e.auctionId)).toEqual(["2", "3", "4"]);
  });

  it("paginates page=1 pageSize=2 with hasMore=true", () => {
    const r = applyFilterSortPaginate(fixture, {}, { page: 1, pageSize: 2 });
    expect(r.entries).toHaveLength(2);
    expect(r.page).toBe(1);
    expect(r.pageSize).toBe(2);
    expect(r.hasMore).toBe(true);
    expect(r.total).toBe(5);
  });

  it("paginates last page with hasMore=false", () => {
    const r = applyFilterSortPaginate(fixture, {}, { page: 3, pageSize: 2 });
    expect(r.entries).toHaveLength(1);
    expect(r.page).toBe(3);
    expect(r.hasMore).toBe(false);
  });

  it("clamps pageSize to [1, 100]", () => {
    const big = applyFilterSortPaginate(fixture, {}, { pageSize: 9999 });
    expect(big.pageSize).toBe(100);
    const tiny = applyFilterSortPaginate(fixture, {}, { pageSize: 0 });
    expect(tiny.pageSize).toBe(1);
  });

  it("clamps page to >= 1 even on negative input", () => {
    const r = applyFilterSortPaginate(fixture, {}, { page: -3 });
    expect(r.page).toBe(1);
  });

  it("combines status + category + q in one filter", () => {
    const r = applyFilterSortPaginate(
      fixture,
      { status: "Slashed", category: "Modern Premium", q: "Modern" },
      {}
    );
    expect(r.entries.map((e) => e.auctionId)).toEqual(["4"]);
  });
});

describe("summarizeStats", () => {
  it("aggregates totals + byStatus + byCategory", () => {
    const stats = summarizeStats(fixture);
    expect(stats.totalAuctions).toBe(5);
    expect(stats.byStatus).toEqual({
      Settled: 1,
      Claimed: 1,
      Open: 1,
      Slashed: 1,
      InFlight: 1, // null status maps to "InFlight"
    });
    expect(stats.byCategory).toEqual({
      "Vintage Holo": 3,
      "Modern Premium": 2,
    });
  });

  it("handles missing categories under 'Unknown' bucket", () => {
    const e = entry({
      auctionId: "x",
      lot: {
        lot_id: 99,
        duration_seconds: 60,
        lot_metadata: { title: "no-cat" }, // no category field
      },
    });
    const stats = summarizeStats([e]);
    expect(stats.byCategory).toEqual({ Unknown: 1 });
  });

  it("returns zeroed stats for an empty list", () => {
    expect(summarizeStats([])).toEqual({
      totalAuctions: 0,
      byStatus: {},
      byCategory: {},
    });
  });
});
