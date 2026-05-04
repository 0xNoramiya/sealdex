import { NextResponse } from "next/server";
import { verifySessionToken } from "@/lib/auth";
import { getSessionSecret, sessionCookieName } from "@/lib/auth-env";

export const dynamic = "force-dynamic";

/**
 * Returns the authenticated wallet pubkey + session expiry, or
 * `{ pubkey: null }` for an unauthenticated browser. Lives at the
 * boundary of the auth surface — the BYOK spawn endpoint and the
 * agent dashboard will both gate on this.
 */
export async function GET(req: Request) {
  const cookies = (req as unknown as {
    cookies: { get(name: string): { value: string } | undefined };
  }).cookies;
  const token = cookies.get(sessionCookieName())?.value;
  if (!token) {
    return NextResponse.json(
      { pubkey: null },
      { headers: { "Cache-Control": "no-store" } }
    );
  }
  const session = verifySessionToken(token, getSessionSecret());
  if (!session) {
    return NextResponse.json(
      { pubkey: null },
      { headers: { "Cache-Control": "no-store" } }
    );
  }
  return NextResponse.json(
    { pubkey: session.pubkey, exp: session.exp },
    { headers: { "Cache-Control": "no-store" } }
  );
}
