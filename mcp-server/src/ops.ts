// Core operations exposed to agents (direct import) and via MCP (stdio).
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import BN from "bn.js";
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

export interface CreateAuctionInput {
  auctionId: string; // bigint as decimal string
  lotMetadataUri: string;
  paymentMint: string; // base58 pubkey (PublicKey.default ok)
  endTimeUnix: number;
  sellerKeypairPath: string;
  /** Pubkeys allowed to read/write the auction PDA on TEE. */
  permittedMembers?: string[];
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

  const createIx = await program.methods
    .createAuction(
      auctionId,
      input.lotMetadataUri,
      new PublicKey(input.paymentMint),
      new BN(input.endTimeUnix)
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
  const sig = await sendAndConfirmTransaction(provider.connection, tx, [seller], {
    skipPreflight: true,
    commitment: "confirmed",
  });
  await waitUntilPermissionActive(TEE_RPC, aPda);

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

  const placeIx = await program.methods
    .placeBid(auctionId, new BN(input.amount))
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
  const sig = await sendAndConfirmTransaction(provider.connection, tx, [bidder], {
    skipPreflight: true,
    commitment: "confirmed",
  });
  await waitUntilPermissionActive(TEE_RPC, bPda);

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
  status: "Open" | "Settled" | "Claimed" | "Unknown";
  winner: string | null;
  winningBid: string | null;
}

function decodeStatus(s: any): AuctionView["status"] {
  if (s?.open !== undefined) return "Open";
  if (s?.settled !== undefined) return "Settled";
  if (s?.claimed !== undefined) return "Claimed";
  return "Unknown";
}

/** Get a single auction by ID (reads from base Solana). */
export async function getAuctionState(
  auctionId: string
): Promise<AuctionView | null> {
  const id = new BN(auctionId);
  const aPda = auctionPda(id);
  const conn = baseConnection();
  const info = await conn.getAccountInfo(aPda);
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
    .remainingAccounts(
      bidPdas.map((p) => ({ pubkey: p, isSigner: false, isWritable: false }))
    )
    .transaction();
  tx.feePayer = payer.publicKey;
  const sig = await sendAndConfirmTransaction(provider.connection, tx, [payer], {
    skipPreflight: true,
    commitment: "confirmed",
  });

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
}> {
  const winner = loadKeypair(input.winnerKeypairPath);
  const provider = baseProvider(winner);
  const program = programFor(provider);
  const auctionId = new BN(input.auctionId);
  const aPda = auctionPda(auctionId);

  const tx = await program.methods
    .claimLot()
    .accounts({
      // @ts-ignore
      auction: aPda,
      winner: winner.publicKey,
    })
    .transaction();
  tx.feePayer = winner.publicKey;
  const sig = await sendAndConfirmTransaction(provider.connection, tx, [winner], {
    skipPreflight: true,
    commitment: "confirmed",
  });
  return { signature: sig };
}

/** Build an end_time relative to the current cluster clock (avoids local skew). */
export async function endTimeFromNow(seconds: number): Promise<number> {
  const ct = await clusterUnixTime();
  return ct + seconds;
}
