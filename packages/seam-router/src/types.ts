/**
 * Domain vocabulary shared across the LODZ core packages.
 *
 * The canonical home for `YieldKind`, `SeamVenueKind`, `RiskTier`, `StopeProfile`,
 * `PairVolatilityClass` and `Seam` is `lodz-assay-engine`. The declarations below are a
 * shape-identical local mirror so this package compiles, tests and publishes on its own
 * schedule.
 *
 * re-exported from lodz-assay-engine once published
 */

/**
 * Where a unit of yield actually comes from.
 *
 * - `sustainable`: trading fees or borrow interest. Money an outside user actually paid.
 * - `emissions`: a protocol token emission schedule. Money the issuer printed, and it
 *   ends on a known date.
 * - `counterparty`: the losing side of a trade. It looks like fee yield on a chart, but
 *   it is funded by someone else's loss, which caps its capacity and makes it revert.
 */
export type YieldKind = "sustainable" | "emissions" | "counterparty";

/** The mechanism a seam uses to produce yield. */
export type SeamVenueKind = "lending" | "lp" | "basis";

/** Coarse risk banding assigned by the LODZ risk layer. */
export type RiskTier = "low" | "medium" | "high";

/** Depositor-selected vault posture. */
export type StopeProfile = "conservative" | "balanced" | "aggressive";

/**
 * How correlated the two sides of an LP pair are, which is what decides whether
 * impermanent loss is a rounding error or larger than the fees.
 */
export type PairVolatilityClass = "correlated" | "mixed" | "uncorrelated";

/** A single yield seam that capital can be routed into. */
export interface Seam {
  id: string;
  name: string;
  venue: string;
  asset: string;
  assetMint: string;
  kind: SeamVenueKind;
  yieldKind: YieldKind;
  /**
   * Spot rate, in basis points.
   *
   * Never routed on directly. A low-TVL moment produces arithmetic artifacts: the Orca
   * cbBTC-USDC history contains a day reading 74,187 percent. Kept only so the planner
   * can report that it was rejected.
   */
  apyBps: number;
  /** Trailing seven day rate, in basis points. */
  apy7dBps: number | null;
  /** Trailing thirty day rate, in basis points. */
  apy30dBps: number | null;
  /** Ninety day median rate, in basis points. The most durable figure when available. */
  apy90dMedianBps: number | null;
  tvlUsd: number;
  allocationBps: number;
  emissionToken: string | null;
  emissionEndsAt: string | null;
  riskTier: RiskTier;
  /**
   * True when the venue cannot absorb meaningful capital. The router also derives this
   * from `tvlUsd`; either signal excludes the seam from routing.
   */
  belowLiquidityFloor: boolean;
  /**
   * True when two independent sources disagree about this seam beyond the accepted
   * threshold. A rate only one source can see is not a rate worth routing capital on.
   */
  sourceDivergence: boolean;
  /**
   * Estimated impermanent loss over the measurement window, in basis points, to be
   * subtracted from the gross rate.
   *
   * `null` means nobody has measured it. It does not mean zero, and this package never
   * substitutes a made-up figure for a missing one.
   */
  ilEstimateBps: number | null;
  pairVolatilityClass: PairVolatilityClass | null;
  /**
   * Custody hops the underlying BTC passes through. Each hop multiplies the trust
   * assumptions: 1 for a direct custodial or program-controlled mint, 2 for a bridged
   * representation that was already wrapped on another chain.
   */
  wrapHops: number;
  sourceUrl: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Allocation constraints
// ---------------------------------------------------------------------------

/**
 * Routing policy that varies by depositor posture.
 *
 * Emission-funded yield is currently absent from the Solana BTC market, so an emissions
 * ceiling alone no longer separates the three postures. The axes that actually separate
 * them today are counterparty-funded yield, uncorrelated LP exposure, and how many
 * custody hops the underlying is allowed to travel. The emissions ceiling is kept
 * because the market has had emissions before and will again.
 */
export interface ProfilePolicy {
  /**
   * Ceiling on capital routed into yield funded by someone else's trading loss, in
   * basis points of total capital.
   */
  maxCounterpartyBps: number;
  /**
   * Ceiling on LP positions whose two sides are uncorrelated, in basis points of total
   * capital. These are the positions where impermanent loss can exceed the fees.
   */
  maxUncorrelatedLpBps: number;
  /** Ceiling on capital routed into emission-funded seams, in basis points of total capital. */
  maxEmissionsBps: number;
  /** Ceiling on aggregate exposure to a single venue, in basis points of total capital. */
  maxSingleVenueBps: number;
  /** Ceiling on aggregate exposure to a single asset, in basis points of total capital. */
  maxSingleAssetBps: number;
  /** Most custody hops this posture will accept. 1 rules out doubly wrapped assets. */
  maxWrapHops: number;
  /** Ceiling on aggregate exposure to each risk tier, in basis points of total capital. */
  maxRiskTierBps: Record<RiskTier, number>;
  /**
   * Whether this posture will hold an LP seam whose impermanent loss nobody has
   * measured. A conservative book will not: an unmeasured cost is still a cost.
   */
  allowIlUnknown: boolean;
  /**
   * How hard the scorer discounts risk, emission dependence, counterparty funding,
   * uncorrelated pairing and unmeasured impermanent loss. 10000 applies the full
   * penalty, 0 ranks purely on the headline rate.
   */
  riskAversionBps: number;
  /** Capital deliberately left undeployed so the redemption queue has something to draw on. */
  liquidityBufferBps: number;
}

/** Fully resolved constraint set used by {@link planAllocation}. */
export interface AllocationConstraints {
  profiles: Record<StopeProfile, ProfilePolicy>;
  /** Ceiling on a single seam, in basis points of total capital. */
  maxSeamBps: number;
  /** Allocations below this size are not worth their execution and monitoring cost. */
  minSeamBps: number;
  /**
   * Hard liquidity floor. A seam thinner than this is excluded outright, however
   * attractive its rate looks. Zeus Bitcoin Market USDC advertises 104 percent against
   * 10,927 dollars of capacity; routing real capital there would be a lie.
   */
  minTvlUsd: number;
  /** Maximum number of seams held at once. */
  maxSeams: number;
  /**
   * Ceiling on the share of a seam's own TVL that LODZ may occupy, in basis points.
   * Capital large enough to dominate a pool does not earn the rate that pool displays.
   */
  maxShareOfTvlBps: number;
  /**
   * How far the spot rate may exceed the durable rate before the spot reading is
   * treated as an artifact and flagged.
   */
  spotRejectMultiple: number;
  /**
   * Window over which an emission schedule is treated as fully durable. An emission
   * ending sooner than this is weighted down proportionally. Only applied when `now`
   * is supplied to {@link planAllocation}.
   */
  emissionsHorizonDays: number;
}

/** Partial override of {@link ProfilePolicy}. */
export interface ProfilePolicyInput {
  maxCounterpartyBps?: number;
  maxUncorrelatedLpBps?: number;
  maxEmissionsBps?: number;
  maxSingleVenueBps?: number;
  maxSingleAssetBps?: number;
  maxWrapHops?: number;
  maxRiskTierBps?: Partial<Record<RiskTier, number>>;
  allowIlUnknown?: boolean;
  riskAversionBps?: number;
  liquidityBufferBps?: number;
}

/** Partial override of {@link AllocationConstraints}. */
export interface AllocationConstraintsInput {
  profiles?: Partial<Record<StopeProfile, ProfilePolicyInput>>;
  maxSeamBps?: number;
  minSeamBps?: number;
  minTvlUsd?: number;
  maxSeams?: number;
  maxShareOfTvlBps?: number;
  spotRejectMultiple?: number;
  emissionsHorizonDays?: number;
}

// ---------------------------------------------------------------------------
// Allocation planning
// ---------------------------------------------------------------------------

export interface AllocationInput {
  seams: readonly Seam[];
  stope: StopeProfile;
  capitalBtc: number;
  /**
   * BTC reference price. Required: the share-of-TVL ceiling and the liquidity floor are
   * denominated in USD, and they cannot be enforced without it.
   */
  btcPriceUsd: number;
  constraints?: AllocationConstraintsInput;
  /**
   * ISO-8601 timestamp used to age emission schedules. Supplied by the caller so the
   * planner stays deterministic; this package never reads the system clock.
   */
  now?: string;
}

/** Which trailing window supplied the rate the planner actually used. */
export type ApySource = "apy90dMedian" | "apy30d" | "apy7d";

/** Why a seam received no allocation. */
export type ExclusionReason =
  | "below-min-tvl"
  | "source-divergence"
  | "no-durable-apy"
  | "non-positive-apy"
  | "wrap-hops-exceeded"
  | "counterparty-not-allowed"
  | "uncorrelated-lp-not-allowed"
  | "risk-tier-not-allowed"
  | "il-unknown"
  | "emissions-ended"
  | "zero-weight"
  | "max-seams"
  | "below-min-allocation"
  | "no-headroom";

/** Which ceiling stopped a seam from growing further. */
export type BindingCap =
  | "seam"
  | "seam-tvl"
  | "counterparty"
  | "uncorrelated-lp"
  | "emissions"
  | "risk-tier"
  | "venue"
  | "asset"
  | null;

export interface SeamAllocation {
  seamId: string;
  name: string;
  venue: string;
  asset: string;
  kind: SeamVenueKind;
  yieldKind: YieldKind;
  riskTier: RiskTier;
  wrapHops: number;
  pairVolatilityClass: PairVolatilityClass | null;
  /** The durable rate the planner used, before impermanent loss. */
  grossApyBps: number;
  /** Which trailing window `grossApyBps` came from. */
  apySource: ApySource;
  /** The spot rate, carried through for display only. */
  spotApyBps: number;
  /** True when the spot rate exceeded the durable rate by more than the allowed multiple. */
  spotRejected: boolean;
  ilEstimateBps: number | null;
  /** `grossApyBps` less impermanent loss. Null when nobody has measured the loss. */
  netApyBps: number | null;
  /** True when this is an LP seam whose impermanent loss is unmeasured. */
  ilUnknown: boolean;
  allocationBps: number;
  capitalBtc: number;
  capitalSats: number;
  /** Risk-adjusted score used for ranking. Relative magnitudes are what matter. */
  weight: number;
  bindingCap: BindingCap;
}

export interface ExcludedSeam {
  seamId: string;
  reason: ExclusionReason;
  detail: string;
}

export interface AllocationPlan {
  stope: StopeProfile;
  capitalBtc: number;
  capitalSats: number;
  capitalUsd: number;
  allocations: SeamAllocation[];
  /** Capital held back, in basis points. `sum(allocations) + idleBps === 10000` always. */
  idleBps: number;
  idleBtc: number;
  idleSats: number;
  totalAllocatedBps: number;
  /** Exposure by yield source, in basis points of total capital. */
  byYieldKind: Record<YieldKind, number>;
  sustainableBps: number;
  emissionsBps: number;
  counterpartyBps: number;
  /** Exposure to LP pairs whose sides are uncorrelated, in basis points of total capital. */
  uncorrelatedLpBps: number;
  /** Capital sitting in seams whose impermanent loss is unmeasured, in basis points. */
  ilUnknownBps: number;
  byRiskTier: Record<RiskTier, number>;
  byVenue: Record<string, number>;
  byAsset: Record<string, number>;
  byWrapHops: Record<string, number>;
  /** Blended durable rate over total capital, before impermanent loss. */
  blendedGrossApyBps: number;
  /** Blended rate contributed by each yield source, over total capital. */
  apyByYieldKindBps: Record<YieldKind, number>;
  /**
   * Blended rate after impermanent loss, over total capital.
   *
   * Null when any allocated seam has unmeasured impermanent loss, because a net figure
   * that silently treats an unmeasured cost as zero is the exact overstatement this
   * package exists to avoid.
   */
  blendedNetApyBps: number | null;
  excluded: ExcludedSeam[];
  constraints: AllocationConstraints;
}

// ---------------------------------------------------------------------------
// Rebalancing
// ---------------------------------------------------------------------------

export interface AllocationSnapshot {
  seamId: string;
  allocationBps: number;
}

export interface RebalanceInput {
  current: readonly AllocationSnapshot[];
  target: readonly AllocationSnapshot[];
  /** Deltas smaller than this are left alone; churn below it is not worth executing. */
  minDeltaBps: number;
  /** Execution cost charged on moved notional, in basis points of the amount moved. */
  gasCostBps: number;
  /** Optional, used to express moves in BTC as well as basis points. */
  capitalBtc?: number;
  /** Optional APY map; supplying it plus `horizonDays` enables the cost/benefit gate. */
  apyBpsBySeamId?: Record<string, number>;
  /** Horizon over which a move must earn back its execution cost. */
  horizonDays?: number;
  /**
   * Seams that must be reduced regardless of what the trade earns.
   *
   * A position that breached a ceiling has to come down whether or not the move is
   * accretive, and it almost never is: the seam that breached its ceiling is usually the
   * highest-yielding one in the book. Without this, the cost/benefit gate would quietly
   * make every risk ceiling unenforceable.
   */
  forcedExitSeamIds?: readonly string[];
}

export type SkipReason = "below-min-delta" | "cost-exceeds-gain" | "unmatched";

export interface SkippedMove {
  reason: SkipReason;
  /** Magnitude that was not executed, in basis points. */
  bps: number;
  seamId?: string;
  fromSeamId?: string;
  toSeamId?: string;
  detail: string;
}

export interface RebalanceMove {
  fromSeamId: string;
  toSeamId: string;
  bps: number;
  btc: number | null;
  /** Execution cost of this move, in basis points of total capital. */
  costBps: number;
  /** Expected gain over `horizonDays`, in basis points of total capital. Null without APY data. */
  expectedGainBps: number | null;
}

export interface RebalancePlan {
  moves: RebalanceMove[];
  skipped: SkippedMove[];
  /** Total capital moved, in basis points of total capital. */
  turnoverBps: number;
  estimatedCostBps: number;
  expectedGainBps: number | null;
  resulting: AllocationSnapshot[];
  /** Absolute distance from `resulting` to `target`, summed over seams. */
  residualDriftBps: number;
}

// ---------------------------------------------------------------------------
// Realized yield
// ---------------------------------------------------------------------------

export interface RealizedYieldEntry {
  seamId: string;
  venue: string;
  asset: string;
  yieldKind: YieldKind;
  /** Realized amount expressed in BTC at the time it was booked. */
  amountBtc: number;
  /** Token actually received. Emission payouts are rarely denominated in BTC. */
  token: string;
  /** ISO-8601 timestamp of the payout. */
  at: string;
}

export interface AggregateWindow {
  /** Inclusive lower bound, ISO-8601. */
  from?: string;
  /** Exclusive upper bound, ISO-8601. */
  to?: string;
}

export interface YieldBucket {
  btc: number;
  sats: number;
  entries: number;
  shareBps: number;
}

export interface SplitBucket extends YieldBucket {
  sustainableBtc: number;
  emissionsBtc: number;
  counterpartyBtc: number;
  sustainableShareBps: number;
  emissionsShareBps: number;
  counterpartyShareBps: number;
}

export interface RealizedYieldReport {
  totalBtc: number;
  totalSats: number;
  entryCount: number;
  byYieldKind: Record<YieldKind, YieldBucket>;
  bySeam: Record<string, SplitBucket>;
  byVenue: Record<string, SplitBucket>;
  byToken: Record<string, YieldBucket>;
  /** Convenience mirrors of `byYieldKind`, in basis points of total realized yield. */
  sustainableShareBps: number;
  emissionsShareBps: number;
  counterpartyShareBps: number;
  window: { from: string | null; to: string | null };
  observed: { first: string | null; last: string | null };
  skippedOutOfWindow: number;
}

// ---------------------------------------------------------------------------
// Keeper bond
// ---------------------------------------------------------------------------

export interface SlashCondition {
  code: string;
  description: string;
  /** Portion of the posted bond forfeited when this condition trips, in basis points. */
  slashBps: number;
  /** Grace period before the condition is enforceable. */
  graceSeconds?: number;
}

export interface KeeperBondParams {
  btcPriceUsd: number;
  lodzPriceUsd: number;
  /** Bond size as a share of managed notional, in basis points. */
  bondRateBps: number;
  minBondUsd: number;
  maxBondUsd: number;
  slashConditions: readonly SlashCondition[];
  /** Optional posture multiplier, in basis points. 10000 leaves the rate unchanged. */
  profileMultiplierBps?: Record<StopeProfile, number>;
  stope?: StopeProfile;
  /**
   * Optional queue-pressure multiplier in basis points of the base rate. A drained
   * redemption queue makes keeper misbehaviour more expensive, so the bond rises.
   */
  utilizationSurchargeBps?: number;
}

export interface ResolvedSlashCondition extends SlashCondition {
  slashUsd: number;
  slashLodz: number;
}

export interface KeeperBondRequirement {
  capitalBtc: number;
  managedNotionalUsd: number;
  effectiveRateBps: number;
  bondUsd: number;
  bondLodz: number;
  /** Bond as a share of managed notional, in basis points. */
  coverageBps: number;
  maxSlashBps: number;
  maxSlashUsd: number;
  maxSlashLodz: number;
  slashConditions: ResolvedSlashCondition[];
  /** Which term set the final bond size. */
  binding: "rate" | "min" | "max";
}
