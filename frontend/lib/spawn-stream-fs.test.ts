import { beforeEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  STREAM_TAIL_BYTES_CAP,
  findStreamFile,
  readStreamTail,
} from "./spawn-stream-fs";

let TMP: string;
beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "sealdex-stream-fs-"));
});

const ev = (overrides: Record<string, unknown>) => ({
  ts: 1_700_000_000_000,
  kind: "agent_response",
  ...overrides,
});

describe("findStreamFile", () => {
  it("returns null when state dir missing", () => {
    expect(findStreamFile(join(TMP, "does-not-exist"))).toBeNull();
  });

  it("returns null when no matching file present", () => {
    mkdirSync(join(TMP, "state-empty"), { recursive: true });
    writeFileSync(join(TMP, "state-empty", "irrelevant.txt"), "hi");
    expect(findStreamFile(join(TMP, "state-empty"))).toBeNull();
  });

  it("finds bidder-<slug>-stream.jsonl in the state dir", () => {
    const dir = join(TMP, "spawn-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bidder-alpha-stream.jsonl"), "{}");
    writeFileSync(join(dir, "bidder-alpha-state.json"), "{}");
    expect(findStreamFile(dir)).toBe(join(dir, "bidder-alpha-stream.jsonl"));
  });

  it("picks the most-recently-modified when several match (renamed agent edge)", async () => {
    const dir = join(TMP, "spawn-2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bidder-old-stream.jsonl"), "{}");
    // Force a clear mtime gap so the test isn't flaky.
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(dir, "bidder-new-stream.jsonl"), "{}");
    expect(findStreamFile(dir)).toBe(join(dir, "bidder-new-stream.jsonl"));
  });
});

describe("readStreamTail", () => {
  it("returns events from a small file unchanged", () => {
    const dir = join(TMP, "tail-1");
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, "bidder-x-stream.jsonl");
    appendFileSync(
      fp,
      JSON.stringify(ev({ kind: "bidder_start", name: "X" })) + "\n"
    );
    appendFileSync(
      fp,
      JSON.stringify(ev({ kind: "bid_placed", amountUsdc: 50 })) + "\n"
    );
    const r = readStreamTail(fp);
    expect(r.events).toHaveLength(2);
    expect(r.events[0].kind).toBe("bidder_start");
    expect(r.events[1].kind).toBe("bid_placed");
    expect(r.truncated).toBe(false);
  });

  it("caps events at maxEvents (last-N when bigger)", () => {
    const dir = join(TMP, "tail-2");
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, "bidder-y-stream.jsonl");
    for (let i = 0; i < 50; i++) {
      appendFileSync(
        fp,
        JSON.stringify(
          ev({ ts: 1_700_000_000_000 + i, kind: "agent_response", n: i })
        ) + "\n"
      );
    }
    const r = readStreamTail(fp, { maxEvents: 10 });
    expect(r.events).toHaveLength(10);
    expect(r.events[0].n).toBe(40);
    expect(r.events[9].n).toBe(49);
  });

  it("returns empty when file missing", () => {
    expect(readStreamTail(join(TMP, "nope.jsonl"))).toEqual({
      events: [],
      truncated: false,
      sizeBytes: 0,
    });
  });

  it("drops the first (partial) line when bytesCap-truncated", () => {
    const dir = join(TMP, "tail-3");
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, "bidder-z-stream.jsonl");
    // Write a file bigger than bytesCap so the read window starts mid-line.
    const padding = "X".repeat(100);
    for (let i = 0; i < 200; i++) {
      appendFileSync(
        fp,
        JSON.stringify(
          ev({ ts: 1_700_000_000_000 + i, kind: "agent_response", n: i, padding })
        ) + "\n"
      );
    }
    const r = readStreamTail(fp, { bytesCap: 4 * 1024, maxEvents: 1000 });
    expect(r.truncated).toBe(true);
    // sizeBytes is the actual file size, not the capped window.
    expect(r.sizeBytes).toBeGreaterThan(4 * 1024);
    // We get a sequence of well-formed events even though the
    // window started mid-line — the leading partial line was dropped.
    for (const e of r.events) {
      expect(typeof e.kind).toBe("string");
      expect(typeof e.ts).toBe("number");
    }
  });
});

describe("STREAM_TAIL_BYTES_CAP", () => {
  it("is a sane default (256 KB)", () => {
    expect(STREAM_TAIL_BYTES_CAP).toBe(256 * 1024);
  });
});
