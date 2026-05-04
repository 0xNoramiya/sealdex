"use client";

// /spawn/me — owner-scoped dashboard. Polls /api/agents/me every 3s
// so status badges update as the worker reconciles. Stop button per
// row POSTs /api/agents/[slug]/stop. Auth gate falls back to the
// connect-wallet flow when signed out.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Footer, TopBar } from "@/components/Chrome";
import { WalletConnectButton } from "@/components/WalletConnectButton";
import {
  relativeTime,
  shortId,
  statusBadgeStyle,
  type SpawnStatus,
} from "@/lib/spawn-format";

interface AuthState {
  pubkey: string | null;
}

interface SpawnRow {
  spawnId: string;
  slug: string;
  name: string;
  status: SpawnStatus | string;
  startedAt: number;
  updatedAt: number;
  pid: number | null;
  message?: string | null;
}

interface MeResponse {
  pubkey: string;
  spawns: SpawnRow[];
}

const POLL_MS = 3000;

export default function SpawnMePage() {
  const [auth, setAuth] = useState<AuthState>({ pubkey: null });
  const [authLoaded, setAuthLoaded] = useState(false);
  const [spawns, setSpawns] = useState<SpawnRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stoppingSlug, setStoppingSlug] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  // Auth probe + first-load. Once authed, switch to polling.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/auth/me", { cache: "no-store" });
        if (cancelled) return;
        if (!r.ok) {
          setAuth({ pubkey: null });
        } else {
          setAuth((await r.json()) as AuthState);
        }
      } catch {
        if (!cancelled) setAuth({ pubkey: null });
      } finally {
        if (!cancelled) setAuthLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/agents/me", { cache: "no-store" });
      if (r.status === 401) {
        setAuth({ pubkey: null });
        setSpawns(null);
        return;
      }
      if (!r.ok) {
        setError(`/api/agents/me ${r.status}`);
        return;
      }
      const data = (await r.json()) as MeResponse;
      setSpawns(data.spawns);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? "fetch failed");
    }
  }, []);

  // Poll when authed.
  useEffect(() => {
    if (!auth.pubkey) return;
    void refresh();
    const id = setInterval(() => {
      void refresh();
      setNow(Date.now());
    }, POLL_MS);
    return () => clearInterval(id);
  }, [auth.pubkey, refresh]);

  const onStop = useCallback(
    async (slug: string) => {
      setStoppingSlug(slug);
      setError(null);
      try {
        const r = await fetch(`/api/agents/${encodeURIComponent(slug)}/stop`, {
          method: "POST",
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          setError(`stop failed: ${(body as any).error ?? r.status}`);
          return;
        }
        // Refresh immediately; the poll will pick up the worker's
        // subsequent pid=null transition once it reconciles.
        await refresh();
      } finally {
        setStoppingSlug(null);
      }
    },
    [refresh]
  );

  const sorted = useMemo(() => {
    if (!spawns) return null;
    return [...spawns].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [spawns]);

  return (
    <div className="min-h-screen flex flex-col paper-bg">
      <TopBar active="agents" />

      <main className="flex-1 max-w-[1000px] mx-auto px-6 py-12 w-full">
        <header className="mb-8 flex items-end justify-between gap-6">
          <div>
            <div className="text-[11px] uppercase tracking-[0.2em] text-dim ff-mono">
              My agents
            </div>
            <h1 className="text-[32px] font-medium mt-1 text-ink">
              Spawned bidders
            </h1>
            <p className="text-[14px] text-dim mt-2 max-w-prose">
              Real-time view of every BYOK agent under your wallet.
              Status updates automatically as the worker reconciles
              child processes; stop a spawn at any time.
            </p>
          </div>
          <Link
            href="/spawn"
            className="shrink-0 px-4 py-2 text-[13px] bg-ink text-paper rounded hover:opacity-90"
          >
            + New agent
          </Link>
        </header>

        {!authLoaded ? (
          <div className="text-[13px] text-dim">Loading…</div>
        ) : !auth.pubkey ? (
          <SignedOutGate />
        ) : sorted === null ? (
          <div className="text-[13px] text-dim">Fetching…</div>
        ) : sorted.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-3">
            {sorted.map((s) => (
              <SpawnCard
                key={s.spawnId}
                spawn={s}
                now={now}
                onStop={onStop}
                stopping={stoppingSlug === s.slug}
              />
            ))}
          </div>
        )}
        {error && (
          <div role="alert" className="mt-6 text-[12px] text-red-700">
            {error}
          </div>
        )}
      </main>

      <Footer />
    </div>
  );
}

function SignedOutGate() {
  return (
    <section className="p-6 border border-rule rounded-lg bg-paper">
      <h2 className="text-[18px] font-medium text-ink">Connect your wallet</h2>
      <p className="text-[13px] text-dim mt-2">
        This page is owner-scoped — only the wallet that signed
        in can see its own spawned agents.
      </p>
      <div className="mt-4">
        <WalletConnectButton />
      </div>
    </section>
  );
}

function EmptyState() {
  return (
    <section className="p-8 border border-rule rounded-lg bg-paper text-center">
      <div className="text-[14px] text-ink2">No agents spawned yet.</div>
      <p className="text-[12px] text-dim mt-1.5">
        Bring your LLM key + a Solana keypair, and the server will
        run a sealed-bid bidder on your behalf.
      </p>
      <Link
        href="/spawn"
        className="inline-block mt-4 px-4 py-2 text-[13px] bg-ink text-paper rounded hover:opacity-90"
      >
        Spawn your first agent →
      </Link>
    </section>
  );
}

function SpawnCard({
  spawn,
  now,
  onStop,
  stopping,
}: {
  spawn: SpawnRow;
  now: number;
  onStop: (slug: string) => void;
  stopping: boolean;
}) {
  const badge = statusBadgeStyle(spawn.status);
  const canStop = spawn.status === "running";

  return (
    <article
      data-testid="spawn-row"
      data-slug={spawn.slug}
      data-status={spawn.status}
      className="border border-rule rounded-lg bg-paper p-5"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h3 className="text-[16px] font-medium text-ink truncate">
              {spawn.name}
            </h3>
            <span
              className={`px-2 py-0.5 text-[11px] ff-mono rounded ${badge.bg} ${badge.text} ${
                badge.pulse ? "pulse-dot" : ""
              }`}
            >
              {badge.label}
            </span>
          </div>
          <div className="mt-1 text-[12px] text-dim ff-mono">
            slug={spawn.slug} · id={shortId(spawn.spawnId, 6, 4)}
          </div>
        </div>
        <div className="shrink-0">
          {canStop ? (
            <button
              data-testid="stop-button"
              onClick={() => onStop(spawn.slug)}
              disabled={stopping}
              className="px-3 py-1.5 text-[12px] border border-rule rounded hover:bg-rule2 disabled:opacity-30"
            >
              {stopping ? "Stopping…" : "Stop"}
            </button>
          ) : (
            <span className="text-[11px] text-dim ff-mono">—</span>
          )}
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-[8rem,1fr] gap-y-1.5 text-[12px]">
        <dt className="text-dim">Started</dt>
        <dd className="text-ink ff-mono">
          {relativeTime(spawn.startedAt, now)}
        </dd>
        <dt className="text-dim">Last update</dt>
        <dd className="text-ink ff-mono">
          {relativeTime(spawn.updatedAt, now)}
        </dd>
        <dt className="text-dim">PID</dt>
        <dd className="text-ink ff-mono">{spawn.pid ?? "—"}</dd>
        {spawn.message && (
          <>
            <dt className="text-dim">Message</dt>
            <dd className="text-ink2 break-words">{spawn.message}</dd>
          </>
        )}
      </dl>
    </article>
  );
}
