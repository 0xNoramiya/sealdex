import { Connection, PublicKey } from "@solana/web3.js";
import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import { readFileSync } from "node:fs";
import path from "node:path";

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID_STR =
  process.env.SEALDEX_PROGRAM_ID ||
  "4DBEkkdMaW7boAsmEFXLMbEiSnVj1xYQUndWYGzPwEMJ";
export const PROGRAM_ID = new PublicKey(PROGRAM_ID_STR);

const AUCTION_SEED = Buffer.from("auction");
const BID_SEED = Buffer.from("bid");

let cachedCoder: BorshAccountsCoder | null = null;
function coder(): BorshAccountsCoder {
  if (cachedCoder) return cachedCoder;
  const idlPath =
    process.env.SEALDEX_IDL_PATH ||
    path.resolve(process.cwd(), "..", "target/idl/sealdex_auction.json");
  const idl = JSON.parse(readFileSync(idlPath, "utf8")) as Idl;
  cachedCoder = new BorshAccountsCoder(idl);
  return cachedCoder;
}

export function auctionPda(auctionId: string | BN): PublicKey {
  const id = BN.isBN(auctionId) ? (auctionId as BN) : new BN(auctionId);
  return PublicKey.findProgramAddressSync(
    [AUCTION_SEED, id.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID
  )[0];
}

export function bidPda(
  auctionId: string | BN,
  bidder: PublicKey | string
): PublicKey {
  const id = BN.isBN(auctionId) ? (auctionId as BN) : new BN(auctionId);
  const b = typeof bidder === "string" ? new PublicKey(bidder) : bidder;
  return PublicKey.findProgramAddressSync(
    [BID_SEED, id.toArrayLike(Buffer, "le", 8), b.toBuffer()],
    PROGRAM_ID
  )[0];
}

export type AuctionStatus =
  | "Open"
  | "Settled"
  | "Claimed"
  | "Slashed"
  | "Unknown";
export type AuctionKind = "FirstPrice" | "SecondPrice" | "Unknown";
export interface AuctionView {
  auctionId: string;
  auctionPda: string;
  seller: string;
  lotMetadataUri: string;
  paymentMint: string;
  endTimeUnix: number;
  status: AuctionStatus;
  winner: string | null;
  winningBidNative: string | null; // u64 native units (e.g. micro-USDC)
  bidDepositLamports: string;
  claimGraceSeconds: number;
  kind: AuctionKind;
}

function decodeKind(k: any): AuctionKind {
  if (k?.FirstPrice !== undefined || k?.firstPrice !== undefined)
    return "FirstPrice";
  if (k?.SecondPrice !== undefined || k?.secondPrice !== undefined)
    return "SecondPrice";
  return "Unknown";
}

function decodeStatus(s: any): AuctionStatus {
  // BorshAccountsCoder emits variants as PascalCase keys (Open / Settled /
  // Claimed / Slashed). Some Anchor codepaths also emit lowercase, so
  // accept both.
  if (s?.Open !== undefined || s?.open !== undefined) return "Open";
  if (s?.Settled !== undefined || s?.settled !== undefined) return "Settled";
  if (s?.Claimed !== undefined || s?.claimed !== undefined) return "Claimed";
  if (s?.Slashed !== undefined || s?.slashed !== undefined) return "Slashed";
  return "Unknown";
}

let cachedConnection: Connection | null = null;
function connection(): Connection {
  if (cachedConnection) return cachedConnection;
  cachedConnection = new Connection(RPC_URL, { commitment: "confirmed" });
  return cachedConnection;
}

export async function readAuction(
  auctionId: string
): Promise<AuctionView | null> {
  const pda = auctionPda(auctionId);
  const info = await connection().getAccountInfo(pda);
  if (!info) return null;
  const a: any = coder().decode("Auction", info.data);
  // BorshAccountsCoder returns IDL field names verbatim (snake_case here).
  // Tolerate both cases so this stays robust if someone swaps in
  // Program.coder.accounts.decode later.
  const auctionIdField = a.auction_id ?? a.auctionId;
  const lotUriField = a.lot_metadata_uri ?? a.lotMetadataUri;
  const paymentMintField = a.payment_mint ?? a.paymentMint;
  const endTimeField = a.end_time ?? a.endTime;
  const winningBidField = a.winning_bid ?? a.winningBid;
  const depositField = a.bid_deposit_lamports ?? a.bidDepositLamports;
  const graceField = a.claim_grace_seconds ?? a.claimGraceSeconds;
  return {
    auctionId: (auctionIdField as BN).toString(),
    auctionPda: pda.toBase58(),
    seller: (a.seller as PublicKey).toBase58(),
    lotMetadataUri: lotUriField,
    paymentMint: (paymentMintField as PublicKey).toBase58(),
    endTimeUnix: (endTimeField as BN).toNumber(),
    status: decodeStatus(a.status),
    winner: a.winner ? (a.winner as PublicKey).toBase58() : null,
    winningBidNative: winningBidField ? (winningBidField as BN).toString() : null,
    bidDepositLamports: depositField ? (depositField as BN).toString() : "0",
    claimGraceSeconds: graceField ? (graceField as BN).toNumber() : 0,
    kind: decodeKind(a.kind),
  };
}

/** Returns the cluster's unix timestamp via getBlockTime. Used so the UI
 * can compute time-left without local clock skew. */
export async function clusterUnixTime(): Promise<number> {
  const conn = connection();
  const slot = await conn.getSlot();
  const t = await conn.getBlockTime(slot);
  if (!t) throw new Error("getBlockTime returned null");
  return t;
}
