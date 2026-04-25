import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Where bidder/auctioneer state lives. In local dev that's <repo>/scripts;
 * on Fly.io it's the persistent volume mount (e.g. /data/state). The agents
 * already respect SEALDEX_STATE_DIR — the frontend has to match.
 */
const REPO_ROOT = path.resolve(process.cwd(), "..");
const SCRIPTS_DIR = process.env.SEALDEX_STATE_DIR
  ? path.resolve(process.env.SEALDEX_STATE_DIR)
  : path.join(REPO_ROOT, "scripts");

export interface RegistryEntry {
  auctionId: string;
  auctionPda: string;
  lot: {
    lot_id: number;
    lot_metadata: Record<string, any>;
    duration_seconds: number;
  };
  endTimeUnix: number;
  signature: string;
}

export function readRegistry(): RegistryEntry[] {
  try {
    const raw = readFileSync(path.join(SCRIPTS_DIR, "auction-registry.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/** A snapshot of a bidder agent's persisted state file. */
export interface BidderState {
  agentSlug: string;
  bidsPlaced: Record<
    string,
    { amountUsdc: number; reasoning: string; signature: string; ts: number }
  >;
}

export interface BidderStreamEntry {
  ts: number;
  kind: string;
  [key: string]: any;
}

export function readBidderStates(): BidderState[] {
  let files: string[] = [];
  try {
    files = readdirSync(SCRIPTS_DIR);
  } catch {
    return [];
  }
  const out: BidderState[] = [];
  for (const f of files) {
    const m = f.match(/^bidder-(.+)-state\.json$/);
    if (!m) continue;
    try {
      const raw = readFileSync(path.join(SCRIPTS_DIR, f), "utf8");
      const data = JSON.parse(raw);
      out.push({ agentSlug: m[1], bidsPlaced: data.bidsPlaced ?? {} });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

/** Reads the last `limit` JSONL records from a bidder stream file. */
export function readBidderStream(
  agentSlug: string,
  limit = 80
): BidderStreamEntry[] {
  const file = path.join(SCRIPTS_DIR, `bidder-${agentSlug}-stream.jsonl`);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  return lines
    .slice(-limit)
    .map((l) => {
      try {
        return JSON.parse(l) as BidderStreamEntry;
      } catch {
        return null;
      }
    })
    .filter((x): x is BidderStreamEntry => x !== null);
}

/** Pretty-print the bidder name/pubkey/tag from the stream's start record.
 *  bidder_start is the FIRST event in the stream — read the head rather than
 *  the tail, otherwise long-running bidders push the start event out of the
 *  window. */
export function readBidderIdentity(
  agentSlug: string
): { name: string; pubkey: string; tag: string } | null {
  const file = path.join(SCRIPTS_DIR, `bidder-${agentSlug}-stream.jsonl`);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const firstLine = raw.split("\n").find((l) => l.trim().length > 0);
  if (!firstLine) return null;
  let start: BidderStreamEntry;
  try {
    start = JSON.parse(firstLine) as BidderStreamEntry;
  } catch {
    return null;
  }
  if (start.kind !== "bidder_start") return null;
  const name = (start as any).name ?? agentSlug;
  const pubkey = (start as any).pubkey ?? "";
  const tag = name
    .replace(/^bidder\s+/i, "")
    .charAt(0)
    .toUpperCase();
  return { name, pubkey, tag };
}
