import { describe, expect, it, vi } from "vitest";
import { isLikelyTransient, retry } from "./retry.js";

describe("isLikelyTransient", () => {
  it("classifies HTTP 429 as transient", () => {
    expect(isLikelyTransient(new Error("HTTP 429 Too Many Requests"))).toBe(
      true
    );
  });

  it("classifies blockhash not found as transient", () => {
    expect(
      isLikelyTransient(new Error("Blockhash not found"))
    ).toBe(true);
  });

  it("classifies timeout/socket errors as transient", () => {
    expect(isLikelyTransient(new Error("Connection timeout"))).toBe(true);
    expect(isLikelyTransient(new Error("ECONNRESET"))).toBe(true);
    expect(isLikelyTransient(new Error("socket hang up"))).toBe(true);
  });

  it("classifies program errors as terminal", () => {
    expect(
      isLikelyTransient(new Error("custom program error: 0x1771"))
    ).toBe(false);
    expect(
      isLikelyTransient(new Error("Anchor error: AccountNotInitialized"))
    ).toBe(false);
  });

  it("classifies insufficient funds as terminal", () => {
    expect(
      isLikelyTransient(new Error("Transaction simulation failed: insufficient funds"))
    ).toBe(false);
  });

  it("returns false for non-error inputs", () => {
    expect(isLikelyTransient(null)).toBe(false);
    expect(isLikelyTransient(undefined)).toBe(false);
  });
});

describe("retry", () => {
  it("returns value on first success without sleep", async () => {
    const fn = vi.fn(async () => 42);
    expect(await retry(fn, { maxAttempts: 3 })).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries transient errors and eventually succeeds", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error("HTTP 429 rate limit");
      return "ok";
    });
    const result = await retry(fn, {
      maxAttempts: 5,
      baseDelayMs: 1,
      logger: () => {},
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry terminal errors", async () => {
    const fn = vi.fn(async () => {
      throw new Error("custom program error: 0x1");
    });
    await expect(
      retry(fn, { maxAttempts: 5, baseDelayMs: 1, logger: () => {} })
    ).rejects.toThrow(/program error/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting attempts on persistent transient errors", async () => {
    const fn = vi.fn(async () => {
      throw new Error("ETIMEDOUT");
    });
    await expect(
      retry(fn, { maxAttempts: 3, baseDelayMs: 1, logger: () => {} })
    ).rejects.toThrow(/ETIMEDOUT/);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("respects custom isRetryable predicate", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 2) throw new Error("anything goes");
      return "x";
    });
    const result = await retry(fn, {
      maxAttempts: 3,
      baseDelayMs: 1,
      isRetryable: () => true,
      logger: () => {},
    });
    expect(result).toBe("x");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
