import { BPS_DENOMINATOR, allocateUnits } from "./bps.js";
import { AssayError } from "./errors.js";
import { LIQUIDITY_FLOOR_USD, isBelowLiquidityFloor } from "./quality.js";
import { isIso8601 } from "./time.js";
import type { Allocation, Seam } from "./types.js";
import {
  PAIR_VOLATILITY_CLASSES,
  RISK_TIERS,
  SEAM_VENUE_KINDS,
  YIELD_KINDS,
} from "./types.js";

function requireNonEmptyString(value: unknown, field: string, seamId?: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AssayError("INVALID_SEAM", `${field} must be a non-empty string`, {
      field,
      ...(seamId === undefined ? {} : { seamId }),
    });
  }
  return value;
}

function requireIntegerInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
  seamId: string,
): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new AssayError("INVALID_SEAM", `${field} must be an integer, received ${String(value)}`, {
      field,
      seamId,
    });
  }
  if (value < min || value > max) {
    throw new AssayError(
      "INVALID_SEAM",
      `${field} must be between ${min} and ${max}, received ${value}`,
      { field, seamId },
    );
  }
  return value;
}

/**
 * Validate one seam.
 *
 * The emissions rules are the reason this function exists: an emissions seam
 * with no declared token and no declared end date is indistinguishable from a
 * sustainable seam in every downstream calculation, which is the single most
 * common way a BTCfi yield number ends up overstated.
 */
export function validateSeam(seam: Seam): Seam {
  if (seam === null || typeof seam !== "object") {
    throw new AssayError("INVALID_SEAM", "seam must be an object");
  }
  const id = requireNonEmptyString(seam.id, "id");
  requireNonEmptyString(seam.name, "name", id);
  requireNonEmptyString(seam.venue, "venue", id);
  requireNonEmptyString(seam.asset, "asset", id);
  requireNonEmptyString(seam.assetMint, "assetMint", id);

  if (!SEAM_VENUE_KINDS.includes(seam.kind)) {
    throw new AssayError(
      "INVALID_SEAM",
      `kind must be one of ${SEAM_VENUE_KINDS.join(", ")}, received ${String(seam.kind)}`,
      { field: "kind", seamId: id },
    );
  }
  if (!YIELD_KINDS.includes(seam.yieldKind)) {
    throw new AssayError(
      "INVALID_SEAM",
      `yieldKind must be one of ${YIELD_KINDS.join(", ")}, received ${String(seam.yieldKind)}`,
      { field: "yieldKind", seamId: id },
    );
  }
  if (!RISK_TIERS.includes(seam.riskTier)) {
    throw new AssayError(
      "INVALID_SEAM",
      `riskTier must be one of ${RISK_TIERS.join(", ")}, received ${String(seam.riskTier)}`,
      { field: "riskTier", seamId: id },
    );
  }

  requireIntegerInRange(seam.apyBps, "apyBps", 0, 100_000_000, id);
  requireIntegerInRange(seam.allocationBps, "allocationBps", 0, BPS_DENOMINATOR, id);

  for (const field of ["apy7dBps", "apy90dMedianBps", "ilEstimateBps"] as const) {
    const value = seam[field];
    if (value === null || value === undefined) continue;
    requireIntegerInRange(value, field, 0, 100_000_000, id);
  }

  if (
    seam.pairVolatilityClass !== null &&
    seam.pairVolatilityClass !== undefined &&
    !PAIR_VOLATILITY_CLASSES.includes(seam.pairVolatilityClass)
  ) {
    throw new AssayError(
      "INVALID_SEAM",
      `pairVolatilityClass must be null or one of ${PAIR_VOLATILITY_CLASSES.join(", ")}`,
      { field: "pairVolatilityClass", seamId: id },
    );
  }

  for (const field of ["belowLiquidityFloor", "sourceDivergence"] as const) {
    const value = seam[field];
    if (value !== undefined && typeof value !== "boolean") {
      throw new AssayError("INVALID_SEAM", `${field} must be a boolean`, {
        field,
        seamId: id,
      });
    }
  }

  if (typeof seam.tvlUsd !== "number" || !Number.isFinite(seam.tvlUsd) || seam.tvlUsd < 0) {
    throw new AssayError(
      "INVALID_SEAM",
      `tvlUsd must be a finite non-negative number, received ${String(seam.tvlUsd)}`,
      { field: "tvlUsd", seamId: id },
    );
  }

  if (seam.yieldKind === "emissions") {
    if (typeof seam.emissionToken !== "string" || seam.emissionToken.trim().length === 0) {
      throw new AssayError(
        "INVALID_SEAM",
        `seam ${id} is emissions funded and must declare emissionToken`,
        { field: "emissionToken", seamId: id },
      );
    }
    if (!isIso8601(seam.emissionEndsAt)) {
      throw new AssayError(
        "INVALID_SEAM",
        `seam ${id} is emissions funded and must declare emissionEndsAt as an ISO-8601 instant`,
        { field: "emissionEndsAt", seamId: id },
      );
    }
  } else {
    if (seam.emissionToken !== null) {
      throw new AssayError(
        "INVALID_SEAM",
        `seam ${id} is ${seam.yieldKind} and must set emissionToken to null`,
        { field: "emissionToken", seamId: id },
      );
    }
    if (seam.emissionEndsAt !== null) {
      throw new AssayError(
        "INVALID_SEAM",
        `seam ${id} is ${seam.yieldKind} and must set emissionEndsAt to null`,
        { field: "emissionEndsAt", seamId: id },
      );
    }
  }

  const sourceUrl = requireNonEmptyString(seam.sourceUrl, "sourceUrl", id);
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new AssayError("INVALID_SEAM", `sourceUrl must be an absolute URL, received ${sourceUrl}`, {
      field: "sourceUrl",
      seamId: id,
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AssayError("INVALID_SEAM", `sourceUrl must use http or https, received ${sourceUrl}`, {
      field: "sourceUrl",
      seamId: id,
    });
  }

  if (!isIso8601(seam.updatedAt)) {
    throw new AssayError(
      "INVALID_SEAM",
      `updatedAt must be an ISO-8601 instant, received ${String(seam.updatedAt)}`,
      { field: "updatedAt", seamId: id },
    );
  }

  return seam;
}

/** Validate every seam and reject duplicate ids. */
export function validateSeams(seams: readonly Seam[]): readonly Seam[] {
  if (!Array.isArray(seams)) {
    throw new AssayError("INVALID_INPUT", "seams must be an array", { field: "seams" });
  }
  if (seams.length === 0) {
    throw new AssayError("EMPTY_PORTFOLIO", "at least one seam is required", { field: "seams" });
  }
  const seen = new Set<string>();
  for (const seam of seams) {
    validateSeam(seam);
    if (seen.has(seam.id)) {
      throw new AssayError("INVALID_SEAM", `duplicate seam id ${seam.id}`, {
        field: "id",
        seamId: seam.id,
      });
    }
    seen.add(seam.id);
  }
  return seams;
}

/** Build the allocation implied by the seams' own `allocationBps`. */
export function defaultAllocation(seams: readonly Seam[]): Allocation {
  const allocation: Record<string, number> = {};
  for (const seam of seams) allocation[seam.id] = seam.allocationBps;
  return allocation;
}

/**
 * Validate an allocation against a seam set.
 *
 * Rejects unknown seam ids, non-integer or negative shares, and any total that
 * is not exactly 10000 bps. Seams missing from the map are treated as 0 bps.
 */
export function validateAllocation(seams: readonly Seam[], allocation: Allocation): Allocation {
  if (allocation === null || typeof allocation !== "object") {
    throw new AssayError("INVALID_ALLOCATION", "allocation must be an object keyed by seam id");
  }
  const known = new Set(seams.map((seam) => seam.id));
  let total = 0;
  for (const [seamId, bps] of Object.entries(allocation)) {
    if (!known.has(seamId)) {
      throw new AssayError("INVALID_ALLOCATION", `allocation references unknown seam ${seamId}`, {
        seamId,
      });
    }
    if (typeof bps !== "number" || !Number.isInteger(bps)) {
      throw new AssayError(
        "INVALID_ALLOCATION",
        `allocation for ${seamId} must be an integer basis point value, received ${String(bps)}`,
        { seamId },
      );
    }
    if (bps < 0 || bps > BPS_DENOMINATOR) {
      throw new AssayError(
        "INVALID_ALLOCATION",
        `allocation for ${seamId} must be between 0 and ${BPS_DENOMINATOR}, received ${bps}`,
        { seamId },
      );
    }
    total += bps;
  }
  if (total !== BPS_DENOMINATOR) {
    throw new AssayError(
      "INVALID_ALLOCATION",
      `allocation must total exactly ${BPS_DENOMINATOR} bps, received ${total}`,
    );
  }
  return allocation;
}

/**
 * Validate a portfolio and resolve the allocation actually used.
 * When no allocation is supplied the seams' own shares are used, and those
 * must total 10000 bps on their own.
 */
export function resolvePortfolio(
  seams: readonly Seam[],
  allocation?: Allocation,
): { seams: readonly Seam[]; allocation: Allocation } {
  validateSeams(seams);
  const resolved = allocation ?? defaultAllocation(seams);
  validateAllocation(seams, resolved);
  return { seams, allocation: resolved };
}

export interface LiquidityFloorResult {
  /** Allocation with undersized seams removed. Still totals exactly 10000 bps. */
  allocation: Allocation;
  floorUsd: number;
  /** Seams dropped for being too small to absorb capital. */
  excludedSeamIds: string[];
  /** Capital that was sitting in dropped seams and had to move, in bps. */
  reallocatedBps: number;
  /** False when nothing was below the floor. */
  applied: boolean;
}

/**
 * Drop seams that cannot absorb capital and redistribute their share.
 *
 * A venue holding ten thousand dollars can quote any rate it likes; routing to
 * it would be advertising a number nobody can actually take. The freed capital
 * is redistributed across the surviving seams in proportion to their existing
 * shares, and the total stays exactly 10000 bps.
 */
export function applyLiquidityFloor(
  seams: readonly Seam[],
  allocation: Allocation,
  floorUsd: number = LIQUIDITY_FLOOR_USD,
): LiquidityFloorResult {
  const excludedSeamIds: string[] = [];
  let reallocatedBps = 0;
  const weights: number[] = [];

  for (const seam of seams) {
    const bps = allocation[seam.id] ?? 0;
    if (isBelowLiquidityFloor(seam, floorUsd)) {
      excludedSeamIds.push(seam.id);
      reallocatedBps += bps;
      weights.push(0);
    } else {
      weights.push(bps);
    }
  }

  if (excludedSeamIds.length === 0) {
    return { allocation, floorUsd, excludedSeamIds, reallocatedBps: 0, applied: false };
  }
  if (weights.every((weight) => weight === 0)) {
    throw new AssayError(
      "ALL_SEAMS_BELOW_LIQUIDITY_FLOOR",
      `every allocated seam sits below the ${floorUsd} USD liquidity floor, so there is nowhere to route capital`,
      { field: "tvlUsd" },
    );
  }

  const shares = allocateUnits(weights, BPS_DENOMINATOR);
  const next: Record<string, number> = {};
  seams.forEach((seam, index) => {
    next[seam.id] = shares[index] ?? 0;
  });

  return { allocation: next, floorUsd, excludedSeamIds, reallocatedBps, applied: true };
}
