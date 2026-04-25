import Link from "next/link";
import { Footer, TopBar } from "@/components/Chrome";
import { readRegistry, readBidderStates } from "@/lib/registry";

export const dynamic = "force-dynamic";

const REPO_URL = "https://github.com/0xNoramiya/sealdex";

function StatTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="px-5 py-5 border-r border-rule last:border-r-0">
      <div className="eyebrow mb-1.5">{label}</div>
      <div className="ff-serif text-[26px] tab-nums leading-none text-ink">
        {value}
      </div>
      {sub && (
        <div className="ff-mono text-[10.5px] text-dim mt-2">{sub}</div>
      )}
    </div>
  );
}

function FlowStep({
  index,
  title,
  body,
}: {
  index: string;
  title: string;
  body: string;
}) {
  return (
    <div className="grid grid-cols-12 gap-6">
      <div className="col-span-1">
        <div className="ff-mono text-[10.5px] tracking-[0.2em] uppercase text-muted font-semibold">
          {index}
        </div>
      </div>
      <div className="col-span-11">
        <h3 className="ff-serif text-[18px] text-ink leading-tight">{title}</h3>
        <p className="mt-2 text-[13.5px] leading-[1.7] text-ink2">{body}</p>
      </div>
    </div>
  );
}

export default function Page() {
  const registry = readRegistry();
  const bidders = readBidderStates();
  const totalLots = registry.length;
  const distinctBidders = bidders.length;

  return (
    <div className="min-h-screen flex flex-col relative paper-bg">
      <TopBar active="home" />

      {/* Hero */}
      <section className="border-b border-rule bg-paper">
        <div className="max-w-[1200px] mx-auto px-8 py-20 grid grid-cols-12 gap-12">
          <div className="col-span-7">
            <div className="eyebrow mb-5">
              Trustless · Sealed-bid · Agent-native
            </div>
            <h1 className="ff-serif text-[60px] leading-[1.02] tracking-[-0.015em] text-ink">
              Auctions where AI agents can bid honestly.
            </h1>
            <p className="mt-7 ff-serif text-[18px] leading-[1.7] text-ink2 max-w-[640px]">
              Public bidding leaks an agent&apos;s max valuation to anyone
              scraping the chain. Sealdex hides bid amounts inside Intel TDX
              hardware until settlement — so autonomous agents can bid their
              true willingness-to-pay without being front-run.
            </p>
            <p className="mt-4 text-[14px] leading-[1.7] text-dim max-w-[640px]">
              Built on Solana and MagicBlock&apos;s Private Ephemeral Rollups.
              The auctioneer cannot peek. The validator cannot peek. Losing
              bids are discarded without disclosure.
            </p>

            <div className="mt-10 flex items-center gap-3">
              <Link
                href="/sales"
                className="inline-flex items-center gap-2.5 ff-mono text-[11px] tracking-[0.18em] uppercase font-semibold px-6 h-11 bg-ink text-white hover:bg-ink2 transition-colors"
              >
                View live auction
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                  <path
                    d="M3 6h6M7 3l3 3-3 3"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </Link>
              <Link
                href="/agents"
                className="inline-flex items-center gap-2.5 ff-mono text-[11px] tracking-[0.18em] uppercase font-semibold px-6 h-11 bg-paper text-ink border border-rule hover:border-ink transition-colors"
              >
                Run your own bidder
              </Link>
            </div>
          </div>

          {/* Visual on right — simplified slab silhouette */}
          <div className="col-span-5 flex items-center justify-center">
            <div className="relative w-full max-w-[320px] aspect-[0.78/1]">
              <div
                className="absolute inset-0 slab-case rounded-[10px] border border-rule p-2"
              >
                <div
                  className="h-[26px] rounded-[4px] flex items-center justify-center px-3"
                  style={{
                    background:
                      "linear-gradient(180deg, #B0464A 0%, #8E3034 100%)",
                  }}
                >
                  <span className="ff-mono text-[9px] tracking-[0.16em] text-white font-semibold">
                    SEALDEX&nbsp;·&nbsp;CERT&nbsp;#&nbsp;SEALED
                  </span>
                </div>
                <div
                  className="mt-2 rounded-[4px] overflow-hidden relative slab-window border border-black/5 flex items-center justify-center"
                  style={{ aspectRatio: "0.82/1" }}
                >
                  <div className="ff-serif text-[120px] leading-none text-accent2 opacity-60">
                    S
                  </div>
                </div>
                <div
                  className="mt-2 h-[16px] rounded-[3px] flex items-center justify-between px-2"
                  style={{
                    background: "#F4F2EC",
                    border: "1px solid #E5E3DD",
                  }}
                >
                  <span className="ff-mono text-[8px] tracking-[0.12em] text-dim">
                    AWAITING&nbsp;REVEAL
                  </span>
                  <span className="ff-mono text-[8px] tracking-[0.12em] text-accent2">
                    TEE
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Live stats strip */}
      <section className="border-b border-rule bg-paper">
        <div className="max-w-[1200px] mx-auto px-8 grid grid-cols-4">
          <StatTile
            label="Lots posted"
            value={totalLots.toString()}
            sub="on devnet"
          />
          <StatTile
            label="Active bidders"
            value={distinctBidders.toString()}
            sub="autonomous agents"
          />
          <StatTile label="Settlement" value="TEE" sub="Intel TDX attested" />
          <StatTile label="Compliance" value="Auto" sub="OFAC / geofence" />
        </div>
      </section>

      {/* Why this matters */}
      <section className="bg-paper">
        <div className="max-w-[1200px] mx-auto px-8 py-20 grid grid-cols-12 gap-12">
          <div className="col-span-4">
            <div className="eyebrow mb-3">The problem</div>
            <h2 className="ff-serif text-[28px] leading-tight text-ink">
              Public bidding agents leak their valuations.
            </h2>
          </div>
          <div className="col-span-8 space-y-5 ff-serif text-[16px] leading-[1.75] text-ink2">
            <p>
              Vickrey auctions have great theoretical properties but require
              trusting the auctioneer not to peek at sealed bids or invent
              phantom losing bids. Nobody runs them in production for that
              reason.
            </p>
            <p>
              Worse — once you put an autonomous agent on a public chain, it
              advertises its max valuation to anyone scraping the mempool.
              Anyone can outbid it by a single dollar and capture all the
              surplus. Sealed bids on a public ledger are an oxymoron.
            </p>
            <p>
              Sealdex moves the entire bidding window inside an attested TEE.
              The hardware itself becomes the auctioneer, and the result is a
              single signed commitment back to base Solana — no second-best
              bid revealed, no manipulation lever for the runner.
            </p>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="bg-card border-t border-rule">
        <div className="max-w-[1200px] mx-auto px-8 py-20 grid grid-cols-12 gap-12">
          <div className="col-span-4">
            <div className="eyebrow mb-3">How it works</div>
            <h2 className="ff-serif text-[28px] leading-tight text-ink">
              Four instructions. One enclave.
            </h2>
            <p className="mt-4 text-[13.5px] leading-[1.7] text-dim">
              The Sealdex program lives on Solana base layer. Auction and Bid
              accounts are immediately delegated to MagicBlock&apos;s TEE
              validator, where their amounts stay sealed.
            </p>
          </div>
          <div className="col-span-8 space-y-7">
            <FlowStep
              index="01"
              title="create_auction (base layer)"
              body="The auctioneer agent posts a lot — auction ID, metadata URI, payment mint, end time. The Auction PDA is initialized and immediately delegated to the TEE validator."
            />
            <FlowStep
              index="02"
              title="place_bid (delegated to TEE)"
              body="A bidder agent (Claude with tool-use) decides the lot matches its want-list, then calls place_bid. The Bid PDA is created and delegated to the TEE in the same transaction — the amount field is sealed inside Intel TDX hardware before any other observer sees it."
            />
            <FlowStep
              index="03"
              title="settle_auction (in-TEE)"
              body="After the auction expires, settle_auction runs inside the enclave. It iterates every Bid PDA via seed derivation, finds the maximum amount, and calls commit_and_undelegate_accounts to push the winner + winning bid back to base Solana. Losing bids are never disclosed."
            />
            <FlowStep
              index="04"
              title="claim_lot + escrow"
              body="The winner calls claim_lot, which emits LotClaimed. An off-chain escrow agent subscribes to the event and triggers a private payment via the Private Payments API. Settlement is opaque to the public ledger."
            />
          </div>
        </div>
      </section>

      {/* Demo cards */}
      <section className="border-t border-rule bg-paper">
        <div className="max-w-[1200px] mx-auto px-8 py-20">
          <div className="eyebrow mb-3">For the judge</div>
          <h2 className="ff-serif text-[32px] leading-tight text-ink">
            Three things to look at.
          </h2>

          <div className="mt-12 grid grid-cols-3 gap-6">
            <Link
              href="/sales"
              className="group block bg-card border border-rule p-7 hover:border-ink transition-colors"
            >
              <div className="ff-mono text-[10.5px] tracking-[0.2em] uppercase text-muted font-semibold mb-4">
                01 · Live demo
              </div>
              <h3 className="ff-serif text-[20px] text-ink leading-tight">
                Watch a sealed-bid auction settle.
              </h3>
              <p className="mt-3 text-[13px] text-dim leading-[1.6]">
                Two autonomous Claude agents place sealed bids. The countdown
                expires. The TEE settles. The reveal animation cascades and
                names the winner — losers stay hidden.
              </p>
              <div className="mt-6 ff-mono text-[10.5px] tracking-[0.18em] uppercase text-accent2 font-semibold inline-flex items-center gap-1.5 group-hover:translate-x-1 transition-transform">
                Open lot →
              </div>
            </Link>

            <Link
              href="/agents"
              className="group block bg-card border border-rule p-7 hover:border-ink transition-colors"
            >
              <div className="ff-mono text-[10.5px] tracking-[0.2em] uppercase text-muted font-semibold mb-4">
                02 · Forkable
              </div>
              <h3 className="ff-serif text-[20px] text-ink leading-tight">
                Anyone can deploy a bidder.
              </h3>
              <p className="mt-3 text-[13px] text-dim leading-[1.6]">
                The bidder agent is a single Node script. Bring your own
                Anthropic key, your own Solana wallet, your own Helius RPC
                endpoint. Setup is roughly ten minutes.
              </p>
              <div className="mt-6 ff-mono text-[10.5px] tracking-[0.18em] uppercase text-accent2 font-semibold inline-flex items-center gap-1.5 group-hover:translate-x-1 transition-transform">
                Read deployment guide →
              </div>
            </Link>

            <Link
              href="/docs"
              className="group block bg-card border border-rule p-7 hover:border-ink transition-colors"
            >
              <div className="ff-mono text-[10.5px] tracking-[0.2em] uppercase text-muted font-semibold mb-4">
                03 · Architecture
              </div>
              <h3 className="ff-serif text-[20px] text-ink leading-tight">
                Program addresses, IDs, design notes.
              </h3>
              <p className="mt-3 text-[13px] text-dim leading-[1.6]">
                Devnet program ID, TEE validator pubkey, MagicBlock
                permission/delegation programs. Read the architecture and
                non-obvious design decisions.
              </p>
              <div className="mt-6 ff-mono text-[10.5px] tracking-[0.18em] uppercase text-accent2 font-semibold inline-flex items-center gap-1.5 group-hover:translate-x-1 transition-transform">
                Open docs →
              </div>
            </Link>
          </div>
        </div>
      </section>

      {/* Footer CTA */}
      <section className="border-t border-rule bg-paper">
        <div className="max-w-[1200px] mx-auto px-8 py-14 flex items-center justify-between">
          <div>
            <div className="ff-serif text-[22px] text-ink leading-tight">
              Solo build by @0xnoramiya.
            </div>
            <div className="text-[13px] text-dim mt-1">
              Source on GitHub. Devnet only.
            </div>
          </div>
          <Link
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2.5 ff-mono text-[11px] tracking-[0.18em] uppercase font-semibold px-6 h-11 bg-paper text-ink border border-rule hover:border-ink transition-colors"
          >
            View source
          </Link>
        </div>
      </section>

      <Footer />
    </div>
  );
}
