import { NextResponse } from "next/server";
import { listOwnedBy } from "@/lib/spawn-store";
import { readSession } from "@/lib/require-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Wallet-gated list of the caller's spawns. Strips secrets — the only
 * fields exposed are the public registry record (slug, name, status,
 * timestamps, pid). The encrypted creds blob never leaves the server.
 */
export async function GET(req: Request) {
  const session = readSession(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const owned = listOwnedBy(session.pubkey);
  return NextResponse.json(
    {
      pubkey: session.pubkey,
      spawns: owned.map((r) => ({
        spawnId: r.spawnId,
        slug: r.slug,
        name: r.name,
        status: r.status,
        startedAt: r.startedAt,
        updatedAt: r.updatedAt,
        pid: r.pid,
        message: r.message ?? null,
      })),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
