import { NextResponse } from "next/server";
import { getSpawnBySlug, updateSpawn } from "@/lib/spawn-store";
import { readSession } from "@/lib/require-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Owner-gated graceful stop. Sets the registry record to
 * `status: "stopped"`. The worker picks this up on its next poll
 * cycle (within a few seconds) and SIGTERMs the child + clears the
 * runtime keypair file. We deliberately do NOT kill the child from
 * the route handler:
 *
 *   - The worker holds the ChildProcess handle, not us. Sending kill
 *     from the wrong process would race the worker's tracking map.
 *   - The route is fast + idempotent. If the worker is briefly down
 *     when stop is called, the child keeps running until the worker
 *     comes back, sees status=stopped, and reconciles.
 *
 * 404 on unknown slug; 403 when the caller's session pubkey doesn't
 * own the spawn. Both with consistent shape so a CSRF attempt can't
 * tell "real but not yours" apart from "doesn't exist."
 */
export async function POST(
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
    // Indistinguishable response for "not found" vs "not yours" so
    // an attacker can't enumerate other people's slugs by 404 vs 403.
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (record.status === "stopped") {
    return NextResponse.json({
      slug: record.slug,
      status: "stopped",
      message: record.message ?? "already stopped",
    });
  }
  const updated = updateSpawn(record.spawnId, {
    status: "stopped",
    message: "stopped by owner",
  });
  return NextResponse.json({
    slug: updated.slug,
    status: updated.status,
    updatedAt: updated.updatedAt,
  });
}
