import { BPS_DENOMINATOR, roundTo } from "./bps.js";
import { AssayError } from "./errors.js";
import type { ApyBasis, Seam } from "./types.js";

/**
 * Minimum venue size, USD, before a seam is allowed to hold capital.
 *
 * A 100% rate on a venue that can absorb ten thousand dollars is not a yield
 * opportunity, it is a number. Routing to it, or advertising it, is dishonest.
 */
export const LIQUIDITY_FLOOR_USD = 100_000;

/**
 * How far a spot rate may exceed the smoothed rate before it is treated as a
 * calculation artifact rather than an observation.
 */
export const SPOT_ARTIFACT_MULTIPLE = 5;

/** Relative gap between two sources, in bps, past which they are in conflict. */
export const SOURCE_DIVERGENCE_THRESHOLD_BPS = 2_000;

export interface QuotedApy {
  /** The rate the engine will actually use, in bps. */
  apyBps: number;
  /** Which observation it came from. */
  basis: ApyBasis;
  /** The spot rate as observed, in bps. */
  spotBps: number;
  /**
   * True when the spot rate exceeds the smoothed rate by `SPOT_ARTIFACT_MULTIPLE`
   * or more. The quoted rate already excludes it; this flag exists so the
   * surface can say why the headline number is not the one being shown.
   */
  spotRejected: boolean;
  /** Spot divided by the smoothed rate, or null when no smoothed rate exists. */
  spotMultiple: number | null;
  /** True when no smoothed observation exists and spot is all there is. */
  spotOnly: boolean;
}

/**
 * Pick the rate to quote for a seam.
 *
 * The engine quotes the most conservative smoothed observation available:
 * the lower of the 7 day rate and the 90 day median. Spot is used only when
 * neither exists, and that case is flagged rather than hidden. Quoting a spot
 * rate from a thin pool is how a 74,187% day ends up on a marketing page.
 */
export function selectQuotedApy(seam: Seam): QuotedApy {
  const spotBps = seam.apyBps;
  const candidates: { basis: ApyBasis; value: number }[] = [];
  if (seam.apy90dMedianBps !== null && seam.apy90dMedianBps !== undefined) {
    candidates.push({ basis: "90d-median", value: seam.apy90dMedianBps });
  }
  if (seam.apy7dBps !== null && seam.apy7dBps !== undefined) {
    candidates.push({ basis: "7d", value: seam.apy7dBps });
  }

  if (candidates.length === 0) {
    return {
      apyBps: spotBps,
      basis: "spot",
      spotBps,
      spotRejected: false,
      spotMultiple: null,
      spotOnly: true,
    };
  }

  const chosen = candidates.reduce((lowest, candidate) =>
    candidate.value < lowest.value ? candidate : lowest,
  );
  const spotMultiple = chosen.value > 0 ? roundTo(spotBps / chosen.value, 4) : null;
  const spotRejected =
    chosen.value > 0
      ? spotBps >= chosen.value * SPOT_ARTIFACT_MULTIPLE
      : spotBps > 0;

  return {
    apyBps: chosen.value,
    basis: chosen.basis,
    spotBps,
    spotRejected,
    spotMultiple,
    spotOnly: false,
  };
}

/** True when a seam is too small to route capital into. */
export function isBelowLiquidityFloor(seam: Seam, floorUsd: number = LIQUIDITY_FLOOR_USD): boolean {
  if (!Number.isFinite(floorUsd) || floorUsd < 0) {
    throw new AssayError(
      "INVALID_INPUT",
      `liquidity floor must be a finite non-negative number, received ${String(floorUsd)}`,
      { field: "floorUsd" },
    );
  }
  return seam.belowLiquidityFloor === true || seam.tvlUsd < floorUsd;
}

/**
 * True when two independent observations of the same rate disagree by more
 * than the threshold, measured against the larger of the two.
 */
export function detectSourceDivergence(
  first: number,
  second: number,
  thresholdBps: number = SOURCE_DIVERGENCE_THRESHOLD_BPS,
): boolean {
  if (!Number.isFinite(first) || !Number.isFinite(second)) {
    throw new AssayError("INVALID_INPUT", "both observations must be finite numbers");
  }
  const largest = Math.max(Math.abs(first), Math.abs(second));
  if (largest === 0) return false;
  const gapBps = (Math.abs(first - second) / largest) * BPS_DENOMINATOR;
  return gapBps > thresholdBps;
}

/**
 * True when this seam's impermanent loss is unknown and matters.
 *
 * It matters for LP positions. Lending and basis positions have no pair to
 * diverge, so a null estimate there is not a gap in the picture.
 */
export function hasUnknownIl(seam: Seam): boolean {
  return seam.kind === "lp" && seam.ilEstimateBps === null;
}

/** Everything the surface needs to caveat a seam's numbers. */
export interface SeamDataQuality {
  seamId: string;
  /** Which observation the quoted rate came from. */
  apyBasis: ApyBasis;
  quotedApyBps: number;
  spotApyBps: number;
  spotRejected: boolean;
  spotMultiple: number | null;
  spotOnly: boolean;
  belowLiquidityFloor: boolean;
  sourceDivergence: boolean;
  /** True for an LP seam with no impermanent loss estimate. */
  ilUnknown: boolean;
  ilEstimateBps: number | null;
  pairVolatilityClass: Seam["pairVolatilityClass"];
  /** True when any caveat above applies. */
  hasCaveats: boolean;
}

export function seamDataQuality(
  seam: Seam,
  floorUsd: number = LIQUIDITY_FLOOR_USD,
): SeamDataQuality {
  const quoted = selectQuotedApy(seam);
  const belowFloor = isBelowLiquidityFloor(seam, floorUsd);
  const ilUnknown = hasUnknownIl(seam);
  return {
    seamId: seam.id,
    apyBasis: quoted.basis,
    quotedApyBps: quoted.apyBps,
    spotApyBps: quoted.spotBps,
    spotRejected: quoted.spotRejected,
    spotMultiple: quoted.spotMultiple,
    spotOnly: quoted.spotOnly,
    belowLiquidityFloor: belowFloor,
    sourceDivergence: seam.sourceDivergence === true,
    ilUnknown,
    ilEstimateBps: seam.ilEstimateBps,
    pairVolatilityClass: seam.pairVolatilityClass,
    hasCaveats:
      quoted.spotRejected ||
      quoted.spotOnly ||
      belowFloor ||
      seam.sourceDivergence === true ||
      ilUnknown,
  };
}
