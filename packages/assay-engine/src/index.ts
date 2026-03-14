/**
 * lodz-assay-engine
 *
 * Splits a BTC yield number by who actually pays it -- an outside user for a
 * service, an incentive program until a date, or a losing counterparty -- and
 * projects what is left once the programs end and impermanent loss is taken off.
 *
 * This package is the canonical home of the LODZ domain types.
 */

export type {
  Allocation,
  Amount,
  AmountSplit,
  ApyBasis,
  BpsSplit,
  EvaluationInstant,
  PairVolatilityClass,
  RiskTier,
  Seam,
  SeamVenueKind,
  StopeProfile,
  YieldKind,
} from "./types.js";
export {
  PAIR_VOLATILITY_CLASSES,
  RISK_TIERS,
  SEAM_VENUE_KINDS,
  STOPE_PROFILES,
  YIELD_KINDS,
} from "./types.js";

export { AssayError } from "./errors.js";
export type { AssayErrorCode, AssayErrorDetail } from "./errors.js";

export {
  BPS_DENOMINATOR,
  DAYS_PER_YEAR,
  MS_PER_DAY,
  MS_PER_YEAR,
  SATS_PER_BTC,
  allocateBps,
  allocateUnits,
  clamp,
  clamp01,
  roundDivBig,
  roundDivInt,
  roundTo,
  sumBps,
} from "./bps.js";

export { addDays, daysBetween, isIso8601, parseInstant, resolveInstant, toIso } from "./time.js";

export {
  applyLiquidityFloor,
  defaultAllocation,
  resolvePortfolio,
  validateAllocation,
  validateSeam,
  validateSeams,
} from "./validate.js";
export type { LiquidityFloorResult } from "./validate.js";

export {
  LIQUIDITY_FLOOR_USD,
  SOURCE_DIVERGENCE_THRESHOLD_BPS,
  SPOT_ARTIFACT_MULTIPLE,
  detectSourceDivergence,
  hasUnknownIl,
  isBelowLiquidityFloor,
  seamDataQuality,
  selectQuotedApy,
} from "./quality.js";
export type { QuotedApy, SeamDataQuality } from "./quality.js";

export {
  ZERO_AMOUNT,
  accrueSats,
  amountFromSats,
  annualizeBps,
  btcToSats,
} from "./amount.js";

export { decomposeYield, effectiveApyBps, isEmissionActive } from "./decompose.js";
export type { YieldComponent, YieldDecomposition } from "./decompose.js";

export { simulatePostEmissions } from "./emissions.js";
export type { EmissionStep, PostEmissionsProjection } from "./emissions.js";

export {
  FADE_HORIZON_DAYS,
  MIN_EMISSION_FADE,
  MIN_THICKNESS,
  annualYieldUsd,
  seamThickness,
  seamThicknessSet,
} from "./thickness.js";
export type { SeamThickness, ThicknessOptions } from "./thickness.js";

export { DEFAULT_STOPE_POLICIES, deriveStopeAllocation } from "./stope.js";
export type { StopeAllocationResult, StopePolicy, StopePolicyTable } from "./stope.js";

export {
  RISK_TIER_SCORE,
  RISK_TIER_THRESHOLDS,
  projectYield,
  tierFromScore,
} from "./project.js";
export type {
  IlAssessment,
  PortfolioRiskWeighting,
  ProjectYieldInput,
  SeamContribution,
  YieldProjection,
} from "./project.js";
