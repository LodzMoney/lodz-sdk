import { BPS_DENOMINATOR, allocateUnits, roundDivInt } from "./bps.js";
import {
  LIQUIDITY_FLOOR_USD,
  hasUnknownIl,
  isBelowLiquidityFloor,
  seamDataQuality,
  selectQuotedApy,
} from "./quality.js";
import type { SeamDataQuality } from "./quality.js";
import { daysBetween, parseInstant, resolveInstant, toIso } from "./time.js";
import type {
  Allocation,
  ApyBasis,
  BpsSplit,
  EvaluationInstant,
  RiskTier,
  Seam,
  SeamVenueKind,
  YieldKind,
} from "./types.js";
import { resolvePortfolio } from "./validate.js";

/** One seam's contribution to the portfolio rate. */
export interface YieldComponent {
  seamId: string;
  name: string;
  venue: string;
  asset: string;
  kind: SeamVenueKind;
  yieldKind: YieldKind;
  riskTier: RiskTier;
  /** Share of capital routed to this seam, in bps. */
  allocationBps: number;
  /** The rate the engine quotes for this seam, in bps. */
  apyBps: number;
  /** Which observation the quoted rate came from. */
  apyBasis: ApyBasis;
  /** The spot rate as observed, in bps. Reported, not used, when smoothed. */
  spotApyBps: number;
  /** The rate the seam is actually paying at the evaluated instant, in bps. */
  effectiveApyBps: number;
  /**
   * This seam's share of the portfolio rate, in bps.
   * The components sum to exactly `apyBps` of the decomposition.
   */
  contributionApyBps: number;
  /** Share of the portfolio rate, in bps. Sums to exactly 10000 when the rate is non-zero. */
  shareOfApyBps: number;
  /** Annual impermanent loss drag, in bps, or null when it is not known. */
  ilEstimateBps: number | null;
  emissionToken: string | null;
  emissionEndsAt: string | null;
  /** False once an emissions program has reached its end date. */
  emissionActive: boolean;
  /** Fractional days until the emissions program ends. Null when there is none. */
  daysUntilEmissionEnd: number | null;
  /** Everything the surface has to caveat about this seam's numbers. */
  quality: SeamDataQuality;
}

/** The result of splitting a portfolio rate by who pays it. */
export interface YieldDecomposition {
  /** Instant the decomposition was evaluated at, ISO-8601. */
  at: string;
  allocation: Allocation;
  /** Portfolio rate actually being paid at `at`, in bps. */
  apyBps: number;
  /** Portion an outside user pays for a service, in bps. */
  sustainableApyBps: number;
  /** Portion an incentive token program pays, in bps. */
  emissionsApyBps: number;
  /** Portion a losing counterparty pays, in bps. */
  counterpartyApyBps: number;
  /** The same three parts as a single object. */
  split: BpsSplit;
  /**
   * Portfolio rate implied by the catalog if every emissions program were still
   * running. Equals `apyBps` unless a program has already ended.
   */
  declaredApyBps: number;
  /** Rate already lost to programs that ended before `at`, in bps. */
  expiredEmissionsApyBps: number;
  /** Share of the portfolio rate each kind accounts for, in bps of the rate. */
  shareOfApyByYieldKind: Record<YieldKind, number>;
  /** Convenience aliases for `shareOfApyByYieldKind`. The three sum to 10000. */
  sustainableShareBps: number;
  emissionsShareBps: number;
  counterpartyShareBps: number;
  /** Share of capital sitting in each yield kind, in bps. */
  allocationByYieldKind: Record<YieldKind, number>;
  /** Share of capital sitting in each venue mechanism, in bps. */
  allocationByVenueKind: Record<SeamVenueKind, number>;
  components: YieldComponent[];
  /** Distinct incentive tokens currently paying into the portfolio. */
  emissionTokens: string[];
  /** Earliest future emissions end date, ISO-8601, or null when none is pending. */
  nextEmissionEndsAt: string | null;
  /** Capital sitting in seams too small to absorb it, in bps. */
  belowLiquidityFloorBps: number;
  /** Capital whose two sources disagree, in bps. */
  sourceDivergenceBps: number;
  /** Capital in LP seams with no impermanent loss estimate, in bps. */
  unknownIlBps: number;
  /** True when any allocated LP seam has no impermanent loss estimate. */
  ilUnknown: boolean;
}

/** True when the seam's emissions program is still paying at `at`. */
export function isEmissionActive(seam: Seam, at: Date): boolean {
  if (seam.yieldKind !== "emissions") return false;
  if (seam.emissionEndsAt === null) return false;
  return parseInstant(seam.emissionEndsAt, "emissionEndsAt").getTime() > at.getTime();
}

/**
 * The rate a seam is actually paying at `at`.
 *
 * Starts from the quoted rate, not the raw spot field. An emissions seam whose
 * program has ended pays nothing: reporting its quoted rate after the end date
 * would be reporting a number nobody is paying.
 */
export function effectiveApyBps(seam: Seam, at: Date): number {
  const quoted = selectQuotedApy(seam).apyBps;
  if (seam.yieldKind !== "emissions") return quoted;
  return isEmissionActive(seam, at) ? quoted : 0;
}

/**
 * Split a portfolio rate by who pays it.
 *
 * Three parts, never one blended number. "APY 59%" made of 11% swap fees and
 * 48% of trader losses is a different asset from 59% of swap fees, and an
 * incentive-funded 59% is a third thing again.
 *
 * @param seams   Portfolio seams. Validated on every call.
 * @param allocation Optional override; defaults to each seam's `allocationBps`.
 * @param at      Instant to evaluate at. Defaults to now.
 */
export function decomposeYield(
  seams: readonly Seam[],
  allocation?: Allocation,
  at?: EvaluationInstant,
): YieldDecomposition {
  const portfolio = resolvePortfolio(seams, allocation);
  const instant = resolveInstant(at, "at");
  return decomposeResolved(portfolio.seams, portfolio.allocation, instant);
}

/** Internal decomposition over an already validated portfolio. */
export function decomposeResolved(
  seams: readonly Seam[],
  allocation: Allocation,
  at: Date,
  floorUsd: number = LIQUIDITY_FLOOR_USD,
): YieldDecomposition {
  const numerators: number[] = [];
  const declaredNumerators: number[] = [];

  for (const seam of seams) {
    const allocationBps = allocation[seam.id] ?? 0;
    numerators.push(allocationBps * effectiveApyBps(seam, at));
    declaredNumerators.push(allocationBps * selectQuotedApy(seam).apyBps);
  }

  const numeratorTotal = numerators.reduce((sum, value) => sum + value, 0);
  const declaredTotal = declaredNumerators.reduce((sum, value) => sum + value, 0);

  const apyBps = roundDivInt(numeratorTotal, BPS_DENOMINATOR);
  const declaredApyBps = roundDivInt(declaredTotal, BPS_DENOMINATOR);

  // Split the rounded portfolio rate across seams by exact numerator weight.
  // Doing it this way makes the per-seam contributions sum to the portfolio
  // rate exactly, instead of each seam rounding on its own and slipping off the total.
  const contributions =
    numeratorTotal > 0 && apyBps > 0
      ? allocateUnits(numerators, apyBps)
      : new Array<number>(seams.length).fill(0);
  const shares =
    numeratorTotal > 0
      ? allocateUnits(numerators, BPS_DENOMINATOR)
      : new Array<number>(seams.length).fill(0);

  const allocationByYieldKind: Record<YieldKind, number> = {
    sustainable: 0,
    emissions: 0,
    counterparty: 0,
  };
  const shareOfApyByYieldKind: Record<YieldKind, number> = {
    sustainable: 0,
    emissions: 0,
    counterparty: 0,
  };
  const allocationByVenueKind: Record<SeamVenueKind, number> = { lending: 0, lp: 0, basis: 0 };
  const apyByYieldKind: Record<YieldKind, number> = {
    sustainable: 0,
    emissions: 0,
    counterparty: 0,
  };

  const emissionTokens = new Set<string>();
  let nextEmissionEndsAtMs: number | null = null;
  let belowLiquidityFloorBps = 0;
  let sourceDivergenceBps = 0;
  let unknownIlBps = 0;

  const components: YieldComponent[] = seams.map((seam, index) => {
    const allocationBps = allocation[seam.id] ?? 0;
    const contributionApyBps = contributions[index] ?? 0;
    const active = isEmissionActive(seam, at);
    const quoted = selectQuotedApy(seam);
    const quality = seamDataQuality(seam, floorUsd);

    allocationByYieldKind[seam.yieldKind] += allocationBps;
    allocationByVenueKind[seam.kind] += allocationBps;
    apyByYieldKind[seam.yieldKind] += contributionApyBps;
    shareOfApyByYieldKind[seam.yieldKind] += shares[index] ?? 0;

    if (isBelowLiquidityFloor(seam, floorUsd)) belowLiquidityFloorBps += allocationBps;
    if (seam.sourceDivergence === true) sourceDivergenceBps += allocationBps;
    if (hasUnknownIl(seam)) unknownIlBps += allocationBps;

    let daysUntilEmissionEnd: number | null = null;
    if (seam.emissionEndsAt !== null) {
      const endsAt = parseInstant(seam.emissionEndsAt, "emissionEndsAt");
      daysUntilEmissionEnd = daysBetween(at, endsAt);
      if (active && allocationBps > 0) {
        emissionTokens.add(seam.emissionToken ?? "");
        const endsAtMs = endsAt.getTime();
        if (nextEmissionEndsAtMs === null || endsAtMs < nextEmissionEndsAtMs) {
          nextEmissionEndsAtMs = endsAtMs;
        }
      }
    }

    return {
      seamId: seam.id,
      name: seam.name,
      venue: seam.venue,
      asset: seam.asset,
      kind: seam.kind,
      yieldKind: seam.yieldKind,
      riskTier: seam.riskTier,
      allocationBps,
      apyBps: quoted.apyBps,
      apyBasis: quoted.basis,
      spotApyBps: quoted.spotBps,
      effectiveApyBps: effectiveApyBps(seam, at),
      contributionApyBps,
      shareOfApyBps: shares[index] ?? 0,
      ilEstimateBps: seam.ilEstimateBps,
      emissionToken: seam.emissionToken,
      emissionEndsAt: seam.emissionEndsAt,
      emissionActive: active,
      daysUntilEmissionEnd,
      quality,
    };
  });

  return {
    at: toIso(at),
    allocation,
    apyBps,
    sustainableApyBps: apyByYieldKind.sustainable,
    emissionsApyBps: apyByYieldKind.emissions,
    counterpartyApyBps: apyByYieldKind.counterparty,
    split: {
      total: apyBps,
      sustainable: apyByYieldKind.sustainable,
      emissions: apyByYieldKind.emissions,
      counterparty: apyByYieldKind.counterparty,
    },
    declaredApyBps,
    expiredEmissionsApyBps: declaredApyBps - apyBps,
    shareOfApyByYieldKind,
    sustainableShareBps: shareOfApyByYieldKind.sustainable,
    emissionsShareBps: shareOfApyByYieldKind.emissions,
    counterpartyShareBps: shareOfApyByYieldKind.counterparty,
    allocationByYieldKind,
    allocationByVenueKind,
    components,
    emissionTokens: [...emissionTokens].filter((token) => token.length > 0).sort(),
    nextEmissionEndsAt:
      nextEmissionEndsAtMs === null ? null : toIso(new Date(nextEmissionEndsAtMs)),
    belowLiquidityFloorBps,
    sourceDivergenceBps,
    unknownIlBps,
    ilUnknown: unknownIlBps > 0,
  };
}
