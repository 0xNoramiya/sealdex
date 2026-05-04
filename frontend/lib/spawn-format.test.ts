import { describe, expect, it } from "vitest";
import {
  relativeTime,
  shortId,
  statusBadgeStyle,
} from "./spawn-format";

describe("relativeTime", () => {
  const now = 1_700_000_000_000; // arbitrary fixed ms

  it("renders sub-minute deltas in seconds", () => {
    expect(relativeTime(1_700_000_000 - 5, now)).toBe("5s ago");
    expect(relativeTime(1_700_000_000 - 59, now)).toBe("59s ago");
  });

  it("renders sub-hour deltas in minutes", () => {
    expect(relativeTime(1_700_000_000 - 60, now)).toBe("1m ago");
    expect(relativeTime(1_700_000_000 - 3599, now)).toBe("59m ago");
  });

  it("renders sub-day deltas in hours", () => {
    expect(relativeTime(1_700_000_000 - 3600, now)).toBe("1h ago");
    expect(relativeTime(1_700_000_000 - 86_399, now)).toBe("23h ago");
  });

  it("renders multi-day deltas in days", () => {
    expect(relativeTime(1_700_000_000 - 86_400, now)).toBe("1d ago");
    expect(relativeTime(1_700_000_000 - 86_400 * 7, now)).toBe("7d ago");
  });

  it("renders 'just now' for sub-1s deltas", () => {
    expect(relativeTime(1_700_000_000, now)).toBe("just now");
  });

  it("handles future timestamps (clock skew)", () => {
    expect(relativeTime(1_700_000_000 + 30, now)).toBe("30s from now");
    expect(relativeTime(1_700_000_000 + 7200, now)).toBe("2h from now");
  });
});

describe("statusBadgeStyle", () => {
  it("maps running to a pulsing accent badge", () => {
    const s = statusBadgeStyle("running");
    expect(s.pulse).toBe(true);
    expect(s.bg).toContain("accent");
    expect(s.label).toBe("running");
  });

  it("maps stopped to a muted badge", () => {
    const s = statusBadgeStyle("stopped");
    expect(s.pulse).toBe(false);
    expect(s.label).toBe("stopped");
  });

  it("maps errored to a red badge", () => {
    const s = statusBadgeStyle("errored");
    expect(s.pulse).toBe(false);
    expect(s.text).toContain("red");
    expect(s.label).toBe("errored");
  });

  it("falls through to a neutral badge for unknown statuses", () => {
    const s = statusBadgeStyle("weird-state");
    expect(s.pulse).toBe(false);
    expect(s.label).toBe("weird-state");
  });
});

describe("shortId", () => {
  it("shortens long ids", () => {
    expect(shortId("0123456789abcdef0123456789abcdef")).toBe("0123…cdef");
  });

  it("returns the original when the id is already short", () => {
    expect(shortId("abc")).toBe("abc");
  });

  it("respects custom head/tail lengths", () => {
    expect(shortId("0123456789abcdef", 2, 2)).toBe("01…ef");
  });
});
