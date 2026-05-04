// Auction deposit auto-sizing. The on-chain program enforces a fixed
// `MIN_BID_DEPOSIT_LAMPORTS` floor (0.01 SOL); above that, the seller
// chooses `bid_deposit_lamports` per auction. Without auto-sizing,
// the auctioneer ships everyone the floor — fine for $50 lots,
// trivially exploitable on $5000 grail lots where 5 dust bids cost
// $7.50 against a $5000 prize.
//
// The sizing rule below scales the deposit linearly with the lot's
// upper estimate, so the spam tax stays proportional to what the
// attacker is trying to grief. v1 uses a hard-coded SOL/USDC rate;
// v2 should pull a price feed (Pyth, Switchboard) and enforce the
// rate inside the program.

export const MIN_BID_DEPOSIT_LAMPORTS = 10_000_000n; // 0.01 SOL — must equal the program constant
export const DEFAULT_DEPOSIT_RATIO_BPS = 100; // 1% of estimate_high_usdc
// Conservative SOL/USDC: 1 SOL = 200 USDC ⇒ 1 USDC = 0.005 SOL = 5_000_000 lamports.
// Sizing the deposit small-side keeps the floor inclusive even when
// SOL pumps; price-feed v2 fixes this directly.
export const DEFAULT_LAMPORTS_PER_USDC = 5_000_000n;

export interface DepositSizingInput {
  /** Upper estimate of the lot's value, in whole USDC. May be missing on some lots. */
  estimateHighUsdc?: number;
  /** Override the 1% default. Express in basis points (100 = 1%, 250 = 2.5%). */
  ratioBps?: number;
  /** Override the SOL/USDC rate. Express in lamports per whole USDC. */
  lamportsPerUsdc?: bigint;
  /** Override the floor (defaults to MIN_BID_DEPOSIT_LAMPORTS). */
  minLamports?: bigint;
}

/**
 * Compute the per-auction deposit a seller should advertise. Returns
 * a bigint of lamports; callers serialize to a u64 string for the on-chain
 * argument.
 *
 * Behaviour:
 *   - missing or non-positive `estimateHighUsdc` → return the floor.
 *   - computed ratio < floor → return the floor.
 *   - otherwise → return the ratio.
 */
export function computeBidDepositLamports(
  input: DepositSizingInput
): bigint {
  const min = input.minLamports ?? MIN_BID_DEPOSIT_LAMPORTS;
  if (
    input.estimateHighUsdc === undefined ||
    input.estimateHighUsdc === null ||
    !Number.isFinite(input.estimateHighUsdc) ||
    input.estimateHighUsdc <= 0
  ) {
    return min;
  }
  const ratioBps = BigInt(input.ratioBps ?? DEFAULT_DEPOSIT_RATIO_BPS);
  const lamportsPerUsdc = input.lamportsPerUsdc ?? DEFAULT_LAMPORTS_PER_USDC;
  // Truncate fractional USDC at the input boundary — sellers don't list
  // half-cents, and BigInt math forces integer ops anyway. floor is safe
  // because we clamp to min below.
  const usdcInt = BigInt(Math.floor(input.estimateHighUsdc));
  const computed = (usdcInt * lamportsPerUsdc * ratioBps) / 10_000n;
  return computed < min ? min : computed;
}
