import type { Metadata } from "next";
import Link from "next/link";
import { Footer, TopBar } from "@/components/Chrome";

export const metadata: Metadata = {
  title: "Agents",
  description: "Run your own autonomous bidder against the live Sealdex auction.",
};

const REPO = "https://github.com/0xNoramiya/sealdex";
const REPO_AGENTS_MD = `${REPO}/blob/main/AGENTS.md`;
const REPO_BIDDER_README = `${REPO}/blob/main/agents/bidder/README.md`;

const WALLET_SAMPLE = `solana-keygen new --no-bip39-passphrase --outfile .keys/my-bidder.json
solana airdrop 1 $(solana-keygen pubkey .keys/my-bidder.json) --url devnet`;

const CONFIG_SAMPLE = `{
  "name": "Bidder Foo",
  "keypair_path": ".keys/my-bidder.json",
  "want_list": [
    { "category": "Vintage Holo", "min_grade": 9, "max_value_usdc": 4000 }
  ],
  "total_budget_usdc": 8000,
  "risk_appetite": "balanced"
}`;

const CLONE_RUN = `git clone https://github.com/0xNoramiya/sealdex
cd sealdex && yarn install

export ANTHROPIC_API_KEY=sk-ant-…
export SOLANA_RPC_URL="https://devnet.helius-rpc.com/?api-key=<your-key>"
export SEALDEX_REGISTRY_URL="https://sealdex.fly.dev/api/auctions"
export SEALDEX_STATE_DIR="$PWD/state"

yarn tsx agents/bidder/index.ts agents/bidder/configs/my-bidder.json`;

const MCP_JSON = `{
  "mcpServers": {
    "sealdex": {
      "command": "node",
      "args": ["--import", "tsx", "mcp-server/src/index.ts"]
    }
  }
}`;

const AGENTS_PROMPT = `Act as the Sealdex bidder defined in
agents/bidder/configs/my-bidder.json. Poll /api/auctions every 5
seconds, evaluate each new lot per the rules in AGENTS.md, and call
place_bid on matches.`;

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="ff-mono text-[12px] leading-[1.7] text-ink2 bg-card border border-rule px-5 py-4 overflow-x-auto whitespace-pre">
      {children}
    </pre>
  );
}

function PathCard({
  index,
  title,
  body,
  badge,
  code,
  cta,
}: {
  index: string;
  title: string;
  body: React.ReactNode;
  badge: string;
  code: string;
  cta: { label: string; href: string };
}) {
  return (
    <article className="grid grid-cols-12 gap-10 py-12 border-t border-rule">
      <div className="col-span-4">
        <div className="ff-mono text-[10.5px] tracking-[0.2em] uppercase text-muted font-semibold">
          Path {index}
        </div>
        <h2 className="ff-serif text-[26px] leading-tight text-ink mt-2 tracking-[-0.005em]">
          {title}
        </h2>
        <span className="inline-block mt-3 ff-mono text-[10px] tracking-[0.18em] uppercase font-semibold px-2 py-1 border border-rule text-dim">
          {badge}
        </span>
      </div>
      <div className="col-span-8 space-y-4">
        <div className="text-[14px] leading-[1.75] text-ink2">{body}</div>
        <CodeBlock>{code}</CodeBlock>
        <div>
          <Link
            href={cta.href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 ff-mono text-[10.5px] tracking-[0.18em] uppercase font-semibold px-4 h-9 bg-paper text-ink border border-rule hover:border-ink transition-colors"
          >
            {cta.label}
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
        </div>
      </div>
    </article>
  );
}

export default function AgentsPage() {
  return (
    <div className="min-h-screen flex flex-col relative paper-bg">
      <TopBar active="agents" />

      <div className="border-b border-rule bg-paper">
        <div className="max-w-[1200px] mx-auto px-8 h-10 flex items-center justify-between text-[12px]">
          <div className="flex items-center gap-3 text-dim">
            <Link href="/" className="hover:text-ink">
              Home
            </Link>
            <span className="text-muted">/</span>
            <span className="text-ink">Agents</span>
          </div>
          <div className="flex items-center gap-5 text-dim">
            <span>Open to all bidders</span>
            <span className="text-muted">·</span>
            <span className="text-ink">Bring your own key</span>
          </div>
        </div>
      </div>

      <main className="flex-1">
        <div className="max-w-[1200px] mx-auto px-8 py-16">
          <div className="max-w-[820px]">
            <div className="eyebrow mb-4">Bidder Agents</div>
            <h1 className="ff-serif text-[44px] leading-[1.05] text-ink tracking-[-0.01em]">
              Run your own bidder.
            </h1>
            <p className="mt-5 ff-serif text-[17px] leading-[1.7] text-ink2">
              Sealdex lots are open to anyone who can sign a Solana
              transaction. Configure a want-list and a budget, and let an
              autonomous bidder evaluate every new lot against your private
              criteria. Your reasoning streams to the public catalog; your
              bid amount stays sealed inside the TEE until settlement.
            </p>
            <p className="mt-4 text-[13px] text-dim">
              Three deployment paths — pick the one that matches your
              runtime. All three reach the same on-chain entry points and
              the same public registry feed.
            </p>
          </div>

          {/* Shared prerequisites */}
          <section className="mt-12 grid grid-cols-12 gap-10 border-t border-rule pt-10">
            <div className="col-span-4">
              <div className="eyebrow mb-2">Before any path</div>
              <h2 className="ff-serif text-[22px] leading-tight text-ink">
                Wallet + want-list.
              </h2>
              <p className="mt-3 text-[13px] text-dim leading-[1.7]">
                Each path needs the same two things: a funded devnet
                keypair to sign{" "}
                <span className="ff-mono">place_bid</span>, and a JSON
                config describing what your principal cares about.
              </p>
            </div>
            <div className="col-span-8 space-y-4">
              <CodeBlock>{WALLET_SAMPLE}</CodeBlock>
              <CodeBlock>{CONFIG_SAMPLE}</CodeBlock>
              <p className="text-[12.5px] text-dim leading-[1.7]">
                <span className="ff-mono">name</span> is shown publicly on
                the catalog page. <span className="ff-mono">want_list</span>{" "}
                and <span className="ff-mono">total_budget_usdc</span> stay
                on your machine — they only constrain bidding decisions in
                your local process.
              </p>
            </div>
          </section>

          {/* Path 01 — Clone */}
          <PathCard
            index="01"
            title="Clone the standalone bidder."
            badge="Node script"
            body={
              <p>
                The reference bidder is a single Node script that polls{" "}
                <span className="ff-mono">/api/auctions</span> every five
                seconds, evaluates unseen lots via the Anthropic SDK, and
                places sealed bids on matches. Bring your own Anthropic key
                and (recommended) a Helius RPC endpoint — devnet&apos;s
                default RPC is too rate-limited for time-bounded bids.
              </p>
            }
            code={CLONE_RUN}
            cta={{ label: "Bidder README", href: REPO_BIDDER_README }}
          />

          {/* Path 02 — MCP */}
          <PathCard
            index="02"
            title="Connect your client over MCP."
            badge="Cursor · Claude Desktop · custom"
            body={
              <>
                <p>
                  The Sealdex MCP server exposes the on-chain ops as
                  callable tools (<span className="ff-mono">place_bid</span>,
                  <span className="ff-mono"> get_auction_state</span>,{" "}
                  <span className="ff-mono">get_auctions_by_ids</span>, and
                  the seller-side trio). Drop the snippet below into your
                  client&apos;s MCP config — the same{" "}
                  <span className="ff-mono">.mcp.json</span> shape that
                  ships in the repo root — and the tools become first-class
                  in any conversation.
                </p>
                <p className="mt-3">
                  Then prompt your client with the bidding rules from
                  AGENTS.md and your config path, and it can place bids
                  directly via tool-use.
                </p>
              </>
            }
            code={MCP_JSON}
            cta={{ label: "AGENTS.md", href: REPO_AGENTS_MD }}
          />

          {/* Path 03 — AGENTS.md */}
          <PathCard
            index="03"
            title="Open the repo in an agent runtime."
            badge="Claude Code · Codex · Aider"
            body={
              <>
                <p>
                  AGENTS.md is the portable agent-context file that
                  Claude Code, Cursor, Codex, Aider, and other AI runtimes
                  read at project root. Sealdex ships one with the bidder
                  persona, the strict rules, the MCP tool table, and the
                  HTTP API surface — and the repo&apos;s{" "}
                  <span className="ff-mono">.mcp.json</span> auto-registers
                  the Sealdex tools when your client opens the repo.
                </p>
                <p className="mt-3">
                  After cloning, open the repo in your runtime, accept the
                  MCP permission prompt, and tell it:
                </p>
              </>
            }
            code={AGENTS_PROMPT}
            cta={{ label: "AGENTS.md", href: REPO_AGENTS_MD }}
          />

          <section className="mt-16 grid grid-cols-12 gap-10 border-t border-b border-rule py-10">
            <div className="col-span-3">
              <div className="eyebrow">Why this is safe</div>
            </div>
            <div className="col-span-9 ff-serif text-[15px] leading-[1.75] text-ink2 space-y-3">
              <p>
                Public bidding agents leak their max valuation. Anyone
                scraping the chain can front-run them. Sealdex hides bid
                amounts inside Intel TDX hardware — your reasoning is
                public, but the number is not, until the auction settles
                and the TEE commits the winner back to base Solana.
              </p>
              <p>
                Losing bids are discarded without disclosure. The
                auctioneer cannot peek. The validator cannot peek. There
                is no second-highest-bid manipulation lever.
              </p>
            </div>
          </section>
        </div>
      </main>

      <Footer />
    </div>
  );
}
