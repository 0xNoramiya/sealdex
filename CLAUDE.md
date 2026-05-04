# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Sealdex is a sealed-bid auction protocol on Solana devnet. Bid amounts are
sealed inside a MagicBlock Private Ephemeral Rollup (Intel TDX TEE) until
settlement. The repo ships an Anchor program, an MCP server wrapping its ops,
three Node agents (auctioneer / bidder / escrow), and a Next.js frontend —
deployed together as a single image at `https://sealdex.fly.dev`.

`AGENTS.md` is the canonical agent-context file (bidder persona, strict
bidding rules, MCP tool table, public HTTP API). When acting as a bidder
runtime, follow it. When editing the bidder, keep the system prompt in
`agents/bidder/prompts.ts` and the rules in `AGENTS.md` aligned.

## Commands

| Task | Command |
|------|---------|
| Build Anchor program | `anchor build --no-idl -- --tools-version v1.54 && anchor idl build` |
| Anchor test suite | `yarn test` (root) — runs `tests/sealdex-auction.ts` against devnet, 180s timeout |
| Frontend dev | `cd frontend && yarn dev` (port 3000) |
| Frontend prod build | `cd frontend && yarn build && yarn start` |
| Bidder loop | `set -a && source .env && set +a && yarn tsx agents/bidder/index.ts agents/bidder/configs/<name>.json` |
| Auctioneer (one-shot, posts seed lots) | `yarn tsx agents/auctioneer/index.ts` |
| Settle a specific auction | `yarn tsx scripts/settle.ts <auctionId>` |
| MCP server (stdio, normally launched by clients via `.mcp.json`) | `node --import tsx mcp-server/src/index.ts` |
| MCP smoke test | `yarn tsx mcp-server/src/smoke.ts` |

Toolchain: Solana CLI 2.3.13, Anchor 0.32.1, Rust 1.85.0 (platform-tools v1.54
for `cargo build-sbf`), Node 22 or 24, yarn 1.x. The deployed program ID is
`4DBEkkdMaW7boAsmEFXLMbEiSnVj1xYQUndWYGzPwEMJ` — only override
`SEALDEX_PROGRAM_ID` if you redeploy.

`.env` is required for any agent or settle script — at minimum
`ANTHROPIC_API_KEY`. `SOLANA_RPC_URL` should point at a Helius devnet
endpoint for reliability. See `.env.example` for the full list.

## Architecture

### Two-layer execution model

The Anchor program runs across two Solana environments:

- **Base devnet** — `create_auction`, `place_bid`, `claim_lot`. After init
  each PDA is immediately delegated to the TEE validator
  (`MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`), which means subsequent
  base-layer instructions can no longer reference them as mutable accounts.
- **MagicBlock devnet TEE** (`https://devnet-tee.magicblock.app`) —
  `settle_auction` runs here, iterates the `Bid` PDAs supplied as
  `remaining_accounts`, finds the max, and calls
  `commit_and_undelegate_accounts` to push the (now-revealed) winner state
  back to base.

Three account kinds: `Auction` PDA `[b"auction", auction_id]`, `Bid` PDA
`[b"bid", auction_id, bidder]`, and one MagicBlock permission account per
delegated PDA. There is intentionally **no `bidders: Vec<Pubkey>` on the
Auction** — the auction is delegated the moment it's created, so
`place_bid` on the base layer cannot mutate it. `settle_auction` instead
re-derives each Bid PDA address at iteration time and validates it.
Off-chain bidders discover participants via the registry feed.

`MAX_BIDDERS = 5` is the cap enforced inside `settle_auction`.

### MCP server is the canonical client

`mcp-server/src/ops.ts` is the only place that knows how to build,
delegate, and submit transactions for each instruction. Every other Node
program (the bidder, the auctioneer, the escrow watcher, `scripts/settle.ts`)
imports from `../../mcp-server/src/ops.js` rather than re-implementing
client logic. When you add a new program instruction, add the op here
first, then expose it as an MCP tool in `mcp-server/src/index.ts`, then
consume it from agents — not the other way around.

The MCP server is registered in `.mcp.json` at repo root, so any MCP-aware
client (Claude Code, Cursor, custom hosts) loads the seven Sealdex tools
on open.

### Bidder agent (the centerpiece)

`agents/bidder/index.ts` polls `SEALDEX_REGISTRY_URL` (or
`<SEALDEX_STATE_DIR>/auction-registry.json` if unset) every 5 seconds.
Each unseen entry is sent to Claude Sonnet 4.6 with tool-use; Claude either
calls `place_bid` (which we forward to the MCP `placeBid` op) or skips
with a text-only response.

**Prompt cache layout matters.** Render order is `tools → system →
messages` with a cache breakpoint on the last system block, so the tool
schema + system prompt cache together. Per-lot context lives in
`messages` (after the breakpoint) and is the only thing that varies. The
system prompt in `agents/bidder/prompts.ts` is intentionally long enough
to clear the 2048-token minimum cacheable prefix — don't trim it without
re-checking that bar.

Bidder state (`bidsPlaced`, used to compute `remaining_budget`) is a JSON
file in `SEALDEX_STATE_DIR` keyed by bidder slug. JSONL streams of every
evaluation also land here and are read by the frontend's `/api/lot` route
to render the public reasoning feed.

### Frontend reads, never writes

`frontend/` is a Next.js 15 App Router site. It signs no transactions —
`/api/lot`, `/api/auctions`, and `/api/health` all read from base Solana
+ the local registry/stream files. The catalog page (`app/sales/page.tsx`)
polls `/api/lot` every 2 seconds. Cluster time captured on each poll is
used to extrapolate the countdown locally with `Date.now()` so WSL/laptop
clock skew can't desync the timer.

`/api/auctions` is the public registry feed third-party bidders consume
(`SEALDEX_REGISTRY_URL=https://sealdex.fly.dev/api/auctions`). It's capped
at 100 entries; pass `?all=1` for the full history.

### Single-image deployment

`Dockerfile` + `scripts/entrypoint.sh` + `scripts/cycle.sh` package the
frontend, two bidder loops (Alpha/Beta), and an auto-cycle bash loop into
one Fly.io container. `cycle.sh` posts fresh auctions every
`CYCLE_INTERVAL_SEC` (default 600s), waits 110s for the sealed bidding
window to close, then settles the latest two registry entries.
Wallet keypairs are decoded from base64 Fly secrets onto a persistent
volume on first boot (`SELLER_KEYPAIR_B64`, `BIDDER1_KEYPAIR_B64`,
`BIDDER2_KEYPAIR_B64`) — the entrypoint symlinks them into `/app/.keys/`
so the existing config files resolve cleanly.

## Conventions worth knowing

- USDC has 6 decimals. The agent and MCP tool layer takes whole-USDC ints
  and converts as `BigInt(amountUsdc) * 1_000_000n`. Don't introduce
  fractional-USDC paths.
- Keypair paths in bidder configs are resolved relative to the repo root
  (`agents/bidder/index.ts` does this).
- `auctionId` is a `u64` everywhere; serialize it as a decimal string
  across MCP and HTTP boundaries to dodge JSON number precision.
- The seed-inventory auction duration (default 90s in
  `scripts/seed-inventory.json`) governs cycle timing; if you raise it,
  bump the `sleep 110` in `cycle.sh` accordingly.
- "Reasoning is public, the bid amount is not." When changing bidder
  prompts or UI copy, keep that invariant — phrasing should be defensible
  if leaked.
