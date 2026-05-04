// Server-only auth runtime config. Centralised so the routes don't
// each duplicate "where do I find the secret / domain / cookie name."
//
// Development fallback for SESSION_SECRET: if the env var is unset we
// still want `next start` to work end-to-end during dev, so we derive
// a per-process secret from the Node start time. NEVER acceptable in
// prod — the warning print is loud on purpose. Production deployments
// MUST set SESSION_SECRET to a long random string and rotate it on
// suspected compromise (rotation invalidates outstanding sessions).

import { secretFingerprint } from "./auth";

let cachedSecret: string | null = null;
let cachedDevWarning = false;

export function getSessionSecret(): string {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.SEALDEX_SESSION_SECRET?.trim();
  if (fromEnv && fromEnv.length >= 32) {
    cachedSecret = fromEnv;
    return cachedSecret;
  }
  // Dev fallback. Random per process boot.
  if (!cachedDevWarning) {
    cachedDevWarning = true;
    // eslint-disable-next-line no-console
    console.warn(
      "[auth] SEALDEX_SESSION_SECRET unset or shorter than 32 chars — using ephemeral dev secret. Sessions will be invalidated on every restart."
    );
  }
  cachedSecret =
    "dev-only-" +
    process.pid +
    "-" +
    Date.now() +
    "-" +
    Math.random().toString(36).slice(2);
  return cachedSecret;
}

/** Domain bound into the SIWS message. Falls back to the public site
 * URL → request host → "sealdex" so something always shows up. The
 * domain is mainly there to prevent cross-origin replays; rough match
 * is fine. */
export function getAuthDomain(req?: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) {
    try {
      return new URL(explicit).host;
    } catch {
      /* fall through */
    }
  }
  if (req) {
    try {
      return new URL(req.url).host;
    } catch {
      /* fall through */
    }
  }
  return "sealdex";
}

export const SESSION_COOKIE_NAME = "sealdex_session";
export const NONCE_COOKIE_NAME = "sealdex_nonce";

/** A cookie name suffix derived from the secret — old cookies become
 * "wrong cookie name" instead of "tampered" after rotation. Easier to
 * reason about than a soft fail-then-clear. */
export function sessionCookieName(): string {
  return `${SESSION_COOKIE_NAME}_${secretFingerprint(getSessionSecret())}`;
}

export const COOKIE_BASE_FLAGS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  // `secure` is set per-request based on the request scheme so dev (http)
  // works without env tweaks while prod (https) gets the flag.
};
