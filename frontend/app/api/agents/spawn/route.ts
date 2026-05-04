import { NextResponse } from "next/server";
import { createSpawn, type SpawnCreatePayload } from "@/lib/spawn-create";
import { getSessionSecret } from "@/lib/auth-env";
import { readSession } from "@/lib/require-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Wallet-gated BYOK spawn. Encrypts the user's LLM API key + Solana
 * keypair under a SEALDEX_SESSION_SECRET-derived per-spawn key,
 * persists the public config, registers the spawn for a worker process
 * to start.
 *
 * This route is **persist-only**: it does NOT fork the bidder loop.
 * The worker (iteration 19) reads the spawn registry and runs each
 * record's loop. Splitting "request → on-disk record" from
 * "registry → process" makes the route fast + idempotent + restart-safe.
 */
export async function POST(req: Request) {
  const session = readSession(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // Inject the authed pubkey as the owner — never trust client claim.
  const payload: SpawnCreatePayload = {
    ...(body as Partial<SpawnCreatePayload>),
    ownerPubkey: session.pubkey,
  } as SpawnCreatePayload;

  const result = createSpawn(payload, getSessionSecret());
  if (result.ok === false) {
    return NextResponse.json(
      { error: result.error.code, message: result.error.message },
      { status: 400 }
    );
  }
  const record = result.record;
  return NextResponse.json({
    spawnId: record.spawnId,
    slug: record.slug,
    name: record.name,
    status: record.status,
    ownerPubkey: record.ownerPubkey,
    startedAt: record.startedAt,
  });
}
