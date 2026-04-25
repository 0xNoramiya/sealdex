import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { settleAuction } from "../mcp-server/src/ops.js";

const auctionId = process.argv[2];
if (!auctionId) {
  console.error("usage: tsx scripts/settle.ts <auctionId>");
  process.exit(1);
}

function pk(path: string): string {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw)).publicKey.toBase58();
}

async function main() {
  const bidderPubkeys = [pk(".keys/bidder1.json"), pk(".keys/bidder2.json")];
  console.log(`settling ${auctionId} with bidders:`, bidderPubkeys);

  const result = await settleAuction({
    auctionId,
    payerKeypairPath: ".keys/seller.json",
    bidderPubkeys,
  });
  console.log("SETTLE RESULT:", JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error("settle failed:", e);
  process.exit(1);
});
