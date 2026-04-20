/** Basis points in a whole. */
export const BPS_TOTAL = 10_000;

/** Satoshis in one BTC. */
export const SATS_PER_BTC = 100_000_000;

/** Upper bound on any amount accepted by this package, in BTC. */
export const MAX_AMOUNT_BTC = 21_000_000;

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Runtime object check. Takes `unknown` on purpose: callers pass values the type system
 * already believes are objects, and this package still validates them because queue
 * state can arrive from storage or an RPC boundary rather than from a compiler.
 */
export function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

export function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

export function isPositiveNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

export function isBps(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0 && value <= BPS_TOTAL;
}

export function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
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
