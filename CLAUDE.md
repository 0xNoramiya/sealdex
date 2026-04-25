# Sealdex

> Sealed-bid infrastructure for autonomous agents.

A trustless TCG-agnostic auction platform built on MagicBlock's Private Ephemeral Rollups (PER), with autonomous Claude-powered bidding, auctioneering, and escrow agents.

**Hackathon submission:** Sunday. Solo build by @0xnoramiya.

---

## Why this exists (read this before coding)

Public bidding is broken: shill bids, snipe wars, and the impossibility of running a Vickrey auction without trusting the auctioneer.

Sealed bidding fixes the mechanism, but historically you had to trust the auctioneer not to peek or invent phantom second-highest bids. PER's TEE attestation removes that trust assumption — bids are hidden inside Intel TDX hardware until the auction settles, then committed to Solana.

This unlocks something bigger: **autonomous bidding agents**. A public bidding agent leaks its max valuation; anyone scraping the chain can front-run it. Sealed bids let agents bid honestly because their reasoning never hits a public mempool. PER is the missing infrastructure that makes agentic commerce safe.

The auction is the wedge. The agent layer is the demo. Graded collectible cards (TCG-agnostic) is the wedge market — large, high-trust-deficit, ripe for sealed bids.

**Do not pitch this as "an auction with privacy." Pitch it as the rollup that makes AI bidding agents safe to deploy.**

---

## Tech stack (versions matter — the SDK is picky)

| Component | Version |
|---|---|
| Solana CLI | 2.3.13 |
| Anchor | 0.32.1 |
| Rust | 1.85.0 |
| Node | 24.10.0 |
| Next.js | latest stable |
| @magicblock-labs/ephemeral-rollups-sdk | >=0.8.0 |
| @anthropic-ai/sdk | latest |
| @modelcontextprotocol/sdk | latest |

**Network:** `devnet-tee.magicblock.app`
**ER validator (devnet TEE):** `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`
**Permission Program:** `ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1`
**Delegation Program:** `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`

---

## Repository layout

```
sealdex/
├── programs/
│   └── sealdex-auction/        # Anchor program
├── agents/
│   ├── auctioneer/              # creates auctions from inventory
│   ├── escrow/                  # event listener → Private Payments transfer
│   └── bidder/                  # autonomous bidding (the centerpiece)
├── mcp-server/                  # wraps program + Private Payments API
├── frontend/                    # Next.js observer dashboard
├── scripts/
│   ├── setup-demo-wallets.ts    # fund devnet wallets, init demo SPL mint
│   └── seed-inventory.json      # demo lot metadata
├── tests/
└── CLAUDE.md
```

---

## Architecture

### On-chain (Anchor program)

Three account types. **Pattern is adapted from MagicBlock's rock-paper-scissor example** — fork that as the starting point. Do not write from scratch:
https://docs.magicblock.gg/pages/private-ephemeral-rollups-pers/how-to-guide/quickstart

#### Accounts

**`Auction` PDA** — `seeds = [b"auction", auction_id.to_le_bytes()]`
- `auction_id: u64`
- `seller: Pubkey`
- `lot_metadata_uri: String` (max 200 chars; IPFS or arweave)
- `payment_mint: Pubkey` (devnet USDC or demo SPL)
- `end_time: i64` (unix seconds)
- `status: AuctionStatus` (Open | Settled | Claimed)
- `bidders: Vec<Pubkey>` (cap at 5 for demo to keep account size bounded)
- `winner: Option<Pubkey>`
- `winning_bid: Option<u64>`

**`Bid` PDA** — `seeds = [b"bid", auction_id.to_le_bytes(), bidder.as_ref()]`
- `auction_id: u64`
- `bidder: Pubkey`
- `amount: u64` ← **this is the field PER hides**
- `timestamp: i64`

**Permission accounts** — one per Auction, one per Bid. Created via Permission Program CPI in the same instruction that initializes the underlying account.

#### Instructions

1. **`create_auction(auction_id, lot_metadata_uri, payment_mint, end_time)`**
   - Init Auction PDA + Auction permission (writable by seller)
   - Delegate Auction to TEE validator

2. **`place_bid(auction_id, amount)`**
   - Init Bid PDA + Bid permission (readable only by bidder + program)
   - Push bidder pubkey onto `auction.bidders`
   - Delegate Bid to TEE validator
   - Require `clock.unix_timestamp < auction.end_time`

3. **`settle_auction(auction_id)`** — runs inside TEE
   - Iterate `remaining_accounts` of all Bid PDAs for this auction
   - Find max amount, set `auction.winner` and `auction.winning_bid`
   - Update permissions: open Auction to public read, mark Bids as revealed
   - `commit_and_undelegate_accounts` — push state to base Solana
   - Require `clock.unix_timestamp >= auction.end_time`

4. **`claim_lot(auction_id)`** — winner-only
   - Emit `LotClaimed` event with `(winner, seller, amount)` for the escrow agent
   - Mark `status = Claimed`

**Skip refunds and bid escrow lockup for the hackathon.** Mention as v2 in the pitch ("collateralized bids prevent griefing"). Don't try to ship it.

#### Program decorators

Use `#[ephemeral]` on the program module and `#[delegate]`/`#[commit]` on relevant context structs. Pattern is in the RPS example — fetch the URL above and copy faithfully.

### Off-chain (Agent layer)

Three agents, each is a Node TS service with its own wallet. All hit the MCP server for tool calls.

#### Auctioneer agent (`agents/auctioneer/`)

Simplest. Reads `seed-inventory.json`, calls `create_auction` for each lot. Can be a script if time is tight — call it "agentic" in the pitch and mention LLM-driven reserve pricing as v2.

```typescript
// agents/auctioneer/index.ts
// Reads inventory, posts auctions sequentially via MCP tool: create_auction
// Optional v2: ask Claude to set reserve prices based on lot metadata
```

#### Escrow agent (`agents/escrow/`)

Subscribes to `LotClaimed` events on base Solana RPC. On event:
1. Verify winner identity matches event payload
2. Call Private Payments API `POST /transfer` from winner → seller
3. Log settlement to dashboard via WebSocket

```typescript
// agents/escrow/index.ts
// connection.onLogs(programId) → filter LotClaimed → POST /transfer
```

#### Bidder agent (`agents/bidder/`) — THE CENTERPIECE

This is what the demo is about. Spend the most polish here.

**Config (`bidder-config.json`):**
```json
{
  "wallet_keypair": "path/to/keypair.json",
  "want_list": [
    { "category": "Vintage Holo", "min_grade": 9, "max_value_usdc": 5000 },
    { "category": "Modern Premium", "min_grade": 8, "max_value_usdc": 800 }
  ],
  "total_budget_usdc": 10000,
  "risk_appetite": "balanced"
}
```

**Loop:**
1. Poll `get_open_auctions` every 5s (or subscribe to `AuctionCreated` events)
2. For each new auction, call Claude API with structured prompt (skeleton below)
3. If Claude says bid, call `place_bid` via MCP tool use
4. Stream Claude's reasoning to the dashboard via WebSocket

**System prompt skeleton (Claude Code: refine in agents/bidder/prompts.ts):**
```
You are an autonomous bidding agent for a TCG card collector.

Your job: evaluate auction lots against your principal's want-list and budget,
and decide whether to place a sealed bid and at what amount.

Each turn you receive:
- want_list: array of category/grade/max_value entries
- remaining_budget: total USDC still allocatable across open bids
- lot: { metadata_uri, category, grade, time_left_seconds }

Rules:
- Never exceed remaining_budget across all open bids
- Never bid above max_value_usdc for the matching want-list entry
- If lot doesn't match any want-list entry, do not bid
- Reason about market value: use the principal's max_value as ceiling
- Output strict JSON: { "bid": boolean, "amount_usdc": number, "reasoning": string }

The reasoning will be displayed publicly on the observer dashboard.
The bid amount is sealed via Private Ephemeral Rollups and only revealed at settle time.
```

**Use Anthropic API tool-use** to let Claude call MCP tools directly from the reasoning loop. Don't hand-roll bid submission — let Claude decide and call the tool.

For the demo, run **two bidder agents** with different want-lists/budgets so the dashboard shows competing reasoning streams. This is what sells the agentic angle.

### MCP Server (`mcp-server/`)

Wraps:
- Program instructions: `create_auction`, `place_bid`, `get_auctions`, `get_auction_state`, `settle_auction`, `claim_lot`
- Private Payments API: `deposit`, `transfer`, `balance`, `private_balance`, `initialize_mint`
- TEE auth helper: `getAuthToken`, `verifyTeeRpcIntegrity`

Use `@modelcontextprotocol/sdk` (TypeScript). Each tool definition includes:
- Name + description (description matters — Claude reads it)
- JSON schema for inputs
- Implementation that calls the underlying Solana / HTTP layer

This server is consumed by all three agents AND can be exposed in the demo as "you can plug Sealdex into Claude Code." Mention this in the pitch — free polish point.

### Frontend (`frontend/`) — Auction catalog page, NOT a dashboard

Next.js + Tailwind. Single lot detail page modeled after Christie's / Sotheby's catalog pages, not an infra console. The auction-house metaphor sells the trustlessness pitch — judges instantly understand "sealed-bid auction with no auctioneer to trust" because the visual language is already an auction house.

#### Aesthetic — committed

- **Palette:** parchment background `#F5EDE0`, ink foreground `#1A1A1A`, muted text `#6B6557`, hairline borders `#D9CFBE`. Single accent: signet green `#1F5F4A` (deep, money-coded — NOT the electric mint from earlier drafts; that aesthetic was rejected).
- **Sealed-state amber** for hidden bid amounts: `#A8966B` muted.
- **Typography:** serif display for lot titles and headline numerals (Cormorant Garamond, Libre Caslon, or similar). Sans-serif for UI chrome (Inter). Monospace for cert numbers, addresses, agent names, bid amounts (JetBrains Mono).
- **Density:** generous whitespace, hairline dividers, no card chrome. Auction catalog energy. Crisp edges, zero glassmorphism.

#### Layout — single page, max ~1280px wide

**1. Top bar** (~56px, hairline divider underneath)
- Left: Sealdex diamond mark + "Sealdex" wordmark in serif + small "DEVNET" pill (outlined, monospace)
- Center: nav links (Sales, Lots, Agents, Settlement, Docs) — Sales is active, the rest are non-functional placeholders for the demo
- Right: signet-green pulsing dot + "TEE Verified" + monospace enclave identifier `enclave://us-east-1.sealdex`

**2. Breadcrumb row** (~40px, hairline below)
- Left: `Sales / Trading Cards · Vintage Holo Series / Lot 001`
- Right: `Sale #A-2026-0418 · Sealed-bid · Single-shot · 3 bidders` (separator dots, muted)

**3. Two-column body** (left ~40% slab + meta, right ~60% auction state)

**LEFT COLUMN — Lot presentation**
- Small monospace label above slab: `LOT 001 · SEALED`
- The slab (centered, ~360px wide, this is the visual hero):
  - Outer beige/cream plastic case with subtle bevel and soft drop shadow
  - Top label band in deep red (`#8B2E2E`), white monospace text: `SEALDEX · CERT #12847291 · GRADE 9`
  - Inner card window: an abstract generative composition. Pastel gradient mesh (mint/lavender/peach) with a deep-green serif "S" monogram in a circular medallion centered. NO TCG IP — this is a stylized fictional card.
  - Above the inner art: a small green-tinted ribbon reading `VINTAGE HOLO · 1999`
  - Below the inner art: two-column footer inside the slab with `SERIAL 001 / 250` and `CONDITION MINT 9.0`
  - Bottom of slab case: monospace footer `PSA-EQ ······ SEALED · TEE`
- Below slab (centered):
  - Lot title in large serif: `Vintage Holo — Lot 001`
  - Subtitle muted sans: `Trading card · Holographic foil · 1999`
  - Smaller line: `Authenticated & encapsulated by Sealdex Cert.`
- Three-column meta strip (hairline top border):
  - `ESTIMATE` / `$2,400 — $3,400`
  - `RESERVE` / `Met`
  - `SETTLEMENT` / `USDC · TEE`

**RIGHT COLUMN — Auction state**
- Small label row: `SEALED-BID AUCTION  ·  Settles in TEE on reveal` on the left, signet-green dot + `AWAITING REVEAL` on the right
- Section: `REVEAL IN`
- Large serif numerals countdown: `00:00:00` (start at `00:00:08` on mount; tick to zero; once at zero, the button activates)
- `REVEAL BIDS →` button: black background, white text, square corners, monospace label, sits inline-right of the countdown. Disabled with subtle opacity reduction until timer hits zero, then activates with a soft signet-green glow ring.
- Hairline divider
- **Sealed Bids table** (no card chrome, just hairline-separated rows)
  - Column headers in muted monospace small caps: `SEALED BIDS` (left), `BIDDER` (center, right-aligned), `AMOUNT` (right)
  - 3 rows, each:
    - Left: square avatar tile with the agent letter (A / B / Γ) in serif on a muted background
    - Name in serif/sans: `Bidder Alpha` / `Bidder Beta` / `Bidder Gamma`
    - Below name in muted mono: truncated address `0x4f...a72c` and a small chip `Autonomous Agent`
    - Status text in muted mono: `sealed via Private Ephemeral Rollup`
    - Right cell: `$ ••• , •••` in amber monospace, large
- Below the table (single row, hairline top):
  - Left mono small caps: `AGENT REASONING ·`
  - Right: ticker text in muted serif, slowly cycling through three lines (4s each):
    - `alpha — lot matches Vintage Holo · grade 9 meets min · bidding within budget`
    - `beta — comp range $2.8k–3.4k · reserving capacity · placing competitive bid`
    - `gamma — aggressive want-list match · max valuation $4k · headroom maintained`
  - Three small dots at the end indicating cycling
- Footnote line below in muted text:
  `Bids remain encrypted in the TEE until the seller calls reveal(). Losing bids are discarded without disclosure.`

**4. Footer** — minimal, just legal/credit line in muted monospace.

#### Reveal sequence (the demo's emotional payoff)

Triggered by clicking `REVEAL BIDS →` after countdown hits `00:00:00`:

1. Each `$ ••• , •••` cell flips on X-axis, 350ms each, **staggered 200ms top-to-bottom**
2. Reveals: `$2,890.00` · `$3,150.00` · `$2,640.00` (Beta is the winner)
3. Loser amounts settle in muted neutral
4. Winner amount in signet green; winner row gains a 4px-wide signet-green left border and the avatar tile gains a subtle green outline
5. Right-side status pill changes from `AWAITING REVEAL` to `REVEALED · SETTLING`
6. ~600ms after the last flip: a settlement strip slides in below the bids table:
   `Settled privately · paid via Private Payments API ✓` in signet green serif
7. Status pill transitions one more time to `SETTLED`
8. The `REVEAL BIDS →` button transitions to a muted disabled `Revealed` state

**No confetti.** The earlier draft called for it; the auction-house aesthetic rejects it. The reveal should feel ceremonial, not celebratory. Restraint is the point.

#### Reads
- Auction state from base Solana RPC (post-settlement) or TEE RPC with auth token (pre-settlement)
- Agent reasoning from a WebSocket served by the agent processes (or pre-rendered for the demo if streaming flakes)
- Settlement events from program logs

**Do not build a "place a bid" form for human users.** The user is the audience, not a participant. Saves ~6 hours and makes the demo cleaner.

#### Anti-patterns for the frontend specifically
- ❌ Three-panel dashboard layouts (rejected — pivoted to catalog page)
- ❌ Electric mint `#3DDC97` (rejected — pivoted to signet green `#1F5F4A`)
- ❌ Confetti, particle bursts, or any celebratory motion
- ❌ Glassmorphism, frosted blur, gradient backgrounds
- ❌ "Place Bid" / "Watchlist" / "Save Lot" affordances
- ❌ Skeuomorphic auction props beyond the slab itself (no gavels, no podiums)
- ❌ Real TCG IP — abstract generative card art only
- ❌ Light/dark toggle (parchment-only for this build)

---

## MagicBlock-specific gotchas (read carefully)

1. **TEE auth flow** is required for any read/write to PER:
   ```typescript
   import { verifyTeeRpcIntegrity, getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";

   const isVerified = await verifyTeeRpcIntegrity(EPHEMERAL_RPC_URL);
   const token = await getAuthToken(EPHEMERAL_RPC_URL, wallet.publicKey, signFn);
   const teeRpcUrl = `${EPHEMERAL_RPC_URL}?token=${token}`;
   ```

2. **Delegation must specify the validator pubkey.** For devnet TEE: `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`. Pass it in `DelegateConfig.validator`.

3. **Permission Program CPI** — both the permissioned account AND its permission account must be passed to the CPI and properly seeded. See RPS example's `create_permission` and `UpdatePermissionCpiBuilder`.

4. **Undelegation order matters.** In `settle_auction`, call `account.exit(&crate::ID)?` before `commit_and_undelegate_accounts` for the auction to commit cleanly to base Solana.

5. **SDK version** — use `>=0.8.0`. Older versions have a different permission program interface and will silently misbehave.

6. **Compliance is automatic** — node-level OFAC + geofencing happens at ingress. You don't implement it. Mention in the pitch as a "free compliance dividend."

7. **Account size for `bidders: Vec<Pubkey>`** — Anchor needs a fixed max. Cap at 5 and reject the 6th bidder with a clear error.

---

## 48-hour build plan

### Saturday AM (4 hours) — Environment + RPS validation
- [ ] Install Solana 2.3.13, Anchor 0.32.1, Node 24
- [ ] Generate 4 devnet keypairs (seller, bidder1, bidder2, escrow), airdrop SOL to each
- [ ] Clone MagicBlock RPS example, deploy to devnet-tee, run end-to-end test with 2 wallets
- [ ] **HARD GATE: if TEE auth flow doesn't work locally, stop and fix before proceeding.** Failing late on Sunday is the failure mode.

### Saturday PM (5 hours) — Auction program
- [ ] Fork RPS, rename Game→Auction, PlayerChoice→Bid
- [ ] Implement create_auction, place_bid (no agents yet — manual TS calls)
- [ ] Implement settle_auction with max-finding loop over remaining_accounts
- [ ] Test 3-bid scenario: 3 wallets bid different amounts, settle, verify winner correctness on base Solana

### Saturday late (3 hours) — MCP server skeleton
- [ ] Define tools: create_auction, place_bid, get_auctions, get_auction_state, settle_auction, transfer_payment
- [ ] Test each tool manually with a curl/TS client before wiring agents

### Sunday AM (4 hours) — Three agents
- [ ] Auctioneer (~30 lines, reads seed inventory, calls create_auction)
- [ ] Escrow (~80 lines, event subscriber + transfer)
- [ ] Bidder (Claude tool-use loop, reasoning stream over WebSocket, two distinct configs running in parallel)

### Sunday early PM (3 hours) — Frontend dashboard
- [ ] Three-panel layout, dark mode, mint accent
- [ ] Auction list + countdown + sealed bid display (`••••`)
- [ ] Reasoning stream (WebSocket from bidder agents)
- [ ] Settlement log with explorer links
- [ ] **Reveal animation** — do not skip

### Sunday late PM (3 hours) — Polish + submit
- [ ] README with architecture diagram (Mermaid is fine)
- [ ] Demo video (60s, script in this file)
- [ ] Deploy frontend to Cloudflare Pages (you've shipped this stack before — portfolio.kudaliar.id muscle memory)
- [ ] Submit with a 1-hour buffer before the deadline. The submission portal will be slow in the final hour.

---

## Cuts list (drop in this order if behind schedule)

1. Auctioneer LLM reasoning → run as a plain script
2. Escrow dispute window → settlement is immediate
3. Multiple concurrent auctions → 2 lots run sequentially in the demo
4. Live Claude streaming → pre-render reasoning if streaming breaks
5. Lot metadata URI → inline string field
6. `claim_lot` instruction → fold the payment trigger into `settle_auction` event
7. Wallet adapter for create_auction → CLI script only

**Hard floor — never drop these:**
- Bidder agent calling Claude API end-to-end with real tool use
- Sealed bids actually hiding amounts in TEE
- Slab visual + reveal flip animation (ceremonial pacing, no confetti)
- Private Payments API actually moving SPL tokens

---

## Demo video (60 seconds, locked script)

| Time | Visual | Voiceover |
|---|---|---|
| 0–10s | Sealdex catalog page loads, slab centered, "AWAITING REVEAL" pulsing | "Sealed-bid auctions are mechanism design's preferred answer to shill bids and snipe wars. Nobody runs them, because you have to trust the auctioneer." |
| 10–22s | Camera lingers on the slab, then pans to the three sealed bid rows showing `$ ••• , •••` | "Three autonomous agents have placed bids on this lot. Each is running on Claude. Each has a different want-list and budget." |
| 22–35s | Highlight the agent reasoning ticker cycling through the three lines | "Their reasoning is public. Their bids are not — sealed inside Intel TDX hardware until the seller calls reveal." |
| 35–45s | Click REVEAL BIDS → flip animation cascades top to bottom → winner row highlights signet green | "On reveal, the rollup commits the result to Solana. Highest bid wins. Losing bids are discarded without disclosure." |
| 45–55s | Settlement strip slides in: "Settled privately · paid via Private Payments API ✓" | "Settlement happens privately. The TEE attests to the result. The auctioneer never had access to the bids." |
| 55–60s | Sealdex wordmark + tagline card | "Sealdex. Sealed-bid infrastructure for autonomous agents." |

---

## Anti-patterns (do NOT do these)

- ❌ **Use Pokemon, MTG, One Piece, or any other named TCG IP.** Generic "graded card slab" framing only. Use AI-generated card art or metadata-only displays.
- ❌ Build a participant UI. Build an observer dashboard.
- ❌ Skip the Saturday AM RPS validation. Failing late is fatal.
- ❌ Drop the reveal animation to save time.
- ❌ Pitch this as "an auction with privacy." Pitch as "infrastructure for agentic commerce."
- ❌ Use real PSA/Beckett APIs. Mock cert numbers.
- ❌ Hardcode keypair paths in committed code. Use `.env` and `.gitignore` it.
- ❌ Forget to pin the validator pubkey in the delegation instruction.
- ❌ Install LangChain or similar. Vanilla `@anthropic-ai/sdk` + tool use is enough.

---

## Reference URLs (Claude Code: web_fetch these as needed)

- PER quickstart: https://docs.magicblock.gg/pages/private-ephemeral-rollups-pers/how-to-guide/quickstart
- Access control: https://docs.magicblock.gg/pages/private-ephemeral-rollups-pers/how-to-guide/access-control
- Onchain privacy: https://docs.magicblock.gg/pages/private-ephemeral-rollups-pers/introduction/onchain-privacy
- Authorization: https://docs.magicblock.gg/pages/private-ephemeral-rollups-pers/introduction/authorization
- Compliance framework: https://docs.magicblock.gg/pages/private-ephemeral-rollups-pers/introduction/compliance-framework
- Private Payments API intro: https://docs.magicblock.gg/pages/private-ephemeral-rollups-pers/api-reference/per/introduction
- Private Payments MCP endpoint: https://docs.magicblock.gg/pages/private-ephemeral-rollups-pers/api-reference/per/mcp
- ephemeral-rollups-sdk repo: https://github.com/magicblock-labs/ephemeral-rollups-sdk

---

## Working notes for Claude Code

- **Test contract logic before integrating agents.** Debugging "is it the contract or the agent?" at 2am Sunday is the failure mode.
- **Stub agent reasoning early** — hardcode bid decisions for the first integration test, swap in the real Claude API call once the end-to-end flow works.
- **Commit frequently.** Hackathons are fragile. Tag working states (`v0.1-contract-works`, `v0.2-agents-bid`, `v0.3-frontend-revealing`).
- **When in doubt about MagicBlock specifics, fetch the doc URLs above rather than guessing.** The patterns are non-obvious and the SDK is opinionated.
- **Time-box every task.** If a step takes >1.5x the estimate, raise it; do not silently grind. The cuts list exists for a reason.
- **Ask the user before adding any major dependency** outside the stack table above.
- **Do not refactor the RPS example beyond renaming.** The delegation/permission/undelegation pattern is fragile; preserve it verbatim where possible.
