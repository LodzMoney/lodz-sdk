/**
 * Canonical LODZ domain types.
 *
 * This module is the single source of truth for the shapes every other LODZ
 * package consumes. Do not redefine these types elsewhere; import them.
 */

/**
 * Who actually pays the yield.
 *
 * - `sustainable`: an outside user pays for a service the seam performs.
 *   Swap fees and borrow interest. It survives token programs.
 * - `emissions`: an incentive token program pays it. It stops on a date.
 * - `counterparty`: someone on the other side of a trade loses it. It looks
 *   like a fee and behaves nothing like one, because it depends on traders
 *   continuing to lose. Folding it into `sustainable` misleads the holder.
 */
export type YieldKind = "sustainable" | "emissions" | "counterparty";

/** The mechanism a seam uses to produce yield. */
export type SeamVenueKind = "lending" | "lp" | "basis";

/** Coarse risk banding used across the product surface. */
export type RiskTier = "low" | "medium" | "high";

/** Stope vault profiles. Each maps to a different allocation policy. */
export type StopeProfile = "conservative" | "balanced" | "aggressive";

/**
 * How correlated the two sides of an LP position are. Carried as supplied
 * metadata. It is never turned into an impermanent loss number: labelling the
 * exposure is honest, inventing a figure for it is not.
 */
export type PairVolatilityClass = "correlated" | "mixed" | "uncorrelated";

/** Which observation the engine quoted a seam's rate from. */
export type ApyBasis = "90d-median" | "7d" | "spot";

export const YIELD_KINDS: readonly YieldKind[] = ["sustainable", "emissions", "counterparty"];
export const SEAM_VENUE_KINDS: readonly SeamVenueKind[] = ["lending", "lp", "basis"];
export const RISK_TIERS: readonly RiskTier[] = ["low", "medium", "high"];
export const STOPE_PROFILES: readonly StopeProfile[] = [
  "conservative",
  "balanced",
  "aggressive",
];
export const PAIR_VOLATILITY_CLASSES: readonly PairVolatilityClass[] = [
  "correlated",
  "mixed",
  "uncorrelated",
];

/**
 * One yield source in the portfolio.
 *
 * A venue that pays both a service fee and an incentive token is modelled as
 * TWO seams sharing a venue, one per `yieldKind`. The engine refuses to fold
 * them together, because folding them together is exactly the accounting that
 * makes a temporary number look permanent.
 */
export interface Seam {
  /** Stable identifier, unique within a portfolio. */
  id: string;
  /** Human readable seam name shown in the Seam Map. */
  name: string;
  /** Protocol that operates the venue. Real protocol names only. */
  venue: string;
  /** BTC representation symbol, e.g. cbBTC / zBTC / tBTC. Not bitcoin itself. */
  asset: string;
  /** SPL mint address of the BTC representation. */
  assetMint: string;
  kind: SeamVenueKind;
  yieldKind: YieldKind;
  /**
   * Spot annualized rate in basis points, as most recently observed.
   *
   * Never quoted on its own when a smoothed observation exists: spot rates on
   * thin pools produce artifacts several orders of magnitude off reality.
   */
  apyBps: number;
  /** Trailing 7 day rate in bps, or null when the source does not publish one. */
  apy7dBps: number | null;
  /** 90 day median rate in bps, or null when the source does not publish one. */
  apy90dMedianBps: number | null;
  /** Total value locked in the venue, USD. Never negative. */
  tvlUsd: number;
  /** Share of portfolio capital routed here, in basis points. */
  allocationBps: number;
  /**
   * Estimated annual impermanent loss drag in bps, or null when it has not
   * been calculated. Null means unknown and is reported as unknown. The engine
   * never fills it in.
   */
  ilEstimateBps: number | null;
  /** Correlation class of the pair, or null for positions that have no pair. */
  pairVolatilityClass: PairVolatilityClass | null;
  /**
   * True when the venue cannot absorb meaningful capital. The engine also
   * derives this from `tvlUsd`; either source excludes the seam from routing.
   */
  belowLiquidityFloor: boolean;
  /** True when two independent sources disagree beyond the accepted threshold. */
  sourceDivergence: boolean;
  /** Incentive token symbol. Required when `yieldKind` is `emissions`. */
  emissionToken: string | null;
  /** ISO-8601 instant the incentive program ends. Required for `emissions`. */
  emissionEndsAt: string | null;
  riskTier: RiskTier;
  /** Where the numbers above came from. */
  sourceUrl: string;
  /** ISO-8601 instant the numbers above were last refreshed. */
  updatedAt: string;
}

/**
 * Capital split across seams, keyed by seam id, in basis points.
 * Must sum to exactly 10000.
 */
export type Allocation = Readonly<Record<string, number>>;

/** An instant to evaluate against. Strings must be ISO-8601. */
export type EvaluationInstant = string | Date;

/** A BTC amount carried as integer satoshis plus a display decimal. */
export interface Amount {
  /** Integer satoshis. Authoritative value. */
  sats: number;
  /** Same amount in BTC, rounded to 8 decimals. Display only. */
  btc: number;
}

/** A BTC amount broken down by who paid it. */
export interface AmountSplit {
  total: Amount;
  sustainable: Amount;
  emissions: Amount;
  counterparty: Amount;
}

/** A basis point figure broken down by who paid it. */
export interface BpsSplit {
  total: number;
  sustainable: number;
  emissions: number;
  counterparty: number;
}
