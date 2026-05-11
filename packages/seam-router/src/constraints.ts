import { fail } from "./errors.js";
import { BPS_TOTAL, isBps, isFiniteNumber, isNonNegativeNumber } from "./math.js";
import type {
  AllocationConstraints,
  AllocationConstraintsInput,
  PairVolatilityClass,
  ProfilePolicy,
  ProfilePolicyInput,
  RiskTier,
  StopeProfile,
  YieldKind,
} from "./types.js";

export const STOPE_PROFILES: readonly StopeProfile[] = [
  "conservative",
  "balanced",
  "aggressive",
];

export const RISK_TIERS: readonly RiskTier[] = ["low", "medium", "high"];

export const YIELD_KINDS: readonly YieldKind[] = ["sustainable", "emissions", "counterparty"];

export const PAIR_VOLATILITY_CLASSES: readonly PairVolatilityClass[] = [
  "correlated",
  "mixed",
  "uncorrelated",
];

/**
 * Default routing policy.
 *
 * The three postures are separated by what kind of yield they will accept, not by how
 * much rate they chase. Counterparty-funded yield is the sharpest axis: a vault that
 * accepts none of it looks completely different from one that accepts a third of it,
 * even when both are offered the same seams.
 *
 * The emissions ceiling is retained even though the Solana BTC market currently has no
 * emission programmes at all. It has had them before and will again, and a ceiling that
 * only appears once the exposure exists is a ceiling nobody reviewed.
 *
 * These are defaults, not law. Anything here can be overridden per call, and the
 * on-chain vault parameters are the authority once the program is live.
 */
export const DEFAULT_CONSTRAINTS: AllocationConstraints = Object.freeze({
  profiles: Object.freeze({
    conservative: Object.freeze({
      maxCounterpartyBps: 0,
      maxUncorrelatedLpBps: 1_000,
      maxEmissionsBps: 1_500,
      maxSingleVenueBps: 3_000,
      maxSingleAssetBps: 4_000,
      maxWrapHops: 1,
      maxRiskTierBps: Object.freeze({ low: 10_000, medium: 3_500, high: 0 }),
      allowIlUnknown: false,
      riskAversionBps: 10_000,
      liquidityBufferBps: 500,
    }),
    balanced: Object.freeze({
      maxCounterpartyBps: 1_000,
      maxUncorrelatedLpBps: 3_500,
      maxEmissionsBps: 3_500,
      maxSingleVenueBps: 4_000,
      maxSingleAssetBps: 6_000,
      maxWrapHops: 2,
      maxRiskTierBps: Object.freeze({ low: 10_000, medium: 7_000, high: 2_000 }),
      allowIlUnknown: true,
      riskAversionBps: 5_500,
      liquidityBufferBps: 250,
    }),
    aggressive: Object.freeze({
      maxCounterpartyBps: 3_000,
      maxUncorrelatedLpBps: 6_000,
      maxEmissionsBps: 6_000,
      maxSingleVenueBps: 5_000,
      maxSingleAssetBps: 7_000,
      maxWrapHops: 3,
      maxRiskTierBps: Object.freeze({ low: 10_000, medium: 10_000, high: 5_000 }),
      allowIlUnknown: true,
      riskAversionBps: 2_000,
      liquidityBufferBps: 0,
    }),
  }),
  maxSeamBps: 3_500,
  minSeamBps: 250,
  minTvlUsd: 100_000,
  maxSeams: 12,
  maxShareOfTvlBps: 1_000,
  spotRejectMultiple: 5,
  emissionsHorizonDays: 90,
}) as AllocationConstraints;

function requireBps(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!isBps(value)) {
    fail("INVALID_CONSTRAINT", `${field} must be an integer between 0 and ${BPS_TOTAL}`, {
      field,
      value,
    });
  }
  return value;
}

function requireNonNegative(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!isNonNegativeNumber(value)) {
    fail("INVALID_CONSTRAINT", `${field} must be a non-negative finite number`, { field, value });
  }
  return value;
}

function requireCount(value: number | undefined, fallback: number, field: string, min: number): number {
  const resolved = value ?? fallback;
  if (!isFiniteNumber(resolved) || !Number.isInteger(resolved) || resolved < min) {
    fail("INVALID_CONSTRAINT", `${field} must be an integer of at least ${min}`, {
      field,
      value: resolved,
    });
  }
  return resolved;
}

function resolveProfile(
  profile: StopeProfile,
  base: ProfilePolicy,
  override: ProfilePolicyInput | undefined,
): ProfilePolicy {
  const maxRiskTierBps: Record<RiskTier, number> = {
    low: base.maxRiskTierBps.low,
    medium: base.maxRiskTierBps.medium,
    high: base.maxRiskTierBps.high,
  };
  for (const tier of RISK_TIERS) {
    maxRiskTierBps[tier] = requireBps(
      override?.maxRiskTierBps?.[tier],
      maxRiskTierBps[tier],
      `constraints.profiles.${profile}.maxRiskTierBps.${tier}`,
    );
  }

  const allowIlUnknown = override?.allowIlUnknown ?? base.allowIlUnknown;
  if (typeof allowIlUnknown !== "boolean") {
    fail("INVALID_CONSTRAINT", `constraints.profiles.${profile}.allowIlUnknown must be a boolean`, {
      profile,
      value: allowIlUnknown,
    });
  }

  return {
    maxCounterpartyBps: requireBps(
      override?.maxCounterpartyBps,
      base.maxCounterpartyBps,
      `constraints.profiles.${profile}.maxCounterpartyBps`,
    ),
    maxUncorrelatedLpBps: requireBps(
      override?.maxUncorrelatedLpBps,
      base.maxUncorrelatedLpBps,
      `constraints.profiles.${profile}.maxUncorrelatedLpBps`,
    ),
    maxEmissionsBps: requireBps(
      override?.maxEmissionsBps,
      base.maxEmissionsBps,
      `constraints.profiles.${profile}.maxEmissionsBps`,
    ),
    maxSingleVenueBps: requireBps(
      override?.maxSingleVenueBps,
      base.maxSingleVenueBps,
      `constraints.profiles.${profile}.maxSingleVenueBps`,
    ),
    maxSingleAssetBps: requireBps(
      override?.maxSingleAssetBps,
      base.maxSingleAssetBps,
      `constraints.profiles.${profile}.maxSingleAssetBps`,
    ),
    maxWrapHops: requireCount(
      override?.maxWrapHops,
      base.maxWrapHops,
      `constraints.profiles.${profile}.maxWrapHops`,
      0,
    ),
    maxRiskTierBps,
    allowIlUnknown,
    riskAversionBps: requireBps(
      override?.riskAversionBps,
      base.riskAversionBps,
      `constraints.profiles.${profile}.riskAversionBps`,
    ),
    liquidityBufferBps: requireBps(
      override?.liquidityBufferBps,
      base.liquidityBufferBps,
      `constraints.profiles.${profile}.liquidityBufferBps`,
    ),
  };
}

/** Merge caller overrides onto {@link DEFAULT_CONSTRAINTS} and validate the result. */
export function resolveConstraints(input?: AllocationConstraintsInput): AllocationConstraints {
  const profiles = {} as Record<StopeProfile, ProfilePolicy>;
  for (const profile of STOPE_PROFILES) {
    profiles[profile] = resolveProfile(
      profile,
      DEFAULT_CONSTRAINTS.profiles[profile],
      input?.profiles?.[profile],
    );
  }

  const spotRejectMultiple = input?.spotRejectMultiple ?? DEFAULT_CONSTRAINTS.spotRejectMultiple;
  if (!isFiniteNumber(spotRejectMultiple) || spotRejectMultiple < 1) {
    fail("INVALID_CONSTRAINT", "constraints.spotRejectMultiple must be at least 1", {
      field: "constraints.spotRejectMultiple",
      value: spotRejectMultiple,
    });
  }

  const emissionsHorizonDays =
    input?.emissionsHorizonDays ?? DEFAULT_CONSTRAINTS.emissionsHorizonDays;
  if (!isFiniteNumber(emissionsHorizonDays) || emissionsHorizonDays <= 0) {
    fail("INVALID_CONSTRAINT", "constraints.emissionsHorizonDays must be greater than 0", {
      field: "constraints.emissionsHorizonDays",
      value: emissionsHorizonDays,
    });
  }

  const resolved: AllocationConstraints = {
    profiles,
    maxSeamBps: requireBps(input?.maxSeamBps, DEFAULT_CONSTRAINTS.maxSeamBps, "constraints.maxSeamBps"),
    minSeamBps: requireBps(input?.minSeamBps, DEFAULT_CONSTRAINTS.minSeamBps, "constraints.minSeamBps"),
    minTvlUsd: requireNonNegative(
      input?.minTvlUsd,
      DEFAULT_CONSTRAINTS.minTvlUsd,
      "constraints.minTvlUsd",
    ),
    maxSeams: requireCount(input?.maxSeams, DEFAULT_CONSTRAINTS.maxSeams, "constraints.maxSeams", 1),
    maxShareOfTvlBps: requireBps(
      input?.maxShareOfTvlBps,
      DEFAULT_CONSTRAINTS.maxShareOfTvlBps,
      "constraints.maxShareOfTvlBps",
    ),
    spotRejectMultiple,
    emissionsHorizonDays,
  };

  if (resolved.maxSeamBps === 0) {
    fail("INVALID_CONSTRAINT", "constraints.maxSeamBps of 0 would deploy nothing", {
      field: "constraints.maxSeamBps",
      value: resolved.maxSeamBps,
    });
  }

  return resolved;
}

/** Assert a value is a known {@link StopeProfile}. */
export function assertStopeProfile(value: unknown): asserts value is StopeProfile {
  if (typeof value !== "string" || !STOPE_PROFILES.includes(value as StopeProfile)) {
    fail("INVALID_PROFILE", `stope must be one of ${STOPE_PROFILES.join(", ")}`, { value });
  }
}
