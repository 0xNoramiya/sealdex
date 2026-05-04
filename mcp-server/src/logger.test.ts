import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

describe("logger", () => {
  it("emits a JSON object with msg + level + base fields", () => {
    const lines: string[] = [];
    const log = createLogger(
      { service: "test" },
      { sink: (l) => lines.push(l) }
    );
    log.info("hello", { auctionId: "42" });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.msg).toBe("hello");
    expect(parsed.level).toBe("info");
    expect(parsed.service).toBe("test");
    expect(parsed.auctionId).toBe("42");
    expect(typeof parsed.time).toBe("string");
  });

  it("respects level threshold (level: warn drops info)", () => {
    const lines: string[] = [];
    const log = createLogger(
      {},
      { level: "warn", sink: (l) => lines.push(l) }
    );
    log.info("noise");
    log.warn("real");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).msg).toBe("real");
  });

  it("child loggers inherit base + add their own", () => {
    const lines: string[] = [];
    const root = createLogger(
      { service: "test" },
      { sink: (l) => lines.push(l) }
    );
    const child = root.child({ bidder: "alpha" });
    child.info("placed");
    const parsed = JSON.parse(lines[0]);
    expect(parsed.service).toBe("test");
    expect(parsed.bidder).toBe("alpha");
  });

  it("flattens Error instances (no [object Error] surprises)", () => {
    const lines: string[] = [];
    const log = createLogger({}, { sink: (l) => lines.push(l) });
    log.error("boom", { err: new Error("kaboom") });
    const parsed = JSON.parse(lines[0]);
    expect(parsed.err.name).toBe("Error");
    expect(parsed.err.message).toBe("kaboom");
    expect(typeof parsed.err.stack).toBe("string");
  });
});
