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
  const idlPath = path.resolve(
    process.cwd(),
    "..",
    "target/idl/sealdex_auction.json"
  );
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

export type AuctionStatus = "Open" | "Settled" | "Claimed" | "Unknown";
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
}

function decodeStatus(s: any): AuctionStatus {
  if (s?.open !== undefined) return "Open";
  if (s?.settled !== undefined) return "Settled";
  if (s?.claimed !== undefined) return "Claimed";
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
  const a: any = coder().decode("auction", info.data);
  return {
    auctionId: (a.auctionId as BN).toString(),
    auctionPda: pda.toBase58(),
    seller: (a.seller as PublicKey).toBase58(),
    lotMetadataUri: a.lotMetadataUri,
    paymentMint: (a.paymentMint as PublicKey).toBase58(),
    endTimeUnix: (a.endTime as BN).toNumber(),
    status: decodeStatus(a.status),
    winner: a.winner ? (a.winner as PublicKey).toBase58() : null,
    winningBidNative: a.winningBid ? (a.winningBid as BN).toString() : null,
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
