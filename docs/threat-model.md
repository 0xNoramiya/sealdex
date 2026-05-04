# Sealdex threat model

> Scope: the on-chain Anchor program (`sealdex-auction`), the off-chain
> agents (auctioneer / bidder / escrow / settle), and the Next.js
> frontend. This file documents what is trusted, what isn't, and what
> attacks we explicitly defend against.

## Trust assumptions

| Entity | Trust level | Why we trust it |
|---|---|---|
| **MagicBlock TEE validator** | Strong | Bid amounts are sealed inside Intel TDX hardware; PER attestation gates writes. If the TEE is compromised, sealed-bid privacy fails — there is no on-chain fallback. |
| **Anchor program (`sealdex-auction`)** | Code review only | No formal audit yet. See "out-of-scope" below for the audit gap. |
| **Sellers' keypairs** | Owner-only | Standard Solana custody assumption; loss = loss of seller privileges. |
| **Bidders' keypairs** | Owner-only | Same as above; deposits and bid PDAs are tied to the keypair. |
| **Helius RPC / devnet RPC** | Soft | Treated as untrusted for correctness — every committed read is reverified against base Solana. Treated as trusted for liveness — no fallback if it goes down. |
| **Anthropic Claude API** | Soft | Used by bidders to decide bid amounts. A compromised Claude returns garbage decisions but cannot leak the bid amount (it's encrypted before transmission). |
| **Frontend (`sealdex.fly.dev`)** | Display only | The frontend signs no transactions. Tampering changes the catalog UX but cannot move funds. |

## In-scope attacks (with mitigation)

### A1. Bid amount disclosure before settlement

**Attack:** A bidder, observer, or competing seller scrapes Solana to learn
another bidder's max valuation, then outbids by $1.

**Mitigation:** Bid PDAs are delegated to the MagicBlock TEE on the same
transaction as `place_bid`, before the tx is finalized to base. The amount
field is invisible on base layer until `settle_auction` commits the winner.
Loser amounts are zeroed before commit so undelegating loser bids does not
leak their values.

**Residual risk:** TEE compromise. If MagicBlock's TDX attestation is
broken, bid amounts can be read by anyone with TEE access.

### A2. Auction-id squatting

**Attack:** Attacker observes the seller's intended `auction_id` (e.g.
`Date.now()`-derived) in mempool, races them with their own
`create_auction`, captures the seller field.

**Mitigation:** `create_auction` uses `init` (not `init_if_needed`). The
discriminator check rejects a duplicate before the body runs, so only one
caller can ever own a given `(auction_id)` PDA. Sellers should still
randomize the high bits of `auction_id` to avoid collisions.

**Residual risk:** A persistent griefer can pre-claim sequential ids; the
seller picks a fresh random id and tries again. No funds at risk.

### A3. Bidder-cap DoS (20-bid spam)

**Attack:** `MAX_BIDDERS = 20` is enforced inside `settle_auction`. An
attacker fires 20 dust bids on every auction to lock real bidders out.

**Mitigation (defense in depth):**

1. **Program-enforced deposit floor + auto-sizing.** `place_bid`
   requires at least `MIN_BID_DEPOSIT_LAMPORTS` (0.01 SOL) per bid,
   CPI-transferred from the bidder into the bid PDA. `create_auction`
   additionally enforces a market floor inside the program:
   `bid_deposit_lamports >= estimate_high_usdc × BID_DEPOSIT_RATIO_BPS × FIXED_LAMPORTS_PER_USDC / 10_000`
   (currently 1% × $1 = 5,000,000 lamports). The auctioneer agent
   forwards `lot.estimate_high_usdc` automatically; a hostile direct-
   MCP seller can no longer bypass this floor — `create_auction`
   rejects with `DepositBelowMarketFloor` (6027). For a $3,400 lot
   the floor is 0.17 SOL; spamming all 20 slots costs 3.4 SOL
   (~$510). For a $50 lot the hard MIN floor dominates; 5 spammers
   ≈ $37. Spam cost stays proportional to lot value, on-chain.

2. **Bidder cap raised 4× from the original 5.** Earlier ceiling was a
   real product limitation — 6th honest bidder couldn't enter. Now 20
   bidders fit in a single legacy transaction (auction + permission +
   payer + 4 ER-context accounts + 20 bids = 27 of the 64-account
   limit). Lifting to 50+ requires Address Lookup Tables (deferred —
   MagicBlock TEE compatibility unverified).

3. **Single-pass settle.** Loser-zeroing now mutates the `amount` field
   via direct `try_borrow_mut_data` writes at a precomputed offset
   (`BID_DATA_AMOUNT_OFFSET = 48`) instead of a second `Account::try_from`
   deserialize. Saves ~10K CU per bid → ~200K CU at MAX_BIDDERS=20.
   Combined with a `ComputeBudgetProgram.setComputeUnitLimit(500_000)`
   prepended client-side in `settleAuction`, settle fits comfortably
   below the 1.4M per-tx CU ceiling.

**Residual risk:** A motivated attacker can still pay $30 to grief a
single auction. The deposit floor is a cost-imposition mechanism, not
a hard exclusion. For high-value lots, raise `bid_deposit_lamports`
per-auction. The settler also retains discretion in which bids to
include — `settle_auction` accepts whatever subset of bid PDAs is
passed via `remaining_accounts`. Closing the discretion gap (proof
that ALL bids were considered) needs an on-chain bid counter, which
is blocked by the auction PDA being TEE-delegated post-create.
Tracked for v2 with a TEE-native counter.

### A4. Winner-walk-away

**Attack:** A bidder wins, then refuses to call `claim_lot` to pay the
seller. The lot is stuck in `Settled` with no resolution.

**Mitigation:** After `end_time + claim_grace_seconds`, anyone can call
`slash_winner`, which forfeits the winner's bid PDA lamports (rent +
deposit) to the seller and sets `status = Slashed`. The deposit is the
seller's compensation for the wasted listing.

**Residual risk:** The slashable amount is bounded by the deposit, not by
the winning bid. A high-stakes auction needs a deposit sized as a
percentage of the expected winning bid — currently flat per-auction.

### A5. Stuck settlement (TEE liveness)

**Attack:** The TEE validator goes down, the seller forgets to settle,
or settle runs without your bid in `remaining_accounts`. Bidders'
deposits sit inside delegated bid PDAs unrecoverably.

**Mitigation:** Three layers.

1. **Anyone can settle.** `settle_auction` has `payer: Signer` with no
   seller check. Any bidder can pay the tx fee and force-settle while
   the TEE is responsive. After settle, `commit_and_undelegate_accounts`
   brings auction + every bid PDA in `remaining_accounts` back to
   base; losers call `refund_bid` to recover their deposit.

2. **Per-bidder `recover_bid_in_tee` fallback.** If settle ran but
   left a particular bid behind (e.g. the settler excluded it), the
   bidder calls this TEE-side instruction with their own keypair after
   a `RECOVER_BID_GRACE_SECONDS` (7-day) timeout. The program zeros
   the bid amount (preserving privacy), commits the PDA back to base,
   and the bidder follows up with `refund_bid` to reclaim their
   deposit. Closes the orphaned-bid case for any single bid without
   needing a settler.

3. **MagicBlock force-undelegate (last-resort).** If the TEE itself is
   unreachable for both settle and `recover_bid_in_tee`, MagicBlock's
   admin force-undelegate path is the final escape. Out-of-protocol;
   tracked as a trusted dependency.

**Residual risk:** The 7-day grace on `recover_bid_in_tee` is
deliberately long — it prevents bidders from retracting before
auction end, and forces honest auctions to settle first. Capital is
locked for up to 7 days in the worst case.

### A6. Late-bid attack

**Attack:** A bidder submits a bid AFTER `end_time` but before settle
runs, and tries to win.

**Mitigation:** `settle_auction` checks
`bid.timestamp <= auction.end_time` per bid; late bids are rejected at
iteration time. The timestamp is captured in `place_bid` against
`Clock::get()`, which the TEE controls.

**Residual risk:** TEE clock manipulation could backdate bids. Treated as
"if TEE compromised, all bets are off."

### A7. Replay / overwrite of bid amount

**Attack:** A bidder tries to call `place_bid` twice with different
amounts to revise their bid upward after seeing competitor reasoning.

**Mitigation:** `place_bid` uses `init_if_needed` for the bid PDA. The
first call creates the account and delegates it to the TEE in the same
tx. A second `place_bid` from base layer can't access the now-delegated
PDA. Revisions would have to go through the TEE, which doesn't expose a
revise path.

**Residual risk:** None observed. (We retain `init_if_needed` deliberately
so a failed delegation can be retried; the body fields are overwritten,
which is fine when the same bidder retries with fresh values.)

### A7b. Bidder-side prompt-injection over-bid

**Attack:** A compromised LLM (or prompt-injection inside an attacker-
controlled `lot_metadata_uri`) returns an `amount_usdc` far above the
principal's stated `max_value_usdc`. The bidder's existing
remaining-budget check passes if the principal has a generous total
budget, so the bid signs and submits at attacker-favourable price.

**Mitigation:** `agents/bidder/index.ts` runs `checkBidCeiling(cfg, lot,
amount_usdc)` as the last step before signing `place_bid`. Hard-rejects
(does not clamp) when:
- amount > matching want_list entry's `max_value_usdc`, or
- amount > `max_value_usdc × upper-of-risk-appetite` (99% / 92% / 80%
  for aggressive / balanced / conservative), or
- no want_list entry matches at all, or
- amount is non-positive / non-finite / non-integer.

The violation is streamed to the JSONL stream + `log.error()` + Sentry
`captureException`, so an operator sees the attack rather than silently
winning at the wrong price. Hard reject (vs clamp) is deliberate:
clamping would preserve the auction outcome but mask the model
malfunction.

**Residual risk:** The check is bidder-local — sellers running the demo
auctioneer trust their own deployment of the bidder process. A
fork-and-modify attacker who removes the check from their own bidder
gains nothing but the ability to lose money faster than they otherwise
would.

### A8. Frontend / RPC / registry tampering

**Attack:** A malicious frontend, RPC, CDN edge cache, or rogue mirror
returns false auction data to bidders — fake `auctionPda` values, lots
that don't exist, lots that exist with different metadata. Bidders sign
`place_bid` against attacker-controlled targets.

**Mitigation:** Three independent layers.

1. **Signed registry feed.** The auctioneer signs every entry
   (`feed_signature`, ed25519, `feed_version: 1`) with its seller
   keypair. Bidders configured with `trusted_publisher_pubkey` reject
   any entry whose signature doesn't verify against that pubkey.
   Closes the in-flight tampering attack: even a compromised CDN can't
   forge entries without the auctioneer's secret key.

2. **PDA derivation re-check.** Independent of trust, bidders verify
   that `auctionPda == findProgramAddress([b"auction", auctionId.le_bytes()], programId)`.
   Catches the case where a malicious-but-signed entry pairs an
   `auctionId` with an `auctionPda` that doesn't actually correspond
   to it — a signature alone binds two fields together but doesn't
   bind a field to its own structural meaning.

3. **Direct on-chain re-read.** Bidders call `getAuctionState` against
   their own RPC after the registry tells them an auction exists, so
   even an unsigned-but-correct-looking entry can be cross-checked.

The frontend remains a display layer only; signing a `place_bid`
requires the bidder's keypair held locally.

**Residual risk:** Bidders that opt out of `trusted_publisher_pubkey`
still trust the registry URL. The publisher key bootstrap is
out-of-band — a bidder operator who pins the wrong key trusts the
wrong publisher. Documented in AGENTS.md.

## Out-of-scope (known gaps for v2)

- **No formal audit.** The Anchor program has been code-reviewed but not
  audited by Sec3 / Ottersec / Halborn. Pre-mainnet, this is a
  prerequisite.
- ~~**No SPL token settlement.**~~ **Shipped (iteration 4).** `claim_lot`
  remains SOL-only; new `claim_lot_spl` instruction handles SPL auctions
  with an atomic `winner_ata → seller_ata` transfer + bid PDA close.
  Mint match and seller-ATA-ownership are both validated at the program
  level so a malicious caller can't substitute a cheaper mint or an
  attacker-controlled ATA.
- **TEE liveness fallback.** No on-chain force-cancel if the TEE itself
  is unreachable. Documented dependency on MagicBlock's admin path.
- **MAX_BIDDERS=5.** Will need a smarter settle loop (paginated, or with
  a heap) to scale beyond 5 bidders per auction.
- **No bid commit-reveal as a TEE alternative.** If TEE attestation
  weakens, a fallback hash-commit + reveal scheme would preserve sealed
  bids without hardware trust. Not implemented.
- **Bidder agent supply chain.** A compromised Anthropic API or rogue
  prompt injection could steer the bidder agent into bad bids. Mitigated
  by the hard `max_value_usdc` ceiling per want-list entry, but not
  eliminated.
- **DOS via small valid deposits.** Setting deposit floor to 0.01 SOL
  caps the easy spam; a financially motivated attacker can still buy 5
  slots for ~$7.50/auction. Per-auction `bid_deposit_lamports` lets the
  seller raise the floor.

## Reference

- Program source: [`programs/sealdex-auction/src/lib.rs`](../programs/sealdex-auction/src/lib.rs)
- MCP ops: [`mcp-server/src/ops.ts`](../mcp-server/src/ops.ts)
- Tests: [`tests/sealdex-auction.ts`](../tests/sealdex-auction.ts), [`tests/sealdex-security.ts`](../tests/sealdex-security.ts)
- AGENTS.md trust expectations: [`../AGENTS.md`](../AGENTS.md)
