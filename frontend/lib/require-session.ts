// Helper for routes that need the authed wallet pubkey. Mirrors the
// /api/auth/me handler but returns null instead of a Response so the
// caller composes its own error shape.

import { verifySessionToken, type SessionPayload } from "./auth";
import { getSessionSecret, sessionCookieName } from "./auth-env";

export function readSession(req: Request): SessionPayload | null {
  const cookies = (req as unknown as {
    cookies: { get(name: string): { value: string } | undefined };
  }).cookies;
  const token = cookies.get(sessionCookieName())?.value;
  if (!token) return null;
  return verifySessionToken(token, getSessionSecret());
}
