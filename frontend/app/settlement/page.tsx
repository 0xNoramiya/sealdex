import type { Metadata } from "next";
import Link from "next/link";
import { Footer, TopBar } from "@/components/Chrome";
import { readRegistry, readBidderStates } from "@/lib/registry";
import { readAuction } from "@/lib/onchain";
import { explorerAddress } from "@/lib/explorer";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Settlement",
  description: "Receipts from settled sealed-bid auctions on Sealdex.",
};

interface SettlementRow {
  auctionId: string;
  auctionPda: string;
  title: string;
  category: string;
  endTimeUnix: number;
  status: "Settled" | "Claimed";
  winner: string;
  winningBidUsdc: number;
  totalBidders: number;
}

function shortPubkey(pk: string): string {
  if (!pk || pk.length < 12) return pk;
  return `${pk.slice(0, 4)}…${pk.slice(-4)}`;
}

function fmtUnix(unix: number): string {
  const d = new Date(unix * 1000);
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

async function buildRows(): Promise<SettlementRow[]> {
  const registry = readRegistry();
  const states = readBidderStates();
  const out: SettlementRow[] = [];
  for (const r of registry) {
    let status: "Settled" | "Claimed" | null = null;
    let winner: string | null = null;
    let winningBidUsdc: number | null = null;
    try {
      const auction = await readAuction(r.auctionId);
      if (
        auction &&
        (auction.status === "Settled" || auction.status === "Claimed") &&
        auction.winner &&
        auction.winningBidNative
      ) {
        status = auction.status;
        winner = auction.winner;
        winningBidUsdc = Math.floor(
          Number(auction.winningBidNative) / 1_000_000,
        );
      }
    } catch {
      /* skip */
    }
    if (!status || !winner || winningBidUsdc == null) continue;
    let totalBidders = 0;
    for (const s of states) {
      if (s.bidsPlaced[r.auctionId]?.amountUsdc > 0) totalBidders++;
    }
    out.push({
      auctionId: r.auctionId,
      auctionPda: r.auctionPda,
      title: r.lot.lot_metadata.title ?? `Lot ${r.lot.lot_id}`,
      category: r.lot.lot_metadata.category ?? "Lot",
      endTimeUnix: r.endTimeUnix,
      status,
      winner,
      winningBidUsdc,
      totalBidders,
    });
  }
  return out.reverse();
}

export default async function SettlementPage() {
  const rows = await buildRows();
  const totalVolumeUsdc = rows.reduce((s, r) => s + r.winningBidUsdc, 0);

  return (
    <div className="min-h-screen flex flex-col relative paper-bg">
      <TopBar active="settlement" />

      <div className="border-b border-rule bg-paper">
        <div className="max-w-[1200px] mx-auto px-8 h-10 flex items-center justify-between text-[12px]">
          <div className="flex items-center gap-3 text-dim">
            <Link href="/" className="hover:text-ink">
              Home
            </Link>
            <span className="text-muted">/</span>
            <span className="text-ink">Settlement</span>
          </div>
          <div className="flex items-center gap-5 text-dim">
            <span>{rows.length} settled</span>
            <span className="text-muted">·</span>
            <span className="ff-mono text-ink">
              ${totalVolumeUsdc.toLocaleString()} USDC volume
            </span>
          </div>
        </div>
      </div>

      <main className="flex-1">
        <div className="max-w-[1200px] mx-auto px-8 py-14">
          <div className="eyebrow mb-3">Settlements</div>
          <h1 className="ff-serif text-[40px] leading-tight text-ink tracking-[-0.01em]">
            Receipts, post-reveal.
          </h1>
          <p className="mt-3 text-[14px] text-dim max-w-[680px]">
            Every settled auction. The TEE attests to the result and commits
            it to base Solana. Losing bids are never disclosed — only the
            winning pubkey and amount appear on-chain.
          </p>

          {rows.length === 0 ? (
            <div className="mt-14 border border-rule bg-card p-12 text-center">
              <div className="ff-serif text-[20px] text-ink mb-2">
                Nothing settled yet.
              </div>
              <p className="text-[13px] text-dim">
                Run an auction cycle to populate this page. After the
                countdown expires, the seller calls{" "}
                <span className="ff-mono text-ink2">settle_auction</span> and
                the result lands here.
              </p>
            </div>
          ) : (
            <div className="mt-12 space-y-5">
              {rows.map((r) => (
                <article
                  key={r.auctionId}
                  className="border border-rule bg-card p-7"
                >
                  <div className="grid grid-cols-12 gap-6 items-start">
                    <div className="col-span-7">
                      <div className="ff-mono text-[10.5px] tracking-[0.18em] uppercase text-muted font-semibold mb-2">
                        Sale&nbsp;#A-{r.auctionId.slice(-6)} ·{" "}
                        {r.category}
                      </div>
                      <h2 className="ff-serif text-[24px] text-ink leading-tight">
                        {r.title}
                      </h2>
                      <div className="mt-3 text-[13px] leading-[1.7] text-ink2">
                        Settled privately to{" "}
                        <a
                          href={explorerAddress(r.winner)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent2 font-medium hover:underline decoration-rule underline-offset-2"
                          title="Open winner address on Solana Explorer"
                        >
                          {shortPubkey(r.winner)}
                        </a>{" "}
                        at{" "}
                        <span className="ff-serif text-[15px] tab-nums text-ink">
                          ${r.winningBidUsdc.toLocaleString()}
                        </span>{" "}
                        USDC. Settlement opacity: full — losing bids
                        discarded inside the enclave.
                      </div>
                      <div className="mt-4 flex items-center gap-4 text-[11.5px] text-dim ff-mono">
                        <a
                          href={explorerAddress(r.auctionPda)}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:text-accent2 underline decoration-rule underline-offset-2"
                          title="Open auction PDA on Solana Explorer"
                        >
                          auction {shortPubkey(r.auctionPda)}
                        </a>
                        <span className="text-muted">·</span>
                        <span>{r.totalBidders} bidders sealed</span>
                        <span className="text-muted">·</span>
                        <span>{fmtUnix(r.endTimeUnix)}</span>
                      </div>
                    </div>

                    <div className="col-span-5 flex flex-col items-end gap-3">
                      <div className="text-right">
                        <div className="eyebrow mb-1">Settlement</div>
                        <div className="flex items-baseline gap-2 justify-end">
                          <span className="ff-serif text-[28px] text-accent2 font-medium tab-nums leading-none">
                            ${r.winningBidUsdc.toLocaleString()}
                          </span>
                          <span className="ff-mono text-[10.5px] tracking-[0.14em] text-dim">
                            USDC
                          </span>
                        </div>
                      </div>
                      <span
                        className={`ff-mono text-[10.5px] tracking-[0.16em] uppercase font-semibold ${
                          r.status === "Claimed"
                            ? "text-accent2"
                            : "text-ink2"
                        }`}
                      >
                        {r.status === "Claimed"
                          ? "Claimed · paid via Private Payments"
                          : "Settled · escrow pending"}
                      </span>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}

          <div className="mt-14 border-t border-rule pt-8 grid grid-cols-2 gap-12">
            <div>
              <div className="eyebrow mb-2">Privacy guarantee</div>
              <p className="text-[13.5px] leading-[1.7] text-ink2">
                Bid amounts are sealed inside Intel TDX hardware from the
                moment they hit the chain. The TEE attests to the result, but
                only the winner&apos;s amount is committed back to base
                Solana. Losing amounts stay encrypted in the enclave forever
                — no observer, including the auctioneer, ever learns them.
              </p>
            </div>
            <div>
              <div className="eyebrow mb-2">Compliance dividend</div>
              <p className="text-[13.5px] leading-[1.7] text-ink2">
                MagicBlock validators perform OFAC and geofence checks at
                ingress, transparent to the application layer. Sealdex
                inherits compliance for free — there&apos;s no policy
                surface in the program code itself.
              </p>
            </div>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
