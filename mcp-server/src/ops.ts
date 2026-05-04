// Core operations exposed to agents (direct import) and via MCP (stdio).
import * as anchor from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";
import { retry } from "./retry.js";

// settle_auction's per-iteration cost (deserialize + PDA derive + duplicate
// scan) scales linearly with bidder count. Empirically ~12K CU per bid plus
// fixed permission/CPI overhead. At MAX_BIDDERS=20 we measured ~260K CU; we
// request 500K to leave headroom for future field additions and TEE jitter.
// This is well under Solana's 1.4M per-tx ceiling.
const SETTLE_CU_LIMIT = 500_000;
import {
  AUTHORITY_FLAG,
  TX_LOGS_FLAG,
  type Member,
  createDelegatePermissionInstruction,
  permissionPdaFromAccount,
  waitUntilPermissionActive,
} from "@magicblock-labs/ephemeral-rollups-sdk";

import {
  auctionPda,
  baseConnection,
  baseProvider,
  bidPda,
  clusterUnixTime,
  loadKeypair,
  PROGRAM_ID,
  programFor,
  TEE_RPC,
  TEE_VALIDATOR,
  teeProvider,
} from "./client.js";

// Anti-spam deposit floor + winner-claim window. The on-chain program
// enforces these against `MIN_BID_DEPOSIT_LAMPORTS` / claim grace bounds;
// keep these values in sync with `programs/sealdex-auction/src/lib.rs`.
export const MIN_BID_DEPOSIT_LAMPORTS = 10_000_000n; // 0.01 SOL
export const DEFAULT_CLAIM_GRACE_SECONDS = 60 * 60; // 1 hour

export type AuctionKind = "FirstPrice" | "SecondPrice";

export interface CreateAuctionInput {
  auctionId: string; // bigint as decimal string
  lotMetadataUri: string;
  paymentMint: string; // base58 pubkey (PublicKey.default ok)
  endTimeUnix: number;
  sellerKeypairPath: string;
  /** Pubkeys allowed to read/write the auction PDA on TEE. */
  permittedMembers?: string[];
  /** Required deposit per bid in lamports. Defaults to MIN_BID_DEPOSIT_LAMPORTS. */
  bidDepositLamports?: string;
  /** Seconds the winner has to claim before they can be slashed. */
  claimGraceSeconds?: number;
  /** First-price (default) or Vickrey second-price settlement. */
  kind?: AuctionKind;
  /**
   * Closed-auction allowlist. When non-empty, settle rejects bids from
   * any bidder not in this list. Empty/omitted = open auction (anyone
   * can bid). Capped at the program's MAX_BIDDERS.
   */
  permittedBidders?: string[];
  /**
   * Lot's high estimate in whole USDC. Drives the program-enforced
   * deposit floor: bid_deposit_lamports must be at least
   * `estimate_high_usdc × BID_DEPOSIT_RATIO_BPS × FIXED_LAMPORTS_PER_USDC / 10_000`.
   * Pass 0 to opt out (only the hard MIN_BID_DEPOSIT_LAMPORTS floor
   * applies); on the demo, the auctioneer agent forwards
   * `lot.estimate_high_usdc` automatically.
   */
  estimateHighUsdc?: number;
  /**
   * Auction floor in bid native units (matches winning_bid). settle
   * declares no winner if no bid >= reserve. Vickrey lifts second-
   * price to reserve when only the highest meets reserve. Pass "0"
   * (or omit) for no reserve. Decimal string so the full u64 range is
   * representable across the JSON boundary.
   */
  reservePrice?: string;
}

export interface CreateAuctionOutput {
  signature: string;
  auctionPda: string;
  permissionPda: string;
}

export async function createAuction(
  input: CreateAuctionInput
): Promise<CreateAuctionOutput> {
  const seller = loadKeypair(input.sellerKeypairPath);
  const provider = baseProvider(seller);
  const program = programFor(provider);
  const auctionId = new BN(input.auctionId);
  const aPda = auctionPda(auctionId);
  const permPda = permissionPdaFromAccount(aPda);

  const members: Member[] = [
    seller.publicKey.toBase58(),
    ...(input.permittedMembers ?? []),
  ].map((pk) => ({
    flags: AUTHORITY_FLAG | TX_LOGS_FLAG,
    pubkey: new PublicKey(pk),
  }));

  const depositLamports = new BN(
    (input.bidDepositLamports ?? MIN_BID_DEPOSIT_LAMPORTS.toString()).toString()
  );
  const claimGrace = new BN(
    input.claimGraceSeconds ?? DEFAULT_CLAIM_GRACE_SECONDS
  );
  const kindArg =
    input.kind === "SecondPrice" ? { secondPrice: {} } : { firstPrice: {} };
  const permittedArg = (input.permittedBidders ?? []).map(
    (pk) => new PublicKey(pk)
  );
  const estimateHighUsdc = new BN(input.estimateHighUsdc ?? 0);
  const reservePrice = new BN((input.reservePrice ?? "0").toString());
  const createIx = await program.methods
    .createAuction(
      auctionId,
      input.lotMetadataUri,
      new PublicKey(input.paymentMint),
      new BN(input.endTimeUnix),
      depositLamports,
      claimGrace,
      kindArg,
      permittedArg,
      estimateHighUsdc,
      reservePrice
    )
    .accounts({
      // @ts-ignore — Anchor typed accounts struct varies by IDL
      auction: aPda,
      seller: seller.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .instruction();

  const createPermIx = await program.methods
    .createPermission({ auction: { auctionId } }, members)
    .accountsPartial({
      payer: seller.publicKey,
      permissionedAccount: aPda,
      permission: permPda,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .instruction();

  const delegatePermIx = createDelegatePermissionInstruction({
    payer: seller.publicKey,
    validator: TEE_VALIDATOR,
    permissionedAccount: [aPda, false],
    authority: [seller.publicKey, true],
  });

  const delegateAuctionIx = await program.methods
    .delegatePda({ auction: { auctionId } })
    .accounts({
      payer: seller.publicKey,
      validator: TEE_VALIDATOR,
      pda: aPda,
    })
    .instruction();

  const tx = new Transaction().add(
    createIx,
    createPermIx,
    delegatePermIx,
    delegateAuctionIx
  );
  tx.feePayer = seller.publicKey;
  const sig = await retry(
    () =>
      sendAndConfirmTransaction(provider.connection, tx, [seller], {
        skipPreflight: true,
        commitment: "confirmed",
      }),
    { label: "create_auction:send" }
  );
  await retry(() => waitUntilPermissionActive(TEE_RPC, aPda), {
    label: "create_auction:permission",
  });

  return {
    signature: sig,
    auctionPda: aPda.toBase58(),
    permissionPda: permPda.toBase58(),
  };
}

export interface PlaceBidInput {
  auctionId: string;
  amount: string; // u64 as decimal string
  bidderKeypairPath: string;
  /** Lamports to deposit alongside the bid; must be >= MIN_BID_DEPOSIT_LAMPORTS. */
  depositLamports?: string;
}

export interface PlaceBidOutput {
  signature: string;
  bidPda: string;
  permissionPda: string;
}

export async function placeBid(input: PlaceBidInput): Promise<PlaceBidOutput> {
  const bidder = loadKeypair(input.bidderKeypairPath);
  const provider = baseProvider(bidder);
  const program = programFor(provider);
  const auctionId = new BN(input.auctionId);
  const bPda = bidPda(auctionId, bidder.publicKey);
  const permPda = permissionPdaFromAccount(bPda);

  const deposit = new BN(
    (input.depositLamports ?? MIN_BID_DEPOSIT_LAMPORTS.toString()).toString()
  );
  const placeIx = await program.methods
    .placeBid(auctionId, new BN(input.amount), deposit)
    .accounts({
      // @ts-ignore
      bid: bPda,
      bidder: bidder.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .instruction();

  const members: Member[] = [
    { flags: AUTHORITY_FLAG | TX_LOGS_FLAG, pubkey: bidder.publicKey },
  ];
  const createPermIx = await program.methods
    .createPermission(
      { bid: { auctionId, bidder: bidder.publicKey } },
      members
    )
    .accountsPartial({
      payer: bidder.publicKey,
      permissionedAccount: bPda,
      permission: permPda,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .instruction();

  const delegatePermIx = createDelegatePermissionInstruction({
    payer: bidder.publicKey,
    validator: TEE_VALIDATOR,
    permissionedAccount: [bPda, false],
    authority: [bidder.publicKey, true],
  });

  const delegateBidIx = await program.methods
    .delegatePda({ bid: { auctionId, bidder: bidder.publicKey } })
    .accounts({
      payer: bidder.publicKey,
      validator: TEE_VALIDATOR,
      pda: bPda,
    })
    .instruction();

  const tx = new Transaction().add(
    placeIx,
    createPermIx,
    delegatePermIx,
    delegateBidIx
  );
  tx.feePayer = bidder.publicKey;
  const sig = await retry(
    () =>
      sendAndConfirmTransaction(provider.connection, tx, [bidder], {
        skipPreflight: true,
        commitment: "confirmed",
      }),
    { label: "place_bid:send" }
  );
  await retry(() => waitUntilPermissionActive(TEE_RPC, bPda), {
    label: "place_bid:permission",
  });

  return {
    signature: sig,
    bidPda: bPda.toBase58(),
    permissionPda: permPda.toBase58(),
  };
}

export interface AuctionView {
  auctionId: string;
  auctionPda: string;
  seller: string;
  lotMetadataUri: string;
  paymentMint: string;
  endTimeUnix: number;
  status: "Open" | "Settled" | "Claimed" | "Slashed" | "Unknown";
  winner: string | null;
  winningBid: string | null;
  bidDepositLamports: string;
  claimGraceSeconds: number;
  kind: AuctionKind | "Unknown";
}

function decodeAuctionKind(k: any): AuctionKind | "Unknown" {
  if (k?.firstPrice !== undefined) return "FirstPrice";
  if (k?.secondPrice !== undefined) return "SecondPrice";
  return "Unknown";
}

function decodeStatus(s: any): AuctionView["status"] {
  if (s?.open !== undefined) return "Open";
  if (s?.settled !== undefined) return "Settled";
  if (s?.claimed !== undefined) return "Claimed";
  if (s?.slashed !== undefined) return "Slashed";
  return "Unknown";
}

/** Get a single auction by ID (reads from base Solana). */
export async function getAuctionState(
  auctionId: string
): Promise<AuctionView | null> {
  const id = new BN(auctionId);
  const aPda = auctionPda(id);
  const conn = baseConnection();
  const info = await retry(() => conn.getAccountInfo(aPda), {
    label: "get_auction_state",
  });
  if (!info) return null;
  const provider = new anchor.AnchorProvider(
    conn,
    new anchor.Wallet(anchor.web3.Keypair.generate()),
    { commitment: "confirmed" }
  );
  const program = programFor(provider);
  const a: any = program.coder.accounts.decode("auction", info.data);
  return {
    auctionId: a.auctionId.toString(),
    auctionPda: aPda.toBase58(),
    seller: a.seller.toBase58(),
    lotMetadataUri: a.lotMetadataUri,
    paymentMint: a.paymentMint.toBase58(),
    endTimeUnix: a.endTime.toNumber(),
    status: decodeStatus(a.status),
    winner: a.winner ? a.winner.toBase58() : null,
    winningBid: a.winningBid ? a.winningBid.toString() : null,
    bidDepositLamports: a.bidDepositLamports?.toString?.() ?? "0",
    claimGraceSeconds: a.claimGraceSeconds?.toNumber?.() ?? 0,
    kind: decodeAuctionKind(a.kind),
  };
}

/**
 * Look up multiple auctions by ID. Active (delegated) auctions return null
 * from base layer because their on-base owner becomes the delegation program;
 * settled/claimed auctions return their committed state.
 *
 * For agents that need to see in-flight auctions, fetch them from TEE with
 * an authed connection — but for placing bids agents only need IDs, which
 * the auctioneer publishes via the registry JSON file.
 */
export async function getAuctionsByIds(
  auctionIds: string[]
): Promise<Array<AuctionView | { auctionId: string; status: "InFlight" }>> {
  const out: Array<AuctionView | { auctionId: string; status: "InFlight" }> = [];
  for (const id of auctionIds) {
    const v = await getAuctionState(id);
    out.push(v ?? { auctionId: id, status: "InFlight" });
  }
  return out;
}

export interface SettleAuctionInput {
  auctionId: string;
  payerKeypairPath: string;
  bidderPubkeys: string[]; // off-chain knowledge of who bid
}

export async function settleAuction(input: SettleAuctionInput): Promise<{
  signature: string;
  winner: string | null;
  winningBid: string | null;
}> {
  const payer = loadKeypair(input.payerKeypairPath);
  const provider = await teeProvider(payer);
  const program = programFor(provider);
  const auctionId = new BN(input.auctionId);
  const aPda = auctionPda(auctionId);
  const permPda = permissionPdaFromAccount(aPda);
  const bidPdas = input.bidderPubkeys.map((pk) =>
    bidPda(auctionId, new PublicKey(pk))
  );

  const tx = await program.methods
    .settleAuction()
    .accounts({
      // @ts-ignore
      auction: aPda,
      permissionAuction: permPda,
      payer: payer.publicKey,
    })
    // Bid PDAs must be writable: settle_auction zeros loser amounts and
    // commits + undelegates them so bidders can claw back deposits.
    .remainingAccounts(
      bidPdas.map((p) => ({ pubkey: p, isSigner: false, isWritable: true }))
    )
    .preInstructions([
      // Lift the per-tx CU limit so settle can fit the full MAX_BIDDERS=20
      // workload. Default 200K is enough for 5 bids, not 20.
      ComputeBudgetProgram.setComputeUnitLimit({ units: SETTLE_CU_LIMIT }),
    ])
    .transaction();
  tx.feePayer = payer.publicKey;
  const sig = await retry(
    () =>
      sendAndConfirmTransaction(provider.connection, tx, [payer], {
        skipPreflight: true,
        commitment: "confirmed",
      }),
    { label: "settle_auction:send" }
  );

  // Poll base layer until the committed auction shows status=Settled
  for (let i = 0; i < 20; i++) {
    const view = await getAuctionState(input.auctionId);
    if (view?.status === "Settled") {
      return {
        signature: sig,
        winner: view.winner,
        winningBid: view.winningBid,
      };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { signature: sig, winner: null, winningBid: null };
}

export interface ClaimLotInput {
  auctionId: string;
  winnerKeypairPath: string;
}

export async function claimLot(input: ClaimLotInput): Promise<{
  signature: string;
  variant: "sol" | "spl";
}> {
  const winner = loadKeypair(input.winnerKeypairPath);
  const provider = baseProvider(winner);
  const program = programFor(provider);
  const auctionId = new BN(input.auctionId);
  const aPda = auctionPda(auctionId);

  // Read the auction's stored payment_mint to dispatch — claim_lot for SOL
  // (the existing path), claim_lot_spl for any non-default mint. Surfacing
  // the chosen variant in the return value makes operator-side observability
  // easier ("which transfer happened?").
  const view = await getAuctionState(input.auctionId);
  if (!view) throw new Error(`Auction ${input.auctionId} not on base layer`);
  const paymentMint = new PublicKey(view.paymentMint);
  const isSol = paymentMint.equals(PublicKey.default);

  const bPda = bidPda(auctionId, winner.publicKey);
  let tx;
  if (isSol) {
    tx = await program.methods
      .claimLot()
      .accounts({
        // @ts-ignore
        auction: aPda,
        bid: bPda,
        winner: winner.publicKey,
      })
      .transaction();
  } else {
    const sellerPubkey = new PublicKey(view.seller);
    const winnerAta = getAssociatedTokenAddressSync(paymentMint, winner.publicKey);
    const sellerAta = getAssociatedTokenAddressSync(paymentMint, sellerPubkey);
    tx = await program.methods
      .claimLotSpl()
      .accounts({
        // @ts-ignore
        auction: aPda,
        bid: bPda,
        winner: winner.publicKey,
        mint: paymentMint,
        winnerAta,
        sellerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .transaction();
  }
  tx.feePayer = winner.publicKey;
  const sig = await retry(
    () =>
      sendAndConfirmTransaction(provider.connection, tx, [winner], {
        skipPreflight: true,
        commitment: "confirmed",
      }),
    { label: isSol ? "claim_lot:send" : "claim_lot_spl:send" }
  );
  return { signature: sig, variant: isSol ? "sol" : "spl" };
}

export interface RefundBidInput {
  auctionId: string;
  bidderKeypairPath: string;
}

/**
 * Loser refund — close the bid PDA after settlement and reclaim the deposit.
 * The on-chain handler rejects this for the auction winner; they must use
 * `claimLot` (which also closes the bid) or wait out the slash window.
 */
export async function refundBid(
  input: RefundBidInput
): Promise<{ signature: string }> {
  const bidder = loadKeypair(input.bidderKeypairPath);
  const provider = baseProvider(bidder);
  const program = programFor(provider);
  const auctionId = new BN(input.auctionId);
  const aPda = auctionPda(auctionId);
  const bPda = bidPda(auctionId, bidder.publicKey);

  const tx = await program.methods
    .refundBid()
    .accounts({
      // @ts-ignore
      auction: aPda,
      bid: bPda,
      bidder: bidder.publicKey,
    })
    .transaction();
  tx.feePayer = bidder.publicKey;
  const sig = await retry(
    () =>
      sendAndConfirmTransaction(provider.connection, tx, [bidder], {
        skipPreflight: true,
        commitment: "confirmed",
      }),
    { label: "refund_bid:send" }
  );
  return { signature: sig };
}

export interface RecoverBidInTeeInput {
  auctionId: string;
  bidderKeypairPath: string;
}

/**
 * Stuck-bid liveness fallback. Runs against the TEE RPC: if a bidder
 * placed a sealed bid but settle never ran (or ran without their bid in
 * remaining_accounts), this lets them undelegate their own bid PDA back
 * to base after the program-enforced 7-day grace. The bid amount is
 * zeroed for privacy. Bidder then calls `refundBid` on base to close
 * the PDA and recover the deposit lamports.
 */
export async function recoverBidInTee(
  input: RecoverBidInTeeInput
): Promise<{ signature: string }> {
  const bidder = loadKeypair(input.bidderKeypairPath);
  const provider = await teeProvider(bidder);
  const program = programFor(provider);
  const auctionId = new BN(input.auctionId);
  const bPda = bidPda(auctionId, bidder.publicKey);

  const tx = await program.methods
    .recoverBidInTee()
    .accounts({
      // @ts-ignore
      bid: bPda,
      bidder: bidder.publicKey,
    })
    .transaction();
  tx.feePayer = bidder.publicKey;
  const sig = await retry(
    () =>
      sendAndConfirmTransaction(provider.connection, tx, [bidder], {
        skipPreflight: true,
        commitment: "confirmed",
      }),
    { label: "recover_bid_in_tee:send" }
  );
  return { signature: sig };
}

export interface SlashWinnerInput {
  auctionId: string;
  callerKeypairPath: string;
}

/**
 * Slash a no-show winner — anyone may call once `end_time + claim_grace`
 * has passed. Forfeits the winner's deposit to the seller and marks the
 * auction Slashed. Bid PDA is closed in the same instruction.
 */
export async function slashWinner(
  input: SlashWinnerInput
): Promise<{ signature: string }> {
  const caller = loadKeypair(input.callerKeypairPath);
  const provider = baseProvider(caller);
  const program = programFor(provider);
  const auctionId = new BN(input.auctionId);
  const aPda = auctionPda(auctionId);
  const view = await getAuctionState(input.auctionId);
  if (!view) throw new Error(`Auction ${input.auctionId} not on base layer`);
  if (!view.winner) throw new Error("Auction has no winner to slash");
  const bPda = bidPda(auctionId, new PublicKey(view.winner));

  const tx = await program.methods
    .slashWinner()
    .accounts({
      // @ts-ignore
      auction: aPda,
      bid: bPda,
      seller: new PublicKey(view.seller),
      caller: caller.publicKey,
    })
    .transaction();
  tx.feePayer = caller.publicKey;
  const sig = await retry(
    () =>
      sendAndConfirmTransaction(provider.connection, tx, [caller], {
        skipPreflight: true,
        commitment: "confirmed",
      }),
    { label: "slash_winner:send" }
  );
  return { signature: sig };
}

/** Build an end_time relative to the current cluster clock (avoids local skew). */
export async function endTimeFromNow(seconds: number): Promise<number> {
  const ct = await clusterUnixTime();
  return ct + seconds;
}
