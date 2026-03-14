import { ZERO_AMOUNT, accrueSats, amountFromSats, annualizeBps, btcToSats } from "./amount.js";
import { BPS_DENOMINATOR, MS_PER_DAY, allocateUnits, roundDivInt } from "./bps.js";
import { decomposeResolved, effectiveApyBps } from "./decompose.js";
import type { YieldDecomposition } from "./decompose.js";
import { AssayError } from "./errors.js";
import { simulateResolved } from "./emissions.js";
import type { PostEmissionsProjection } from "./emissions.js";
import { LIQUIDITY_FLOOR_USD, hasUnknownIl, selectQuotedApy } from "./quality.js";
import type { SeamDataQuality } from "./quality.js";
import { DEFAULT_STOPE_POLICIES, deriveStopeAllocation } from "./stope.js";
import type { StopeAllocationResult, StopePolicyTable } from "./stope.js";
import { seamThicknessSet } from "./thickness.js";
import { parseInstant, resolveInstant, toIso } from "./time.js";
import type {
  Allocation,
  Amount,
  AmountSplit,
  ApyBasis,
  EvaluationInstant,
  PairVolatilityClass,
  RiskTier,
  Seam,
  SeamVenueKind,
  StopeProfile,
  YieldKind,
} from "./types.js";
import { applyLiquidityFloor, resolvePortfolio } from "./validate.js";
import type { LiquidityFloorResult } from "./validate.js";

/** Centi-points assigned to each risk tier for weighting. */
export const RISK_TIER_SCORE: Record<RiskTier, number> = { low: 100, medium: 200, high: 300 };

/** Upper bound of each tier on the weighted centi-point scale. */
export const RISK_TIER_THRESHOLDS: readonly { tier: RiskTier; maxScore: number }[] = [
  { tier: "low", maxScore: 150 },
  { tier: "medium", maxScore: 250 },
  { tier: "high", maxScore: Number.POSITIVE_INFINITY },
];

/** Map a weighted centi-point score back onto a tier. */
export function tierFromScore(score: number): RiskTier {
  for (const threshold of RISK_TIER_THRESHOLDS) {
    if (score <= threshold.maxScore) return threshold.tier;
  }
  return "high";
}

export interface SeamContribution {
  seamId: string;
  name: string;
  venue: string;
  asset: string;
  kind: SeamVenueKind;
  yieldKind: YieldKind;
  riskTier: RiskTier;
  allocationBps: number;
  /** The rate the engine quotes for this seam, in bps. */
  apyBps: number;
  apyBasis: ApyBasis;
  spotApyBps: number;
  /** Rate the seam is actually paying at the evaluation instant, in bps. */
  effectiveApyBps: number;
  /** BTC routed to this seam. */
  principal: Amount;
  /** Yield if today's rate held for the whole horizon. */
  yieldFlat: Amount;
  /** Yield once this seam's emissions program stops on schedule. */
  yieldScheduled: Amount;
  /** Impermanent loss drag over the horizon. Zero when the estimate is unknown. */
  ilDrag: Amount;
  /** Annual impermanent loss estimate in bps, or null when it is not known. */
  ilEstimateBps: number | null;
  /** True for an LP seam with no impermanent loss estimate. */
  ilUnknown: boolean;
  pairVolatilityClass: PairVolatilityClass | null;
  /** Share of the flat portfolio yield, in bps. Sums to exactly 10000. */
  shareOfYieldBps: number;
  emissionToken: string | null;
  emissionEndsAt: string | null;
  emissionActive: boolean;
  daysUntilEmissionEnd: number | null;
  /** Milliseconds of the horizon this seam actually pays for. */
  accrualMs: number;
  /** Normalized draw width for the Seam Map, 0..1. */
  thickness: number;
  /** Draw fade for the Seam Map, 0..1. Non-zero only for emissions seams. */
  fade: number;
  quality: SeamDataQuality;
}

export interface PortfolioRiskWeighting {
  /** Allocation weighted tier score in centi-points, 100..300. */
  weightedScore: number;
  /** Tier the weighted score lands in. */
  weightedTier: RiskTier;
  /** Worst tier holding any capital at all. Never averaged away. */
  worstTier: RiskTier;
  /** Capital sitting in each tier, in bps. */
  allocationByTier: Record<RiskTier, number>;
}

/** Impermanent loss picture for the whole portfolio. */
export interface IlAssessment {
  /** Allocation weighted annual IL drag, in bps. Counts known estimates only. */
  ilDragBps: number;
  /** Portfolio rate after the known IL drag is taken off, in bps. May be negative. */
  netOfIlBps: number;
  /**
   * True when any allocated LP seam has no estimate. When this is true,
   * `netOfIlBps` is an upper bound, not an answer.
   */
  ilUnknown: boolean;
  /** LP capital with a known estimate, in bps of LP capital. */
  ilCoverageBps: number;
  /** LP capital with no estimate, in bps of total capital. */
  unknownIlAllocationBps: number;
  /** LP seams with no estimate. */
  unknownIlSeamIds: string[];
  /** Drag over the projection horizon, in BTC. */
  ilDrag: Amount;
}

export interface ProjectYieldInput {
  /** BTC deposited, decimal. */
  btcAmount: number;
  seams: readonly Seam[];
  /** Projection window in days. Fractional days are allowed. */
  horizonDays: number;
  /** Stope vault profile. Derives the allocation when no explicit map is given. */
  stope?: StopeProfile;
  /** Explicit allocation. Takes precedence over `stope`. */
  allocation?: Allocation;
  /** Instant to evaluate from. Defaults to now. */
  at?: EvaluationInstant;
  /** Override the Stope policy table. */
  stopePolicies?: StopePolicyTable;
  /** Minimum venue size, USD. Defaults to `LIQUIDITY_FLOOR_USD`. */
  liquidityFloorUsd?: number;
  /** Set false to route into undersized venues anyway. Defaults to true. */
  enforceLiquidityFloor?: boolean;
}

export interface YieldProjection {
  at: string;
  btcAmount: number;
  principal: Amount;
  horizonDays: number;
  stope: StopeProfile | null;
  /** Allocation actually used, summing to exactly 10000 bps. */
  allocation: Allocation;
  /** Present when the allocation was derived from a Stope profile. */
  stopeAllocation: StopeAllocationResult | null;
  /** What the liquidity floor did to the allocation. */
  liquidityFloor: LiquidityFloorResult;
  /** Rate split by who pays it. */
  decomposition: YieldDecomposition;
  /** Rate staircase across every emissions end date. */
  emissions: PostEmissionsProjection;
  /** Yield assuming today's rate holds for the whole horizon. */
  yieldFlat: AmountSplit;
  /** Yield once every emissions program stops on its declared date. */
  yieldScheduled: AmountSplit;
  /** BTC the flat projection overstates by, if the programs end on schedule. */
  emissionsShortfall: Amount;
  /** Scheduled yield with the known impermanent loss drag taken off. */
  yieldScheduledNetOfIl: Amount;
  /** Impermanent loss picture. `netOfIlBps` lives here. */
  il: IlAssessment;
  /** Realized rate over the horizon once emissions stop on schedule, in bps. */
  realizedApyBps: number;
  /** Rate once every emissions program has ended, in bps. */
  postEmissionsApyBps: number;
  contributions: SeamContribution[];
  risk: PortfolioRiskWeighting;
}

function splitFromSats(
  total: bigint,
  sustainable: bigint,
  emissions: bigint,
  counterparty: bigint,
): AmountSplit {
  const wrap = (value: bigint): Amount => (value === 0n ? ZERO_AMOUNT : amountFromSats(value));
  return {
    total: wrap(total),
    sustainable: wrap(sustainable),
    emissions: wrap(emissions),
    counterparty: wrap(counterparty),
  };
}

/**
 * Project yield for a BTC deposit over a horizon.
 *
 * Three totals come back on purpose. `yieldFlat` is the number produced by
 * holding today's rate flat, which is what a headline APY implies.
 * `yieldScheduled` stops each incentive program on its declared end date.
 * `yieldScheduledNetOfIl` then takes off the impermanent loss that is known
 * about. Where it is not known, `il.ilUnknown` says so instead of the engine
 * inventing a figure.
 */
export function projectYield(input: ProjectYieldInput): YieldProjection {
  if (input === null || typeof input !== "object") {
    throw new AssayError("INVALID_INPUT", "projectYield requires an input object");
  }
  const {
    btcAmount,
    seams,
    horizonDays,
    stope,
    allocation,
    at,
    stopePolicies,
    liquidityFloorUsd,
    enforceLiquidityFloor,
  } = input;

  if (typeof horizonDays !== "number" || !Number.isFinite(horizonDays) || horizonDays <= 0) {
    throw new AssayError(
      "INVALID_INPUT",
      `horizonDays must be a finite positive number, received ${String(horizonDays)}`,
      { field: "horizonDays" },
    );
  }

  const floorUsd = liquidityFloorUsd ?? LIQUIDITY_FLOOR_USD;
  const from = resolveInstant(at, "at");
  const principalSats = btcToSats(btcAmount);
  const horizonMs = Math.round(horizonDays * MS_PER_DAY);
  const horizonEndMs = from.getTime() + horizonMs;

  let stopeAllocation: StopeAllocationResult | null = null;
  let resolvedAllocation: Allocation;
  if (allocation !== undefined) {
    resolvedAllocation = resolvePortfolio(seams, allocation).allocation;
  } else if (stope !== undefined) {
    stopeAllocation = deriveStopeAllocation(
      seams,
      stope,
      stopePolicies ?? DEFAULT_STOPE_POLICIES,
      floorUsd,
    );
    resolvedAllocation = resolvePortfolio(seams, stopeAllocation.allocation).allocation;
  } else {
    resolvedAllocation = resolvePortfolio(seams).allocation;
  }

  const liquidityFloor =
    enforceLiquidityFloor === false
      ? {
          allocation: resolvedAllocation,
          floorUsd,
          excludedSeamIds: [],
          reallocatedBps: 0,
          applied: false,
        }
      : applyLiquidityFloor(seams, resolvedAllocation, floorUsd);
  const effectiveAllocation = liquidityFloor.allocation;

  const decomposition = decomposeResolved(seams, effectiveAllocation, from, floorUsd);
  const emissions = simulateResolved(seams, effectiveAllocation, from);
  const thicknesses = new Map(
    seamThicknessSet(seams, { at: from }).map((entry) => [entry.seamId, entry]),
  );

  const flatSats: bigint[] = [];
  const scheduledSats: bigint[] = [];
  const ilSats: bigint[] = [];
  const accrualMsList: number[] = [];

  const flatByKind: Record<YieldKind, bigint> = {
    sustainable: 0n,
    emissions: 0n,
    counterparty: 0n,
  };
  const scheduledByKind: Record<YieldKind, bigint> = {
    sustainable: 0n,
    emissions: 0n,
    counterparty: 0n,
  };
  let flatTotal = 0n;
  let scheduledTotal = 0n;
  let ilTotal = 0n;

  let ilNumerator = 0;
  let lpAllocationBps = 0;
  let lpCoveredBps = 0;
  let unknownIlAllocationBps = 0;
  const unknownIlSeamIds: string[] = [];

  for (const seam of seams) {
    const allocationBps = effectiveAllocation[seam.id] ?? 0;
    const rateBps = effectiveApyBps(seam, from);
    const quotedBps = selectQuotedApy(seam).apyBps;

    const flat = accrueSats(principalSats, allocationBps, rateBps, horizonMs);

    // An emissions program only pays until its end date, even if the horizon
    // runs past it. Other kinds pay for the whole horizon.
    let accrualMs = horizonMs;
    if (seam.yieldKind === "emissions" && seam.emissionEndsAt !== null) {
      const endsAtMs = parseInstant(seam.emissionEndsAt, "emissionEndsAt").getTime();
      accrualMs = Math.max(0, Math.min(horizonEndMs, endsAtMs) - from.getTime());
    }
    const scheduled = accrueSats(principalSats, allocationBps, quotedBps, accrualMs);

    // Impermanent loss only counts where somebody actually measured it.
    const ilBps = seam.ilEstimateBps;
    const ilDrag = ilBps === null ? 0n : accrueSats(principalSats, allocationBps, ilBps, horizonMs);
    if (ilBps !== null) ilNumerator += allocationBps * ilBps;
    if (seam.kind === "lp") {
      lpAllocationBps += allocationBps;
      if (ilBps === null) {
        unknownIlAllocationBps += allocationBps;
        if (allocationBps > 0) unknownIlSeamIds.push(seam.id);
      } else {
        lpCoveredBps += allocationBps;
      }
    }

    flatSats.push(flat);
    scheduledSats.push(scheduled);
    ilSats.push(ilDrag);
    accrualMsList.push(accrualMs);

    flatTotal += flat;
    scheduledTotal += scheduled;
    ilTotal += ilDrag;
    flatByKind[seam.yieldKind] += flat;
    scheduledByKind[seam.yieldKind] += scheduled;
  }

  const shareWeights = flatSats.map((value) => Number(value));
  const shares =
    flatTotal > 0n
      ? allocateUnits(shareWeights, BPS_DENOMINATOR)
      : new Array<number>(seams.length).fill(0);

  const componentsById = new Map(
    decomposition.components.map((component) => [component.seamId, component]),
  );

  const contributions: SeamContribution[] = seams.map((seam, index) => {
    const allocationBps = effectiveAllocation[seam.id] ?? 0;
    const component = componentsById.get(seam.id);
    const thickness = thicknesses.get(seam.id);
    const quoted = selectQuotedApy(seam);
    const seamPrincipalSats =
      allocationBps === 0
        ? 0n
        : (principalSats * BigInt(allocationBps)) / BigInt(BPS_DENOMINATOR);

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
      effectiveApyBps: component?.effectiveApyBps ?? effectiveApyBps(seam, from),
      principal: amountFromSats(seamPrincipalSats),
      yieldFlat: amountFromSats(flatSats[index] ?? 0n),
      yieldScheduled: amountFromSats(scheduledSats[index] ?? 0n),
      ilDrag: amountFromSats(ilSats[index] ?? 0n),
      ilEstimateBps: seam.ilEstimateBps,
      ilUnknown: hasUnknownIl(seam),
      pairVolatilityClass: seam.pairVolatilityClass,
      shareOfYieldBps: shares[index] ?? 0,
      emissionToken: seam.emissionToken,
      emissionEndsAt: seam.emissionEndsAt,
      emissionActive: component?.emissionActive ?? false,
      daysUntilEmissionEnd: component?.daysUntilEmissionEnd ?? null,
      accrualMs: accrualMsList[index] ?? 0,
      thickness: thickness?.thickness ?? 0,
      fade: thickness?.fade ?? 0,
      quality: component?.quality ?? {
        seamId: seam.id,
        apyBasis: quoted.basis,
        quotedApyBps: quoted.apyBps,
        spotApyBps: quoted.spotBps,
        spotRejected: quoted.spotRejected,
        spotMultiple: quoted.spotMultiple,
        spotOnly: quoted.spotOnly,
        belowLiquidityFloor: false,
        sourceDivergence: seam.sourceDivergence === true,
        ilUnknown: hasUnknownIl(seam),
        ilEstimateBps: seam.ilEstimateBps,
        pairVolatilityClass: seam.pairVolatilityClass,
        hasCaveats: false,
      },
    };
  });

  const allocationByTier: Record<RiskTier, number> = { low: 0, medium: 0, high: 0 };
  let weightedNumerator = 0;
  let worstTier: RiskTier = "low";
  for (const seam of seams) {
    const allocationBps = effectiveAllocation[seam.id] ?? 0;
    allocationByTier[seam.riskTier] += allocationBps;
    weightedNumerator += allocationBps * RISK_TIER_SCORE[seam.riskTier];
    if (allocationBps > 0 && RISK_TIER_SCORE[seam.riskTier] > RISK_TIER_SCORE[worstTier]) {
      worstTier = seam.riskTier;
    }
  }
  const weightedScore = roundDivInt(weightedNumerator, BPS_DENOMINATOR);
  const ilDragBps = roundDivInt(ilNumerator, BPS_DENOMINATOR);

  return {
    at: toIso(from),
    btcAmount,
    principal: amountFromSats(principalSats),
    horizonDays,
    stope: stope ?? null,
    allocation: effectiveAllocation,
    stopeAllocation,
    liquidityFloor,
    decomposition,
    emissions,
    yieldFlat: splitFromSats(
      flatTotal,
      flatByKind.sustainable,
      flatByKind.emissions,
      flatByKind.counterparty,
    ),
    yieldScheduled: splitFromSats(
      scheduledTotal,
      scheduledByKind.sustainable,
      scheduledByKind.emissions,
      scheduledByKind.counterparty,
    ),
    emissionsShortfall: amountFromSats(flatTotal - scheduledTotal),
    yieldScheduledNetOfIl: amountFromSats(scheduledTotal - ilTotal),
    il: {
      ilDragBps,
      netOfIlBps: decomposition.apyBps - ilDragBps,
      ilUnknown: unknownIlSeamIds.length > 0,
      ilCoverageBps:
        lpAllocationBps > 0 ? roundDivInt(lpCoveredBps * BPS_DENOMINATOR, lpAllocationBps) : 0,
      unknownIlAllocationBps,
      unknownIlSeamIds,
      ilDrag: amountFromSats(ilTotal),
    },
    realizedApyBps: annualizeBps(scheduledTotal, principalSats, horizonMs),
    postEmissionsApyBps: emissions.postEmissionsApyBps,
    contributions,
    risk: {
      weightedScore,
      weightedTier: tierFromScore(weightedScore),
      worstTier,
      allocationByTier,
    },
  };
}
