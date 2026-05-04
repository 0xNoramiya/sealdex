import { NextResponse } from "next/server";
import {
  getAgentStats,
  type AgentsLeaderboard,
} from "@/lib/agents-stats";
import type { HistoryFilter } from "@/lib/history";

export const dynamic = "force-dynamic";

const VALID_STATUS = new Set([
  "Open",
  "Settled",
  "Claimed",
  "Slashed",
  "Unknown",
]);

/**
 * Per-bidder leaderboard. Aggregates each bidder's attempted bids,
 * realized wins, and total winning volume across the auction
 * history. Filter params let callers narrow to a category, status,
 * or time window — useful for tournament-style "best bidder of the
 * month" dashboards.
 *
 * Sort order: most wins → biggest winning-volume tiebreaker → most
 * recent activity. Stable across calls because the underlying data
 * is deterministic given the registry + state files.
 */
export async function GET(req: Request): Promise<NextResponse<AgentsLeaderboard>> {
  const url = new URL(req.url);
  const sp = url.searchParams;
  const statusRaw = sp.get("status") ?? undefined;
  const status =
    statusRaw && VALID_STATUS.has(statusRaw)
      ? (statusRaw as HistoryFilter["status"])
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

  const data = await getAgentStats(filter);
  return NextResponse.json<AgentsLeaderboard>(data, {
    headers: {
      "Cache-Control": "public, max-age=10, must-revalidate",
    },
  });
}
