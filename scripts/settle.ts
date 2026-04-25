import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import { settleAuction } from "../mcp-server/src/ops.js";

const auctionId = process.argv[2];
if (!auctionId) {
  console.error("usage: tsx scripts/settle.ts <auctionId>");
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const KEYS_DIR = process.env.SEALDEX_KEYS_DIR
  ? resolve(process.env.SEALDEX_KEYS_DIR)
  : resolve(ROOT, ".keys");

function pk(path: string): string {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw)).publicKey.toBase58();
}

async function main() {
  const sellerKey = resolve(KEYS_DIR, "seller.json");
  const bidderPubkeys = [
    pk(resolve(KEYS_DIR, "bidder1.json")),
    pk(resolve(KEYS_DIR, "bidder2.json")),
  ];
  console.log(`settling ${auctionId} with bidders:`, bidderPubkeys);

  const result = await settleAuction({
    auctionId,
    payerKeypairPath: sellerKey,
    bidderPubkeys,
  });
  console.log("SETTLE RESULT:", JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error("settle failed:", e);
  process.exit(1);
});
