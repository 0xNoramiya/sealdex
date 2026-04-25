import { NextResponse } from "next/server";
import { readBidderStates, readRegistry } from "@/lib/registry";
import { clusterUnixTime } from "@/lib/onchain";

export const dynamic = "force-dynamic";

const BOOT_AT = Date.now();

export async function GET() {
  const registry = readRegistry();
  const bidders = readBidderStates();

  // Bound the cluster probe so a slow devnet RPC can't push the health
  // route past the Fly check timeout (5s). If we don't hear back in 3s we
  // mark the cluster unreachable rather than blocking.
  const CLUSTER_PROBE_MS = 3000;
  let clusterUnix: number | null = null;
  let clusterReachable = true;
  try {
    clusterUnix = await Promise.race([
      clusterUnixTime(),
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error("cluster probe timeout")), CLUSTER_PROBE_MS),
      ),
    ]);
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
