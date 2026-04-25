// Auctioneer agent — reads seed-inventory.json and posts each lot as an auction.
// Persists the resulting auction IDs to scripts/auction-registry.json for the
// bidder/escrow agents to pick up.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAuction,
  endTimeFromNow,
  type CreateAuctionOutput,
} from "../../mcp-server/src/ops.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SELLER =
  process.env.SEALDEX_SELLER_KEYPAIR || resolve(ROOT, ".keys/seller.json");
const PAYMENT_MINT =
  process.env.SEALDEX_PAYMENT_MINT || "11111111111111111111111111111111";

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
}

async function main() {
  const inventoryPath = resolve(ROOT, "scripts/seed-inventory.json");
  const registryPath = resolve(ROOT, "scripts/auction-registry.json");
  const inventory: Lot[] = JSON.parse(readFileSync(inventoryPath, "utf8"));

  // Load any pre-existing registry so we can append, not overwrite.
  let registry: RegistryEntry[] = [];
  try {
    registry = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch {
    /* fresh */
  }

  // Add bidder pubkeys (if their keypairs exist) to the auction permission so
  // they can read the auction PDA via TEE auth.
  const bidderPaths = ["bidder1.json", "bidder2.json"]
    .map((f) => resolve(ROOT, ".keys", f));
  const permittedMembers: string[] = [];
  for (const p of bidderPaths) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      const { Keypair } = await import("@solana/web3.js");
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
      console.warn(
        `⚠ lot ${lot.lot_id} metadata uri ${lotUri.length} chars > 200 cap; truncating`
      );
    }
    const result: CreateAuctionOutput = await createAuction({
      auctionId,
      lotMetadataUri: lotUri.slice(0, 200),
      paymentMint: PAYMENT_MINT,
      endTimeUnix,
      sellerKeypairPath: SELLER,
      permittedMembers,
    });
    console.log(
      `🟢 lot ${lot.lot_id} (${lot.lot_metadata.title}) → auction ${auctionId} ends @ ${endTimeUnix}`
    );
    console.log(`   pda=${result.auctionPda} sig=${result.signature}`);
    registry.push({
      auctionId,
      auctionPda: result.auctionPda,
      lot,
      endTimeUnix,
      signature: result.signature,
    });
  }

  writeFileSync(registryPath, JSON.stringify(registry, null, 2));
  console.log(`✓ wrote ${registry.length} entries to ${registryPath}`);
}

main().catch((e) => {
  console.error("auctioneer failed:", e);
  process.exit(1);
});
