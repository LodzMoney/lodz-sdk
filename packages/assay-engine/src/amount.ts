import { BPS_DENOMINATOR, MS_PER_YEAR, SATS_PER_BTC, roundDivBig, roundTo } from "./bps.js";
import { AssayError } from "./errors.js";
import type { Amount } from "./types.js";

const BPS_DENOMINATOR_BIG = BigInt(BPS_DENOMINATOR);
const MS_PER_YEAR_BIG = BigInt(MS_PER_YEAR);

/** Convert decimal BTC to integer satoshis. */
export function btcToSats(btcAmount: number): bigint {
  if (typeof btcAmount !== "number" || !Number.isFinite(btcAmount) || btcAmount < 0) {
    throw new AssayError(
      "INVALID_INPUT",
      `btcAmount must be a finite non-negative number, received ${String(btcAmount)}`,
      { field: "btcAmount" },
    );
  }
  return BigInt(Math.round(btcAmount * SATS_PER_BTC));
}

/** Wrap integer satoshis as a display-ready amount. */
export function amountFromSats(sats: bigint): Amount {
  const asNumber = Number(sats);
  if (!Number.isSafeInteger(asNumber)) {
    throw new AssayError("INVALID_INPUT", "amount exceeds the safe integer range for satoshis");
  }
  return { sats: asNumber, btc: roundTo(asNumber / SATS_PER_BTC, 8) };
}

export const ZERO_AMOUNT: Amount = { sats: 0, btc: 0 };

/**
 * Simple (non-compounding) accrual on integer satoshis.
 *
 * principal * allocationBps/10000 * apyBps/10000 * elapsedMs/yearMs
 *
 * Every factor stays integral until one final rounded division, so the sum of
 * per-seam accruals equals the portfolio accrual exactly. No compounding is
 * applied: compounding a quoted APY is a common way to inflate a projection.
 */
export function accrueSats(
  principalSats: bigint,
  allocationBps: number,
  apyBps: number,
  elapsedMs: number,
): bigint {
  if (!Number.isInteger(elapsedMs) || elapsedMs < 0) {
    throw new AssayError(
      "INVALID_INPUT",
      `elapsed milliseconds must be a non-negative integer, received ${String(elapsedMs)}`,
    );
  }
  if (allocationBps === 0 || apyBps === 0 || elapsedMs === 0 || principalSats === 0n) return 0n;
  const numerator =
    principalSats * BigInt(allocationBps) * BigInt(apyBps) * BigInt(elapsedMs);
  const denominator = BPS_DENOMINATOR_BIG * BPS_DENOMINATOR_BIG * MS_PER_YEAR_BIG;
  return roundDivBig(numerator, denominator);
}

/**
 * Annualize a realized accrual back into basis points.
 * Returns 0 when there is no principal or no elapsed time.
 */
export function annualizeBps(
  accruedSats: bigint,
  principalSats: bigint,
  elapsedMs: number,
): number {
  if (principalSats <= 0n || elapsedMs <= 0) return 0;
  const numerator = accruedSats * BPS_DENOMINATOR_BIG * MS_PER_YEAR_BIG;
  const denominator = principalSats * BigInt(Math.round(elapsedMs));
  return Number(roundDivBig(numerator, denominator));
}
