"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Footer, TopBar } from "@/components/Chrome";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface the error to whatever monitoring is wired in.
    // (We don't ship Sentry yet, but logging keeps the trail visible.)
    console.error(error);
  }, [error]);

  return (
    <div className="min-h-screen flex flex-col paper-bg">
      <TopBar active="home" />

      <main className="flex-1">
        <div className="max-w-[1200px] mx-auto px-8 py-24 grid grid-cols-12 gap-12 items-start">
          <div className="col-span-7">
            <div className="eyebrow mb-4">Something went wrong</div>
            <h1 className="ff-serif text-[60px] leading-[1.04] tracking-[-0.015em] text-ink">
              The page failed to render.
            </h1>
            <p className="mt-6 ff-serif text-[18px] leading-[1.7] text-ink2 max-w-[560px]">
              Something raised an uncaught exception while building this view.
              The auction state on Solana is unaffected — only this rendering
              path failed. Try again, or jump to one of the live surfaces.
            </p>

            {error.digest && (
              <div className="mt-5 ff-mono text-[11.5px] text-dim">
                ref:{" "}
                <span className="text-ink2 select-all">{error.digest}</span>
              </div>
            )}

            <div className="mt-10 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => reset()}
                className="inline-flex items-center gap-2.5 ff-mono text-[11px] tracking-[0.18em] uppercase font-semibold px-6 h-11 bg-ink text-white hover:bg-ink2 transition-colors"
              >
                Try again
              </button>
              <Link
                href="/sales"
                className="inline-flex items-center gap-2.5 ff-mono text-[11px] tracking-[0.18em] uppercase font-semibold px-6 h-11 bg-paper text-ink border border-rule hover:border-ink transition-colors"
              >
                Open the catalog
              </Link>
              <Link
                href="/"
                className="inline-flex items-center gap-2.5 ff-mono text-[11px] tracking-[0.18em] uppercase font-semibold px-6 h-11 bg-paper text-ink border border-rule hover:border-ink transition-colors"
              >
                Back to landing
              </Link>
            </div>
          </div>

          <aside className="col-span-5">
            <div className="border border-rule bg-card p-7">
              <div className="eyebrow mb-3">Likely causes</div>
              <ul className="space-y-3 text-[13.5px] text-ink2">
                <li className="border-b border-rule pb-3">
                  Devnet RPC briefly unreachable — the Solana cluster
                  occasionally throttles or refuses connections.
                </li>
                <li className="border-b border-rule pb-3">
                  TEE validator returning malformed account data — rare, but
                  can happen during MagicBlock validator restarts.
                </li>
                <li>
                  A regression in the rendering path. The error reference
                  above will help reproduce it from the server logs.
                </li>
              </ul>
            </div>
          </aside>
        </div>
      </main>

      <Footer />
    </div>
  );
}
