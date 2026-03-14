import { BPS_DENOMINATOR, allocateUnits } from "./bps.js";
import { AssayError } from "./errors.js";
import { LIQUIDITY_FLOOR_USD, isBelowLiquidityFloor } from "./quality.js";
import type { Allocation, RiskTier, Seam, StopeProfile, YieldKind } from "./types.js";
import { STOPE_PROFILES } from "./types.js";
import { validateSeams } from "./validate.js";

/**
 * How a Stope vault reweights the seam catalog.
 *
 * Policies are data, not behaviour: pass your own table to `deriveStopeAllocation`
 * or `projectYield` and the engine uses it verbatim.
 */
export interface StopePolicy {
  profile: StopeProfile;
  /** Relative multiplier applied to each seam's catalog share, by risk tier. */
  riskTierWeights: Record<RiskTier, number>;
  /** Risk tiers this vault refuses to route capital into. */
  excludedRiskTiers: readonly RiskTier[];
  /** Ceiling on the capital allowed to sit in emissions funded seams, in bps. */
  maxEmissionsShareBps: number;
  /**
   * Ceiling on the capital allowed to sit in counterparty funded seams, in bps.
   * Counterparty yield is paid out of someone else's losses, so it gets its own
   * ceiling rather than being counted as ordinary fee income.
   */
  maxCounterpartyShareBps: number;
}

export type StopePolicyTable = Readonly<Record<StopeProfile, StopePolicy>>;

/**
 * Default policy table.
 *
 * Conservative refuses high tier seams outright, caps emissions exposure at 20%
 * and refuses counterparty exposure entirely. Aggressive still caps emissions at
 * 70% and counterparty at 40%: no profile is allowed to sit entirely on yield
 * that has an end date or that depends on someone else losing money.
 */
export const DEFAULT_STOPE_POLICIES: StopePolicyTable = Object.freeze({
  conservative: {
    profile: "conservative",
    riskTierWeights: { low: 6, medium: 2, high: 0 },
    excludedRiskTiers: ["high"],
    maxEmissionsShareBps: 2_000,
    maxCounterpartyShareBps: 0,
  },
  balanced: {
    profile: "balanced",
    riskTierWeights: { low: 4, medium: 3, high: 1 },
    excludedRiskTiers: [],
    maxEmissionsShareBps: 4_000,
    maxCounterpartyShareBps: 1_500,
  },
  aggressive: {
    profile: "aggressive",
    riskTierWeights: { low: 2, medium: 3, high: 3 },
    excludedRiskTiers: [],
    maxEmissionsShareBps: 7_000,
    maxCounterpartyShareBps: 4_000,
  },
});

export interface StopeAllocationResult {
  profile: StopeProfile;
  /** Derived allocation. Sums to exactly 10000 bps. */
  allocation: Allocation;
  /** Capital that landed in each yield kind, in bps. */
  shareByYieldKind: Record<YieldKind, number>;
  /** Capital that landed in emissions funded seams, in bps. */
  emissionsShareBps: number;
  /** Capital that landed in counterparty funded seams, in bps. */
  counterpartyShareBps: number;
  /** Ceilings the policy asked for, in bps. */
  emissionsCapBps: number;
  counterpartyCapBps: number;
  /**
   * False when the catalog held no sustainable seam to move capital into, so a
   * ceiling could not be met. The number is reported, never quietly faked.
   */
  capsSatisfied: boolean;
  /** Seams the profile refuses to hold. */
  excludedSeamIds: string[];
  /** Seams excluded specifically for being too small to absorb capital. */
  belowLiquidityFloorSeamIds: string[];
}

function weightFor(seam: Seam, policy: StopePolicy, floorUsd: number): number {
  if (isBelowLiquidityFloor(seam, floorUsd)) return 0;
  if (policy.excludedRiskTiers.includes(seam.riskTier)) return 0;
  const tierWeight = policy.riskTierWeights[seam.riskTier];
  return seam.allocationBps * tierWeight;
}

function requireCap(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > BPS_DENOMINATOR) {
    throw new AssayError(
      "INVALID_INPUT",
      `${field} must be an integer between 0 and ${BPS_DENOMINATOR}, received ${String(value)}`,
      { field },
    );
  }
  return value;
}

/**
 * Reweight a seam catalog for a Stope vault profile.
 *
 * Weights are the catalog share scaled by the profile's risk tier multiplier,
 * with undersized venues zeroed out, then normalized to exactly 10000 bps by
 * largest remainder. Emissions and counterparty groups are then scaled down to
 * their ceilings and the sustainable group absorbs whatever that frees.
 */
export function deriveStopeAllocation(
  seams: readonly Seam[],
  profile: StopeProfile,
  policies: StopePolicyTable = DEFAULT_STOPE_POLICIES,
  floorUsd: number = LIQUIDITY_FLOOR_USD,
): StopeAllocationResult {
  validateSeams(seams);
  if (!STOPE_PROFILES.includes(profile)) {
    throw new AssayError(
      "INVALID_INPUT",
      `stope must be one of ${STOPE_PROFILES.join(", ")}, received ${String(profile)}`,
      { field: "stope" },
    );
  }
  const policy = policies[profile];
  if (policy === undefined) {
    throw new AssayError("INVALID_INPUT", `no stope policy supplied for profile ${profile}`, {
      field: "stope",
    });
  }
  requireCap(policy.maxEmissionsShareBps, "maxEmissionsShareBps");
  requireCap(policy.maxCounterpartyShareBps, "maxCounterpartyShareBps");

  const weights = seams.map((seam) => weightFor(seam, policy, floorUsd));
  const excludedSeamIds = seams
    .filter((_seam, index) => (weights[index] ?? 0) === 0)
    .map((seam) => seam.id);
  const belowLiquidityFloorSeamIds = seams
    .filter((seam) => isBelowLiquidityFloor(seam, floorUsd))
    .map((seam) => seam.id);

  if (weights.every((weight) => weight === 0)) {
    throw new AssayError(
      "STOPE_EXCLUDES_EVERY_SEAM",
      `the ${profile} profile excludes every seam in this catalog`,
      { field: "stope" },
    );
  }

  const base = allocateUnits(weights, BPS_DENOMINATOR);
  const indexesOf = (kind: YieldKind): number[] =>
    seams.map((seam, index) => (seam.yieldKind === kind ? index : -1)).filter((i) => i >= 0);

  const groups: Record<YieldKind, number[]> = {
    sustainable: indexesOf("sustainable"),
    emissions: indexesOf("emissions"),
    counterparty: indexesOf("counterparty"),
  };
  const baseShareOf = (kind: YieldKind): number =>
    groups[kind].reduce((sum, index) => sum + (base[index] ?? 0), 0);
  const weightOf = (kind: YieldKind): number =>
    groups[kind].reduce((sum, index) => sum + (weights[index] ?? 0), 0);

  const caps: Record<"emissions" | "counterparty", number> = {
    emissions: policy.maxEmissionsShareBps,
    counterparty: policy.maxCounterpartyShareBps,
  };

  let shares = base;
  let capsSatisfied = true;
  let freed = 0;
  const targets: Record<YieldKind, number> = {
    sustainable: baseShareOf("sustainable"),
    emissions: baseShareOf("emissions"),
    counterparty: baseShareOf("counterparty"),
  };

  for (const kind of ["emissions", "counterparty"] as const) {
    const capped = Math.min(targets[kind], caps[kind]);
    freed += targets[kind] - capped;
    targets[kind] = capped;
  }
  targets.sustainable += freed;

  if (freed > 0) {
    if (weightOf("sustainable") <= 0) {
      // Nothing to move the capital into. Report the breach instead of pretending.
      capsSatisfied = false;
    } else {
      const next = new Array<number>(seams.length).fill(0);
      for (const kind of ["sustainable", "emissions", "counterparty"] as const) {
        const indexes = groups[kind];
        if (indexes.length === 0) continue;
        if (targets[kind] === 0) continue;
        const groupShares = allocateUnits(
          indexes.map((index) => weights[index] ?? 0),
          targets[kind],
        );
        indexes.forEach((seamIndex, position) => {
          next[seamIndex] = groupShares[position] ?? 0;
        });
      }
      shares = next;
    }
  }

  const allocation: Record<string, number> = {};
  seams.forEach((seam, index) => {
    allocation[seam.id] = shares[index] ?? 0;
  });

  const shareByYieldKind: Record<YieldKind, number> = {
    sustainable: 0,
    emissions: 0,
    counterparty: 0,
  };
  seams.forEach((seam, index) => {
    shareByYieldKind[seam.yieldKind] += shares[index] ?? 0;
  });

  return {
    profile,
    allocation,
    shareByYieldKind,
    emissionsShareBps: shareByYieldKind.emissions,
    counterpartyShareBps: shareByYieldKind.counterparty,
    emissionsCapBps: policy.maxEmissionsShareBps,
    counterpartyCapBps: policy.maxCounterpartyShareBps,
    capsSatisfied,
    excludedSeamIds,
    belowLiquidityFloorSeamIds,
  };
}
