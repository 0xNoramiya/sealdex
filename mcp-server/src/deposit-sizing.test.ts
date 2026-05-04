import { describe, expect, it } from "vitest";
import {
  computeBidDepositLamports,
  DEFAULT_DEPOSIT_RATIO_BPS,
  DEFAULT_LAMPORTS_PER_USDC,
  MIN_BID_DEPOSIT_LAMPORTS,
} from "./deposit-sizing.js";

describe("computeBidDepositLamports", () => {
  it("returns the floor when estimate_high_usdc is missing", () => {
    expect(computeBidDepositLamports({})).toBe(MIN_BID_DEPOSIT_LAMPORTS);
  });

  it("returns the floor when estimate_high_usdc is zero", () => {
    expect(computeBidDepositLamports({ estimateHighUsdc: 0 })).toBe(
      MIN_BID_DEPOSIT_LAMPORTS
    );
  });

  it("returns the floor when estimate_high_usdc is negative", () => {
    expect(computeBidDepositLamports({ estimateHighUsdc: -100 })).toBe(
      MIN_BID_DEPOSIT_LAMPORTS
    );
  });

  it("returns the floor when estimate_high_usdc is NaN", () => {
    expect(computeBidDepositLamports({ estimateHighUsdc: NaN })).toBe(
      MIN_BID_DEPOSIT_LAMPORTS
    );
  });

  it("returns the floor when computed value is below it (small lot)", () => {
    // 1% of $100 = $1 = 5_000_000 lamports → below the 10_000_000 floor.
    expect(computeBidDepositLamports({ estimateHighUsdc: 100 })).toBe(
      MIN_BID_DEPOSIT_LAMPORTS
    );
  });

  it("scales above the floor for high-value lots", () => {
    // 1% of $3400 = $34 = 34 * 5_000_000 = 170_000_000 lamports = 0.17 SOL.
    expect(computeBidDepositLamports({ estimateHighUsdc: 3400 })).toBe(
      170_000_000n
    );
  });

  it("scales linearly with estimate_high_usdc", () => {
    const low = computeBidDepositLamports({ estimateHighUsdc: 1000 });
    const high = computeBidDepositLamports({ estimateHighUsdc: 10_000 });
    expect(high).toBe(low * 10n);
  });

  it("respects custom ratio_bps overrides (250 bps = 2.5%)", () => {
    // 2.5% of $1000 = $25 = 125_000_000 lamports.
    expect(
      computeBidDepositLamports({ estimateHighUsdc: 1000, ratioBps: 250 })
    ).toBe(125_000_000n);
  });

  it("respects custom lamports_per_usdc rate", () => {
    // If 1 USDC = 1_000_000 lamports (mock cheaper SOL), 1% of $5000
    // = $50 = 50_000_000 lamports.
    expect(
      computeBidDepositLamports({
        estimateHighUsdc: 5000,
        lamportsPerUsdc: 1_000_000n,
      })
    ).toBe(50_000_000n);
  });

  it("truncates fractional USDC inputs", () => {
    // 1234.99 → truncate to 1234. 1% of $1234 = $12.34 = 61_700_000 lamports.
    expect(computeBidDepositLamports({ estimateHighUsdc: 1234.99 })).toBe(
      61_700_000n
    );
  });

  it("respects a custom minLamports override", () => {
    // With a small estimate but huge floor, return the floor.
    expect(
      computeBidDepositLamports({
        estimateHighUsdc: 1,
        minLamports: 1_000_000_000n,
      })
    ).toBe(1_000_000_000n);
  });

  it("exposed default constants match the program contract", () => {
    expect(MIN_BID_DEPOSIT_LAMPORTS).toBe(10_000_000n);
    expect(DEFAULT_DEPOSIT_RATIO_BPS).toBe(100);
    expect(DEFAULT_LAMPORTS_PER_USDC).toBe(5_000_000n);
  });

  it("worked example: $5000 grail lot pays a $50 deposit (≈0.25 SOL)", () => {
    // 5 spammers × 0.25 SOL = 1.25 SOL ≈ $250 — proportional friction.
    const lamports = computeBidDepositLamports({ estimateHighUsdc: 5000 });
    expect(lamports).toBe(250_000_000n);
    // Sanity: floor was 10_000_000 — we're 25× above it.
    expect(lamports / MIN_BID_DEPOSIT_LAMPORTS).toBe(25n);
  });
});
