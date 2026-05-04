import { NextResponse } from "next/server";
import { getSpawnBySlug } from "@/lib/spawn-store";
import { readSession } from "@/lib/require-session";
import { perSpawnStateDir } from "@/lib/spawn-process";
import {
  findStreamFile,
  readStreamTail,
} from "@/lib/spawn-stream-fs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Owner-gated tail of a spawn's JSONL stream. Returns the last N
 * events as JSON. The dashboard polls this every few seconds when
 * a row is expanded.
 *
 * Why polling rather than SSE: SSE adds a long-lived connection
 * per expanded row that the Next.js dev server doesn't love, and
 * the bidder's poll cadence is 5s anyway — there's no value in a
 * sub-second push channel. Polling at 3s keeps the implementation
 * simple and matches the dashboard's existing /api/agents/me cadence.
 *
 * Auth model is the same as /stop:
 *   - 401 when no session
 *   - 404 for both "no such slug" AND "not yours" (anti-enumeration)
 *
 * Query params:
 *   ?n=<int>   — max events to return (1..500, default 100)
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string }> }
) {
  const session = readSession(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { slug } = await ctx.params;
  if (!slug) {
    return NextResponse.json({ error: "missing_slug" }, { status: 400 });
  }
  const record = getSpawnBySlug(slug);
  if (!record || record.ownerPubkey !== session.pubkey) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const url = new URL(req.url);
  const nRaw = url.searchParams.get("n");
  let maxEvents = 100;
  if (nRaw) {
    const parsed = Number.parseInt(nRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 500) {
      maxEvents = parsed;
    }
  }

  const dir = perSpawnStateDir(record.spawnId);
  const filePath = findStreamFile(dir);
  if (!filePath) {
    // No stream yet — bidder hasn't started writing, or spawn
    // already ended without ever starting. Return an empty tail
    // rather than 404 so the dashboard's empty-state can render
    // "no events yet" cleanly.
    return NextResponse.json({
      slug: record.slug,
      events: [],
      truncated: false,
      sizeBytes: 0,
      streamFound: false,
    });
  }

  const tail = readStreamTail(filePath, { maxEvents });
  return NextResponse.json({
    slug: record.slug,
    events: tail.events,
    truncated: tail.truncated,
    sizeBytes: tail.sizeBytes,
    streamFound: true,
  });
}
