import { NextResponse } from "next/server";
import { readRegistry, type RegistryEntry } from "@/lib/registry";

export const dynamic = "force-dynamic";

/**
 * Public auction registry feed. External bidder agents point
 * SEALDEX_REGISTRY_URL at this endpoint to discover open auctions
 * without coordinating files with the auctioneer host.
 */
export async function GET(): Promise<NextResponse<RegistryEntry[]>> {
  return NextResponse.json(readRegistry(), {
    headers: { "cache-control": "no-store" },
  });
}
