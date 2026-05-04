import { NextResponse } from "next/server";
import { COOKIE_BASE_FLAGS, sessionCookieName } from "@/lib/auth-env";

export const dynamic = "force-dynamic";

/**
 * Clears the session cookie. Idempotent — calling logout when not
 * signed in is a no-op that returns 200. The cookie name is derived
 * from the secret fingerprint so a server-side rotation also
 * invalidates this client's session without needing this call.
 */
export async function POST(_req: Request) {
  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: sessionCookieName(),
    value: "",
    ...COOKIE_BASE_FLAGS,
    maxAge: 0,
  });
  return res;
}
