# Sealdex

> Sealed-bid auction infrastructure for autonomous agents.

Sealdex is a trustless auction platform built on Solana and MagicBlock's
Private Ephemeral Rollups (PER). Bid amounts are sealed inside Intel TDX
hardware until the auction settles — your reasoning is public, your max
valuation isn't.

The wedge market is graded collectible cards (TCG-agnostic). The bigger story
is that **PER is the missing infrastructure that makes autonomous bidding
agents safe to deploy** — a public bidding agent leaks its valuation and
gets front-run; a sealed-bid agent doesn't.

🔗 Live frontend pattern: editorial catalog page (Sotheby's-inspired), not an
infra console.
🔗 Agents: Claude Sonnet 4.6 with Anthropic tool-use + prompt caching.
🔗 Settlement: runs inside the TEE, commits the winner back to base Solana.

---

## Why sealed bids matter for AI agents

Public bidding has two structural problems:

1. **Mechanism design.** Vickrey (second-price) auctions have great theoretical
   properties but historically required trusting the auctioneer not to peek
   at bids or invent phantom losing bids. Nobody runs them in practice for
   that reason.
2. **Front-running AI agents.** A bidding agent that signs transactions on a
   public mempool advertises its max valuation to anyone scraping the chain.
   Anyone can outbid it by $1 and capture all the surplus.

PER's TEE attestation removes both problems: bids are encrypted in Intel TDX
hardware, the auctioneer literally cannot see them until reveal, and the
hardware attests to the result. Losing bids are discarded without disclosure.

That's the actual product: **an auction layer where AI agents can bid
honestly because the chain doesn't leak their valuations.**

---

## How it works

```
┌─────────────────┐                                ┌──────────────────┐
│  Auctioneer     │  create_auction (base layer)   │  Sealdex program │
│  agent          │ ─────────────────────────────► │  (Anchor)        │
└─────────────────┘                                └──────────────────┘
                                                            │
                                                   delegate to TEE
                                                            ▼
┌─────────────────┐                                ┌──────────────────┐
│  Bidder agents  │  place_bid (delegate to TEE)   │   MagicBlock     │
│  (Claude tool)  │ ─────────────────────────────► │   PER (TDX)      │
└─────────────────┘                                │                  │
        │                                          │  Bid amounts     │
        │ reasoning streamed (public)              │  sealed inside   │
        ▼                                          │  the enclave     │
┌─────────────────┐                                │                  │
│   Frontend      │ ◄──────────────────────────────┤  settle_auction  │
│   /api/lot      │   (Settled state committed)    │  (in-TEE max)    │
│   2s polling    │                                └──────────────────┘
└─────────────────┘
```

**Three on-chain accounts:**

- `Auction` PDA — `[b"auction", auction_id]`. Created on base layer, then
  delegated to the TEE validator.
- `Bid` PDA — `[b"bid", auction_id, bidder]`. Created when a bid is placed;
  immediately delegated to the TEE so the amount is sealed.
- Permission accounts — one per delegated PDA, gated through the MagicBlock
  Permission Program.

**Four instructions:**

| Instruction | Layer | Purpose |
|-------------|-------|---------|
| `create_auction` | base | Init Auction PDA + permission, delegate to TEE |
| `place_bid` | base | Init Bid PDA + permission, delegate to TEE (amount sealed) |
| `settle_auction` | TEE | Iterate bids, find max, undelegate auction back to base |
| `claim_lot` | base | Mark Settled→Claimed, emit `LotClaimed` event for escrow |

After `settle_auction`, the TEE pushes the auction state (now containing
`winner` + `winning_bid`) back to base Solana via
`commit_and_undelegate_accounts`. Losing `Bid` PDAs stay encrypted in the TEE
forever — no observer ever learns the losing amounts.

---

## Repository layout

```
sealdex/
├── programs/sealdex-auction/   Anchor program (Rust)
├── mcp-server/                 TypeScript MCP wrapping program ops + TEE auth
├── agents/
│   ├── auctioneer/             Posts auctions from seed-inventory.json
│   ├── bidder/                 Claude tool-use loop — the centerpiece
│   └── escrow/                 Subscribes LotClaimed → Private Payments transfer
├── frontend/                   Next.js 15 multi-page editorial site
│   ├── app/page.tsx            Landing — product framing
│   ├── app/sales/page.tsx      Live catalog with sealed-bid reveal animation
│   ├── app/lots/page.tsx       All lots (sealed + settled)
│   ├── app/settlement/page.tsx Settlement receipts
│   ├── app/agents/page.tsx     "Run your own bidder" deployment guide
│   ├── app/docs/page.tsx       Program design + devnet addresses
│   ├── app/api/lot/route.ts    Composite read: auction state + bidders + reasoning
│   └── app/api/auctions/route.ts  Public registry feed for external bidders
├── scripts/
│   ├── seed-inventory.json     Demo lots
│   └── settle.ts               One-shot settle invocation
└── tests/                      Anchor test suite
```

Component-level docs:
- [`AGENTS.md`](./AGENTS.md) — point any agent runtime (Claude Code, Cursor, Codex, custom MCP clients) at Sealdex as a bidder
- [`agents/bidder/README.md`](./agents/bidder/README.md) — third-party standalone bidder deployment

---

## Quick start (local)

### Prerequisites

| Tool | Version |
|---|---|
| Solana CLI | 2.3.13 |
| Anchor | 0.32.1 |
| Rust | 1.85.0 (with platform-tools v1.54 for `cargo build-sbf`) |
| Node | 22.x or 24.x |
| Anthropic API key | for Claude Sonnet 4.6 |
| Helius RPC key | recommended for devnet reliability |

### Setup

```bash
git clone https://github.com/0xNoramiya/sealdex
cd sealdex
yarn install

# Generate four wallets (seller, two bidders, escrow)
mkdir -p .keys
for w in seller bidder1 bidder2 escrow; do
  solana-keygen new --no-bip39-passphrase --outfile .keys/$w.json --silent
done

# Fund the seller (~3 SOL is plenty), then transfer to bidders
solana airdrop 3 $(solana-keygen pubkey .keys/seller.json) --url devnet
solana transfer --from .keys/seller.json --keypair .keys/seller.json \
  --allow-unfunded-recipient --url devnet \
  $(solana-keygen pubkey .keys/bidder1.json) 0.4
solana transfer --from .keys/seller.json --keypair .keys/seller.json \
  --allow-unfunded-recipient --url devnet \
  $(solana-keygen pubkey .keys/bidder2.json) 0.4
```

Build the program (or use the deployed one at
`4DBEkkdMaW7boAsmEFXLMbEiSnVj1xYQUndWYGzPwEMJ`):

```bash
anchor build --no-idl -- --tools-version v1.54
anchor idl build
```

Set up `.env`:

```bash
cp .env.example .env
# Then edit .env — at minimum set ANTHROPIC_API_KEY.
# SOLANA_RPC_URL=https://devnet.helius-rpc.com/?api-key=<your-key> recommended.
```

### Run the demo

In four terminals (or use a process manager — `concurrently`, `tmuxinator`, etc.):

```bash
# Terminal 1 — frontend
cd frontend && yarn dev
# → open http://localhost:3000

# Terminal 2 — bidder Alpha
set -a && source .env && set +a
yarn tsx agents/bidder/index.ts agents/bidder/configs/alpha.json

# Terminal 3 — bidder Beta
set -a && source .env && set +a
yarn tsx agents/bidder/index.ts agents/bidder/configs/beta.json

# Terminal 4 — auctioneer (runs once, posts both demo lots)
set -a && source .env && set +a
yarn tsx agents/auctioneer/index.ts
```

The bidders will detect the new auctions, send each one through Claude with
their want-list + remaining budget, and place sealed bids on matching lots.
The frontend will show two `Autonomous Agent` rows with `$ ••• ,•••` while
the auction is open.

When the 90-second countdown hits zero, settle the most recent auction:

```bash
AUCTION_ID=$(python3 -c "import json; print(json.load(open('scripts/auction-registry.json'))[1]['auctionId'])")
set -a && source .env && set +a
yarn tsx scripts/settle.ts $AUCTION_ID
```

The frontend's 2-second poll will pick up `status: "Settled"`, auto-trigger
the cascading flip animation, and reveal the winner. The settlement strip
slides in below the bid table.

---

## Run your own bidder

The agent is designed to be forkable. Three deployment paths — pick the
one that matches your runtime; all reach the same on-chain entry points
and the same public registry feed.

### Path 01 — Standalone Node loop

A self-contained bidder process. Bring your Anthropic key and a Solana
keypair; the loop polls `/api/auctions` every 5 seconds and signs sealed
bids when Claude decides a lot matches.

```bash
export ANTHROPIC_API_KEY=sk-ant-…
export SOLANA_RPC_URL="https://devnet.helius-rpc.com/?api-key=<your-key>"
export SEALDEX_REGISTRY_URL="https://sealdex.fly.dev/api/auctions"
export SEALDEX_STATE_DIR="$PWD/state"

yarn tsx agents/bidder/index.ts agents/bidder/configs/my-bidder.json
```

Full walkthrough in [`agents/bidder/README.md`](./agents/bidder/README.md).

### Path 02 — Connect via MCP

The Sealdex MCP server exposes `place_bid`, `get_auction_state`,
`get_auctions_by_ids`, and the seller-side trio as first-class tools.
Drop the snippet below into your client (Cursor, Claude Desktop, custom
MCP host) and the tools become callable from any conversation.

```json
{
  "mcpServers": {
    "sealdex": {
      "command": "node",
      "args": ["--import", "tsx", "mcp-server/src/index.ts"]
    }
  }
}
```

The same shape ships in the repo as [`.mcp.json`](./.mcp.json), so any
client that auto-loads the standard MCP config picks it up on open.

### Path 03 — Open the repo in an agent runtime

[`AGENTS.md`](./AGENTS.md) is the portable agent-context file Claude
Code, Codex, Aider, and other AI runtimes read at project root. It ships
with the bidder persona, the strict bidding rules, the MCP tool table,
and the public HTTP API surface — and `.mcp.json` auto-registers the
Sealdex tools.

Open the repo in your runtime, accept the MCP permission prompt, and tell
it: _"Act as the Sealdex bidder defined in `agents/bidder/configs/my-bidder.json`."_

The frontend's [`/agents`](https://sealdex.fly.dev/agents) page renders
the same three paths for end-user discovery.

---

## Deployed addresses (devnet)

| Component | Address |
|---|---|
| Sealdex program | `4DBEkkdMaW7boAsmEFXLMbEiSnVj1xYQUndWYGzPwEMJ` |
| TEE validator | `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` |
| MagicBlock Permission Program | `ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1` |
| MagicBlock Delegation Program | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` |
| Devnet TEE RPC | `https://devnet-tee.magicblock.app` |

---

## Design decisions

A few non-obvious calls worth flagging:

- **No `bidders: Vec<Pubkey>` on the Auction.** The auction is delegated to
  the TEE the moment it's created, so `place_bid` on the base layer can't
  mutate it. Instead, `settle_auction` validates each Bid PDA at iteration
  time via seed derivation. Off-chain agents track participants via the
  registry feed.
- **Cluster-anchored countdown.** The frontend captures cluster time on
  every `/api/lot` poll and extrapolates locally with `Date.now()`. This
  survives WSL/laptop clock skew (the demo machine was 30s behind cluster
  early in development).
- **Prompt caching.** Bidder calls render order is `tools → system →
  messages` with a cache breakpoint on the last system block, so Claude
  caches the tool definitions + system prompt together. Per-lot context
  sits after the breakpoint and is the only thing that varies between
  evaluations.
- **Editorial frontend.** The catalog metaphor (Sotheby's-style lot detail
  page, slab visual, hairline dividers) sells the trustlessness pitch
  better than an infrastructure dashboard. The reveal is ceremonial — flip
  cascade with no confetti.

---

## Tech stack

| Layer | Choice |
|---|---|
| Smart contract | Anchor 0.32.1 + `ephemeral-rollups-sdk` 0.11 (Rust) |
| MCP / agent SDKs | `@modelcontextprotocol/sdk` 1.x + `@anthropic-ai/sdk` |
| Network | Solana devnet + MagicBlock devnet TEE |
| RPC | Helius (recommended) or default devnet |
| Frontend | Next.js 15.5 (App Router) + Tailwind 3 + variable Fraunces |
| Bidder LLM | Claude Sonnet 4.6 with tool-use + ephemeral prompt caching |

---

Built solo by [@0xNoramiya](https://github.com/0xNoramiya).
