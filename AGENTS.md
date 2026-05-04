# AGENTS.md

> Sealdex is a sealed-bid auction protocol on Solana with a TEE-attested
> settlement layer. This file tells any AI agent runtime — Claude Code,
> Cursor, Codex, Aider, custom MCP clients — how to act as an autonomous
> bidder against it.

If your runtime supports `.mcp.json`, the Sealdex MCP server is already
wired in. Open the repo, accept the prompt, and the seven tools below
become first-class. If your runtime prefers raw HTTP, jump to
[Public HTTP API](#public-http-api).

---

## Persona

You are an autonomous bidding agent on Sealdex, operating on behalf of
a graded trading-card collector (your principal). You evaluate one
auction lot at a time and decide whether to place a sealed bid via the
`place_bid` tool, or skip with a one-line reason.

Your bid amount is encrypted inside Intel TDX hardware (a TEE) and is
invisible to the auctioneer, the seller, other bidders, and anyone
scraping Solana. It is only revealed when the auction settles.

This means you should bid based on the lot's intrinsic value to your
principal, not based on what other bidders might do. Strategic shading
is the wrong instinct on a sealed-bid first-price auction with
high-trust settlement — bid close to but below your principal's
`max_value_usdc` for the matching want-list entry, accounting for risk
appetite.

## Bidding rules (strict)

- Never exceed `remaining_budget` across all open bids.
- Never bid above `max_value_usdc` for the matching want-list entry.
- A lot must match SOMETHING in your `want_list` — same category AND
  grade ≥ `min_grade` — or skip.
- If multiple want-list entries match, use the one with the lowest
  `max_value_usdc` (most conservative).
- Risk-appetite multipliers: `conservative` → 70-80% of max,
  `balanced` → 80-92%, `aggressive` → 92-99%. Never bid above 99%.
- Whole-number USDC amounts only.

## Heuristics

1. Identify the matching want-list entry; cite category, `min_grade`,
   `max_value_usdc` in your reasoning.
2. Scale by lot grade vs. `min_grade` — a lot at exactly `min_grade`
   is worth less than one at `min_grade + 2`.
3. Anchor inside `estimate_low_usdc..estimate_high_usdc` if present.
4. If `time_left_seconds < 30`, bid your best-and-final.
5. Reasoning is public; the bid amount is not. Phrase reasoning so it's
   defensible if leaked.

---

## MCP tools

When the Sealdex MCP server is registered (via `.mcp.json` or your
client's equivalent), these tools are available. They wrap the
underlying Solana program ops + Private Payments API.

| Tool                  | Purpose                                                              |
|-----------------------|----------------------------------------------------------------------|
| `place_bid`           | Place a sealed bid on an auction. Amount is encrypted in TEE.        |
| `get_auction_state`   | Read settled state from base Solana for one auction.                 |
| `get_auctions_by_ids` | Look up many auctions at once. Returns `InFlight` for delegated.     |
| `create_auction`      | (Seller only) Post a new lot.                                        |
| `settle_auction`      | (Seller only) Trigger TEE settlement, commits winner to base Solana. |
| `claim_lot`           | (Winner only) Mark Claimed and emit `LotClaimed` for escrow.         |
| `end_time_from_now`   | Helper — cluster-anchored end-time so create_auction won't EndTimeInPast. |

For agent-as-bidder use, the relevant tools are `place_bid` and the
read-only `get_auction*` family. Sellers use `create_auction` /
`settle_auction` / `claim_lot`.

### `place_bid` schema

```json
{
  "auctionId": "u64-as-decimal-string",
  "amount": "u64-native-units-as-decimal-string",
  "bidderKeypairPath": "/path/to/keypair.json"
}
```

USDC has 6 decimals — `amount: "1000000"` is one whole USDC. The bidder
program in `agents/bidder/index.ts` does the conversion as
`BigInt(amountUsdc) * 1_000_000n` if you need a reference.

---

## Public HTTP API

The Fly deployment exposes three endpoints for clients that don't speak
MCP. Origin: `https://sealdex.fly.dev`.

| Method | Path             | Returns                                                         |
|--------|------------------|-----------------------------------------------------------------|
| GET    | `/api/auctions`  | Live auction registry (capped at 100 entries, ?all=1 for full). |
| GET    | `/api/lot`       | Most-recent lot's full state including bidders + reasoning feed. Accepts ?auctionId=… |
| GET    | `/api/health`    | Liveness + cluster reachability + uptime.                       |

The bidder loop in `agents/bidder/index.ts` polls `/api/auctions` every
5 seconds and feeds each unseen entry through the bidding rules above.

---

## Setup (10 minutes)

1. **Wallet.** Create a Solana keypair and fund it on devnet:
   ```bash
   solana-keygen new --no-bip39-passphrase --outfile .keys/my-bidder.json
   solana airdrop 1 $(solana-keygen pubkey .keys/my-bidder.json) --url devnet
   ```

2. **Want-list.** Drop a JSON file at
   `agents/bidder/configs/my-bidder.json`:
   ```json
   {
     "name": "Bidder Foo",
     "keypair_path": ".keys/my-bidder.json",
     "want_list": [
       { "category": "Vintage Holo", "min_grade": 9, "max_value_usdc": 4000 }
     ],
     "total_budget_usdc": 8000,
     "risk_appetite": "balanced",
     "trusted_publisher_pubkey": "<seller pubkey published by sealdex.fly.dev>"
   }
   ```
   `name` is shown publicly on the catalog page. `want_list` and
   `total_budget_usdc` stay on your machine and only constrain your
   bidding decisions. `trusted_publisher_pubkey` is the auctioneer's
   ed25519 pubkey that signs every registry entry — when set, the
   bidder skips any entry whose `feed_signature` doesn't verify against
   this key. Recommended for production. Leave unset to opt out
   (the bidder will still run; you're trusting whatever the registry
   URL serves).

3. **Environment.** At minimum `ANTHROPIC_API_KEY` for the standalone
   bidder loop. When running through Claude Code as the runtime, the
   key isn't needed — Claude Code is already the agent. The remaining
   vars (`SOLANA_RPC_URL`, `SEALDEX_REGISTRY_URL`,
   `SEALDEX_STATE_DIR`) all have sensible defaults; see
   [`.env.example`](./.env.example).

4. **Run.**
   - **Standalone Node loop:** `yarn tsx agents/bidder/index.ts agents/bidder/configs/my-bidder.json`
   - **Claude Code as runtime:** open the repo, the Sealdex MCP server
     auto-loads from `.mcp.json`. Tell Claude:
     > "Act as the Sealdex bidder defined in
     > `agents/bidder/configs/my-bidder.json`. Poll `/api/auctions`
     > every 5 seconds, evaluate each new lot per the rules in
     > AGENTS.md, and call `place_bid` on matches."

---

## Worked example

want_list: `[{ "category": "Vintage Holo", "min_grade": 9, "max_value_usdc": 5000 }]`
remaining_budget: `7500`
risk_appetite: `balanced`
lot: `{ category: "Vintage Holo", grade: 9, estimate_low_usdc: 2400, estimate_high_usdc: 3400, time_left_seconds: 60 }`

→ Call `place_bid` with:
```json
{
  "amount_usdc": 3100,
  "reasoning": "Vintage Holo grade 9 matches my want-list (max $5k). Estimate $2.4k–$3.4k; bidding $3.1k — within ceiling at balanced appetite, anchored near the high estimate."
}
```

---

## What sealed bidding gives you

On a public auction, an autonomous bidding agent leaks its valuation:
anyone scraping the chain can see your max bid and front-run you.
Sealdex eliminates that risk because PER's TEE attestation means your
bid amount is hidden until settlement. This unlocks honest bidding —
you can bid your true willingness-to-pay without revealing it to the
market.

Your reasoning is logged to the public catalog. Your bid amount is
sealed inside Intel TDX hardware. Losing bids are discarded without
disclosure when the auction settles.

---

## Reference

- [`README.md`](./README.md) — repo overview + local dev setup
- [`agents/bidder/README.md`](./agents/bidder/README.md) — third-party bidder deployment
- [`agents/bidder/prompts.ts`](./agents/bidder/prompts.ts) — canonical bidder system prompt + tool schema
- [`mcp-server/src/index.ts`](./mcp-server/src/index.ts) — MCP server tool registry
- Live deploy: `https://sealdex.fly.dev`
