// Anchor program + connection helpers shared by ops and the MCP server.
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import nacl from "tweetnacl";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";

import idlJson from "../../target/idl/sealdex_auction.json" with { type: "json" };

export const PROGRAM_ID = new PublicKey(
  process.env.SEALDEX_PROGRAM_ID || "4DBEkkdMaW7boAsmEFXLMbEiSnVj1xYQUndWYGzPwEMJ"
);
export const TEE_VALIDATOR = new PublicKey(
  process.env.TEE_VALIDATOR_PUBKEY || "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo"
);
export const BASE_RPC =
  process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
export const TEE_RPC =
  process.env.EPHEMERAL_RPC_URL || "https://devnet-tee.magicblock.app";
export const TEE_WS = TEE_RPC.replace(/^http/, "ws");

export const AUCTION_SEED = Buffer.from("auction");
export const BID_SEED = Buffer.from("bid");

export type Idl = anchor.Idl;
export const IDL = idlJson as unknown as Idl;

export function loadKeypair(path: string): Keypair {
  const expanded = path.startsWith("~/")
    ? resolve(process.env.HOME || "", path.slice(2))
    : path;
  const raw = JSON.parse(readFileSync(expanded, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function baseConnection(): Connection {
  return new Connection(BASE_RPC, { commitment: "confirmed" });
}

/** TEE provider — must include a valid auth token for the wallet. */
export async function teeProvider(
  payer: Keypair
): Promise<anchor.AnchorProvider> {
  const tok = await getAuthToken(TEE_RPC, payer.publicKey, (msg: Uint8Array) =>
    Promise.resolve(nacl.sign.detached(msg, payer.secretKey))
  );
  const conn = new Connection(`${TEE_RPC}?token=${tok.token}`, {
    commitment: "confirmed",
    wsEndpoint: `${TEE_WS}?token=${tok.token}`,
  });
  return new anchor.AnchorProvider(conn, new anchor.Wallet(payer), {
    commitment: "confirmed",
  });
}

export function baseProvider(payer: Keypair): anchor.AnchorProvider {
  return new anchor.AnchorProvider(baseConnection(), new anchor.Wallet(payer), {
    commitment: "confirmed",
  });
}

export function programFor(provider: anchor.AnchorProvider): anchor.Program {
  return new anchor.Program(IDL, provider);
}

export function auctionPda(auctionId: anchor.BN): PublicKey {
  return PublicKey.findProgramAddressSync(
    [AUCTION_SEED, auctionId.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID
  )[0];
}

export function bidPda(auctionId: anchor.BN, bidder: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [BID_SEED, auctionId.toArrayLike(Buffer, "le", 8), bidder.toBuffer()],
    PROGRAM_ID
  )[0];
}

/** Fetch the current cluster unix time (used to avoid local clock skew). */
export async function clusterUnixTime(): Promise<number> {
  const conn = baseConnection();
  const slot = await conn.getSlot();
  const t = await conn.getBlockTime(slot);
  if (!t) throw new Error("getBlockTime returned null");
  return t;
}
