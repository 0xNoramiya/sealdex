import { NextResponse } from "next/server";
import { getLotPayload, type LotPayload } from "@/lib/lot-cache";

export const dynamic = "force-dynamic";

export type LotResponse = LotPayload;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const queryAuctionId = url.searchParams.get("auctionId");
  const payload = await getLotPayload(queryAuctionId);
  return NextResponse.json<LotResponse>(payload, {
    // Encourage browser-side caching for ~1s so concurrent visitors on
    // the same machine don't burn N requests/s.
    headers: { "Cache-Control": "public, max-age=1, must-revalidate" },
  });
}
