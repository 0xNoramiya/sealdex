// Pure helpers for the bidder agent. Side-effect-free so they can be
// unit-tested without filesystem or network access. The runtime loop in
// `index.ts` imports from here.

export interface WantListEntry {
  category: string;
  min_grade: number;
  max_value_usdc: number;
}

export interface BidderConfig {
  name: string;
  keypair_path: string;
  want_list: WantListEntry[];
  total_budget_usdc: number;
  risk_appetite: "conservative" | "balanced" | "aggressive";
}

export interface BidStateEntry {
  amountUsdc: number;
  reasoning: string;
  signature: string;
  ts: number;
}

export interface BidState {
  bidsPlaced: Record<string, BidStateEntry>;
}

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

/** Stable slug for filenames + state keys. */
export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** Whole-USDC remaining budget after accounting for all open bids. */
export function remainingBudget(
  cfg: Pick<BidderConfig, "total_budget_usdc">,
  state: BidState
): number {
  let spent = 0;
  for (const v of Object.values(state.bidsPlaced)) spent += v.amountUsdc;
  return cfg.total_budget_usdc - spent;
}

/** Build the per-lot context string Claude sees as the user message. */
export function buildLotContext(
  cfg: BidderConfig,
  state: BidState,
  entry: RegistryEntry,
  clusterUnixTime: number
): string {
  const md = entry.lot.lot_metadata;
  const timeLeftSeconds = Math.max(0, entry.endTimeUnix - clusterUnixTime);
  return [
    `# CURRENT LOT EVALUATION`,
    ``,
    `auction_id: ${entry.auctionId}`,
    `time_left_seconds: ${timeLeftSeconds}`,
    `risk_appetite: ${cfg.risk_appetite}`,
    `remaining_budget: ${remainingBudget(cfg, state)}`,
    ``,
    `want_list: ${JSON.stringify(cfg.want_list)}`,
    ``,
    `lot:`,
    `  category: ${md.category}`,
    `  grade: ${md.grade}`,
    `  year: ${md.year ?? "n/a"}`,
    `  serial: ${md.serial ?? "n/a"}`,
    `  estimate_low_usdc: ${md.estimate_low_usdc ?? "n/a"}`,
    `  estimate_high_usdc: ${md.estimate_high_usdc ?? "n/a"}`,
    `  cert_number: ${md.cert_number ?? "n/a"}`,
    ``,
    `Decide: bid via place_bid, or skip with a short text reply.`,
  ].join("\n");
}

/**
 * Risk-appetite multiplier ranges used to validate Claude's bid suggestion
 * against the principal's policy. Returns the [min, max] of acceptable
 * fractions of `max_value_usdc` for the given risk profile.
 */
export function riskFractionRange(
  appetite: BidderConfig["risk_appetite"]
): [number, number] {
  switch (appetite) {
    case "conservative":
      return [0.7, 0.8];
    case "balanced":
      return [0.8, 0.92];
    case "aggressive":
      return [0.92, 0.99];
  }
}

/**
 * Cheap pre-check: does ANY want-list entry match this lot? Used by the
 * bidder loop to skip Claude entirely when a lot can't possibly match.
 * Saves API calls + cache writes during high-volume catalogs.
 */
export function lotMatchesWantList(
  wantList: WantListEntry[],
  lot: { category?: string; grade?: number }
): boolean {
  if (!lot.category || typeof lot.grade !== "number") return false;
  return wantList.some(
    (w) => w.category === lot.category && lot.grade! >= w.min_grade
  );
}

/**
 * Returns the most conservative (lowest max_value_usdc) want-list entry
 * the lot matches, or null when no entry matches. Mirrors the
 * "if multiple match, use the lowest" rule from AGENTS.md.
 */
export function chooseWantListEntry(
  wantList: WantListEntry[],
  lot: { category: string; grade: number }
): WantListEntry | null {
  const matches = wantList.filter(
    (w) => w.category === lot.category && lot.grade >= w.min_grade
  );
  if (matches.length === 0) return null;
  return matches.reduce((a, b) =>
    a.max_value_usdc <= b.max_value_usdc ? a : b
  );
}

export type CeilingViolation =
  | "no_matching_want_list"
  | "exceeds_max_value"
  | "exceeds_risk_appetite_ceiling"
  | "non_positive_amount"
  | "non_integer_amount";

export interface CeilingCheckResult {
  ok: boolean;
  reason?: CeilingViolation;
  /** The matching want-list entry, if one was found. */
  match?: WantListEntry;
  /** Hard ceiling derived from match.max_value_usdc + risk multiplier. */
  hardCeiling?: number;
}

/**
 * Validates a Claude-suggested bid amount against the principal's policy.
 *
 * Why this is the load-bearing safety check, not a nice-to-have:
 *
 * The bidder agent talks to a remote LLM that consumes attacker-controlled
 * inputs (registry entries, lot metadata). A compromised Claude or a
 * prompt-injection inside `lot_metadata_uri` could bias the model into
 * suggesting a bid far above the principal's stated ceiling. The
 * remaining-budget check alone doesn't catch this — a $99K bid on a $5K
 * lot fits comfortably under a $100K total budget.
 *
 * This validator is the last line of defense before the bidder signs
 * `place_bid`. Hard reject (not clamp) on violation: clamping silently
 * masks the attack; rejecting surfaces it via the streamLog so the
 * operator can investigate.
 *
 * Rules enforced (matches AGENTS.md):
 *   - amount must match SOMETHING in want_list (category + grade ≥ min_grade)
 *   - amount must be a positive integer (whole-USDC only)
 *   - amount must NOT exceed match.max_value_usdc
 *   - amount must NOT exceed match.max_value_usdc × upper-bound-of-risk-appetite
 *     (99% for aggressive, 92% for balanced, 80% for conservative)
 */
export function checkBidCeiling(
  cfg: Pick<BidderConfig, "want_list" | "risk_appetite">,
  lot: { category?: string; grade?: number },
  amountUsdc: number
): CeilingCheckResult {
  if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
    return { ok: false, reason: "non_positive_amount" };
  }
  if (!Number.isInteger(amountUsdc)) {
    return { ok: false, reason: "non_integer_amount" };
  }
  if (typeof lot.category !== "string" || typeof lot.grade !== "number") {
    return { ok: false, reason: "no_matching_want_list" };
  }
  const match = chooseWantListEntry(cfg.want_list, {
    category: lot.category,
    grade: lot.grade,
  });
  if (!match) {
    return { ok: false, reason: "no_matching_want_list" };
  }
  if (amountUsdc > match.max_value_usdc) {
    return { ok: false, reason: "exceeds_max_value", match };
  }
  // The risk-appetite ceiling caps the bid at the upper bound of the
  // configured range. Aggressive bidders can use up to 99%; balanced up
  // to 92%; conservative up to 80%. Going above this means Claude
  // ignored the principal's stated risk policy.
  const [, upper] = riskFractionRange(cfg.risk_appetite);
  const hardCeiling = Math.floor(match.max_value_usdc * upper);
  if (amountUsdc > hardCeiling) {
    return {
      ok: false,
      reason: "exceeds_risk_appetite_ceiling",
      match,
      hardCeiling,
    };
  }
  return { ok: true, match, hardCeiling };
}
