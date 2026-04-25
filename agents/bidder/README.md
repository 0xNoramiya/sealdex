# Sealdex Bidder Agent

Run your own autonomous bidder against the live Sealdex auction. Bring your
own Anthropic API key and your own Solana wallet — bids are sealed inside
MagicBlock's TEE until the auction settles, so your reasoning doesn't leak
your max valuation.

## Prerequisites

- Node 24+ and `pnpm`/`npm`/`yarn`
- Anthropic API key with access to Claude Sonnet 4.6
- A Solana keypair funded on devnet (≈0.1 SOL is enough for a few auctions)
- A Helius API key (free tier works) — devnet RPC reliability matters when
  bids are time-bounded

## One-time setup

```bash
git clone https://github.com/0xNoramiya/sealdex
cd sealdex
yarn install
anchor build                # produces target/idl/sealdex_auction.json
```

Generate a keypair (or copy an existing one):

```bash
solana-keygen new --no-bip39-passphrase --outfile .keys/my-bidder.json
solana airdrop 1 $(solana-keygen pubkey .keys/my-bidder.json) --url devnet
```

## Configure

Create `agents/bidder/configs/my-bidder.json`:

```json
{
  "name": "Bidder Foo",
  "keypair_path": ".keys/my-bidder.json",
  "want_list": [
    { "category": "Vintage Holo", "min_grade": 9, "max_value_usdc": 4000 },
    { "category": "Modern Premium", "min_grade": 8, "max_value_usdc": 600 }
  ],
  "total_budget_usdc": 8000,
  "risk_appetite": "balanced"
}
```

The `name` is shown publicly on the catalog page. The `want_list` and
`total_budget_usdc` are private — they only constrain Claude's bid decisions
inside your local process.

## Environment

```bash
export ANTHROPIC_API_KEY=sk-ant-…

# Helius devnet RPC — replace <your-key> with your Helius API key.
export SOLANA_RPC_URL="https://devnet.helius-rpc.com/?api-key=<your-key>"

# Public auction feed. Point at the Sealdex frontend you're bidding into.
export SEALDEX_REGISTRY_URL="https://sealdex.example/api/auctions"

# Where bidder writes its own state + JSONL stream. Defaults to repo
# scripts/ when running alongside the auctioneer; override for hosted runs.
export SEALDEX_STATE_DIR="$PWD/state"
```

## Run

```bash
yarn tsx agents/bidder/index.ts agents/bidder/configs/my-bidder.json
```

The agent will:

1. Poll the registry every 5 seconds for new auctions
2. Send each unseen lot through Claude with the want-list + remaining budget
3. Place a sealed bid via the on-chain `place_bid` instruction when Claude decides to bid
4. Skip lots that don't match — silently, with no on-chain footprint

Your reasoning is logged to `<state-dir>/bidder-<slug>-stream.jsonl` and
displayed on the public catalog page if your stream is reachable. Your bid
amount is sealed in the TEE until settle.

## How sealing actually works

`place_bid` writes the amount onto a `Bid` PDA, then immediately delegates
that PDA to the MagicBlock TEE validator. From that point until settlement,
the amount lives inside Intel TDX hardware. `settle_auction` runs inside the
TEE, finds the max bid across all `Bid` PDAs, and commits only the winner +
winning amount back to base Solana. Losing amounts are never disclosed.

## Cost

Each lot evaluation is a single Claude call (~2.5k cached input + ~150
output tokens). Roughly $0.003 per evaluation at Sonnet 4.6 list prices.
Place-bid transactions on devnet are gasless beyond the negligible signature
fee.
