"use client";

// Phantom + Solflare connect button using each wallet's injected
// provider. Hand-rolled instead of @solana/wallet-adapter — the
// surface here is small (one button, two wallets) and the adapter UI
// pulls in a heavy dep tree for what is, in our case, "click sign".
//
// Sign-in flow:
//   1. Detect injected provider (window.solana? window.solflare?).
//   2. connect() → returns the user's pubkey.
//   3. GET /api/auth/nonce → server stores nonce in HttpOnly cookie,
//      returns the message to sign + the bound domain.
//   4. provider.signMessage(message) → wallet pops a "sign in"
//      prompt that shows the message text + nonce.
//   5. POST /api/auth/verify with { pubkey, signature }. On success
//      the server sets the session cookie.
//   6. Refresh local session state from /api/auth/me.

import { useCallback, useEffect, useState } from "react";

interface SolanaProvider {
  isPhantom?: boolean;
  isSolflare?: boolean;
  publicKey: { toString(): string } | null;
  connect(): Promise<{ publicKey: { toString(): string } }>;
  disconnect?(): Promise<void>;
  signMessage(
    message: Uint8Array,
    encoding?: "utf8"
  ): Promise<{ signature: Uint8Array }>;
}

declare global {
  interface Window {
    solana?: SolanaProvider;
    solflare?: SolanaProvider;
  }
}

interface AuthMe {
  pubkey: string | null;
  exp?: number;
}

function pickProvider(): { name: "phantom" | "solflare"; provider: SolanaProvider } | null {
  if (typeof window === "undefined") return null;
  if (window.solana?.isPhantom) {
    return { name: "phantom", provider: window.solana };
  }
  if (window.solflare?.isSolflare) {
    return { name: "solflare", provider: window.solflare };
  }
  // Phantom may not advertise isPhantom on older injected versions.
  if (window.solana) return { name: "phantom", provider: window.solana };
  if (window.solflare) return { name: "solflare", provider: window.solflare };
  return null;
}

function shortPubkey(pk: string): string {
  if (!pk || pk.length < 12) return pk;
  return `${pk.slice(0, 4)}…${pk.slice(-4)}`;
}

// bs58 in the browser. The Solana wallet APIs deal in raw bytes for
// signMessage, but the API roundtrip uses base58 strings (matching
// what every Solana tool expects on the wire). We import the same
// `bs58` package the rest of the codebase uses.
import bs58 from "bs58";

export function WalletConnectButton() {
  const [me, setMe] = useState<AuthMe>({ pubkey: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshMe = useCallback(async () => {
    try {
      const r = await fetch("/api/auth/me", { cache: "no-store" });
      if (!r.ok) {
        setMe({ pubkey: null });
        return;
      }
      const data = (await r.json()) as AuthMe;
      setMe(data);
    } catch {
      setMe({ pubkey: null });
    }
  }, []);

  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);

  const onConnect = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const picked = pickProvider();
      if (!picked) {
        setError(
          "No Solana wallet detected. Install Phantom or Solflare and refresh."
        );
        return;
      }
      const conn = await picked.provider.connect();
      const pubkey = conn.publicKey.toString();
      const nonceRes = await fetch("/api/auth/nonce", { cache: "no-store" });
      if (!nonceRes.ok) {
        setError(`nonce fetch failed (${nonceRes.status})`);
        return;
      }
      const { message } = (await nonceRes.json()) as { message: string };
      const messageBytes = new TextEncoder().encode(message);
      const signed = await picked.provider.signMessage(messageBytes, "utf8");
      const signatureB58 = bs58.encode(signed.signature);
      const verifyRes = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pubkey, signature: signatureB58 }),
      });
      if (!verifyRes.ok) {
        const body = await verifyRes.json().catch(() => ({}));
        setError(`verify failed: ${(body as any).error ?? verifyRes.status}`);
        return;
      }
      await refreshMe();
    } catch (err) {
      setError((err as Error).message ?? "connect failed");
    } finally {
      setBusy(false);
    }
  }, [refreshMe]);

  const onDisconnect = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      // Disconnecting from the wallet itself is best-effort — some
      // wallets reject programmatic disconnect; we don't depend on it.
      const picked = pickProvider();
      try {
        await picked?.provider.disconnect?.();
      } catch {
        /* ignore */
      }
      setMe({ pubkey: null });
    } finally {
      setBusy(false);
    }
  }, []);

  if (me.pubkey) {
    return (
      <div
        className="flex items-center gap-2 text-[12px] text-dim"
        data-auth-state="signed-in"
      >
        <span className="text-ink">{shortPubkey(me.pubkey)}</span>
        <button
          onClick={onDisconnect}
          disabled={busy}
          className="px-2 py-1 border border-rule rounded hover:bg-paper disabled:opacity-40"
          aria-label="Sign out"
        >
          {busy ? "…" : "Sign out"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1" data-auth-state="signed-out">
      <button
        onClick={onConnect}
        disabled={busy}
        className="px-3 py-1 text-[12px] border border-rule rounded hover:bg-paper disabled:opacity-40"
      >
        {busy ? "Signing in…" : "Connect wallet"}
      </button>
      {error ? (
        <span className="text-[10px] text-dim max-w-[220px]" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
