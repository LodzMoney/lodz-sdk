/**
 * lodz-seam-router
 *
 * Deterministic capital routing across BTC yield seams on Solana.
 *
 * Every function here is pure: no network calls, no filesystem, no clock, no random
 * source. Timestamps arrive as arguments so the same input always produces the same
 * plan, which is what lets an off-chain planner and an on-chain program agree.
 */

export { planAllocation } from "./allocation.js";
export { planRebalance } from "./rebalance.js";
export { aggregateRealizedYield } from "./realized.js";
export { keeperBondRequirement } from "./bond.js";

export {
  DEFAULT_CONSTRAINTS,
  PAIR_VOLATILITY_CLASSES,
  RISK_TIERS,
  STOPE_PROFILES,
  YIELD_KINDS,
  assertStopeProfile,
  resolveConstraints,
} from "./constraints.js";

export { SeamRouterError } from "./errors.js";
export type { SeamRouterErrorCode } from "./errors.js";

export { BPS_TOTAL, MAX_CAPITAL_BTC, SATS_PER_BTC, btcToSats, satsToBtc } from "./math.js";

export type {
  AggregateWindow,
  ApySource,
  AllocationConstraints,
  AllocationConstraintsInput,
  AllocationInput,
  AllocationPlan,
  AllocationSnapshot,
  BindingCap,
  ExcludedSeam,
  ExclusionReason,
  KeeperBondParams,
  KeeperBondRequirement,
  PairVolatilityClass,
  ProfilePolicy,
  ProfilePolicyInput,
  RealizedYieldEntry,
  RealizedYieldReport,
  RebalanceInput,
  RebalanceMove,
  RebalancePlan,
  ResolvedSlashCondition,
  RiskTier,
  Seam,
  SeamAllocation,
  SeamVenueKind,
  SkipReason,
  SkippedMove,
  SlashCondition,
  SplitBucket,
  StopeProfile,
  YieldBucket,
  YieldKind,
} from "./types.js";
