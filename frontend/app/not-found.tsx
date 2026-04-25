import Link from "next/link";
import { Footer, TopBar } from "@/components/Chrome";

export default function NotFound() {
  return (
    <div className="min-h-screen flex flex-col paper-bg">
      <TopBar active="home" />

      <main className="flex-1">
        <div className="max-w-[1200px] mx-auto px-8 py-24 grid grid-cols-12 gap-12 items-start">
          <div className="col-span-7">
            <div className="eyebrow mb-4">404 · Lot withdrawn</div>
            <h1 className="ff-serif text-[64px] leading-[1.04] tracking-[-0.015em] text-ink">
              This lot is not on the catalog.
            </h1>
            <p className="mt-6 ff-serif text-[18px] leading-[1.7] text-ink2 max-w-[560px]">
              The page you tried to open does not exist on this Sealdex
              deployment. It may have been an unposted lot, an in-flight
              auction that has since settled, or a route that has not been
              wired up yet.
            </p>
            <p className="mt-3 text-[13.5px] text-dim max-w-[560px]">
              Returning you to live state from one of the surfaces below.
            </p>

            <div className="mt-10 flex flex-wrap items-center gap-3">
              <Link
                href="/"
                className="inline-flex items-center gap-2.5 ff-mono text-[11px] tracking-[0.18em] uppercase font-semibold px-6 h-11 bg-ink text-white hover:bg-ink2 transition-colors"
              >
                Back to landing
              </Link>
              <Link
                href="/sales"
                className="inline-flex items-center gap-2.5 ff-mono text-[11px] tracking-[0.18em] uppercase font-semibold px-6 h-11 bg-paper text-ink border border-rule hover:border-ink transition-colors"
              >
                Open the catalog
              </Link>
              <Link
                href="/lots"
                className="inline-flex items-center gap-2.5 ff-mono text-[11px] tracking-[0.18em] uppercase font-semibold px-6 h-11 bg-paper text-ink border border-rule hover:border-ink transition-colors"
              >
                All lots
              </Link>
            </div>
          </div>

          <aside className="col-span-5">
            <div className="border border-rule bg-card p-7">
              <div className="eyebrow mb-3">Likely you were looking for</div>
              <ul className="space-y-3 text-[13.5px] text-ink2">
                <li className="flex items-start justify-between gap-4 border-b border-rule pb-3">
                  <Link href="/sales" className="hover:text-accent2">
                    The live sealed-bid auction
                  </Link>
                  <span className="ff-mono text-[10.5px] text-muted shrink-0">
                    /sales
                  </span>
                </li>
                <li className="flex items-start justify-between gap-4 border-b border-rule pb-3">
                  <Link href="/lots" className="hover:text-accent2">
                    Every lot, sealed and settled
                  </Link>
                  <span className="ff-mono text-[10.5px] text-muted shrink-0">
                    /lots
                  </span>
                </li>
                <li className="flex items-start justify-between gap-4 border-b border-rule pb-3">
                  <Link href="/agents" className="hover:text-accent2">
                    Run your own bidder agent
                  </Link>
                  <span className="ff-mono text-[10.5px] text-muted shrink-0">
                    /agents
                  </span>
                </li>
                <li className="flex items-start justify-between gap-4 border-b border-rule pb-3">
                  <Link href="/settlement" className="hover:text-accent2">
                    Settlement receipts
                  </Link>
                  <span className="ff-mono text-[10.5px] text-muted shrink-0">
                    /settlement
                  </span>
                </li>
                <li className="flex items-start justify-between gap-4">
                  <Link href="/docs" className="hover:text-accent2">
                    Program design + addresses
                  </Link>
                  <span className="ff-mono text-[10.5px] text-muted shrink-0">
                    /docs
                  </span>
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
