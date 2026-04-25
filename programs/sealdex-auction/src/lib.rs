use anchor_lang::prelude::*;
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
pub const MAX_BIDDERS: usize = 5;
pub const MAX_METADATA_URI_LEN: usize = 200;

#[ephemeral]
#[program]
pub mod sealdex_auction {
    use super::*;

    // 1️⃣ Seller creates an auction
    pub fn create_auction(
        ctx: Context<CreateAuction>,
        auction_id: u64,
        lot_metadata_uri: String,
        payment_mint: Pubkey,
        end_time: i64,
    ) -> Result<()> {
        require!(
            lot_metadata_uri.len() <= MAX_METADATA_URI_LEN,
            AuctionError::MetadataTooLong
        );
        let now = Clock::get()?.unix_timestamp;
        require!(end_time > now, AuctionError::EndTimeInPast);

        let auction = &mut ctx.accounts.auction;
        auction.auction_id = auction_id;
        auction.seller = ctx.accounts.seller.key();
        auction.lot_metadata_uri = lot_metadata_uri;
        auction.payment_mint = payment_mint;
        auction.end_time = end_time;
        auction.status = AuctionStatus::Open;
        auction.winner = None;
        auction.winning_bid = None;

        msg!("Auction {} created by {}", auction_id, auction.seller);
        Ok(())
    }

    // 2️⃣ Bidder places a sealed bid (auction account NOT referenced — it's delegated to TEE).
    // settle_auction enforces that bid.timestamp <= auction.end_time, so late bids don't count.
    pub fn place_bid(ctx: Context<PlaceBid>, auction_id: u64, amount: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let bidder_key = ctx.accounts.bidder.key();

        let bid = &mut ctx.accounts.bid;
        bid.auction_id = auction_id;
        bid.bidder = bidder_key;
        bid.amount = amount;
        bid.timestamp = now;

        msg!("Bid placed by {} on auction {}", bidder_key, auction_id);
        Ok(())
    }

    // 3️⃣ Settle the auction inside the TEE: find max bid, commit & undelegate
    pub fn settle_auction<'info>(
        ctx: Context<'_, '_, 'info, 'info, SettleAuction<'info>>,
    ) -> Result<()> {
        let auction = &mut ctx.accounts.auction;
        let now = Clock::get()?.unix_timestamp;
        require!(now >= auction.end_time, AuctionError::AuctionNotEnded);
        require!(
            auction.status == AuctionStatus::Open,
            AuctionError::AuctionClosed
        );

        require!(
            ctx.remaining_accounts.len() <= MAX_BIDDERS,
            AuctionError::BidderCapReached
        );

        let mut highest_amount: u64 = 0;
        let mut highest_bidder: Option<Pubkey> = None;
        let mut seen_bidders: Vec<Pubkey> = Vec::with_capacity(MAX_BIDDERS);

        for ai in ctx.remaining_accounts.iter() {
            let bid_account: Account<Bid> = Account::try_from(ai)?;
            require!(
                bid_account.auction_id == auction.auction_id,
                AuctionError::WrongAuctionForBid
            );
            // Reject late bids whose on-chain timestamp is after end_time.
            require!(
                bid_account.timestamp <= auction.end_time,
                AuctionError::AuctionEnded
            );
            // Reject duplicates.
            require!(
                !seen_bidders.contains(&bid_account.bidder),
                AuctionError::AlreadyBid
            );
            seen_bidders.push(bid_account.bidder);

            let (expected_pda, _) = Pubkey::find_program_address(
                &[
                    BID_SEED,
                    &auction.auction_id.to_le_bytes(),
                    bid_account.bidder.as_ref(),
                ],
                &crate::ID,
            );
            require!(ai.key() == expected_pda, AuctionError::WrongAuctionForBid);

            if bid_account.amount > highest_amount {
                highest_amount = bid_account.amount;
                highest_bidder = Some(bid_account.bidder);
            }
        }

        auction.winner = highest_bidder;
        auction.winning_bid = highest_bidder.map(|_| highest_amount);
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
            "Auction {} settled. Winner: {:?} amount {}",
            auction.auction_id,
            auction.winner,
            highest_amount
        );

        auction.exit(&crate::ID)?;

        commit_and_undelegate_accounts(
            &ctx.accounts.payer,
            vec![&auction.to_account_info()],
            magic_context,
            magic_program,
            None,
        )?;

        Ok(())
    }

    // 4️⃣ Winner claims the lot — emits LotClaimed for the escrow agent
    pub fn claim_lot(ctx: Context<ClaimLot>) -> Result<()> {
        let auction = &mut ctx.accounts.auction;
        require!(
            auction.status == AuctionStatus::Settled,
            AuctionError::NotSettled
        );
        let winner = auction.winner.ok_or(AuctionError::NoWinner)?;
        require!(
            ctx.accounts.winner.key() == winner,
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
    #[account(
        init_if_needed,
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
    #[account(mut)]
    pub winner: Signer<'info>,
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
}

impl Auction {
    pub const LEN: usize = 8                                 // auction_id
        + 32                                                  // seller
        + 4 + MAX_METADATA_URI_LEN                            // String len + bytes
        + 32                                                  // payment_mint
        + 8                                                   // end_time
        + 1                                                   // status (3 unit variants)
        + 1 + 32                                              // Option<Pubkey> winner
        + 1 + 8;                                              // Option<u64> winning_bid
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub enum AuctionStatus {
    Open,
    Settled,
    Claimed,
}

#[account]
pub struct Bid {
    pub auction_id: u64,
    pub bidder: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}
impl Bid {
    pub const LEN: usize = 8 + 32 + 8 + 8;
}

#[event]
pub struct LotClaimed {
    pub auction_id: u64,
    pub winner: Pubkey,
    pub seller: Pubkey,
    pub amount: u64,
    pub payment_mint: Pubkey,
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
    #[msg("Auction has no winner.")]
    NoWinner,
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
