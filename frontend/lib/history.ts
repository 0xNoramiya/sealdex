// Auction history feed. Enriches the registry feed with on-chain
// status (winner, winning_bid, claim/slash state) and exposes a
// paginated + filterable view.
//
// Caching strategy is status-aware: terminal states (Claimed, Slashed)
// never transition again, so we cache them ~forever; Settled can flip
// to Claimed/Slashed, so we cache ~30s; Open / in-flight is short
// (5s) since end_time crossings are time-sensitive. This avoids both
// the "thunderingly hammer the RPC" failure mode AND the "stale data
// shows up days later" failure mode.

import {
  readAuction,
  type AuctionView,
} from "./onchain";
import { readRegistry, type RegistryEntry } from "./registry";

export interface EnrichedEntry {
  auctionId: string;
  auctionPda: string;
  signature: string;
  endTimeUnix: number;
  lot: RegistryEntry["lot"];
  // null when the auction is still delegated and base-layer reads
  // return nothing — i.e. we know it exists per the registry but we
  // don't have a status yet. Treat as "in-flight" in the UI.
  status: AuctionView["status"] | null;
  winner: string | null;
  winningBidNative: string | null;
  bidDepositLamports: string | null;
  kind: AuctionView["kind"] | null;
}

export interface HistoryFilter {
  /** Restrict to a particular status. Omit for any. */
  status?: EnrichedEntry["status"];
  /** Case-insensitive exact match on lot.lot_metadata.category. */
  category?: string;
  /** Case-insensitive substring match against title + category. */
  q?: string;
  /** Min cluster-unix-time end (inclusive). */
  endTimeFrom?: number;
  /** Max cluster-unix-time end (inclusive). */
  endTimeTo?: number;
}

export interface HistoryPagination {
  /** 1-indexed page number. Default 1. */
  page?: number;
  /** Entries per page. Default 20, max 100. */
  pageSize?: number;
  /** "endTime" newest-first by default; "endTimeAsc" oldest-first. */
  sort?: "endTimeDesc" | "endTimeAsc";
}

export interface HistoryStats {
  totalAuctions: number;
  byStatus: Record<string, number>;
  byCategory: Record<string, number>;
}

export interface HistoryResponse {
  entries: EnrichedEntry[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  stats: HistoryStats;
}

interface CacheEntry {
  view: AuctionView | null;
  expiresAt: number;
}

const ENRICH_CACHE = new Map<string, CacheEntry>();

function ttlForStatus(status: AuctionView["status"] | null): number {
  switch (status) {
    case "Claimed":
    case "Slashed":
      // Terminal — never transitions again. Long TTL (1 hour).
      return 60 * 60_000;
    case "Settled":
      // Can flip to Claimed/Slashed within the grace window.
      return 30_000;
    default:
      // Open / unknown / in-flight.
      return 5_000;
  }
}

async function enrichOne(entry: RegistryEntry): Promise<EnrichedEntry> {
  const now = Date.now();
  const cached = ENRICH_CACHE.get(entry.auctionId);
  let view: AuctionView | null;
  if (cached && cached.expiresAt > now) {
    view = cached.view;
  } else {
    view = await readAuction(entry.auctionId).catch(() => null);
    ENRICH_CACHE.set(entry.auctionId, {
      view,
      expiresAt: now + ttlForStatus(view?.status ?? null),
    });
  }
  return {
    auctionId: entry.auctionId,
    auctionPda: entry.auctionPda,
    signature: entry.signature,
    endTimeUnix: entry.endTimeUnix,
    lot: entry.lot,
    status: view?.status ?? null,
    winner: view?.winner ?? null,
    winningBidNative: view?.winningBidNative ?? null,
    bidDepositLamports: view?.bidDepositLamports ?? null,
    kind: view?.kind ?? null,
  };
}

/** Apply filter + sort + pagination to an already-enriched list. Pure. */
export function applyFilterSortPaginate(
  enriched: EnrichedEntry[],
  filter: HistoryFilter,
  pagination: HistoryPagination
): { entries: EnrichedEntry[]; total: number; page: number; pageSize: number; hasMore: boolean } {
  const filtered = enriched.filter((e) => {
    if (filter.status && e.status !== filter.status) return false;
    if (filter.category) {
      const cat = (e.lot.lot_metadata as { category?: string }).category ?? "";
      if (cat.toLowerCase() !== filter.category.toLowerCase()) return false;
    }
    if (filter.q) {
      const q = filter.q.toLowerCase();
      const md = e.lot.lot_metadata as { title?: string; category?: string };
      const haystack = [md.title, md.category].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    if (filter.endTimeFrom !== undefined && e.endTimeUnix < filter.endTimeFrom) {
      return false;
    }
    if (filter.endTimeTo !== undefined && e.endTimeUnix > filter.endTimeTo) {
      return false;
    }
    return true;
  });

  const sort = pagination.sort ?? "endTimeDesc";
  filtered.sort((a, b) =>
    sort === "endTimeAsc"
      ? a.endTimeUnix - b.endTimeUnix
      : b.endTimeUnix - a.endTimeUnix
  );

  const page = Math.max(1, Math.floor(pagination.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(pagination.pageSize ?? 20)));
  const start = (page - 1) * pageSize;
  const slice = filtered.slice(start, start + pageSize);
  return {
    entries: slice,
    total: filtered.length,
    page,
    pageSize,
    hasMore: start + slice.length < filtered.length,
  };
}

/** Pure aggregate over the unfiltered enriched list. */
export function summarizeStats(enriched: EnrichedEntry[]): HistoryStats {
  const byStatus: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  for (const e of enriched) {
    const s = e.status ?? "InFlight";
    byStatus[s] = (byStatus[s] ?? 0) + 1;
    const cat = (e.lot.lot_metadata as { category?: string }).category ?? "Unknown";
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
  }
  return { totalAuctions: enriched.length, byStatus, byCategory };
}

/**
 * Top-level helper. Reads the registry, enriches each entry (cached),
 * applies filter + pagination, returns the response shape the API
 * route serializes directly.
 */
export async function getHistory(
  filter: HistoryFilter,
  pagination: HistoryPagination
): Promise<HistoryResponse> {
  const registry = readRegistry();
  // Fan out — the per-auction cache absorbs repeats so this is cheap
  // on subsequent calls. Promise.all keeps tail latency bounded by the
  // slowest single read.
  const enriched = await Promise.all(registry.map(enrichOne));
  const stats = summarizeStats(enriched);
  const paged = applyFilterSortPaginate(enriched, filter, pagination);
  return { ...paged, stats };
}

/** Test-only — wipe the per-auction cache between runs. */
export function _clearHistoryCache(): void {
  ENRICH_CACHE.clear();
}
