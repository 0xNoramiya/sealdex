import { describe, expect, it } from "vitest";
import {
  buildLotContext,
  checkBidCeiling,
  chooseWantListEntry,
  lotMatchesWantList,
  remainingBudget,
  riskFractionRange,
  slug,
  type BidderConfig,
  type BidState,
  type RegistryEntry,
} from "./lib.js";

const exampleConfig = (overrides: Partial<BidderConfig> = {}): BidderConfig => ({
  name: "Bidder Alpha",
  keypair_path: "/tmp/k.json",
  total_budget_usdc: 10_000,
  risk_appetite: "balanced",
  want_list: [
    { category: "Vintage Holo", min_grade: 9, max_value_usdc: 5_000 },
    { category: "Modern Pull", min_grade: 10, max_value_usdc: 1_500 },
  ],
  ...overrides,
});

const emptyState = (): BidState => ({ bidsPlaced: {} });

describe("slug", () => {
  it("lowercases and dasherizes alphanum", () => {
    expect(slug("Bidder Alpha")).toBe("bidder-alpha");
    expect(slug("β-Test #2")).toBe("-test-2");
  });
});

describe("remainingBudget", () => {
  it("returns total_budget_usdc when no bids placed", () => {
    expect(remainingBudget(exampleConfig(), emptyState())).toBe(10_000);
  });

  it("subtracts open bid amounts", () => {
    const state: BidState = {
      bidsPlaced: {
        "111": { amountUsdc: 3_000, reasoning: "x", signature: "s", ts: 0 },
        "222": { amountUsdc: 2_500, reasoning: "y", signature: "s", ts: 0 },
      },
    };
    expect(remainingBudget(exampleConfig(), state)).toBe(4_500);
  });

  it("can go negative when overcommitted (signal to caller, not error)", () => {
    const state: BidState = {
      bidsPlaced: {
        "1": { amountUsdc: 12_000, reasoning: "", signature: "", ts: 0 },
      },
    };
    expect(remainingBudget(exampleConfig(), state)).toBe(-2_000);
  });
});

describe("riskFractionRange", () => {
  it("conservative is 70-80%", () => {
    expect(riskFractionRange("conservative")).toEqual([0.7, 0.8]);
  });
  it("balanced is 80-92%", () => {
    expect(riskFractionRange("balanced")).toEqual([0.8, 0.92]);
  });
  it("aggressive is 92-99%", () => {
    expect(riskFractionRange("aggressive")).toEqual([0.92, 0.99]);
  });
});

describe("lotMatchesWantList", () => {
  it("matches when category equal and grade >= min_grade", () => {
    expect(
      lotMatchesWantList(exampleConfig().want_list, {
        category: "Vintage Holo",
        grade: 9,
      })
    ).toBe(true);
  });

  it("rejects below min_grade", () => {
    expect(
      lotMatchesWantList(exampleConfig().want_list, {
        category: "Vintage Holo",
        grade: 8,
      })
    ).toBe(false);
  });

  it("rejects unknown category", () => {
    expect(
      lotMatchesWantList(exampleConfig().want_list, {
        category: "Nope",
        grade: 10,
      })
    ).toBe(false);
  });

  it("returns false on missing fields", () => {
    expect(lotMatchesWantList(exampleConfig().want_list, {})).toBe(false);
  });
});

describe("chooseWantListEntry", () => {
  it("picks the lowest max_value_usdc when multiple match", () => {
    const cfg = exampleConfig({
      want_list: [
        { category: "Vintage Holo", min_grade: 7, max_value_usdc: 8_000 },
        { category: "Vintage Holo", min_grade: 9, max_value_usdc: 5_000 },
      ],
    });
    const chosen = chooseWantListEntry(cfg.want_list, {
      category: "Vintage Holo",
      grade: 10,
    });
    expect(chosen?.max_value_usdc).toBe(5_000);
  });

  it("returns null when nothing matches", () => {
    expect(
      chooseWantListEntry(exampleConfig().want_list, {
        category: "Vintage Holo",
        grade: 1,
      })
    ).toBeNull();
  });
});

describe("buildLotContext", () => {
  const entry: RegistryEntry = {
    auctionId: "1234",
    auctionPda: "Pda…",
    lot: {
      lot_id: 1,
      lot_metadata: {
        category: "Vintage Holo",
        grade: 10,
        year: 1999,
        serial: "abc",
        estimate_low_usdc: 2400,
        estimate_high_usdc: 3400,
        cert_number: "PSA-42",
      },
      duration_seconds: 90,
    },
    endTimeUnix: 1000,
    signature: "sig",
  };

  it("renders all fields from the metadata", () => {
    const text = buildLotContext(exampleConfig(), emptyState(), entry, 950);
    expect(text).toContain("auction_id: 1234");
    expect(text).toContain("time_left_seconds: 50");
    expect(text).toContain("category: Vintage Holo");
    expect(text).toContain("grade: 10");
    expect(text).toContain("estimate_high_usdc: 3400");
    expect(text).toContain("remaining_budget: 10000");
  });

  it("clamps time_left at 0 once cluster crosses end_time", () => {
    const text = buildLotContext(exampleConfig(), emptyState(), entry, 9_999);
    expect(text).toContain("time_left_seconds: 0");
  });

  it("falls back to n/a for missing optional metadata", () => {
    const lite: RegistryEntry = {
      ...entry,
      lot: { ...entry.lot, lot_metadata: { category: "X", grade: 5 } },
    };
    const text = buildLotContext(exampleConfig(), emptyState(), lite, 0);
    expect(text).toContain("year: n/a");
    expect(text).toContain("serial: n/a");
    expect(text).toContain("cert_number: n/a");
  });
});

describe("checkBidCeiling", () => {
  const cfg = exampleConfig({
    risk_appetite: "balanced", // upper bound 0.92
    want_list: [
      { category: "Vintage Holo", min_grade: 9, max_value_usdc: 5_000 },
      { category: "Modern Pull", min_grade: 10, max_value_usdc: 1_500 },
    ],
  });

  it("accepts a bid below max_value AND below risk-appetite ceiling", () => {
    // balanced upper = 0.92 → 0.92 * 5000 = 4600. 4500 is fine.
    const r = checkBidCeiling(
      cfg,
      { category: "Vintage Holo", grade: 10 },
      4500
    );
    expect(r.ok).toBe(true);
    expect(r.match?.max_value_usdc).toBe(5000);
    expect(r.hardCeiling).toBe(4600);
  });

  it("rejects bids above max_value_usdc with exceeds_max_value", () => {
    const r = checkBidCeiling(
      cfg,
      { category: "Vintage Holo", grade: 10 },
      5500 // > 5000
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("exceeds_max_value");
  });

  it("rejects bids above the risk-appetite ceiling even if below max_value", () => {
    // 4700 < 5000 (passes max_value) but > 0.92 * 5000 = 4600.
    const r = checkBidCeiling(
      cfg,
      { category: "Vintage Holo", grade: 10 },
      4700
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("exceeds_risk_appetite_ceiling");
    expect(r.hardCeiling).toBe(4600);
  });

  it("uses the most conservative matching want_list entry", () => {
    // A "Vintage Holo grade 10" lot matches the first entry only;
    // construct a lot that matches both, with different ceilings.
    const cfgBoth = exampleConfig({
      risk_appetite: "aggressive",
      want_list: [
        { category: "X", min_grade: 5, max_value_usdc: 8_000 },
        { category: "X", min_grade: 9, max_value_usdc: 3_000 }, // more conservative
      ],
    });
    // Aggressive upper = 0.99 → 0.99 * 3000 = 2970.
    const ok = checkBidCeiling(cfgBoth, { category: "X", grade: 10 }, 2900);
    expect(ok.ok).toBe(true);
    expect(ok.match?.max_value_usdc).toBe(3000);
    const overConservative = checkBidCeiling(
      cfgBoth,
      { category: "X", grade: 10 },
      4000
    );
    expect(overConservative.ok).toBe(false);
    expect(overConservative.reason).toBe("exceeds_max_value");
  });

  it("rejects when no want_list entry matches the lot", () => {
    const r = checkBidCeiling(
      cfg,
      { category: "Junk Wax", grade: 10 },
      100
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_matching_want_list");
  });

  it("rejects when grade is below the entry's min_grade", () => {
    // Vintage Holo requires min_grade=9, lot has grade 7.
    const r = checkBidCeiling(
      cfg,
      { category: "Vintage Holo", grade: 7 },
      4000
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_matching_want_list");
  });

  it("rejects non-positive bid amounts", () => {
    const zero = checkBidCeiling(
      cfg,
      { category: "Vintage Holo", grade: 10 },
      0
    );
    expect(zero.ok).toBe(false);
    expect(zero.reason).toBe("non_positive_amount");
    const neg = checkBidCeiling(
      cfg,
      { category: "Vintage Holo", grade: 10 },
      -100
    );
    expect(neg.ok).toBe(false);
    expect(neg.reason).toBe("non_positive_amount");
  });

  it("rejects non-finite amounts (NaN, Infinity)", () => {
    const nan = checkBidCeiling(
      cfg,
      { category: "Vintage Holo", grade: 10 },
      NaN
    );
    expect(nan.ok).toBe(false);
    expect(nan.reason).toBe("non_positive_amount");
    const inf = checkBidCeiling(
      cfg,
      { category: "Vintage Holo", grade: 10 },
      Infinity
    );
    expect(inf.ok).toBe(false);
    // Infinity > 0 trips the positive check first; we land on
    // exceeds_max_value because Number.isFinite catches it. Verify
    // the actual reason rather than guessing.
    expect(["non_positive_amount", "non_integer_amount"]).toContain(inf.reason);
  });

  it("rejects fractional bid amounts (whole-USDC-only invariant)", () => {
    const r = checkBidCeiling(
      cfg,
      { category: "Vintage Holo", grade: 10 },
      4500.5
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("non_integer_amount");
  });

  it("conservative ceiling caps at 80% of max_value", () => {
    const cfgC = exampleConfig({
      risk_appetite: "conservative",
      want_list: [
        { category: "X", min_grade: 5, max_value_usdc: 1000 },
      ],
    });
    // 0.80 × 1000 = 800. Bid 850 should reject.
    const r = checkBidCeiling(cfgC, { category: "X", grade: 10 }, 850);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("exceeds_risk_appetite_ceiling");
    expect(r.hardCeiling).toBe(800);
  });

  it("aggressive ceiling caps at 99% of max_value (still under 100%)", () => {
    const cfgA = exampleConfig({
      risk_appetite: "aggressive",
      want_list: [
        { category: "X", min_grade: 5, max_value_usdc: 1000 },
      ],
    });
    // 0.99 × 1000 = 990. 990 OK; 991 NO.
    expect(
      checkBidCeiling(cfgA, { category: "X", grade: 10 }, 990).ok
    ).toBe(true);
    expect(
      checkBidCeiling(cfgA, { category: "X", grade: 10 }, 991).ok
    ).toBe(false);
  });

  it("worked example: prompt-injection over-bid is caught", () => {
    // Principal has a $5,000 ceiling on Vintage Holo; a compromised
    // Claude returns $99,000 hoping to win the lot at any cost. The
    // remaining-budget check ($10K total budget) WOULD pass — only
    // the ceiling check stops the bid.
    const cfgVictim = exampleConfig({
      total_budget_usdc: 100_000, // huge budget, hides the attack
      risk_appetite: "balanced",
      want_list: [
        { category: "Vintage Holo", min_grade: 9, max_value_usdc: 5_000 },
      ],
    });
    const attack = checkBidCeiling(
      cfgVictim,
      { category: "Vintage Holo", grade: 10 },
      99_000
    );
    expect(attack.ok).toBe(false);
    expect(attack.reason).toBe("exceeds_max_value");
  });
});
