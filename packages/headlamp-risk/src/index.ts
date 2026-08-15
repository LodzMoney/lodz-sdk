/**
 * @lodz/headlamp-risk
 *
 * Measures the bridge, custody, protocol, oracle and liquidity exposure behind
 * a BTC position on Solana as layers, and keeps the worst layer visible instead
 * of averaging it away.
 *
 * Domain types come from `@lodz/assay-engine`.
 */

export type { RiskFactor, RiskLayer, Severity } from "./types.js";
export {
  HIGH_SEVERITY,
  MAX_SEVERITY,
  MIN_SEVERITY,
  RISK_LAYERS,
  UNEVIDENCED_SEVERITY,
  clampSeverity,
  isRiskLayer,
  isSeverity,
} from "./types.js";

export { HeadlampError } from "./errors.js";
export type { HeadlampErrorCode, HeadlampErrorDetail } from "./errors.js";

export {
  FREEZABLE_CUSTODY_FLOOR,
  YIELD_KIND_RISK,
  MEAN_LAYER_WEIGHT_PCT,
  TIER_THRESHOLDS,
  WORST_LAYER_WEIGHT_PCT,
  assessSeam,
  bridgeFloorForHops,
  compositeScore,
  protocolFloorFor,
  tierFromScore,
  validateRiskFactor,
} from "./assess.js";
export type {
  AppliedFloor,
  AssessSeamOptions,
  LayerAssessment,
  SeamRiskAssessment,
  WorstLayerRef,
} from "./assess.js";

export { assessPortfolio } from "./portfolio.js";
export type {
  Concentration,
  LayerExposure,
  PortfolioRiskAssessment,
  PortfolioWorstLayer,
  SeamRiskEntry,
} from "./portfolio.js";

export {
  CUSTODY_TYPES,
  CUSTODY_TYPE_BY_TRUST_MODEL,
  PROTOCOL_BASE_SEVERITY,
  DEFAULT_CUSTODY_SEVERITY,
  DEFAULT_REDEEMABILITY_SEVERITY,
  REDEEMABILITY_KINDS,
  RESERVE_EVIDENCE_KINDS,
  TRUST_MODELS,
  TRUST_MODEL_BY_CUSTODY_TYPE,
  createCustodyLedger,
  custodyTouchesProtocolLayer,
  custodyTypeFromTrustModel,
  describeCustody,
  getCustodyLedger,
  normalizeCustodyModel,
  protocolSeverityFor,
  setCustodyLedger,
  validateCustodyModel,
} from "./custody.js";
export type {
  CustodyDescription,
  CustodyLedger,
  CustodyModel,
  CustodyType,
  Redeemability,
  ReserveEvidence,
  ResolvedCustodyModel,
  TrustModel,
} from "./custody.js";

export type { Allocation, RiskTier, Seam, YieldKind } from "@lodz/assay-engine";
