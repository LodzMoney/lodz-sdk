import { BPS_DENOMINATOR, clamp01, roundTo } from "./bps.js";
import { AssayError } from "./errors.js";
import { daysBetween, parseInstant, resolveInstant } from "./time.js";
import type { EvaluationInstant, Seam, YieldKind } from "./types.js";
import { validateSeam, validateSeams } from "./validate.js";

/** Thinnest a drawn seam may get, so a small seam is still visible. */
export const MIN_THICKNESS = 0.08;

/** Faintest an emissions seam is ever drawn, even with years left to run. */
export const MIN_EMISSION_FADE = 0.35;

/** Window over which an emissions seam fades toward invisible, in days. */
export const FADE_HORIZON_DAYS = 365;

export interface ThicknessOptions {
  /**
   * Largest realized annual yield in the seam set, USD. Supply this to
   * normalize by realized yield, which is what the Seam Map draws.
   * `seamThicknessSet` computes it for you.
   */
  maxAnnualYieldUsd?: number;
  /** Instant to measure emissions decay against. Defaults to now. */
  at?: EvaluationInstant;
  /** Floor applied to the returned thickness. Defaults to `MIN_THICKNESS`. */
  minThickness?: number;
}

export interface SeamThickness {
  seamId: string;
  yieldKind: YieldKind;
  /** Realized annual yield produced by this seam, USD. */
  annualYieldUsd: number;
  /** Normalized draw width, 0..1. Monotonic in realized yield. */
  thickness: number;
  /**
   * How faint to draw the seam, 0..1.
   * 0 for sustainable seams. Emissions seams start at `MIN_EMISSION_FADE` and
   * reach 1 as their program runs out, so a drying seam looks like one.
   */
  fade: number;
  /** Fractional days until the emissions program ends. Null for sustainable. */
  daysUntilEmissionEnd: number | null;
}

/** Realized annual yield of a seam in USD, from TVL and quoted rate. */
export function annualYieldUsd(seam: Seam): number {
  return (seam.tvlUsd * seam.apyBps) / BPS_DENOMINATOR;
}

function fadeFor(seam: Seam, at: Date): { fade: number; daysUntilEmissionEnd: number | null } {
  if (seam.yieldKind !== "emissions" || seam.emissionEndsAt === null) {
    return { fade: 0, daysUntilEmissionEnd: null };
  }
  const endsAt = parseInstant(seam.emissionEndsAt, "emissionEndsAt");
  const remainingDays = daysBetween(at, endsAt);
  if (remainingDays <= 0) return { fade: 1, daysUntilEmissionEnd: remainingDays };
  const progress = clamp01(1 - remainingDays / FADE_HORIZON_DAYS);
  const fade = MIN_EMISSION_FADE + (1 - MIN_EMISSION_FADE) * progress;
  return { fade: roundTo(fade, 4), daysUntilEmissionEnd: remainingDays };
}

/**
 * Normalized draw width for one seam, 0..1.
 *
 * Thickness tracks realized yield, not headline rate: a 40% rate on 200k USD is
 * a thinner seam than a 4% rate on 40m USD, and drawing it the other way round
 * would advertise the rate instead of the yield.
 *
 * With `options.maxAnnualYieldUsd` supplied the ratio is realized yield over
 * the set's largest realized yield. Without it, `maxTvlUsd` alone can only
 * express capital share, and the result falls back to that. The square root
 * keeps small seams legible at 3D line widths.
 */
export function seamThickness(
  seam: Seam,
  maxTvlUsd: number,
  options: ThicknessOptions = {},
): SeamThickness {
  validateSeam(seam);
  if (typeof maxTvlUsd !== "number" || !Number.isFinite(maxTvlUsd) || maxTvlUsd < 0) {
    throw new AssayError(
      "INVALID_INPUT",
      `maxTvlUsd must be a finite non-negative number, received ${String(maxTvlUsd)}`,
      { field: "maxTvlUsd", seamId: seam.id },
    );
  }
  const at = resolveInstant(options.at, "at");
  const minThickness = options.minThickness ?? MIN_THICKNESS;
  const seamYield = annualYieldUsd(seam);

  const reference =
    options.maxAnnualYieldUsd !== undefined && options.maxAnnualYieldUsd > 0
      ? options.maxAnnualYieldUsd
      : (maxTvlUsd * seam.apyBps) / BPS_DENOMINATOR;

  const ratio = reference > 0 ? clamp01(seamYield / reference) : 0;
  const thickness = minThickness + (1 - minThickness) * Math.sqrt(ratio);
  const { fade, daysUntilEmissionEnd } = fadeFor(seam, at);

  return {
    seamId: seam.id,
    yieldKind: seam.yieldKind,
    annualYieldUsd: roundTo(seamYield, 2),
    thickness: roundTo(clamp01(thickness), 4),
    fade,
    daysUntilEmissionEnd,
  };
}

/**
 * Thickness for every seam in a set, normalized against the set's largest
 * realized annual yield. This is the form the Seam Map uses.
 */
export function seamThicknessSet(
  seams: readonly Seam[],
  options: Omit<ThicknessOptions, "maxAnnualYieldUsd"> = {},
): SeamThickness[] {
  validateSeams(seams);
  let maxTvlUsd = 0;
  let maxAnnualYieldUsd = 0;
  for (const seam of seams) {
    maxTvlUsd = Math.max(maxTvlUsd, seam.tvlUsd);
    maxAnnualYieldUsd = Math.max(maxAnnualYieldUsd, annualYieldUsd(seam));
  }
  return seams.map((seam) => seamThickness(seam, maxTvlUsd, { ...options, maxAnnualYieldUsd }));
}
