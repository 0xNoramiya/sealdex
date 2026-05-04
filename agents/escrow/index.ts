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
import { getLogger } from "../../mcp-server/src/logger.js";
import { captureException } from "../../mcp-server/src/sentry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const STATE_DIR = process.env.SEALDEX_STATE_DIR
  ? resolve(process.env.SEALDEX_STATE_DIR)
  : resolve(ROOT, "scripts");
const LOG_PATH = resolve(STATE_DIR, "escrow-log.jsonl");

const PRIVATE_PAYMENTS_TIMEOUT_MS = 15_000;

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
  const log = getLogger("escrow");
  const apiBase = process.env.PRIVATE_PAYMENTS_API_BASE;
  const apiKey = process.env.PRIVATE_PAYMENTS_API_KEY;
  if (!apiBase || !apiKey) {
    log.warn("private payments API not configured — stubbing transfer", {
      from: fromPubkey,
      to: toPubkey,
      amount,
      mint,
    });
    return { stubbed: true };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PRIVATE_PAYMENTS_TIMEOUT_MS);
  let r: Response;
  try {
    r = await fetch(`${apiBase}/transfer`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ from: fromPubkey, to: toPubkey, amount, mint }),
      signal: ctrl.signal,
    });
  } catch (err) {
    if ((err as any)?.name === "AbortError") {
      throw new Error(
        `PP /transfer timeout after ${PRIVATE_PAYMENTS_TIMEOUT_MS}ms`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
  const log = getLogger("escrow");
  if (!existsSync(LOG_PATH)) writeFileSync(LOG_PATH, "");

  const conn = baseConnection();
  log.info("escrow listener starting", {
    rpc: BASE_RPC,
    programId: PROGRAM_ID.toBase58(),
    logPath: LOG_PATH,
  });

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
      log.info("LotClaimed observed", record);
      appendFileSync(LOG_PATH, JSON.stringify(record) + "\n");
      callPrivatePaymentsTransfer(
        record.winner,
        record.seller,
        record.amount,
        record.paymentMint
      )
        .then((r) => log.info("private-payments transfer ok", { result: r, signature: record.signature }))
        .catch((e) => {
          log.error("private-payments transfer failed", {
            err: e,
            signature: record.signature,
          });
          captureException(e, {
            op: "escrow.privatePayments",
            auctionId: record.auctionId,
            signature: record.signature,
          });
        });
    },
    "confirmed"
  );

  // Keep process alive
  await new Promise(() => {});
}

main().catch((e) => {
  const log = getLogger("escrow");
  log.fatal("escrow fatal", { err: e });
  captureException(e, { op: "escrow.main" });
  process.exit(1);
});
