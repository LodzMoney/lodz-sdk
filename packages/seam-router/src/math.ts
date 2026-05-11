/** Basis points in a whole. */
export const BPS_TOTAL = 10_000;

/** Satoshis in one BTC. */
export const SATS_PER_BTC = 100_000_000;

/** Slack used when comparing floating-point shares. */
export const EPSILON = 1e-9;

/** Upper bound on capital accepted by this package, in BTC. */
export const MAX_CAPITAL_BTC = 21_000_000;

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Runtime object check. Takes `unknown` on purpose: callers pass values the type system
 * already believes are objects, and this package still validates them because the data
 * arrives from an indexer rather than from a compiler.
 */
export function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

export function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

export function isBps(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0 && value <= BPS_TOTAL;
}

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function btcToSats(btc: number): number {
  return Math.round(btc * SATS_PER_BTC);
}

export function satsToBtc(sats: number): number {
  return roundTo(sats / SATS_PER_BTC, 8);
}

/**
 * Split an integer `total` across `weights` so that every part is an integer and the
 * parts sum to exactly `total`.
 *
 * Uses the largest-remainder method. Ties are broken by ascending index, so the same
 * inputs always produce the same split. Buckets with a non-positive weight always
 * receive zero, which is what keeps a zero-weight seam from picking up stray dust.
 */
export function largestRemainder(weights: readonly number[], total: number): number[] {
  const count = weights.length;
  const parts = new Array<number>(count).fill(0);
  if (count === 0 || total <= 0) return parts;

  let weightSum = 0;
  for (const weight of weights) {
    if (weight > 0) weightSum += weight;
  }
  if (weightSum <= 0) return parts;

  const remainders: Array<{ index: number; fraction: number }> = [];
  let assigned = 0;

  for (let index = 0; index < count; index += 1) {
    const weight = weights[index] > 0 ? weights[index] : 0;
    if (weight <= 0) continue;
    // Divide before multiplying: `total * weight` overflows exact integer range for
    // large satoshi totals, while `weight / weightSum` stays in [0, 1].
    const exact = total * (weight / weightSum);
    const floored = Math.floor(exact);
    parts[index] = floored;
    assigned += floored;
    remainders.push({ index, fraction: exact - floored });
  }

  remainders.sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  let leftover = total - assigned;
  for (const entry of remainders) {
    if (leftover <= 0) break;
    parts[entry.index] += 1;
    leftover -= 1;
  }

  return parts;
}

/** Sum of a numeric array, written out so intent is obvious at call sites. */
export function sum(values: readonly number[]): number {
  let acc = 0;
  for (const value of values) acc += value;
  return acc;
}
