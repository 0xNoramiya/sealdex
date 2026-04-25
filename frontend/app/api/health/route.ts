import { NextResponse } from "next/server";
import { readBidderStates, readRegistry } from "@/lib/registry";
import { clusterUnixTime } from "@/lib/onchain";

export const dynamic = "force-dynamic";

const BOOT_AT = Date.now();

export async function GET() {
  const registry = readRegistry();
  const bidders = readBidderStates();

  let clusterUnix: number | null = null;
  let clusterReachable = true;
  try {
    clusterUnix = await clusterUnixTime();
  } catch {
    clusterReachable = false;
  }

  return NextResponse.json(
    {
      ok: true,
      service: "sealdex",
      uptimeSeconds: Math.floor((Date.now() - BOOT_AT) / 1000),
      registrySize: registry.length,
      bidderCount: bidders.length,
      cluster: {
        reachable: clusterReachable,
        unixTime: clusterUnix,
      },
      env: {
        node: process.version,
        region: process.env.FLY_REGION ?? null,
        machineId: process.env.FLY_MACHINE_ID ?? null,
      },
    },
    {
      headers: { "cache-control": "no-store" },
    },
  );
}
