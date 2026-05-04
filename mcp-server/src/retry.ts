// Exponential-backoff retry with jitter. Used to wrap RPC calls in
// `ops.ts` so transient failures (rate limits, gateway timeouts, dropped
// websockets) don't surface as bid placements that "just failed."
//
// We deliberately do NOT retry on errors that look like simulation
// reverts or invalid-input — only on transport-shaped errors. The
// classifier below errs on the side of "treat as transient" because a
// permanent error retried 3 times is annoying; a transient error not
// retried at all loses bids.

export interface RetryOptions {
  /** Total attempts including the first call. Default 5. */
  maxAttempts?: number;
  /** Base delay in milliseconds. Default 250. */
  baseDelayMs?: number;
  /** Cap on delay between attempts. Default 8_000. */
  maxDelayMs?: number;
  /** Tag for logs (e.g. "place_bid"). */
  label?: string;
  /** Custom logger. Defaults to console.warn. */
  logger?: (line: string) => void;
  /**
   * Return true if the error should be retried, false if it's terminal.
   * Defaults to `isLikelyTransient`.
   */
  isRetryable?: (err: unknown) => boolean;
}

const DEFAULT: Required<Omit<RetryOptions, "label" | "logger" | "isRetryable">> = {
  maxAttempts: 5,
  baseDelayMs: 250,
  maxDelayMs: 8_000,
};

/** Heuristic for "this looks like a network blip, not a logic error." */
export function isLikelyTransient(err: unknown): boolean {
  if (!err) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // Permanent shapes — bail out.
  if (
    msg.includes("insufficient funds") ||
    msg.includes("custom program error") ||
    msg.includes("anchor error") ||
    msg.includes("simulation failed") ||
    msg.includes("invalid signature") ||
    msg.includes("invalid program argument") ||
    msg.includes("instruction not implemented")
  ) {
    return false;
  }
  // Transient shapes — retry.
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("gateway") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("eai_again") ||
    msg.includes("socket hang up") ||
    msg.includes("blockhash not found") ||
    msg.includes("network request failed") ||
    msg.includes("fetch failed") ||
    // Solana web3.js wraps HTTP failures in this generic shape.
    msg.includes("failed to fetch")
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` with exponential backoff. Returns the resolved value on first
 * success; throws the last seen error after exhausting attempts.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const cfg = { ...DEFAULT, ...opts };
  const log = opts.logger ?? ((line: string) => console.warn(line));
  const retryable = opts.isRetryable ?? isLikelyTransient;
  const label = opts.label ?? "retry";

  let lastError: unknown;
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const transient = retryable(err);
      if (!transient || attempt === cfg.maxAttempts) {
        throw err;
      }
      const exp = Math.min(
        cfg.maxDelayMs,
        cfg.baseDelayMs * 2 ** (attempt - 1)
      );
      const jitter = exp * (0.5 + Math.random()); // [0.5x, 1.5x]
      log(
        `[${label}] attempt ${attempt}/${cfg.maxAttempts} failed: ${
          (err as Error).message ?? String(err)
        } — retrying in ${Math.round(jitter)}ms`
      );
      await sleep(jitter);
    }
  }
  throw lastError;
}
