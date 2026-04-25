import type { Metadata } from "next";
import Link from "next/link";
import { Footer, TopBar } from "@/components/Chrome";
import { readRegistry, readBidderStates } from "@/lib/registry";
import { readAuction } from "@/lib/onchain";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Lots",
  description: "Every lot posted to the Sealdex program — sealed and settled.",
};

interface LotRow {
  auctionId: string;
  auctionPda: string;
  title: string;
  category: string;
  grade: number;
  estimateLow?: number;
  estimateHigh?: number;
  endTimeUnix: number;
  status: "Open" | "Settled" | "Claimed" | "Unknown";
  winner: string | null;
  winningBidUsdc: number | null;
  bidsPlaced: number;
}

function shortPubkey(pk: string): string {
  if (!pk || pk.length < 12) return pk;
  return `${pk.slice(0, 4)}…${pk.slice(-4)}`;
}

function fmtTimeLeft(secondsLeft: number): string {
  if (secondsLeft <= 0) return "ended";
  const m = Math.floor(secondsLeft / 60);
  const s = secondsLeft % 60;
  if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

async function buildLotRows(): Promise<LotRow[]> {
  const registry = readRegistry();
  const states = readBidderStates();
  const now = Math.floor(Date.now() / 1000);
  const out: LotRow[] = [];
  for (const r of registry) {
    let status: LotRow["status"] = "Unknown";
    let winner: string | null = null;
    let winningBidUsdc: number | null = null;
    try {
      const auction = await readAuction(r.auctionId);
      if (auction) {
        status = auction.status;
        winner = auction.winner;
        if (auction.winningBidNative) {
          winningBidUsdc = Math.floor(
            Number(auction.winningBidNative) / 1_000_000,
          );
        }
      } else {
        status = r.endTimeUnix <= now ? "Unknown" : "Open";
      }
    } catch {
      status = r.endTimeUnix <= now ? "Unknown" : "Open";
    }
    let bidsPlaced = 0;
    for (const s of states) {
      if (s.bidsPlaced[r.auctionId]?.amountUsdc > 0) bidsPlaced++;
    }
    out.push({
      auctionId: r.auctionId,
      auctionPda: r.auctionPda,
      title: r.lot.lot_metadata.title ?? `Lot ${r.lot.lot_id}`,
      category: r.lot.lot_metadata.category ?? "Lot",
      grade: r.lot.lot_metadata.grade ?? 0,
      estimateLow: r.lot.lot_metadata.estimate_low_usdc,
      estimateHigh: r.lot.lot_metadata.estimate_high_usdc,
      endTimeUnix: r.endTimeUnix,
      status,
      winner,
      winningBidUsdc,
      bidsPlaced,
    });
  }
  return out.reverse();
}

function StatusPill({ status }: { status: LotRow["status"] }) {
  if (status === "Open") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-accent pulse-dot" />
        <span className="ff-mono text-[10.5px] tracking-[0.16em] uppercase text-accent2 font-semibold">
          Sealed
        </span>
      </span>
    );
  }
  if (status === "Settled") {
    return (
      <span className="ff-mono text-[10.5px] tracking-[0.16em] uppercase text-ink font-semibold">
        Settled
      </span>
    );
  }
  if (status === "Claimed") {
    return (
      <span className="ff-mono text-[10.5px] tracking-[0.16em] uppercase text-accent2 font-semibold">
        Claimed
      </span>
    );
  }
  return (
    <span className="ff-mono text-[10.5px] tracking-[0.16em] uppercase text-muted font-semibold">
      Unknown
    </span>
  );
}

export default async function LotsPage() {
  const rows = await buildLotRows();
  const now = Math.floor(Date.now() / 1000);

  return (
    <div className="min-h-screen flex flex-col relative paper-bg">
      <TopBar active="lots" />

      <div className="border-b border-rule bg-paper">
        <div className="max-w-[1200px] mx-auto px-8 h-10 flex items-center justify-between text-[12px]">
          <div className="flex items-center gap-3 text-dim">
            <Link href="/" className="hover:text-ink">
              Home
            </Link>
            <span className="text-muted">/</span>
            <span className="text-ink">Lots</span>
          </div>
          <div className="flex items-center gap-5 text-dim">
            <span>{rows.length} total</span>
            <span className="text-muted">·</span>
            <span>
              {rows.filter((r) => r.status === "Open").length} sealed
            </span>
            <span className="text-muted">·</span>
            <span>
              {rows.filter((r) => r.status === "Settled" || r.status === "Claimed").length} settled
            </span>
          </div>
        </div>
      </div>

      <main className="flex-1">
        <div className="max-w-[1200px] mx-auto px-8 py-14">
          <div className="eyebrow mb-3">All lots</div>
          <h1 className="ff-serif text-[40px] leading-tight text-ink tracking-[-0.01em]">
            Auction history.
          </h1>
          <p className="mt-3 text-[14px] text-dim max-w-[640px]">
            Every lot posted to the Sealdex program. Sealed lots have their
            bid amounts hidden inside the TEE; settled lots show only the
            winning amount on base Solana.
          </p>

          {rows.length === 0 ? (
            <div className="mt-14 border border-rule bg-card p-12 text-center">
              <div className="ff-serif text-[20px] text-ink mb-2">
                No lots yet.
              </div>
              <p className="text-[13px] text-dim">
                The auctioneer hasn&apos;t posted any auctions on this host.
                Run{" "}
                <span className="ff-mono text-ink2">
                  yarn tsx agents/auctioneer/index.ts
                </span>{" "}
                to seed the demo inventory.
              </p>
            </div>
          ) : (
            <div className="mt-12 border border-rule bg-card">
              <div className="grid grid-cols-12 px-6 h-12 items-center border-b border-rule bg-paper text-[10.5px] tracking-[0.14em] uppercase text-muted font-semibold">
                <div className="col-span-4">Lot</div>
                <div className="col-span-2">Category</div>
                <div className="col-span-2 text-right">Estimate</div>
                <div className="col-span-2 text-right">Bidders</div>
                <div className="col-span-2 text-right">Status</div>
              </div>
              {rows.map((r) => (
                <Link
                  key={r.auctionId}
                  href="/sales"
                  className="grid grid-cols-12 px-6 py-5 items-center border-b border-rule last:border-b-0 hover:bg-paper transition-colors group"
                >
                  <div className="col-span-4 flex items-center gap-4">
                    <div
                      className="shrink-0 w-9 h-9 flex items-center justify-center"
                      style={{
                        background: "#FFFFFF",
                        color: "#14171C",
                        border: "1px solid #E5E3DD",
                        borderRadius: 2,
                        fontFamily: "var(--font-fraunces), serif",
                        fontWeight: 500,
                        fontSize: 16,
                      }}
                    >
                      {r.title.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="ff-serif text-[16px] text-ink truncate">
                        {r.title}
                      </div>
                      <div className="ff-mono text-[10.5px] text-muted mt-1">
                        {shortPubkey(r.auctionPda)} ·{" "}
                        {r.status === "Open"
                          ? fmtTimeLeft(r.endTimeUnix - now)
                          : "ended"}
                      </div>
                    </div>
                  </div>

                  <div className="col-span-2 text-[13px] text-dim">
                    {r.category}
                    <div className="ff-mono text-[10.5px] text-muted">
                      Grade {r.grade}
                    </div>
                  </div>

                  <div className="col-span-2 text-right">
                    {r.estimateLow && r.estimateHigh ? (
                      <div className="ff-serif text-[14px] text-ink2 tab-nums">
                        ${r.estimateLow.toLocaleString()} —{" "}
                        ${r.estimateHigh.toLocaleString()}
                      </div>
                    ) : (
                      <div className="text-[13px] text-muted">—</div>
                    )}
                  </div>

                  <div className="col-span-2 text-right">
                    {r.status === "Open" ? (
                      <div className="ff-mono text-[13px] text-stamp tab-nums">
                        {r.bidsPlaced} sealed
                      </div>
                    ) : r.winningBidUsdc != null ? (
                      <div className="ff-serif text-[15px] text-accent2 font-medium tab-nums">
                        ${r.winningBidUsdc.toLocaleString()}
                      </div>
                    ) : (
                      <div className="text-[13px] text-muted">—</div>
                    )}
                    {r.status !== "Open" && r.winner && (
                      <div className="ff-mono text-[10.5px] text-muted mt-1">
                        {shortPubkey(r.winner)}
                      </div>
                    )}
                  </div>

                  <div className="col-span-2 text-right">
                    <StatusPill status={r.status} />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </main>

      <Footer />
    </div>
  );
}
