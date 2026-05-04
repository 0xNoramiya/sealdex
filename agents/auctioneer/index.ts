// Auctioneer agent — reads seed-inventory.json and posts each lot as an auction.
// Persists the resulting auction IDs to scripts/auction-registry.json for the
// bidder/escrow agents to pick up.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import {
  createAuction,
  endTimeFromNow,
  type CreateAuctionOutput,
} from "../../mcp-server/src/ops.js";
import { atomicWriteJsonSync } from "../../mcp-server/src/atomic-write.js";
import {
  signRegistryEntry,
  type RegistryEntryUnsigned,
} from "../../mcp-server/src/registry-sign.js";
import { getLogger } from "../../mcp-server/src/logger.js";
import { captureException } from "../../mcp-server/src/sentry.js";
import { computeBidDepositLamports } from "../../mcp-server/src/deposit-sizing.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const STATE_DIR = process.env.SEALDEX_STATE_DIR
  ? resolve(process.env.SEALDEX_STATE_DIR)
  : resolve(ROOT, "scripts");
const INVENTORY_PATH =
  process.env.SEALDEX_INVENTORY_PATH ||
  resolve(ROOT, "scripts/seed-inventory.json");
const SELLER =
  process.env.SEALDEX_SELLER_KEYPAIR || resolve(ROOT, ".keys/seller.json");
const PAYMENT_MINT =
  process.env.SEALDEX_PAYMENT_MINT || "11111111111111111111111111111111";
const KEYS_DIR = process.env.SEALDEX_KEYS_DIR
  ? resolve(process.env.SEALDEX_KEYS_DIR)
  : resolve(ROOT, ".keys");

interface Lot {
  lot_id: number;
  lot_metadata: Record<string, any>;
  duration_seconds: number;
}

interface RegistryEntry {
  auctionId: string;
  auctionPda: string;
  lot: Lot;
  endTimeUnix: number;
  signature: string;
  feed_signature?: string;
  feed_pubkey?: string;
  feed_version?: 1;
}

async function main() {
  const log = getLogger("auctioneer");
  const registryPath = resolve(STATE_DIR, "auction-registry.json");
  const inventory: Lot[] = JSON.parse(readFileSync(INVENTORY_PATH, "utf8"));

  // Load any pre-existing registry so we can append, not overwrite.
  let registry: RegistryEntry[] = [];
  try {
    registry = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch {
    /* fresh */
  }

  // Auctioneer signs every published entry with the seller keypair so
  // bidders can verify the feed wasn't tampered with in transit. The
  // public key is derived directly from the secret key — bidders that
  // care about provenance should pin this pubkey out-of-band (AGENTS.md
  // documents the canonical demo publisher).
  const sellerSecret = Uint8Array.from(JSON.parse(readFileSync(SELLER, "utf8")));
  const sellerKeypair = Keypair.fromSecretKey(sellerSecret);
  log.info("auctioneer starting", {
    publisher: sellerKeypair.publicKey.toBase58(),
    inventoryPath: INVENTORY_PATH,
    registryPath,
    inventorySize: inventory.length,
  });

  // Add bidder pubkeys (if their keypairs exist) to the auction permission so
  // they can read the auction PDA via TEE auth.
  const bidderPaths = ["bidder1.json", "bidder2.json"]
    .map((f) => resolve(KEYS_DIR, f));
  const permittedMembers: string[] = [];
  for (const p of bidderPaths) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      permittedMembers.push(
        Keypair.fromSecretKey(Uint8Array.from(raw)).publicKey.toBase58()
      );
    } catch {
      /* keypair missing — skip */
    }
  }

  for (const lot of inventory) {
    const auctionId = String(Date.now() + lot.lot_id);
    const endTimeUnix = await endTimeFromNow(lot.duration_seconds);
    const lotUri = `data:application/json;base64,${Buffer.from(
      JSON.stringify(lot.lot_metadata)
    ).toString("base64")}`;
    if (lotUri.length > 200) {
      log.warn("lot metadata URI exceeds 200-char cap; truncating", {
        lotId: lot.lot_id,
        uriLength: lotUri.length,
      });
    }
    // Auto-size the deposit so DoS cost scales with lot value. Lots
    // without a numeric estimate_high_usdc fall back to the program
    // floor (0.01 SOL).
    const estimateHigh =
      typeof lot.lot_metadata.estimate_high_usdc === "number"
        ? lot.lot_metadata.estimate_high_usdc
        : undefined;
    const bidDepositLamports = computeBidDepositLamports({
      estimateHighUsdc: estimateHigh,
    }).toString();

    let result: CreateAuctionOutput;
    try {
      result = await createAuction({
        auctionId,
        lotMetadataUri: lotUri.slice(0, 200),
        paymentMint: PAYMENT_MINT,
        endTimeUnix,
        sellerKeypairPath: SELLER,
        permittedMembers,
        bidDepositLamports,
        estimateHighUsdc: estimateHigh,
      });
    } catch (err) {
      log.error("createAuction failed for lot", {
        lotId: lot.lot_id,
        title: lot.lot_metadata.title,
        err,
      });
      captureException(err, {
        op: "auctioneer.createAuction",
        lotId: lot.lot_id,
      });
      throw err;
    }
    log.info("auction posted", {
      lotId: lot.lot_id,
      title: lot.lot_metadata.title,
      auctionId,
      auctionPda: result.auctionPda,
      endTimeUnix,
      signature: result.signature,
      estimateHighUsdc: estimateHigh ?? null,
      bidDepositLamports,
    });
    const unsigned: RegistryEntryUnsigned = {
      auctionId,
      auctionPda: result.auctionPda,
      lot: lot as unknown as Record<string, unknown>,
      endTimeUnix,
      signature: result.signature,
    };
    registry.push(
      signRegistryEntry(unsigned, sellerSecret) as unknown as RegistryEntry
    );
  }

  atomicWriteJsonSync(registryPath, registry);
  log.info("registry written", { count: registry.length, path: registryPath });
}

main().catch((e) => {
  const log = getLogger("auctioneer");
  log.fatal("auctioneer fatal", { err: e });
  captureException(e, { op: "auctioneer.main" });
  process.exit(1);
});
