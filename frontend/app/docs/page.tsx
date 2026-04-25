import type { Metadata } from "next";
import Link from "next/link";
import { Footer, TopBar } from "@/components/Chrome";
import DocsSidebar from "./Sidebar";

export const metadata: Metadata = {
  title: "Protocol",
  description: "Program design, devnet addresses, and architecture for Sealdex.",
};

const REPO = "https://github.com/0xNoramiya/sealdex";

const ADDRESSES = [
  {
    label: "Sealdex program",
    value: "4DBEkkdMaW7boAsmEFXLMbEiSnVj1xYQUndWYGzPwEMJ",
  },
  {
    label: "TEE validator pubkey",
    value: "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo",
  },
  {
    label: "Permission Program",
    value: "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1",
  },
  {
    label: "Delegation Program",
    value: "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh",
  },
  {
    label: "Devnet TEE RPC",
    value: "https://devnet-tee.magicblock.app",
  },
  {
    label: "Base layer RPC",
    value: "https://api.devnet.solana.com",
  },
];

const INSTRUCTIONS = [
  {
    name: "create_auction",
    layer: "base layer",
    body: "The auctioneer initializes an Auction PDA at [b\"auction\", auction_id], creates a Permission account allowing the seller to mutate it, and immediately delegates the PDA to the MagicBlock TEE validator. The auction is sealed from the moment it exists.",
  },
  {
    name: "place_bid",
    layer: "base layer → TEE",
    body: "Each bidder calls place_bid with their amount. The Bid PDA at [b\"bid\", auction_id, bidder] is created, given a Permission account scoped to the bidder, and delegated to the TEE in the same transaction. The amount field is sealed inside Intel TDX before any other observer sees it.",
  },
  {
    name: "settle_auction",
    layer: "in-TEE",
    body: "After the auction expires, settle_auction runs inside the enclave. It iterates each Bid PDA via seed derivation (validating that the right bidder + auction match), finds the maximum amount, sets auction.winner and auction.winning_bid, then calls commit_and_undelegate_accounts to push the auction state back to base Solana. Losing Bid PDAs stay encrypted in the TEE.",
  },
  {
    name: "claim_lot",
    layer: "base layer",
    body: "The winner calls claim_lot, which marks status=Claimed and emits the LotClaimed event. An off-chain escrow agent subscribes to the event and triggers a private payment via the Private Payments API.",
  },
];

const DECISIONS = [
  {
    title: "No Vec<Pubkey> on the Auction.",
    body: "Auctions are delegated to the TEE the moment they're created, so place_bid on the base layer can't mutate them. Tracking participants happens off-chain via the registry feed; settle_auction validates each Bid PDA at iteration time via seed derivation.",
  },
  {
    title: "Cluster-anchored countdown.",
    body: "The frontend captures cluster time on every /api/lot poll and extrapolates locally with Date.now() between fetches. This survives WSL/laptop clock skew.",
  },
  {
    title: "Prompt caching for the bidder.",
    body: "Bidder calls render in tools → system → messages order with a cache breakpoint on the last system block, so Claude caches tool definitions + system prompt together. Per-lot context sits after the breakpoint and is the only thing that varies between evaluations.",
  },
  {
    title: "Editorial frontend.",
    body: "Sotheby's-style catalog page sells the trustlessness pitch better than an infrastructure dashboard. The reveal is ceremonial — flip cascade with no confetti.",
  },
];

export default function DocsPage() {
  return (
    <div className="min-h-screen flex flex-col relative paper-bg">
      <TopBar active="docs" />

      <div className="border-b border-rule bg-paper">
        <div className="max-w-[1200px] mx-auto px-8 h-10 flex items-center justify-between text-[12px]">
          <div className="flex items-center gap-3 text-dim">
            <Link href="/" className="hover:text-ink">
              Home
            </Link>
            <span className="text-muted">/</span>
            <span className="text-ink">Docs</span>
          </div>
          <div className="flex items-center gap-5 text-dim">
            <Link
              href={REPO}
              target="_blank"
              rel="noreferrer"
              className="hover:text-ink ff-mono"
            >
              github.com/0xNoramiya/sealdex
            </Link>
          </div>
        </div>
      </div>

      <main className="flex-1">
        <div className="max-w-[1200px] mx-auto px-8 py-14">
          <div className="grid grid-cols-12 gap-12">
            {/* Sidebar */}
            <aside className="col-span-3">
              <DocsSidebar repoUrl={REPO} />
            </aside>

            {/* Main */}
            <article className="col-span-9 space-y-16">
              {/* Overview */}
              <section id="overview">
                <div className="eyebrow mb-3">Overview</div>
                <h1 className="ff-serif text-[40px] leading-tight text-ink tracking-[-0.01em]">
                  Sealdex architecture.
                </h1>
                <div className="mt-5 ff-serif text-[16px] leading-[1.75] text-ink2 space-y-4 max-w-[720px]">
                  <p>
                    Sealdex is a sealed-bid auction platform where the
                    auctioneer cannot peek at bids, the validator cannot
                    peek, and losing bids are discarded without disclosure.
                    It runs on Solana with MagicBlock&apos;s Private
                    Ephemeral Rollups providing the trusted execution
                    environment.
                  </p>
                  <p>
                    The core pattern: every Auction and Bid PDA is delegated
                    to a TEE validator on creation. From that moment until
                    settlement, the data lives inside Intel TDX hardware.
                    settle_auction runs inside the enclave, picks the max
                    bid, and commits only the winner back to base Solana via
                    commit_and_undelegate_accounts.
                  </p>
                </div>

                <div className="mt-10 grid grid-cols-3 gap-4">
                  <div className="border border-rule bg-card p-5">
                    <div className="eyebrow mb-2">Smart contract</div>
                    <div className="ff-serif text-[16px] text-ink">Anchor 0.32.1</div>
                    <div className="ff-mono text-[11px] text-dim mt-1">
                      ephemeral-rollups-sdk 0.11
                    </div>
                  </div>
                  <div className="border border-rule bg-card p-5">
                    <div className="eyebrow mb-2">Bidder LLM</div>
                    <div className="ff-serif text-[16px] text-ink">
                      Claude Sonnet 4.6
                    </div>
                    <div className="ff-mono text-[11px] text-dim mt-1">
                      Anthropic SDK · tool-use
                    </div>
                  </div>
                  <div className="border border-rule bg-card p-5">
                    <div className="eyebrow mb-2">Frontend</div>
                    <div className="ff-serif text-[16px] text-ink">Next.js 15</div>
                    <div className="ff-mono text-[11px] text-dim mt-1">
                      App Router · Tailwind 3
                    </div>
                  </div>
                </div>
              </section>

              {/* Instructions */}
              <section id="program">
                <div className="eyebrow mb-3">Program design</div>
                <h2 className="ff-serif text-[28px] leading-tight text-ink">
                  Four instructions.
                </h2>
                <div className="mt-8 space-y-7">
                  {INSTRUCTIONS.map((ix) => (
                    <div
                      key={ix.name}
                      className="grid grid-cols-12 gap-6 border-t border-rule pt-6"
                    >
                      <div className="col-span-3">
                        <div className="ff-mono text-[14px] text-ink font-semibold">
                          {ix.name}
                        </div>
                        <div className="ff-mono text-[10.5px] text-dim mt-1.5 tracking-[0.12em] uppercase">
                          {ix.layer}
                        </div>
                      </div>
                      <p className="col-span-9 text-[13.5px] leading-[1.75] text-ink2">
                        {ix.body}
                      </p>
                    </div>
                  ))}
                </div>
              </section>

              {/* Addresses */}
              <section id="addresses">
                <div className="eyebrow mb-3">Devnet addresses</div>
                <h2 className="ff-serif text-[28px] leading-tight text-ink">
                  Where to point your tools.
                </h2>
                <div className="mt-8 border border-rule bg-card">
                  {ADDRESSES.map((a, i) => (
                    <div
                      key={a.value}
                      className={`grid grid-cols-12 px-5 py-4 items-center ${
                        i < ADDRESSES.length - 1 ? "border-b border-rule" : ""
                      }`}
                    >
                      <div className="col-span-4 text-[13px] text-ink2">
                        {a.label}
                      </div>
                      <div className="col-span-8 ff-mono text-[12px] text-ink truncate">
                        {a.value}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              {/* Design decisions */}
              <section id="decisions">
                <div className="eyebrow mb-3">Design decisions</div>
                <h2 className="ff-serif text-[28px] leading-tight text-ink">
                  Non-obvious calls.
                </h2>
                <div className="mt-8 grid grid-cols-2 gap-x-10 gap-y-8">
                  {DECISIONS.map((d) => (
                    <div key={d.title}>
                      <h3 className="ff-serif text-[17px] text-ink leading-tight">
                        {d.title}
                      </h3>
                      <p className="mt-2 text-[13px] leading-[1.7] text-ink2">
                        {d.body}
                      </p>
                    </div>
                  ))}
                </div>
              </section>

              {/* Run */}
              <section id="run">
                <div className="eyebrow mb-3">Run it locally</div>
                <h2 className="ff-serif text-[28px] leading-tight text-ink">
                  Five-minute setup.
                </h2>
                <pre className="mt-8 ff-mono text-[12px] leading-[1.75] text-ink2 bg-card border border-rule px-5 py-4 overflow-x-auto whitespace-pre">
{`# Clone + install
git clone https://github.com/0xNoramiya/sealdex
cd sealdex && yarn install

# Wallets — generate four keypairs and fund the seller
mkdir -p .keys
for w in seller bidder1 bidder2 escrow; do
  solana-keygen new --no-bip39-passphrase --outfile .keys/$w.json --silent
done
solana airdrop 3 $(solana-keygen pubkey .keys/seller.json) --url devnet

# Env — at minimum set ANTHROPIC_API_KEY
cp .env.example .env

# Run the demo (four terminals)
cd frontend && yarn dev                                   # frontend at :3000
yarn tsx agents/bidder/index.ts agents/bidder/configs/alpha.json
yarn tsx agents/bidder/index.ts agents/bidder/configs/beta.json
yarn tsx agents/auctioneer/index.ts                       # posts demo lots`}
                </pre>
                <p className="mt-5 text-[13px] text-dim max-w-[720px]">
                  Full setup including third-party bidder deployment in the{" "}
                  <Link
                    href={`${REPO}/blob/main/README.md`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-ink2 underline decoration-rule underline-offset-2 hover:text-accent2"
                  >
                    repository README
                  </Link>{" "}
                  and the{" "}
                  <Link
                    href={`${REPO}/blob/main/agents/bidder/README.md`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-ink2 underline decoration-rule underline-offset-2 hover:text-accent2"
                  >
                    bidder agent guide
                  </Link>
                  .
                </p>
              </section>
            </article>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
