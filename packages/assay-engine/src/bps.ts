import { AssayError } from "./errors.js";

/** Basis point denominator. 10000 bps == 100%. */
export const BPS_DENOMINATOR = 10_000;

/** Satoshis per BTC. All internal amount math runs on integer satoshis. */
export const SATS_PER_BTC = 100_000_000;

/** Day count convention for annualization. Simple interest, no compounding. */
export const DAYS_PER_YEAR = 365;

export const MS_PER_DAY = 86_400_000;

export const MS_PER_YEAR = DAYS_PER_YEAR * MS_PER_DAY;

/** Integer division rounded half away from zero. */
export function roundDivInt(numerator: number, denominator: number): number {
  if (denominator === 0) {
    throw new AssayError("INVALID_INPUT", "division by zero");
  }
  const quotient = numerator / denominator;
  return quotient >= 0 ? Math.round(quotient) : -Math.round(-quotient);
}

/** BigInt division rounded half away from zero. */
export function roundDivBig(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new AssayError("INVALID_INPUT", "division by zero");
  }
  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;
  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;
  const rounded = remainder * 2n >= absDenominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** Round a float to `digits` decimals so serialized output stays stable. */
export function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  const scaled = value * factor;
  const rounded = scaled >= 0 ? Math.round(scaled) : -Math.round(-scaled);
  return rounded / factor;
}

/**
 * Split `totalUnits` integer units across `weights` using the largest
 * remainder method.
 *
 * The returned array always sums to exactly `totalUnits`. Leftover units go to
 * the entries with the largest fractional remainder; ties break toward the
 * larger whole share, then toward the lower index. Floating point weights are
 * accepted, but the output is integral and the sum is exact, so downstream
 * basis point totals never wander off 10000.
 */
export function allocateUnits(weights: readonly number[], totalUnits: number): number[] {
  if (!Number.isInteger(totalUnits) || totalUnits < 0) {
    throw new AssayError(
      "INVALID_INPUT",
      `total units must be a non-negative integer, received ${String(totalUnits)}`,
    );
  }
  const count = weights.length;
  if (count === 0) {
    if (totalUnits === 0) return [];
    throw new AssayError("EMPTY_PORTFOLIO", "cannot distribute units across zero entries");
  }

  let weightSum = 0;
  for (const weight of weights) {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new AssayError(
        "INVALID_INPUT",
        `weights must be finite and non-negative, received ${String(weight)}`,
      );
    }
    weightSum += weight;
  }
  if (weightSum <= 0) {
    throw new AssayError("INVALID_ALLOCATION", "cannot distribute units across zero total weight");
  }

  const base: number[] = new Array<number>(count).fill(0);
  const remainder: number[] = new Array<number>(count).fill(0);
  let assigned = 0;

  for (let index = 0; index < count; index += 1) {
    const exact = ((weights[index] ?? 0) * totalUnits) / weightSum;
    const floored = Math.floor(exact);
    base[index] = floored;
    remainder[index] = exact - floored;
    assigned += floored;
  }

  const order = Array.from({ length: count }, (_unused, index) => index).sort((a, b) => {
    const byRemainder = (remainder[b] ?? 0) - (remainder[a] ?? 0);
    if (byRemainder !== 0) return byRemainder;
    const byBase = (base[b] ?? 0) - (base[a] ?? 0);
    if (byBase !== 0) return byBase;
    return a - b;
  });

  let leftover = totalUnits - assigned;
  let cursor = 0;
  while (leftover > 0) {
    const index = order[cursor % count] ?? 0;
    base[index] = (base[index] ?? 0) + 1;
    leftover -= 1;
    cursor += 1;
  }
  // Defensive: float error could in principle over-assign. Take units back from
  // the smallest remainders rather than returning a total that is not exact.
  let guard = 0;
  while (leftover < 0 && guard < count * 4) {
    const index = order[count - 1 - (guard % count)] ?? 0;
    if ((base[index] ?? 0) > 0) {
      base[index] = (base[index] ?? 0) - 1;
      leftover += 1;
    }
    guard += 1;
  }
  if (leftover !== 0) {
    throw new AssayError("INVALID_ALLOCATION", "unit distribution failed to reach an exact total");
  }

  return base;
}

/** Split 10000 basis points across `weights`. Always sums to exactly 10000. */
export function allocateBps(weights: readonly number[], totalBps = BPS_DENOMINATOR): number[] {
  return allocateUnits(weights, totalBps);
}

/** Sum a basis point map. */
export function sumBps(values: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const value of Object.values(values)) total += value;
  return total;
}
