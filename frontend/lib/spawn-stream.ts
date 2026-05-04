// Pure helpers for parsing + summarising the bidder's JSONL stream.
// CLIENT-SAFE: this file imports zero node-only modules so the
// dashboard can import its display helpers (summarizeEvent,
// eventTone, type StreamEvent) without webpack dragging `node:fs`
// into the client bundle. Server-only fs helpers live in the
// sibling `spawn-stream-fs.ts`.
//
// The bidder writes one JSON record per line via streamLog() to
//   <SEALDEX_STATE_DIR>/bidder-<slug>-stream.jsonl
// where every record has the shape { ts: <ms>, kind: <string>, ... }.
// We don't enforce a closed enum on `kind` — new kinds can land any
// time the bidder gains a new code path; the dashboard renders an
// "(unknown event)" fallback rather than dropping them.

/** Event kinds the dashboard understands explicitly. Anything else
 *  falls through to a generic display. */
export type KnownEventKind =
  | "bidder_start"
  | "agent_response"
  | "agent_text"
  | "agent_error"
  | "lot_skipped_pre_claude"
  | "feed_verification_failed"
  | "auction_pda_mismatch"
  | "bid_attempt"
  | "bid_placed"
  | "evaluate_error"
  | "guardrail_block"
  | "ceiling_violation";

export interface StreamEvent {
  /** unix-ms timestamp written by the bidder. */
  ts: number;
  /** Event kind. KnownEventKind for the well-defined ones. */
  kind: string;
  /** All other fields the bidder logged. We pass through, the UI
   *  picks per-kind. */
  [key: string]: unknown;
}

/**
 * Parse a JSONL blob into events. Tolerates blank lines and a
 * partial trailing line (which is what a tail in flight looks like).
 * Rejects malformed JSON lines silently — the bidder is the only
 * writer and its writer is `appendFileSync` so torn lines are vanishingly
 * rare, but we don't want one bad line to nuke the whole tail.
 */
export function parseStreamLines(text: string): StreamEvent[] {
  if (!text) return [];
  const out: StreamEvent[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as StreamEvent;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.kind === "string" &&
        typeof parsed.ts === "number"
      ) {
        out.push(parsed);
      }
    } catch {
      // Drop malformed line; do not throw.
    }
  }
  return out;
}

/** Last N events. Stable order — caller can reverse() for newest-first. */
export function tailLastN(events: StreamEvent[], n: number): StreamEvent[] {
  if (n <= 0 || events.length === 0) return [];
  if (events.length <= n) return events.slice();
  return events.slice(events.length - n);
}

/** A single short summary line for display. Keeps the dashboard
 *  scannable — we deliberately do NOT dump full JSON per row. */
export function summarizeEvent(event: StreamEvent): string {
  const aid = typeof event.auctionId === "string" ? event.auctionId : null;
  const auctionTag = aid ? ` lot=${aid}` : "";
  switch (event.kind) {
    case "bidder_start":
      return `started · ${asString(event.name) ?? "agent"} (${asString(event.pubkey)?.slice(0, 8) ?? "?"}…)`;
    case "agent_response": {
      const provider = asString(event.provider) ?? "agent";
      const stop = asString(event.stop_reason) ?? "?";
      return `${provider} replied · stop=${stop}${auctionTag}`;
    }
    case "agent_text":
      return `agent text${auctionTag} · ${truncate(asString(event.text) ?? "", 140)}`;
    case "agent_error":
      return `agent error${auctionTag} · ${asString(event.error) ?? "(no msg)"}`;
    case "lot_skipped_pre_claude":
      return `skip (pre-LLM)${auctionTag} · category=${asString(event.category) ?? "?"} grade=${event.grade ?? "?"}`;
    case "feed_verification_failed":
      return `feed signature FAIL${auctionTag} · ${asString(event.reason) ?? "?"}`;
    case "auction_pda_mismatch":
      return `auction PDA mismatch${auctionTag}`;
    case "bid_attempt": {
      const amt = event.amountUsdc;
      return `bidding $${amt}${auctionTag}`;
    }
    case "bid_placed": {
      const amt = event.amountUsdc;
      const sigPrefix = (asString(event.signature) ?? "").slice(0, 8);
      return `BID PLACED $${amt}${auctionTag} · sig=${sigPrefix}…`;
    }
    case "evaluate_error":
      return `evaluate error${auctionTag} · ${truncate(asString(event.error) ?? "", 140)}`;
    case "guardrail_block":
      return `guardrail blocked${auctionTag} · ${asString(event.reason) ?? "?"}`;
    case "ceiling_violation":
      return `ceiling violation${auctionTag} · ${asString(event.reason) ?? "?"}`;
    default:
      return `${event.kind}${auctionTag}`;
  }
}

/** Categorise an event for badge colouring. */
export function eventTone(event: StreamEvent):
  | "info"
  | "good"
  | "warn"
  | "error" {
  switch (event.kind) {
    case "bid_placed":
      return "good";
    case "bid_attempt":
    case "agent_response":
    case "lot_skipped_pre_claude":
    case "agent_text":
    case "bidder_start":
      return "info";
    case "guardrail_block":
    case "feed_verification_failed":
    case "auction_pda_mismatch":
      return "warn";
    case "agent_error":
    case "evaluate_error":
    case "ceiling_violation":
      return "error";
    default:
      return "info";
  }
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}
