import { NextResponse } from "next/server";
import {
  getHistory,
  type EnrichedEntry,
  type HistoryFilter,
  type HistoryPagination,
  type HistoryResponse,
} from "@/lib/history";

export const dynamic = "force-dynamic";

const VALID_STATUS = new Set([
  "Open",
  "Settled",
  "Claimed",
  "Slashed",
  "Unknown",
]);

/**
 * Auction history feed. Paginated + filterable; enriches the registry
 * with on-chain status/winner so dashboards and external integrators
 * don't have to re-implement the cluster reads.
 *
 * Query params:
 *   page=N        1-indexed (default 1)
 *   pageSize=N    1-100 (default 20)
 *   sort=endTimeAsc | endTimeDesc (default endTimeDesc)
 *   status=Open|Settled|Claimed|Slashed
 *   category=...  exact match (case-insensitive)
 *   q=...         substring match on title + category
 *   endTimeFrom / endTimeTo  cluster-unix bounds
 */
export async function GET(req: Request): Promise<NextResponse<HistoryResponse>> {
  const url = new URL(req.url);
  const sp = url.searchParams;

  const statusRaw = sp.get("status") ?? undefined;
  const status =
    statusRaw && VALID_STATUS.has(statusRaw)
      ? (statusRaw as EnrichedEntry["status"])
      : undefined;

  const filter: HistoryFilter = {
    status,
    category: sp.get("category") ?? undefined,
    q: sp.get("q") ?? undefined,
    endTimeFrom: sp.has("endTimeFrom")
      ? Number(sp.get("endTimeFrom"))
      : undefined,
    endTimeTo: sp.has("endTimeTo") ? Number(sp.get("endTimeTo")) : undefined,
  };

  const sortRaw = sp.get("sort") ?? undefined;
  const sort: HistoryPagination["sort"] =
    sortRaw === "endTimeAsc" ? "endTimeAsc" : "endTimeDesc";

  const pagination: HistoryPagination = {
    page: sp.has("page") ? Number(sp.get("page")) : undefined,
    pageSize: sp.has("pageSize") ? Number(sp.get("pageSize")) : undefined,
    sort,
  };

  const response = await getHistory(filter, pagination);

  return NextResponse.json<HistoryResponse>(response, {
    headers: {
      // Short browser cache so paginated dashboards don't hammer the
      // route on click-through, but the per-auction cache inside the
      // handler is the heavier lever.
      "Cache-Control": "public, max-age=10, must-revalidate",
    },
  });
}
