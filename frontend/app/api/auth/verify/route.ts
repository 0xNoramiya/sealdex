import { NextResponse } from "next/server";
import {
  DEFAULT_SESSION_TTL_SECONDS,
  signSessionToken,
  verifySignInSignature,
} from "@/lib/auth";
import {
  COOKIE_BASE_FLAGS,
  NONCE_COOKIE_NAME,
  getAuthDomain,
  getSessionSecret,
  sessionCookieName,
} from "@/lib/auth-env";

export const dynamic = "force-dynamic";

interface VerifyBody {
  pubkey?: string;
  signature?: string;
}

/**
 * Step 2 of sign-in. Reads the nonce cookie set by /api/auth/nonce,
 * verifies the wallet's ed25519 signature over `buildSignInMessage`,
 * and on success stamps an HMAC-signed session cookie naming the
 * pubkey + expiry. The nonce cookie is consumed (cleared) on every
 * call so a successful sign-in can't be replayed against a future
 * different wallet.
 */
export async function POST(req: Request) {
  let body: VerifyBody;
  try {
    body = (await req.json()) as VerifyBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const pubkey = body.pubkey?.trim();
  const signature = body.signature?.trim();
  if (!pubkey || !signature) {
    return NextResponse.json(
      { error: "missing_fields" },
      { status: 400 }
    );
  }

  const cookieStore = (req as unknown as { cookies: Map<string, { value: string }> })
    .cookies;
  // Next.js Request#cookies is actually RequestCookies; use its get() API.
  // The Map cast above is for typing; the real method is below.
  const nonceCookie = (req as unknown as {
    cookies: { get(name: string): { value: string } | undefined };
  }).cookies.get(NONCE_COOKIE_NAME);
  if (!nonceCookie?.value) {
    return NextResponse.json({ error: "no_nonce" }, { status: 400 });
  }
  const nonce = nonceCookie.value;
  const domain = getAuthDomain(req);

  const ok = verifySignInSignature({
    domain,
    nonce,
    pubkeyBase58: pubkey,
    signatureBase58: signature,
  });
  if (!ok) {
    // Always clear the nonce on failure so brute-force is one-shot.
    const fail = NextResponse.json(
      { error: "bad_signature" },
      { status: 401 }
    );
    fail.cookies.set({
      name: NONCE_COOKIE_NAME,
      value: "",
      ...COOKIE_BASE_FLAGS,
      maxAge: 0,
    });
    return fail;
  }

  const exp = Math.floor(Date.now() / 1000) + DEFAULT_SESSION_TTL_SECONDS;
  const token = signSessionToken({ pubkey, exp }, getSessionSecret());

  const isHttps = req.url.startsWith("https://");
  const res = NextResponse.json({ pubkey, exp });
  res.cookies.set({
    name: sessionCookieName(),
    value: token,
    ...COOKIE_BASE_FLAGS,
    secure: isHttps,
    maxAge: DEFAULT_SESSION_TTL_SECONDS,
  });
  // Single-use nonce: clear so it can't be replayed by the same browser.
  res.cookies.set({
    name: NONCE_COOKIE_NAME,
    value: "",
    ...COOKIE_BASE_FLAGS,
    maxAge: 0,
  });
  return res;
}
