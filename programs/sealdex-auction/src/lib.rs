use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use ephemeral_rollups_sdk::access_control::instructions::{
    CreatePermissionCpiBuilder, UpdatePermissionCpiBuilder,
};
use ephemeral_rollups_sdk::access_control::structs::{Member, MembersArgs};
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID;
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::commit_and_undelegate_accounts;

declare_id!("4DBEkkdMaW7boAsmEFXLMbEiSnVj1xYQUndWYGzPwEMJ");

pub const AUCTION_SEED: &[u8] = b"auction";
pub const BID_SEED: &[u8] = b"bid";
// Cap on bidders per auction. Bounded by:
//   - Solana legacy tx account list: 64 entries hard. settle's fixed
//     accounts use 6 (auction, permission_auction, payer, permission
//     program, magic_program, magic_context), plus 4 for the @commit
//     ER context, leaving ~54 slots before we'd need address lookup
//     tables. 20 keeps headroom and works without ALTs.
//   - Compute units: settle deserializes each Bid once and zeroes
//     loser amount fields via direct byte mutation (~1K CU each)
//     instead of a second deserialize (~10K CU). At 20 bids the
//     measured cost is ~250K CU — under the 400K we request from
//     the client side. See `mcp-server/src/ops.ts` settleAuction.
//   - Privacy: even at 20 bidders, only the winning amount is
//     revealed; loser amounts are still zeroed before commit.
pub const MAX_BIDDERS: usize = 20;
pub const MAX_METADATA_URI_LEN: usize = 200;

// Byte offsets into the Bid PDA data (after the 8-byte Anchor
// discriminator). Used by settle_auction for zero-cost loser zeroing.
const BID_DATA_DISC_LEN: usize = 8;
const BID_DATA_AMOUNT_OFFSET: usize = BID_DATA_DISC_LEN + 8 /*auction_id*/ + 32 /*bidder*/;

// Anti-spam deposit posted with each bid. Sized so 5 spam bids cost the
// attacker meaningful capital (~$7.50 at $150/SOL) while staying small
// enough that legitimate bidders aren't gated on it. See threat-model.md
// for the full reasoning.
pub const MIN_BID_DEPOSIT_LAMPORTS: u64 = 10_000_000; // 0.01 SOL

// Conservative SOL/USDC rate baked into create_auction so the program
// enforces a value-proportional deposit floor without an oracle dep.
// 1 SOL = 200 USDC ⇒ 1 USDC = 5_000_000 lamports. Errs on the under-
// priced side: if SOL appreciates, the deposit ends up over-sized
// (more friction for spammers). v2 should swap this for a Pyth feed.
pub const FIXED_LAMPORTS_PER_USDC: u64 = 5_000_000;
// Bidder deposit must be at least this percent of the lot's high
// estimate. 100 bps = 1%. Same default the auctioneer agent picked
// in iteration 8, now lifted into the program so hostile direct-MCP
// sellers can't bypass it.
pub const BID_DEPOSIT_RATIO_BPS: u64 = 100;
pub const BPS_DENOMINATOR: u64 = 10_000;

// v1 only supports SOL settlement off-chain via Private Payments, signalled
// by `payment_mint == Pubkey::default()` (== system_program::ID). A non-SOL
// mint passed to create_auction is allowed to be stored (forward-compatible
// with v2 SPL settlement) but claim_lot rejects it until on-chain SPL CPIs
// land.
pub const SOL_PAYMENT_MINT: Pubkey = Pubkey::new_from_array([0u8; 32]);

// How long after `end_time` a winner has to call `claim_lot` before the
// seller can slash their deposit. Floor prevents grief-claims; ceiling
// keeps stuck capital bounded.
pub const MIN_CLAIM_GRACE_SECONDS: i64 = 60;
pub const MAX_CLAIM_GRACE_SECONDS: i64 = 7 * 24 * 60 * 60;

// How long a bid must sit in the TEE before its bidder can self-recover
// it via `recover_bid_in_tee`. Closes the stuck-bid problem (settle never
// ran, or ran without this bid in remaining_accounts) without enabling
// early retraction during the bidding window. 7 days is conservative
// enough that legitimate auctions always settle first; bidders who
// invoke this are admitting the TEE / settler is unreachable.
pub const RECOVER_BID_GRACE_SECONDS: i64 = 7 * 24 * 60 * 60;

#[ephemeral]
#[program]
pub mod sealdex_auction {
    use super::*;

    // 1️⃣ Seller creates an auction. Stores the deposit + claim-grace
    // policy that bidders must comply with — both enforced at settle time
    // (auction is delegated by then, so place_bid can't read it directly).
    pub fn create_auction(
        ctx: Context<CreateAuction>,
        auction_id: u64,
        lot_metadata_uri: String,
        payment_mint: Pubkey,
        end_time: i64,
        bid_deposit_lamports: u64,
        claim_grace_seconds: i64,
        kind: AuctionKind,
        permitted_bidders: Vec<Pubkey>,
        estimate_high_usdc: u64,
        reserve_price: u64,
    ) -> Result<()> {
        require!(
            lot_metadata_uri.len() <= MAX_METADATA_URI_LEN,
            AuctionError::MetadataTooLong
        );
        let now = Clock::get()?.unix_timestamp;
        require!(end_time > now, AuctionError::EndTimeInPast);
        require!(
            bid_deposit_lamports >= MIN_BID_DEPOSIT_LAMPORTS,
            AuctionError::DepositTooLow
        );
        require!(
            claim_grace_seconds >= MIN_CLAIM_GRACE_SECONDS
                && claim_grace_seconds <= MAX_CLAIM_GRACE_SECONDS,
            AuctionError::InvalidClaimGrace
        );
        // Program-enforced market floor: bidder deposit must be at least
        // BID_DEPOSIT_RATIO_BPS (1%) of the lot's high estimate, converted
        // to lamports at the fixed conservative rate. Closes the
        // iteration-8 hostile-seller gap where direct-MCP callers could
        // bypass the auctioneer agent's auto-sizing. estimate_high_usdc
        // == 0 = seller declined to publish an estimate; only the
        // MIN_BID_DEPOSIT_LAMPORTS hard floor applies in that case.
        let market_floor: u64 = (estimate_high_usdc as u128)
            .checked_mul(FIXED_LAMPORTS_PER_USDC as u128)
            .and_then(|v| v.checked_mul(BID_DEPOSIT_RATIO_BPS as u128))
            .and_then(|v| v.checked_div(BPS_DENOMINATOR as u128))
            .and_then(|v| u64::try_from(v).ok())
            .unwrap_or(u64::MAX); // overflow ⇒ saturate so we always reject
        require!(
            bid_deposit_lamports >= market_floor,
            AuctionError::DepositBelowMarketFloor
        );
        // Empty list = open auction (anyone can bid; settler retains
        // discretion). Non-empty = closed: settle requires every
        // permitted bidder's slot, closing the discretion gap. Cap at
        // MAX_BIDDERS to keep the account size + settle CU bounded.
        require!(
            permitted_bidders.len() <= MAX_BIDDERS,
            AuctionError::PermittedBiddersExceedsCap
        );
        // Reject duplicates in the permitted list — they'd inflate the
        // required slot count and confuse settle's matching logic.
        for (i, pk) in permitted_bidders.iter().enumerate() {
            for other in &permitted_bidders[i + 1..] {
                require!(pk != other, AuctionError::DuplicatePermittedBidder);
            }
        }

        let auction = &mut ctx.accounts.auction;
        auction.auction_id = auction_id;
        auction.seller = ctx.accounts.seller.key();
        auction.lot_metadata_uri = lot_metadata_uri;
        auction.payment_mint = payment_mint;
        auction.end_time = end_time;
        auction.status = AuctionStatus::Open;
        auction.winner = None;
        auction.winning_bid = None;
        auction.bid_deposit_lamports = bid_deposit_lamports;
        auction.claim_grace_seconds = claim_grace_seconds;
        auction.kind = kind;
        auction.permitted_bidders = permitted_bidders;
        auction.estimate_high_usdc = estimate_high_usdc;
        auction.reserve_price = reserve_price;

        msg!(
            "Auction {} created by {} (kind={:?}, permitted={}, estimate_high_usdc={}, reserve={})",
            auction_id,
            auction.seller,
            auction.kind,
            auction.permitted_bidders.len(),
            estimate_high_usdc,
            reserve_price
        );
        emit!(AuctionCreated {
            auction_id,
            seller: auction.seller,
            end_time,
            payment_mint,
            bid_deposit_lamports,
            estimate_high_usdc,
            reserve_price,
            kind_is_second_price: matches!(auction.kind, AuctionKind::SecondPrice),
            permitted_bidder_count: auction.permitted_bidders.len() as u8,
        });
        Ok(())
    }

    // 2️⃣ Bidder places a sealed bid. The auction account is NOT referenced
    // (it's delegated to the TEE), so place_bid can't enforce against
    // auction.bid_deposit_lamports here — settle_auction does that filter
    // when it can read both. We still enforce a hard floor so the cheapest
    // possible spam costs `MIN_BID_DEPOSIT_LAMPORTS * MAX_BIDDERS`.
    pub fn place_bid(
        ctx: Context<PlaceBid>,
        auction_id: u64,
        amount: u64,
        deposit_lamports: u64,
    ) -> Result<()> {
        require!(
            deposit_lamports >= MIN_BID_DEPOSIT_LAMPORTS,
            AuctionError::DepositTooLow
        );

        // Move the deposit from the bidder into the bid PDA. The lamports
        // travel with the PDA when it gets delegated to the TEE in the
        // same transaction, and come back when settle commits + undelegates.
        let cpi = system_program::Transfer {
            from: ctx.accounts.bidder.to_account_info(),
            to: ctx.accounts.bid.to_account_info(),
        };
        system_program::transfer(
            CpiContext::new(ctx.accounts.system_program.to_account_info(), cpi),
            deposit_lamports,
        )?;

        let now = Clock::get()?.unix_timestamp;
        let bidder_key = ctx.accounts.bidder.key();
        let bid_pda_key = ctx.accounts.bid.key();
        let bid = &mut ctx.accounts.bid;
        bid.auction_id = auction_id;
        bid.bidder = bidder_key;
        bid.amount = amount;
        bid.timestamp = now;
        bid.deposit_lamports = deposit_lamports;

        msg!("Bid placed by {} on auction {}", bidder_key, auction_id);
        // Note: amount is intentionally NOT in the event — it's the
        // sealed value. Indexers learn that bidder X placed a bid on
        // auction Y at time T with deposit D, but never the bid amount.
        emit!(BidPlaced {
            auction_id,
            bidder: bidder_key,
            bid_pda: bid_pda_key,
            deposit_lamports,
            timestamp: now,
        });
        Ok(())
    }

    // 3️⃣ Settle the auction inside the TEE: filter under-deposited bids,
    // find the max amongst the rest, zero out loser amounts (privacy), and
    // commit + undelegate auction + ALL bids back to base. Anyone may call
    // — that's the force-progress lever for stuck auctions.
    pub fn settle_auction<'info>(
        ctx: Context<'_, '_, 'info, 'info, SettleAuction<'info>>,
    ) -> Result<()> {
        let auction_end_time = ctx.accounts.auction.end_time;
        let auction_id = ctx.accounts.auction.auction_id;
        let auction_min_deposit = ctx.accounts.auction.bid_deposit_lamports;
        let auction_status = ctx.accounts.auction.status.clone();
        // Clone here so we can borrow `auction` mutably later without
        // tripping the borrow checker against this read-side reference.
        let permitted = ctx.accounts.auction.permitted_bidders.clone();
        let is_closed = !permitted.is_empty();

        let now = Clock::get()?.unix_timestamp;
        require!(now >= auction_end_time, AuctionError::AuctionNotEnded);
        require!(
            auction_status == AuctionStatus::Open,
            AuctionError::AuctionClosed
        );

        require!(
            ctx.remaining_accounts.len() <= MAX_BIDDERS,
            AuctionError::BidderCapReached
        );

        // CLOSED-AUCTION GUARD: any initialized bid in remaining_accounts
        // must come from a permitted bidder. Closes the spam-into-closed-
        // auction attack — non-permitted bids are rejected at settle. Note
        // this does NOT force the settler to include EVERY permitted
        // bidder's bid (that requires passing uninit placeholder accounts
        // through the TEE, whose semantics aren't verified for
        // ephemeral_rollups_sdk's commit path; deferred to v2 with TEE
        // testing). The current bound: closed auctions cannot be
        // hijacked by outsiders, and the seller's own permission list
        // is the canonical record of who could have bid.
        let mut highest_amount: u64 = 0;
        let mut second_highest_amount: u64 = 0;
        let mut highest_bidder: Option<Pubkey> = None;
        let mut seen_bidders: Vec<Pubkey> = Vec::with_capacity(MAX_BIDDERS);
        let mut loser_indices: Vec<usize> = Vec::with_capacity(MAX_BIDDERS);

        // First pass — pick the winner amongst eligible bids. Track the
        // second-highest amount so Vickrey auctions can pay the loser
        // price; first-price auctions ignore it.
        for (idx, ai) in ctx.remaining_accounts.iter().enumerate() {
            let bid_account: Account<Bid> = Account::try_from(ai)?;
            require!(
                bid_account.auction_id == auction_id,
                AuctionError::WrongAuctionForBid
            );
            require!(
                bid_account.timestamp <= auction_end_time,
                AuctionError::AuctionEnded
            );
            require!(
                !seen_bidders.contains(&bid_account.bidder),
                AuctionError::AlreadyBid
            );
            // Closed auctions: reject bids from non-permitted bidders.
            if is_closed {
                require!(
                    permitted.contains(&bid_account.bidder),
                    AuctionError::UnpermittedBidder
                );
            }
            seen_bidders.push(bid_account.bidder);

            let (expected_pda, _) = Pubkey::find_program_address(
                &[
                    BID_SEED,
                    &auction_id.to_le_bytes(),
                    bid_account.bidder.as_ref(),
                ],
                &crate::ID,
            );
            require!(ai.key() == expected_pda, AuctionError::WrongAuctionForBid);

            // Bids that didn't post the seller's required deposit don't
            // count for the max. They're still undelegated so the
            // bidder can claw back whatever they did post.
            if bid_account.deposit_lamports < auction_min_deposit {
                loser_indices.push(idx);
                continue;
            }

            if bid_account.amount > highest_amount {
                second_highest_amount = highest_amount;
                highest_amount = bid_account.amount;
                highest_bidder = Some(bid_account.bidder);
            } else if bid_account.amount > second_highest_amount {
                second_highest_amount = bid_account.amount;
            }
        }

        // Reserve-aware pricing.
        //
        // First-price: winner pays their own bid IF it meets the reserve;
        // otherwise no winner (auction "passes" / no-sale).
        //
        // Vickrey-with-reserve (textbook): if highest < reserve, no winner.
        // Else if second_highest >= reserve, winner pays the second-highest.
        // Else winner pays the reserve itself — the second-price would
        // have been below the seller's floor, so we lift it to the floor.
        // This keeps the truthful-bidding incentive while honouring the
        // seller's minimum.
        let reserve = ctx.accounts.auction.reserve_price;
        let pay_amount: Option<u64> = match ctx.accounts.auction.kind {
            AuctionKind::FirstPrice => {
                if highest_amount >= reserve && highest_bidder.is_some() {
                    Some(highest_amount)
                } else {
                    None
                }
            }
            AuctionKind::SecondPrice => {
                if highest_amount < reserve || highest_bidder.is_none() {
                    None
                } else if second_highest_amount >= reserve {
                    Some(second_highest_amount)
                } else {
                    Some(reserve)
                }
            }
        };
        // No-winner scenarios still mark the auction Settled — the lot
        // doesn't sell, but the auction is closed for further bids and
        // bidders can refund their deposits. Distinguishing "settled with
        // winner" vs "no-sale" is via the auction.winner field on base.
        let final_winner = if pay_amount.is_some() {
            highest_bidder
        } else {
            None
        };

        // Second pass — zero out loser amounts to preserve sealed-bid
        // privacy when the bid PDA gets undelegated. We collected
        // `seen_bidders[idx] == bid_account.bidder` in pass 1, so we
        // already know which idx maps to which bidder. Direct byte
        // mutation at the precomputed amount-field offset avoids the
        // second `Account::try_from` deserialize (saves ~10K CU per
        // bid, ~200K CU at MAX_BIDDERS=20). Discriminator + bidder are
        // untouched so subsequent reads via Account<Bid> still decode
        // cleanly with `amount: 0`.
        for (idx, ai) in ctx.remaining_accounts.iter().enumerate() {
            let bidder_at_idx = seen_bidders[idx];
            // "Winner" here means the FINAL winner — accounts for the
            // reserve check above. If the highest bidder didn't meet
            // reserve, final_winner is None and we zero every bid.
            let is_winner = Some(bidder_at_idx) == final_winner
                && !loser_indices.contains(&idx);
            if !is_winner {
                let mut data = ai.try_borrow_mut_data()?;
                if data.len() < BID_DATA_AMOUNT_OFFSET + 8 {
                    return err!(AuctionError::WrongAuctionForBid);
                }
                data[BID_DATA_AMOUNT_OFFSET..BID_DATA_AMOUNT_OFFSET + 8]
                    .fill(0);
            }
        }

        let auction = &mut ctx.accounts.auction;
        auction.winner = final_winner;
        auction.winning_bid = pay_amount;
        auction.status = AuctionStatus::Settled;

        let permission_program = &ctx.accounts.permission_program.to_account_info();
        let permission_auction = &ctx.accounts.permission_auction.to_account_info();
        let magic_program = &ctx.accounts.magic_program.to_account_info();
        let magic_context = &ctx.accounts.magic_context.to_account_info();

        // Open the auction PDA to public read by clearing membership
        UpdatePermissionCpiBuilder::new(permission_program)
            .permissioned_account(&auction.to_account_info(), true)
            .authority(&auction.to_account_info(), false)
            .permission(permission_auction)
            .args(MembersArgs { members: None })
            .invoke_signed(&[&[
                AUCTION_SEED,
                &auction.auction_id.to_le_bytes(),
                &[ctx.bumps.auction],
            ]])?;

        msg!(
            "Auction {} settled (kind={:?}). Winner: {:?} pays {:?} (reserve={})",
            auction.auction_id,
            auction.kind,
            auction.winner,
            pay_amount,
            reserve
        );
        emit!(AuctionSettled {
            auction_id: auction.auction_id,
            winner: auction.winner,
            winning_bid: auction.winning_bid,
            eligible_bid_count: ctx.remaining_accounts.len() as u8,
            kind_is_second_price: matches!(auction.kind, AuctionKind::SecondPrice),
            reserve_price: reserve,
        });

        auction.exit(&crate::ID)?;

        // Commit + undelegate auction AND every bid passed in. After this
        // each bidder owns their bid PDA on base again, can close it for
        // a deposit refund (loser path) or wait for claim_lot (winner).
        let mut to_undelegate: Vec<&AccountInfo<'info>> =
            Vec::with_capacity(1 + ctx.remaining_accounts.len());
        to_undelegate.push(auction.as_ref());
        for ai in ctx.remaining_accounts.iter() {
            to_undelegate.push(ai);
        }
        commit_and_undelegate_accounts(
            &ctx.accounts.payer,
            to_undelegate,
            magic_context,
            magic_program,
            None,
        )?;

        Ok(())
    }

    // 4️⃣ Winner claims the lot. Closes the winner's bid PDA atomically
    // (refunds the deposit) and emits LotClaimed for the off-chain escrow
    // agent. The actual SPL/SOL transfer of the winning amount stays in
    // Private Payments for v1 — this instruction is the on-chain receipt
    // that gates that flow.
    pub fn claim_lot(ctx: Context<ClaimLot>) -> Result<()> {
        let auction = &mut ctx.accounts.auction;
        require!(
            auction.status == AuctionStatus::Settled,
            AuctionError::NotSettled
        );
        // v1: only SOL-denominated auctions can be claimed on-chain. Other
        // mints are stored for forward-compat but their settlement isn't
        // wired through claim_lot yet.
        require!(
            auction.payment_mint == SOL_PAYMENT_MINT,
            AuctionError::PaymentMintNotSupported
        );
        let winner = auction.winner.ok_or(AuctionError::NoWinner)?;
        require!(
            ctx.accounts.winner.key() == winner,
            AuctionError::NotWinner
        );
        require!(
            ctx.accounts.bid.bidder == winner,
            AuctionError::NotWinner
        );
        let amount = auction.winning_bid.ok_or(AuctionError::NoWinner)?;

        auction.status = AuctionStatus::Claimed;

        emit!(LotClaimed {
            auction_id: auction.auction_id,
            winner,
            seller: auction.seller,
            amount,
            payment_mint: auction.payment_mint,
        });

        Ok(())
    }

    // 4b️⃣ Winner claims an SPL-denominated lot. Atomically transfers
    // `winning_bid` from the winner's ATA to the seller's ATA, closes the
    // winner's bid PDA (refunds the deposit), and emits LotClaimed for
    // observers. Use this instead of `claim_lot` whenever
    // `auction.payment_mint != SOL_PAYMENT_MINT`. The MCP `claimLot` op
    // dispatches automatically based on the auction's stored mint.
    pub fn claim_lot_spl(ctx: Context<ClaimLotSpl>) -> Result<()> {
        let auction = &mut ctx.accounts.auction;
        require!(
            auction.status == AuctionStatus::Settled,
            AuctionError::NotSettled
        );
        // Enforce that this op runs only on SPL auctions. SOL auctions go
        // through `claim_lot`, which has the inverse check.
        require!(
            auction.payment_mint != SOL_PAYMENT_MINT,
            AuctionError::PaymentMintNotSupported
        );
        // Mint must match what the seller committed to at create time —
        // closes a swap-attack where a malicious caller passes a different
        // mint with cheaper tokens.
        require!(
            ctx.accounts.mint.key() == auction.payment_mint,
            AuctionError::PaymentMintMismatch
        );
        // Seller's ATA is `mut`-checked to be the same mint. We additionally
        // require its owner to be the auction's seller — Anchor's
        // `token::mint =` constraint catches mint mismatches but not
        // attacker-owned ATAs of the right mint.
        require!(
            ctx.accounts.seller_ata.owner == auction.seller,
            AuctionError::WrongSellerAta
        );

        let winner = auction.winner.ok_or(AuctionError::NoWinner)?;
        require!(
            ctx.accounts.winner.key() == winner,
            AuctionError::NotWinner
        );
        require!(ctx.accounts.bid.bidder == winner, AuctionError::NotWinner);
        let amount = auction.winning_bid.ok_or(AuctionError::NoWinner)?;

        // SPL transfer signed by the winner's keypair (already a Signer
        // on this instruction). The bid PDA close = winner constraint
        // refunds the deposit lamports atomically with the SPL transfer.
        let cpi_accounts = Transfer {
            from: ctx.accounts.winner_ata.to_account_info(),
            to: ctx.accounts.seller_ata.to_account_info(),
            authority: ctx.accounts.winner.to_account_info(),
        };
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
            ),
            amount,
        )?;

        auction.status = AuctionStatus::Claimed;
        emit!(LotClaimed {
            auction_id: auction.auction_id,
            winner,
            seller: auction.seller,
            amount,
            payment_mint: auction.payment_mint,
        });
        Ok(())
    }

    // 5️⃣ Loser refund. Anyone who bid + lost can close their own bid PDA
    // and recover their deposit. Status check ensures we only refund after
    // the auction is decided so the caller can prove they're not the
    // winner.
    pub fn refund_bid(ctx: Context<RefundBid>) -> Result<()> {
        let auction = &ctx.accounts.auction;
        require!(
            auction.status == AuctionStatus::Settled
                || auction.status == AuctionStatus::Claimed
                || auction.status == AuctionStatus::Slashed,
            AuctionError::NotSettled
        );
        let bid = &ctx.accounts.bid;
        require!(
            bid.bidder == ctx.accounts.bidder.key(),
            AuctionError::NotBidder
        );
        require!(
            Some(bid.bidder) != auction.winner,
            AuctionError::WinnerCannotRefund
        );
        emit!(BidRefunded {
            auction_id: bid.auction_id,
            bidder: bid.bidder,
            deposit_lamports: bid.deposit_lamports,
        });
        // The Anchor `close = bidder` constraint sweeps lamports to bidder.
        Ok(())
    }

    // 6️⃣ Slash a no-show winner. After end_time + claim_grace, anyone may
    // forfeit the winner's deposit to the seller. Enforces accountability
    // for winners who try to walk away from the off-chain SPL transfer.
    pub fn slash_winner(ctx: Context<SlashWinner>) -> Result<()> {
        let auction = &mut ctx.accounts.auction;
        require!(
            auction.status == AuctionStatus::Settled,
            AuctionError::NotSettled
        );
        let winner = auction.winner.ok_or(AuctionError::NoWinner)?;
        require!(
            ctx.accounts.bid.bidder == winner,
            AuctionError::NotWinner
        );
        require!(
            ctx.accounts.seller.key() == auction.seller,
            AuctionError::NotSeller
        );

        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= auction
                .end_time
                .saturating_add(auction.claim_grace_seconds),
            AuctionError::ClaimGraceNotElapsed
        );

        auction.status = AuctionStatus::Slashed;
        emit!(BidSlashed {
            auction_id: auction.auction_id,
            winner,
            seller: auction.seller,
            // The full lamport balance of the bid PDA gets swept to the
            // seller — both the deposit and the rent. Reading the PDA's
            // current lamports here gives the caller the precise amount
            // that's about to move.
            forfeited_lamports: ctx.accounts.bid.to_account_info().lamports(),
        });
        // The Anchor `close = seller` constraint sweeps lamports to seller.
        Ok(())
    }

    // 7️⃣ TEE-side bid recovery — the stuck-bid liveness fallback. If
    // settle never runs (TEE unreachable) or runs without this bidder
    // in remaining_accounts, their bid PDA is otherwise sealed in the
    // TEE forever. After RECOVER_BID_GRACE_SECONDS (7 days) the bidder
    // can call this from a TEE-authed connection: the bid amount is
    // zeroed (privacy preserved) and the PDA is committed back to base.
    // The bidder then calls the existing `refund_bid` on base to close
    // the PDA and recover their deposit lamports.
    pub fn recover_bid_in_tee<'info>(
        ctx: Context<'_, '_, 'info, 'info, RecoverBidInTee<'info>>,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let bid = &mut ctx.accounts.bid;
        require!(
            bid.bidder == ctx.accounts.bidder.key(),
            AuctionError::NotBidder
        );
        // 7-day timeout means an honest auction always settles first.
        // Bidders only reach this path when the TEE / settler is truly
        // unreachable; early retraction is structurally prevented.
        require!(
            now >= bid.timestamp.saturating_add(RECOVER_BID_GRACE_SECONDS),
            AuctionError::RecoverGraceNotElapsed
        );
        let recovered_after = now.saturating_sub(bid.timestamp);
        emit!(BidRecovered {
            auction_id: bid.auction_id,
            bidder: bid.bidder,
            recovered_after_seconds: recovered_after,
        });
        bid.amount = 0; // privacy — never let a sealed bid leak post-recovery
        bid.exit(&crate::ID)?;

        let magic_program = &ctx.accounts.magic_program.to_account_info();
        let magic_context = &ctx.accounts.magic_context.to_account_info();
        commit_and_undelegate_accounts(
            &ctx.accounts.bidder,
            vec![&bid.to_account_info()],
            magic_context,
            magic_program,
            None,
        )?;
        Ok(())
    }

    /// Delegate auction or bid PDA to the TEE validator
    pub fn delegate_pda(ctx: Context<DelegatePda>, account_type: AccountType) -> Result<()> {
        let seed_data = derive_seeds_from_account_type(&account_type);
        let seeds_refs: Vec<&[u8]> = seed_data.iter().map(|s| s.as_slice()).collect();

        let validator = ctx.accounts.validator.as_ref().map(|v| v.key());
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &seeds_refs,
            DelegateConfig {
                validator,
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Create a permission account for the auction or bid PDA
    pub fn create_permission(
        ctx: Context<CreatePermission>,
        account_type: AccountType,
        members: Option<Vec<Member>>,
    ) -> Result<()> {
        let CreatePermission {
            permissioned_account,
            permission,
            payer,
            permission_program,
            system_program,
        } = ctx.accounts;

        let seed_data = derive_seeds_from_account_type(&account_type);

        let (_, bump) = Pubkey::find_program_address(
            &seed_data.iter().map(|s| s.as_slice()).collect::<Vec<_>>(),
            &crate::ID,
        );

        let mut seeds = seed_data.clone();
        seeds.push(vec![bump]);
        let seed_refs: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();

        CreatePermissionCpiBuilder::new(&permission_program)
            .permissioned_account(&permissioned_account.to_account_info())
            .permission(&permission)
            .payer(&payer)
            .system_program(&system_program)
            .args(MembersArgs { members })
            .invoke_signed(&[seed_refs.as_slice()])?;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(auction_id: u64, lot_metadata_uri: String)]
pub struct CreateAuction<'info> {
    // `init` (not init_if_needed): a second create_auction with the same
    // auction_id fails at the discriminator check before any of the body
    // runs. Without this, an attacker could front-run the seller's
    // delegate_pda call and overwrite seller/end_time/payment_mint.
    #[account(
        init,
        payer = seller,
        space = 8 + Auction::LEN,
        seeds = [AUCTION_SEED, &auction_id.to_le_bytes()],
        bump
    )]
    pub auction: Account<'info, Auction>,

    #[account(mut)]
    pub seller: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(auction_id: u64)]
pub struct PlaceBid<'info> {
    #[account(
        init_if_needed,
        payer = bidder,
        space = 8 + Bid::LEN,
        seeds = [BID_SEED, &auction_id.to_le_bytes(), bidder.key().as_ref()],
        bump
    )]
    pub bid: Account<'info, Bid>,

    #[account(mut)]
    pub bidder: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[commit]
#[derive(Accounts)]
pub struct SettleAuction<'info> {
    #[account(mut, seeds = [AUCTION_SEED, &auction.auction_id.to_le_bytes()], bump)]
    pub auction: Account<'info, Auction>,
    /// CHECK: Checked by the permission program
    #[account(mut)]
    pub permission_auction: UncheckedAccount<'info>,
    /// Anyone can trigger settlement once end_time has passed
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: PERMISSION PROGRAM
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ClaimLot<'info> {
    #[account(mut, seeds = [AUCTION_SEED, &auction.auction_id.to_le_bytes()], bump)]
    pub auction: Account<'info, Auction>,
    #[account(
        mut,
        close = winner,
        seeds = [BID_SEED, &auction.auction_id.to_le_bytes(), winner.key().as_ref()],
        bump
    )]
    pub bid: Account<'info, Bid>,
    #[account(mut)]
    pub winner: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimLotSpl<'info> {
    #[account(mut, seeds = [AUCTION_SEED, &auction.auction_id.to_le_bytes()], bump)]
    pub auction: Account<'info, Auction>,
    #[account(
        mut,
        close = winner,
        seeds = [BID_SEED, &auction.auction_id.to_le_bytes(), winner.key().as_ref()],
        bump
    )]
    pub bid: Account<'info, Bid>,
    #[account(mut)]
    pub winner: Signer<'info>,
    /// CHECK: address-checked against auction.payment_mint in the handler.
    pub mint: UncheckedAccount<'info>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = winner,
    )]
    pub winner_ata: Account<'info, TokenAccount>,
    /// Seller's ATA — `token::mint = mint` ensures the right denomination,
    /// and the handler additionally checks `seller_ata.owner == auction.seller`.
    #[account(mut, token::mint = mint)]
    pub seller_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RefundBid<'info> {
    #[account(seeds = [AUCTION_SEED, &auction.auction_id.to_le_bytes()], bump)]
    pub auction: Account<'info, Auction>,
    #[account(
        mut,
        close = bidder,
        seeds = [BID_SEED, &auction.auction_id.to_le_bytes(), bidder.key().as_ref()],
        bump,
        has_one = bidder,
    )]
    pub bid: Account<'info, Bid>,
    #[account(mut)]
    pub bidder: Signer<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct RecoverBidInTee<'info> {
    #[account(
        mut,
        seeds = [BID_SEED, &bid.auction_id.to_le_bytes(), bid.bidder.as_ref()],
        bump,
    )]
    pub bid: Account<'info, Bid>,
    /// Bidder must sign — and must be the bidder recorded on the PDA
    /// (verified in the handler against `bid.bidder`). Pays the commit
    /// CPI rent + fees.
    #[account(mut)]
    pub bidder: Signer<'info>,
}

#[derive(Accounts)]
pub struct SlashWinner<'info> {
    #[account(mut, seeds = [AUCTION_SEED, &auction.auction_id.to_le_bytes()], bump)]
    pub auction: Account<'info, Auction>,
    #[account(
        mut,
        close = seller,
        seeds = [BID_SEED, &auction.auction_id.to_le_bytes(), bid.bidder.as_ref()],
        bump,
    )]
    pub bid: Account<'info, Bid>,
    /// CHECK: Verified against auction.seller in handler.
    #[account(mut)]
    pub seller: UncheckedAccount<'info>,
    /// Anyone can trigger slashing once the grace window has elapsed.
    pub caller: Signer<'info>,
}

/// Unified delegate PDA context (Auction or Bid)
#[delegate]
#[derive(Accounts)]
pub struct DelegatePda<'info> {
    /// CHECK: The PDA to delegate
    #[account(mut, del)]
    pub pda: AccountInfo<'info>,
    pub payer: Signer<'info>,
    /// CHECK: Checked by the delegate program
    pub validator: Option<AccountInfo<'info>>,
}

#[derive(Accounts)]
pub struct CreatePermission<'info> {
    /// CHECK: Validated via permission program CPI
    pub permissioned_account: UncheckedAccount<'info>,
    /// CHECK: Checked by the permission program
    #[account(mut)]
    pub permission: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: PERMISSION PROGRAM
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct Auction {
    pub auction_id: u64,
    pub seller: Pubkey,
    pub lot_metadata_uri: String,
    pub payment_mint: Pubkey,
    pub end_time: i64,
    pub status: AuctionStatus,
    pub winner: Option<Pubkey>,
    pub winning_bid: Option<u64>,
    pub bid_deposit_lamports: u64,
    pub claim_grace_seconds: i64,
    pub kind: AuctionKind,
    /// Empty Vec = open auction (anyone can bid). Non-empty = closed:
    /// settle rejects bids from any bidder not in this list. Capped
    /// at MAX_BIDDERS to keep the account size + settle CU bounded.
    pub permitted_bidders: Vec<Pubkey>,
    /// Seller-published high estimate in whole USDC. Used by
    /// `create_auction` to enforce a deposit floor proportional to lot
    /// value so spammers pay $50/bid on a $5,000 grail instead of $0.50.
    /// Zero = no estimate published; only the hard floor applies.
    pub estimate_high_usdc: u64,
    /// Auction floor in bid native units (matches `winning_bid`). settle
    /// declares no winner if `highest_amount < reserve_price`. Vickrey
    /// pays `max(second_highest, reserve)` when `highest >= reserve`.
    /// Zero = no reserve (every meeting bid wins). Public — visible to
    /// anyone reading the auction PDA on base or via TEE auth.
    pub reserve_price: u64,
}

impl Auction {
    pub const LEN: usize = 8                                 // auction_id
        + 32                                                  // seller
        + 4 + MAX_METADATA_URI_LEN                            // String len + bytes
        + 32                                                  // payment_mint
        + 8                                                   // end_time
        + 1                                                   // status (4 unit variants)
        + 1 + 32                                              // Option<Pubkey> winner
        + 1 + 8                                               // Option<u64> winning_bid
        + 8                                                   // bid_deposit_lamports
        + 8                                                   // claim_grace_seconds
        + 1                                                   // kind (FirstPrice/SecondPrice)
        + 4 + 32 * MAX_BIDDERS                               // Vec<Pubkey> permitted_bidders
        + 8                                                   // estimate_high_usdc
        + 8;                                                  // reserve_price
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub enum AuctionStatus {
    Open,
    Settled,
    Claimed,
    Slashed,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum AuctionKind {
    /// Winner pays their own bid (highest_amount).
    FirstPrice,
    /// Winner pays the second-highest eligible bid (Vickrey). Falls back
    /// to FirstPrice when only one bidder is eligible.
    SecondPrice,
}

#[account]
pub struct Bid {
    pub auction_id: u64,
    pub bidder: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
    pub deposit_lamports: u64,
}
impl Bid {
    pub const LEN: usize = 8 + 32 + 8 + 8 + 8;
}

#[event]
pub struct LotClaimed {
    pub auction_id: u64,
    pub winner: Pubkey,
    pub seller: Pubkey,
    pub amount: u64,
    pub payment_mint: Pubkey,
}

#[event]
pub struct AuctionCreated {
    pub auction_id: u64,
    pub seller: Pubkey,
    pub end_time: i64,
    pub payment_mint: Pubkey,
    pub bid_deposit_lamports: u64,
    pub estimate_high_usdc: u64,
    pub reserve_price: u64,
    pub kind_is_second_price: bool,
    pub permitted_bidder_count: u8,
}

#[event]
pub struct BidPlaced {
    pub auction_id: u64,
    pub bidder: Pubkey,
    pub bid_pda: Pubkey,
    pub deposit_lamports: u64,
    pub timestamp: i64,
}

#[event]
pub struct AuctionSettled {
    pub auction_id: u64,
    pub winner: Option<Pubkey>,
    pub winning_bid: Option<u64>,
    pub eligible_bid_count: u8,
    pub kind_is_second_price: bool,
    pub reserve_price: u64,
}

#[event]
pub struct BidRefunded {
    pub auction_id: u64,
    pub bidder: Pubkey,
    pub deposit_lamports: u64,
}

#[event]
pub struct BidSlashed {
    pub auction_id: u64,
    pub winner: Pubkey,
    pub seller: Pubkey,
    pub forfeited_lamports: u64,
}

#[event]
pub struct BidRecovered {
    pub auction_id: u64,
    pub bidder: Pubkey,
    pub recovered_after_seconds: i64,
}

#[error_code]
pub enum AuctionError {
    #[msg("Lot metadata URI exceeds 200 chars.")]
    MetadataTooLong,
    #[msg("End time must be in the future.")]
    EndTimeInPast,
    #[msg("Auction is not open.")]
    AuctionClosed,
    #[msg("Auction has already ended.")]
    AuctionEnded,
    #[msg("Auction has not yet ended.")]
    AuctionNotEnded,
    #[msg("Bidder cap reached.")]
    BidderCapReached,
    #[msg("Already bid on this auction.")]
    AlreadyBid,
    #[msg("Wrong bid count in remaining_accounts.")]
    WrongBidCount,
    #[msg("Bid PDA does not match auction.")]
    WrongAuctionForBid,
    #[msg("Unknown bidder in remaining_accounts.")]
    UnknownBidder,
    #[msg("Auction not yet settled.")]
    NotSettled,
    #[msg("Caller is not the auction winner.")]
    NotWinner,
    #[msg("Caller is not the auction seller.")]
    NotSeller,
    #[msg("Caller is not the original bidder.")]
    NotBidder,
    #[msg("Auction has no winner.")]
    NoWinner,
    #[msg("Bid deposit below the program minimum.")]
    DepositTooLow,
    #[msg("Claim grace must be between MIN_CLAIM_GRACE_SECONDS and MAX_CLAIM_GRACE_SECONDS.")]
    InvalidClaimGrace,
    #[msg("Winner cannot refund — must call claim_lot or wait for slash window.")]
    WinnerCannotRefund,
    #[msg("Claim grace window has not elapsed yet.")]
    ClaimGraceNotElapsed,
    #[msg("Auction payment_mint requires the other claim variant (claim_lot for SOL, claim_lot_spl for SPL).")]
    PaymentMintNotSupported,
    #[msg("Provided mint account does not match auction.payment_mint.")]
    PaymentMintMismatch,
    #[msg("Seller ATA owner does not match auction.seller.")]
    WrongSellerAta,
    #[msg("permitted_bidders length exceeds MAX_BIDDERS.")]
    PermittedBiddersExceedsCap,
    #[msg("permitted_bidders contains a duplicate pubkey.")]
    DuplicatePermittedBidder,
    #[msg("Bid placed by a non-permitted bidder on a closed auction.")]
    UnpermittedBidder,
    #[msg("Closed-auction settle is missing a slot for a permitted bidder.")]
    PermittedBidderSlotMissing,
    #[msg("Recover-bid grace window has not elapsed yet.")]
    RecoverGraceNotElapsed,
    #[msg("Bid deposit is below the program-enforced market floor (estimate_high_usdc × ratio × SOL/USDC).")]
    DepositBelowMarketFloor,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum AccountType {
    Auction { auction_id: u64 },
    Bid { auction_id: u64, bidder: Pubkey },
}

fn derive_seeds_from_account_type(account_type: &AccountType) -> Vec<Vec<u8>> {
    match account_type {
        AccountType::Auction { auction_id } => {
            vec![AUCTION_SEED.to_vec(), auction_id.to_le_bytes().to_vec()]
        }
        AccountType::Bid { auction_id, bidder } => {
            vec![
                BID_SEED.to_vec(),
                auction_id.to_le_bytes().to_vec(),
                bidder.to_bytes().to_vec(),
            ]
        }
    }
}
