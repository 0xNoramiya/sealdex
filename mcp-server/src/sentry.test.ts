import { describe, expect, it } from "vitest";
import { captureException, captureMessage, isEnabled } from "./sentry.js";

describe("sentry", () => {
  it("is disabled when SENTRY_DSN is unset (default test env)", () => {
    expect(isEnabled()).toBe(false);
  });

  it("captureException is a no-op without DSN (does not throw)", () => {
    expect(() =>
      captureException(new Error("test error"), { auctionId: "1" })
    ).not.toThrow();
  });

  it("captureMessage is a no-op without DSN (does not throw)", () => {
    expect(() => captureMessage("hello", "info")).not.toThrow();
  });

  it("non-Error inputs are coerced safely", () => {
    expect(() => captureException("string error")).not.toThrow();
    expect(() => captureException(null)).not.toThrow();
    expect(() => captureException({ weird: "shape" })).not.toThrow();
  });
});
