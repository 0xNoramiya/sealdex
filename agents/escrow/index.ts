// Escrow agent — subscribes to LotClaimed events on the Sealdex program.
// On each event, logs settlement to a JSON file and (in production) would call
// the Private Payments API to transfer funds from winner → seller. The PP call
// is stubbed because we don't have an API key configured yet.
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { IDL, PROGRAM_ID, BASE_RPC, baseConnection } from "../../mcp-server/src/client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = resolve(__dirname, "../../scripts/escrow-log.jsonl");

type LotClaimed = {
  auctionId: anchor.BN;
  winner: PublicKey;
  seller: PublicKey;
  amount: anchor.BN;
  paymentMint: PublicKey;
};

async function callPrivatePaymentsTransfer(
  fromPubkey: string,
  toPubkey: string,
  amount: string,
  mint: string
) {
  const apiBase = process.env.PRIVATE_PAYMENTS_API_BASE;
  const apiKey = process.env.PRIVATE_PAYMENTS_API_KEY;
  if (!apiBase || !apiKey) {
    console.log(
      `⚠ Private Payments API not configured — would transfer ${amount} (${mint}) from ${fromPubkey} → ${toPubkey}`
    );
    return { stubbed: true };
  }
  const r = await fetch(`${apiBase}/transfer`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ from: fromPubkey, to: toPubkey, amount, mint }),
  });
  if (!r.ok) throw new Error(`PP /transfer ${r.status}: ${await r.text()}`);
  return r.json();
}

function decodeLotClaimedFromLog(
  programLogs: string[],
  conn: Connection
): LotClaimed | null {
  // Anchor emits events as base64-encoded "Program data: ..." log lines.
  // We decode using the IDL's events parser.
  const provider = new anchor.AnchorProvider(
    conn,
    new anchor.Wallet(anchor.web3.Keypair.generate()),
    { commitment: "confirmed" }
  );
  const program = new anchor.Program(IDL, provider);
  const eventParser = new anchor.EventParser(PROGRAM_ID, program.coder);
  for (const ev of eventParser.parseLogs(programLogs)) {
    if (ev.name === "LotClaimed" || ev.name === "lotClaimed") {
      return ev.data as unknown as LotClaimed;
    }
  }
  return null;
}

async function main() {
  if (!existsSync(LOG_PATH)) writeFileSync(LOG_PATH, "");

  const conn = baseConnection();
  console.log(
    `🛡  escrow agent listening on ${BASE_RPC} for LotClaimed events from ${PROGRAM_ID.toBase58()}`
  );

  conn.onLogs(
    PROGRAM_ID,
    (logs) => {
      if (logs.err) return;
      const event = decodeLotClaimedFromLog(logs.logs, conn);
      if (!event) return;
      const record = {
        ts: Date.now(),
        signature: logs.signature,
        auctionId: event.auctionId.toString(),
        winner: event.winner.toBase58(),
        seller: event.seller.toBase58(),
        amount: event.amount.toString(),
        paymentMint: event.paymentMint.toBase58(),
      };
      console.log("📥 LotClaimed:", record);
      appendFileSync(LOG_PATH, JSON.stringify(record) + "\n");
      callPrivatePaymentsTransfer(
        record.winner,
        record.seller,
        record.amount,
        record.paymentMint
      )
        .then((r) => console.log("💸 PP transfer:", r))
        .catch((e) => console.error("PP transfer failed:", e));
    },
    "confirmed"
  );

  // Keep process alive
  await new Promise(() => {});
}

main().catch((e) => {
  console.error("escrow agent failed:", e);
  process.exit(1);
});
