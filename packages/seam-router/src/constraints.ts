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
 * # Where the two yield-kind ceilings come from
 *
 * `maxEmissionsBps` and `maxCounterpartyBps` are transcribed from the `lodz-vault`
 * program: `RiskProfile::max_emissions_bps` and `RiskProfile::max_counterparty_bps` in
 * `programs/lodz-vault/src/state/mod.rs`. They are not this package's opinion. The
 * program is deployed on devnet, and `register_seam` and `update_seam_allocation`
 * reject anything over them with `EmissionsAllocationExceeded` (6030) or
 * `CounterpartyAllocationExceeded` (6053). Those are the ceilings a caller operates
 * under whatever this file says, so this file says the same numbers.
 *
 * Do not lower either row to express a house risk appetite. A ceiling states how much
 * exposure is *possible*, and an integrator who reads `maxEmissionsBps` to answer "how
 * much of an aggressive book can be funded by token emissions?" gets a wrong and
 * flattering answer if this file says 6000 while the chain permits 10000. Understating
 * a ceiling is not caution; it under-reports the exposure. Appetite belongs in the
 * allocation, not the ceiling: `riskAversionBps` already tilts the weights, and a
 * caller who wants their own book to hold less can pass a lower ceiling for that call.
 * The published default has to match the chain.
 *
 * The aggressive emissions figure is 10000. That posture permits a book funded entirely
 * by emissions, nothing on chain caps it lower, and nothing here should imply otherwise.
 *
 * The emissions ceiling is retained even though the Solana BTC market currently has no
 * emission programmes at all. It has had them before and will again, and a ceiling that
 * only appears once the exposure exists is a ceiling nobody reviewed.
 *
 * The remaining rows are defaults rather than law and can be overridden per call.
 * Overriding the two yield-kind ceilings upward only produces allocations the program
 * refuses; raising them for real takes a program upgrade, which is friction these two
 * promises are load-bearing enough to deserve.
 */
export const DEFAULT_CONSTRAINTS: AllocationConstraints = Object.freeze({
  profiles: Object.freeze({
    conservative: Object.freeze({
      maxCounterpartyBps: 0,
      maxUncorrelatedLpBps: 1_000,
      // 2_000, from RiskProfile::max_emissions_bps. Was 1_500 here, which is the
      // number an integrator would have quoted for the ceiling while the chain
      // accepted a third more than that.
      maxEmissionsBps: 2_000,
      maxSingleVenueBps: 3_000,
      maxSingleAssetBps: 4_000,
      maxWrapHops: 1,
      maxRiskTierBps: Object.freeze({ low: 10_000, medium: 3_500, high: 0 }),
      allowIlUnknown: false,
      riskAversionBps: 10_000,
      liquidityBufferBps: 500,
    }),
    balanced: Object.freeze({
      // Zero, not 1_000. CHAMBER_POLICY in apps/web carries
      // admitsCounterparty:false for this chamber and its stance sentence
      // offers only an emission schedule, so a router default of 10 percent
      // would route exposure the site says this chamber does not take. The
      // on-chain RiskProfile::max_counterparty_bps now rejects it outright, so
      // leaving this at 1_000 would only produce allocations the chain
      // refuses.
      maxCounterpartyBps: 0,
      maxUncorrelatedLpBps: 3_500,
      // 5_000, from RiskProfile::max_emissions_bps. Half the book, not the 3_500
      // this file used to publish. The balanced stance sentence on the site offers
      // an emission schedule and this is how much of one it can actually hold.
      maxEmissionsBps: 5_000,
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
      // 10_000, from RiskProfile::max_emissions_bps: an aggressive book may be
      // funded entirely by emissions. This file used to say 6_000, which read as a
      // limit the chain does not impose. State the real one.
      maxEmissionsBps: 10_000,
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
