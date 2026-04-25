// Smoke test for ops.ts — creates an auction with a far-future end_time,
// reads it back via get_auction_state, then verifies it shows up via getAuctionsByIds.
// Skips bids/settle so it doesn't consume bidder wallets.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAuction,
  endTimeFromNow,
  getAuctionsByIds,
  getAuctionState,
} from "./ops.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const KEYS_DIR = process.env.SEALDEX_KEYS_DIR
  ? resolve(process.env.SEALDEX_KEYS_DIR)
  : resolve(ROOT, ".keys");
const SELLER =
  process.env.SEALDEX_SELLER_KEYPAIR || resolve(KEYS_DIR, "seller.json");

async function main() {
  // While delegated, the auction won't be readable from base layer — that's expected.
  const auctionId = String(Date.now());
  const lotMetadataUri = "ipfs://bafyfakecid/sealdex-smoke.json";
  const paymentMint = "11111111111111111111111111111111"; // SystemProgram::ID stand-in
  const endTimeUnix = await endTimeFromNow(3600); // 1 hour out — won't auto-settle

  console.log("→ creating auction id", auctionId, "ending @", endTimeUnix);
  const created = await createAuction({
    auctionId,
    lotMetadataUri,
    paymentMint,
    endTimeUnix,
    sellerKeypairPath: SELLER,
  });
  console.log("✓ created", created);

  console.log("→ get_auction_state (returns last-committed snapshot)");
  const single = await getAuctionState(auctionId);
  console.log("  state:", single);
  if (!single) throw new Error("get_auction_state returned null");
  if (single.status !== "Open") {
    throw new Error(`expected Open, got ${single.status}`);
  }
  if (single.lotMetadataUri !== lotMetadataUri) {
    throw new Error("lotMetadataUri mismatch");
  }

  console.log("→ get_auctions_by_ids");
  const list = await getAuctionsByIds([auctionId]);
  console.log("  list:", list);
  if (list.length !== 1 || (list[0] as any).status !== "Open") {
    throw new Error("getAuctionsByIds did not return the new auction as Open");
  }
  console.log("✅ smoke OK — created, indexed, and readable from base layer");
}

main().catch((e) => {
  console.error("smoke failed:", e);
  process.exit(1);
});
