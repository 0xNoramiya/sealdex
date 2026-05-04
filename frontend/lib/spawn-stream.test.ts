import { describe, expect, it } from "vitest";
import {
  eventTone,
  parseStreamLines,
  summarizeEvent,
  tailLastN,
  type StreamEvent,
} from "./spawn-stream";

const ev = (overrides: Partial<StreamEvent>): StreamEvent => ({
  ts: 1_700_000_000_000,
  kind: "agent_response",
  ...overrides,
});

describe("parseStreamLines", () => {
  it("parses one event per non-empty line", () => {
    const text = [
      JSON.stringify(ev({ kind: "bidder_start", name: "Alpha", pubkey: "PKEY12345" })),
      JSON.stringify(ev({ kind: "agent_response", auctionId: "1", stop_reason: "end_turn" })),
    ].join("\n");
    const events = parseStreamLines(text);
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("bidder_start");
    expect(events[1].kind).toBe("agent_response");
  });

  it("tolerates blank lines", () => {
    const text = [
      "",
      "  ",
      JSON.stringify(ev({ kind: "bid_placed", auctionId: "9", amountUsdc: 100 })),
      "",
    ].join("\n");
    expect(parseStreamLines(text)).toHaveLength(1);
  });

  it("drops malformed JSON lines silently", () => {
    const text = [
      JSON.stringify(ev({ kind: "bid_attempt", auctionId: "1", amountUsdc: 50 })),
      "{not json",
      JSON.stringify(ev({ kind: "bid_placed", auctionId: "1", amountUsdc: 50 })),
    ].join("\n");
    const events = parseStreamLines(text);
    expect(events.map((e) => e.kind)).toEqual(["bid_attempt", "bid_placed"]);
  });

  it("rejects lines that lack ts or kind", () => {
    const text = [
      JSON.stringify({ ts: 1, kind: "ok" }),
      JSON.stringify({ ts: 1 }), // missing kind
      JSON.stringify({ kind: "ok" }), // missing ts
    ].join("\n");
    const events = parseStreamLines(text);
    expect(events).toHaveLength(1);
  });

  it("returns [] on empty input", () => {
    expect(parseStreamLines("")).toEqual([]);
  });
});

describe("tailLastN", () => {
  it("returns last N events in order", () => {
    const events = [
      ev({ ts: 1, kind: "a" }),
      ev({ ts: 2, kind: "b" }),
      ev({ ts: 3, kind: "c" }),
    ];
    expect(tailLastN(events, 2).map((e) => e.kind)).toEqual(["b", "c"]);
  });

  it("returns all when N >= length", () => {
    const events = [ev({ ts: 1, kind: "a" })];
    expect(tailLastN(events, 5)).toHaveLength(1);
  });

  it("returns [] for n <= 0 or empty input", () => {
    expect(tailLastN([], 5)).toEqual([]);
    expect(tailLastN([ev({ kind: "a" })], 0)).toEqual([]);
    expect(tailLastN([ev({ kind: "a" })], -1)).toEqual([]);
  });
});

describe("summarizeEvent", () => {
  it("formats bidder_start", () => {
    expect(
      summarizeEvent(
        ev({ kind: "bidder_start", name: "Alpha", pubkey: "PKEY1234567" })
      )
    ).toMatch(/started.*Alpha.*PKEY1234/);
  });

  it("formats bid_placed with amount + sig prefix", () => {
    expect(
      summarizeEvent(
        ev({
          kind: "bid_placed",
          auctionId: "42",
          amountUsdc: 250,
          signature: "5KJp...AbCdEfGhIjK",
        })
      )
    ).toMatch(/BID PLACED \$250.*lot=42.*sig=5KJp/);
  });

  it("formats agent_response with provider + stop reason", () => {
    expect(
      summarizeEvent(
        ev({
          kind: "agent_response",
          provider: "openai-compatible",
          stop_reason: "tool_calls",
          auctionId: "7",
        })
      )
    ).toMatch(/openai-compatible replied.*stop=tool_calls.*lot=7/);
  });

  it("truncates long agent_text", () => {
    const longText = "x".repeat(500);
    const summary = summarizeEvent(
      ev({ kind: "agent_text", auctionId: "1", text: longText })
    );
    // 140 char cap (139 + ellipsis) inside the prefix
    expect(summary.length).toBeLessThan(200);
    expect(summary).toMatch(/agent text/);
    expect(summary).toMatch(/…/);
  });

  it("falls through with raw kind for unknown events", () => {
    expect(summarizeEvent(ev({ kind: "novel_event", auctionId: "9" }))).toBe(
      "novel_event lot=9"
    );
  });

  it("formats lot_skipped_pre_claude with category + grade", () => {
    expect(
      summarizeEvent(
        ev({
          kind: "lot_skipped_pre_claude",
          auctionId: "5",
          category: "Vintage Holo",
          grade: 8,
        })
      )
    ).toMatch(/skip \(pre-LLM\).*Vintage Holo.*grade=8/);
  });
});

describe("eventTone", () => {
  it("good for bid_placed", () => {
    expect(eventTone(ev({ kind: "bid_placed" }))).toBe("good");
  });
  it("error for ceiling_violation, evaluate_error, agent_error", () => {
    expect(eventTone(ev({ kind: "ceiling_violation" }))).toBe("error");
    expect(eventTone(ev({ kind: "evaluate_error" }))).toBe("error");
    expect(eventTone(ev({ kind: "agent_error" }))).toBe("error");
  });
  it("warn for guardrail_block, feed_verification_failed, auction_pda_mismatch", () => {
    expect(eventTone(ev({ kind: "guardrail_block" }))).toBe("warn");
    expect(eventTone(ev({ kind: "feed_verification_failed" }))).toBe("warn");
    expect(eventTone(ev({ kind: "auction_pda_mismatch" }))).toBe("warn");
  });
  it("info for everything else", () => {
    expect(eventTone(ev({ kind: "bid_attempt" }))).toBe("info");
    expect(eventTone(ev({ kind: "agent_response" }))).toBe("info");
    expect(eventTone(ev({ kind: "lot_skipped_pre_claude" }))).toBe("info");
    expect(eventTone(ev({ kind: "anything_else" }))).toBe("info");
  });
});

