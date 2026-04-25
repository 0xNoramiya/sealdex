import { NextResponse } from "next/server";
import { readRegistry, type RegistryEntry } from "@/lib/registry";

export const dynamic = "force-dynamic";

// Match the bidder's own grace window — anything that ended more than
// EXPIRED_GRACE_SEC ago is past the point where any bid could still land.
const EXPIRED_GRACE_SEC = 60;
// Hard cap so the payload stays bounded even if a large run of auctions
// landed within the grace window.
const MAX_ENTRIES = 100;

/**
 * Public auction registry feed. External bidder agents point
 * SEALDEX_REGISTRY_URL at this endpoint to discover open auctions
 * without coordinating files with the auctioneer host.
 *
 * Optional ?all=1 query param returns the full unfiltered registry —
 * useful for the dashboard pages that surface settled history.
 */
export async function GET(req: Request): Promise<NextResponse<RegistryEntry[]>> {
  const wantAll = new URL(req.url).searchParams.get("all") === "1";
  const all = readRegistry();
  if (wantAll) {
    return NextResponse.json(all, {
      headers: { "cache-control": "no-store" },
    });
  }
  const now = Math.floor(Date.now() / 1000);
  const open = all.filter((e) => e.endTimeUnix > now - EXPIRED_GRACE_SEC);
  const recent = open.slice(-MAX_ENTRIES);
  return NextResponse.json(recent, {
    headers: { "cache-control": "no-store" },
  });
}
