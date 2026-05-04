import { NextResponse } from "next/server";
import {
  buildSignInMessage,
  generateNonce,
} from "@/lib/auth";
import {
  COOKIE_BASE_FLAGS,
  NONCE_COOKIE_NAME,
  getAuthDomain,
} from "@/lib/auth-env";

export const dynamic = "force-dynamic";

const NONCE_TTL_SECONDS = 5 * 60; // 5-minute window to sign + return.

/**
 * Step 1 of sign-in. Issues a fresh single-use nonce, stamps it into
 * an HttpOnly cookie (so /verify can match it server-side without
 * trusting the client's claim), and returns the message bytes the
 * wallet should display + sign.
 *
 * The nonce cookie's TTL bounds the sign-in window; if the user takes
 * longer than 5 min to approve in their wallet they'll get a clean
 * "nonce expired, try again."
 */
export async function GET(req: Request) {
  const nonce = generateNonce();
  const domain = getAuthDomain(req);
  const message = buildSignInMessage(domain, nonce);

  const isHttps = req.url.startsWith("https://");
  const res = NextResponse.json({ nonce, message, domain });
  res.cookies.set({
    name: NONCE_COOKIE_NAME,
    value: nonce,
    ...COOKIE_BASE_FLAGS,
    secure: isHttps,
    maxAge: NONCE_TTL_SECONDS,
  });
  return res;
}
