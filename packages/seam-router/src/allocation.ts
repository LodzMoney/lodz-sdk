import {
  PAIR_VOLATILITY_CLASSES,
  RISK_TIERS,
  YIELD_KINDS,
  assertStopeProfile,
  resolveConstraints,
} from "./constraints.js";
import { fail } from "./errors.js";
import {
  BPS_TOTAL,
  EPSILON,
  MAX_CAPITAL_BTC,
  btcToSats,
  clamp,
  isFiniteNumber,
  isNonNegativeNumber,
  isObject,
  largestRemainder,
  roundTo,
  satsToBtc,
  sum,
} from "./math.js";
import { daysBetween, parseTimestamp } from "./time.js";
import type {
  AllocationInput,
  AllocationPlan,
  ApySource,
  BindingCap,
  ExcludedSeam,
  PairVolatilityClass,
  RiskTier,
  Seam,
  SeamAllocation,
  SeamVenueKind,
  YieldKind,
} from "./types.js";

/**
 * How much a risk tier is discounted at full risk aversion. A high tier seam has to
 * out-yield a low tier seam by more than three times before a conservative book will
 * rank it first.
 */
const TIER_PENALTY: Record<RiskTier, number> = { low: 0, medium: 0.35, high: 0.7 };

/**
 * How much each yield source is discounted at full risk aversion.
 *
 * Emission yield is real while it lasts and then stops on a schedule. Counterparty
 * yield is funded by the losing side of a trade, which makes it both capacity-limited
 * and mean-reverting: a 214 percent reading is a statement about how badly traders did
 * last month, not about what the next month pays.
 */
const KIND_PENALTY: Record<YieldKind, number> = {
  sustainable: 0,
  emissions: 0.5,
  counterparty: 0.65,
};

/**
 * How much an LP pair is discounted for the divergence between its two sides. An
 * uncorrelated pair can lose more to impermanent loss than it collects in fees.
 */
const PAIR_PENALTY: Record<PairVolatilityClass, number> = {
  correlated: 0,
  mixed: 0.2,
  uncorrelated: 0.45,
};

/**
 * Discount applied to an LP seam whose impermanent loss nobody has measured.
 *
 * This is a ranking penalty, not a substitute figure. The seam's reported `netApyBps`
 * stays null, because inventing a number for an unmeasured cost is how a gross rate
 * gets presented as a net one.
 */
const IL_UNKNOWN_PENALTY = 0.5;

const VENUE_KINDS: readonly SeamVenueKind[] = ["lending", "lp", "basis"];

interface CapGroup {
  kind: Exclude<BindingCap, null>;
  capBps: number;
  members: number[];
}

const BINDING_PRIORITY: ReadonlyArray<Exclude<BindingCap, null>> = [
  "seam-tvl",
  "seam",
  "counterparty",
  "uncorrelated-lp",
  "emissions",
  "risk-tier",
  "venue",
  "asset",
];

function isNullableRate(value: unknown): value is number | null {
  return value === null || isNonNegativeNumber(value);
}

function validateSeams(seams: readonly Seam[]): void {
  if (!Array.isArray(seams as unknown)) {
    fail("INVALID_SEAM", "seams must be an array");
  }
  const seen = new Set<string>();
  for (let index = 0; index < seams.length; index += 1) {
    const seam = seams[index];
    const at = `seams[${index}]`;
    if (!isObject(seam)) {
      fail("INVALID_SEAM", `${at} must be an object`, { index });
    }
    if (typeof seam.id !== "string" || seam.id.length === 0) {
      fail("INVALID_SEAM", `${at}.id must be a non-empty string`, { index });
    }
    if (seen.has(seam.id)) {
      fail("DUPLICATE_SEAM", `${at}.id "${seam.id}" appears more than once`, { id: seam.id });
    }
    seen.add(seam.id);
    if (typeof seam.venue !== "string" || seam.venue.length === 0) {
      fail("INVALID_SEAM", `${at}.venue must be a non-empty string`, { id: seam.id });
    }
    if (typeof seam.asset !== "string" || seam.asset.length === 0) {
      fail("INVALID_SEAM", `${at}.asset must be a non-empty string`, { id: seam.id });
    }
    if (!VENUE_KINDS.includes(seam.kind)) {
      fail("INVALID_SEAM", `${at}.kind must be one of ${VENUE_KINDS.join(", ")}`, { id: seam.id });
    }
    if (!YIELD_KINDS.includes(seam.yieldKind)) {
      fail("INVALID_SEAM", `${at}.yieldKind must be one of ${YIELD_KINDS.join(", ")}`, {
        id: seam.id,
      });
    }
    if (!RISK_TIERS.includes(seam.riskTier)) {
      fail("INVALID_SEAM", `${at}.riskTier must be one of ${RISK_TIERS.join(", ")}`, {
        id: seam.id,
      });
    }
    if (!isNonNegativeNumber(seam.apyBps)) {
      fail("INVALID_SEAM", `${at}.apyBps must be a non-negative finite number`, { id: seam.id });
    }
    for (const field of ["apy7dBps", "apy30dBps", "apy90dMedianBps"] as const) {
      if (!isNullableRate(seam[field])) {
        fail("INVALID_SEAM", `${at}.${field} must be a non-negative finite number or null`, {
          id: seam.id,
          field,
        });
      }
    }
    if (!isNullableRate(seam.ilEstimateBps)) {
      fail("INVALID_SEAM", `${at}.ilEstimateBps must be a non-negative finite number or null`, {
        id: seam.id,
      });
    }
    if (
      seam.pairVolatilityClass !== null &&
      !PAIR_VOLATILITY_CLASSES.includes(seam.pairVolatilityClass)
    ) {
      fail(
        "INVALID_SEAM",
        `${at}.pairVolatilityClass must be one of ${PAIR_VOLATILITY_CLASSES.join(", ")} or null`,
        { id: seam.id },
      );
    }
    for (const flag of ["belowLiquidityFloor", "sourceDivergence"] as const) {
      if (typeof seam[flag] !== "boolean") {
        fail("INVALID_SEAM", `${at}.${flag} must be a boolean`, { id: seam.id, field: flag });
      }
    }
    if (!isNonNegativeNumber(seam.wrapHops) || !Number.isInteger(seam.wrapHops)) {
      fail("INVALID_SEAM", `${at}.wrapHops must be a non-negative integer`, { id: seam.id });
    }
    if (!isNonNegativeNumber(seam.tvlUsd)) {
      fail("INVALID_SEAM", `${at}.tvlUsd must be a non-negative finite number`, { id: seam.id });
    }
    if (seam.emissionEndsAt !== null && typeof seam.emissionEndsAt !== "string") {
      fail("INVALID_SEAM", `${at}.emissionEndsAt must be an ISO-8601 string or null`, {
        id: seam.id,
      });
    }
  }
}

interface DurableApy {
  grossApyBps: number;
  apySource: ApySource;
  spotRejected: boolean;
}

/**
 * Pick the rate the planner is allowed to route on.
 *
 * The spot rate is never it. Orca cbBTC-USDC has a day in its history reading 74,187
 * percent, produced by dividing a normal fee take by a momentarily tiny TVL. Routing on
 * spot would have put the whole book there for a day.
 *
 * Among the trailing windows the lowest one wins, and `apySource` names which it was.
 * Windows disagree by a lot on this market: Orca cbBTC-USDC reads 15.46 percent over
 * seven days, 22.01 over thirty and 28.50 as a ninety day median. Picking the highest
 * would let the planner justify a position with a rate the pool is no longer paying, so
 * the lowest is used. It cannot overstate, and no single inflated window can carry a
 * seam into the book on its own.
 *
 * `spotRejected` is raised separately when the spot reading exceeds the trailing week
 * by more than the allowed multiple. The flag is for disclosure; the spot value never
 * reaches the allocation either way.
 *
 * Returns null when the seam has no trailing figure at all. That seam is then excluded
 * rather than routed on its spot rate.
 */
function resolveDurableApy(seam: Seam, spotRejectMultiple: number): DurableApy | null {
  const windows: Array<{ value: number; source: ApySource }> = [];
  if (isFiniteNumber(seam.apy7dBps)) windows.push({ value: seam.apy7dBps, source: "apy7d" });
  if (isFiniteNumber(seam.apy30dBps)) windows.push({ value: seam.apy30dBps, source: "apy30d" });
  if (isFiniteNumber(seam.apy90dMedianBps)) {
    windows.push({ value: seam.apy90dMedianBps, source: "apy90dMedian" });
  }

  const chosen = windows[0];
  if (chosen === undefined) return null;
  let best = chosen;
  for (const window of windows) {
    if (window.value < best.value) best = window;
  }

  const weekly = isFiniteNumber(seam.apy7dBps) ? seam.apy7dBps : null;
  const reference = weekly ?? best.value;
  const spotRejected = reference > 0 && seam.apyBps > reference * spotRejectMultiple;

  return { grossApyBps: best.value, apySource: best.source, spotRejected };
}

function groupHeadroom(index: number, alloc: number[], groups: CapGroup[], membership: number[][]): number {
  let room = Number.POSITIVE_INFINITY;
  for (const groupIndex of membership[index]) {
    const group = groups[groupIndex];
    let used = 0;
    for (const member of group.members) used += alloc[member];
    const available = group.capBps - used;
    if (available < room) room = available;
  }
  return room > 0 ? room : 0;
}

/**
 * Proportional allocation under simultaneous group ceilings.
 *
 * Capital is poured out in rounds. Each round splits what is left across the seams
 * that still have room, in proportion to their weight, and then applies the largest
 * uniform fraction of that demand which breaches no ceiling. Every round therefore
 * either exhausts the budget or saturates at least one ceiling, and the seams sharing a
 * ceiling divide it in proportion to their weight instead of by whoever is read first.
 *
 * Scaling the whole round by one factor is what makes the result independent of
 * iteration order. Filling seam by seam would let the first seam in a shared group take
 * all of that group's headroom, which would make the plan an artifact of array order
 * rather than of the weights.
 */
function waterfill(
  order: readonly number[],
  weights: readonly number[],
  groups: CapGroup[],
  membership: number[][],
  budgetBps: number,
  size: number,
): number[] {
  const alloc = new Array<number>(size).fill(0);
  let remaining = budgetBps;

  for (let round = 0; round < 256 && remaining > EPSILON; round += 1) {
    const eligible = order.filter(
      (index) => weights[index] > 0 && groupHeadroom(index, alloc, groups, membership) > EPSILON,
    );
    if (eligible.length === 0) break;

    let weightSum = 0;
    for (const index of eligible) weightSum += weights[index];
    if (weightSum <= 0) break;

    const demand = new Array<number>(size).fill(0);
    for (const index of eligible) demand[index] = (remaining * weights[index]) / weightSum;

    let scale = 1;
    for (const group of groups) {
      let groupDemand = 0;
      let groupUsed = 0;
      for (const member of group.members) {
        groupDemand += demand[member];
        groupUsed += alloc[member];
      }
      if (groupDemand <= EPSILON) continue;
      const available = group.capBps - groupUsed;
      const groupScale = available <= 0 ? 0 : available / groupDemand;
      if (groupScale < scale) scale = groupScale;
    }
    if (scale <= 0) break;

    let added = 0;
    for (const index of eligible) {
      const give = demand[index] * scale;
      alloc[index] += give;
      added += give;
    }
    remaining -= added;
    if (added <= EPSILON) break;
  }

  return alloc;
}

function canAdd(index: number, bps: number[], groups: CapGroup[], membership: number[][]): boolean {
  for (const groupIndex of membership[index]) {
    const group = groups[groupIndex];
    let used = 0;
    for (const member of group.members) used += bps[member];
    if (used + 1 > group.capBps) return false;
  }
  return true;
}

/**
 * Turn fractional shares into whole basis points that still respect every ceiling.
 *
 * Floors first, then hands out the remainder by largest fraction, skipping any seam
 * whose extra basis point would breach a group ceiling. A basis point nobody can take
 * stays undeployed rather than quietly breaking a cap.
 */
function roundToWholeBps(
  alloc: readonly number[],
  order: readonly number[],
  groups: CapGroup[],
  membership: number[][],
  budgetBps: number,
): number[] {
  const result = alloc.map((value) => Math.floor(value + 1e-9));
  let leftover = budgetBps - sum(result);

  const rank = new Map<number, number>();
  order.forEach((index, position) => rank.set(index, position));

  const candidates = order
    .filter((index) => alloc[index] > EPSILON)
    .slice()
    .sort((a, b) => {
      const fractionA = alloc[a] - Math.floor(alloc[a] + 1e-9);
      const fractionB = alloc[b] - Math.floor(alloc[b] + 1e-9);
      return fractionB - fractionA || (rank.get(a) ?? 0) - (rank.get(b) ?? 0);
    });

  while (leftover > 0) {
    let progressed = false;
    for (const index of candidates) {
      if (leftover <= 0) break;
      if (!canAdd(index, result, groups, membership)) continue;
      result[index] += 1;
      leftover -= 1;
      progressed = true;
    }
    if (!progressed) break;
  }

  return result;
}

function bindingCapFor(
  index: number,
  bps: readonly number[],
  groups: CapGroup[],
  membership: number[][],
): BindingCap {
  const binding = new Set<Exclude<BindingCap, null>>();
  for (const groupIndex of membership[index]) {
    const group = groups[groupIndex];
    let used = 0;
    for (const member of group.members) used += bps[member];
    if (used >= group.capBps) binding.add(group.kind);
  }
  for (const kind of BINDING_PRIORITY) {
    if (binding.has(kind)) return kind;
  }
  return null;
}

interface Scored {
  durable: DurableApy;
  netApyBps: number | null;
  ilUnknown: boolean;
  weight: number;
}

/**
 * Plan target allocations across seams for one vault posture.
 *
 * Four gates run before anything is ranked, and each one exists because the measured
 * Solana BTC market contains a case that would otherwise produce a dishonest plan:
 *
 * - a liquidity floor, because a 104 percent rate against 10,927 dollars of capacity
 *   is not a seam;
 * - a durable-rate requirement, because spot readings contain arithmetic artifacts
 *   three orders of magnitude wide;
 * - a custody hop limit, because a doubly wrapped asset carries two sets of trust
 *   assumptions and a conservative depositor did not agree to the second;
 * - an impermanent-loss gate, because the only real yield on this market is LP fees and
 *   nobody has measured the loss that offsets them.
 *
 * `sum(allocations.allocationBps) + idleBps` is exactly 10000 for every input. When the
 * ceilings make full deployment impossible the surplus stays in `idleBps` instead of
 * being forced into a seam that is already at its limit.
 */
export function planAllocation(input: AllocationInput): AllocationPlan {
  const { seams, stope, capitalBtc, btcPriceUsd } = input;

  assertStopeProfile(stope);
  if (!isNonNegativeNumber(capitalBtc)) {
    fail("INVALID_CAPITAL", "capitalBtc must be a non-negative finite number", { capitalBtc });
  }
  if (capitalBtc > MAX_CAPITAL_BTC) {
    fail("INVALID_CAPITAL", `capitalBtc must not exceed ${MAX_CAPITAL_BTC}`, { capitalBtc });
  }
  if (!isFiniteNumber(btcPriceUsd) || btcPriceUsd <= 0) {
    fail(
      "INVALID_CAPITAL",
      "btcPriceUsd must be greater than 0; the liquidity floor and the share-of-TVL ceiling are denominated in USD and cannot be enforced without it",
      { btcPriceUsd },
    );
  }
  validateSeams(seams);

  const constraints = resolveConstraints(input.constraints);
  const policy = constraints.profiles[stope];
  const nowMs = input.now === undefined ? null : parseTimestamp(input.now, "now");

  const capitalSats = btcToSats(capitalBtc);
  const capitalUsd = roundTo(capitalBtc * btcPriceUsd, 2);
  const deployableBps = BPS_TOTAL - policy.liquidityBufferBps;
  const riskAversion = policy.riskAversionBps / BPS_TOTAL;

  const excluded: ExcludedSeam[] = [];
  const weights = new Array<number>(seams.length).fill(0);
  const scored = new Array<Scored | null>(seams.length).fill(null);
  const eligible: number[] = [];

  for (let index = 0; index < seams.length; index += 1) {
    const seam = seams[index];

    if (seam.tvlUsd < constraints.minTvlUsd || seam.belowLiquidityFloor) {
      excluded.push({
        seamId: seam.id,
        reason: "below-min-tvl",
        detail: seam.belowLiquidityFloor
          ? `flagged by the indexer as unable to absorb capital (tvlUsd ${seam.tvlUsd})`
          : `tvlUsd ${seam.tvlUsd} is under the ${constraints.minTvlUsd} floor; the rate is real but the capacity is not`,
      });
      continue;
    }

    // Two sources disagreeing about a rate means at least one of them is stale. Showing
    // the disputed number as settled is how a stale feed becomes a published promise.
    if (seam.sourceDivergence) {
      excluded.push({
        seamId: seam.id,
        reason: "source-divergence",
        detail: "independent sources disagree about this seam beyond the accepted threshold",
      });
      continue;
    }

    const durable = resolveDurableApy(seam, constraints.spotRejectMultiple);
    if (durable === null) {
      excluded.push({
        seamId: seam.id,
        reason: "no-durable-apy",
        detail: "no trailing 7d, 30d or 90d rate is available, and the spot rate alone is not routable",
      });
      continue;
    }
    if (durable.grossApyBps <= 0) {
      excluded.push({
        seamId: seam.id,
        reason: "non-positive-apy",
        detail: `durable rate from ${durable.apySource} is ${durable.grossApyBps} bps, so there is nothing to route to`,
      });
      continue;
    }

    if (seam.wrapHops > policy.maxWrapHops) {
      excluded.push({
        seamId: seam.id,
        reason: "wrap-hops-exceeded",
        detail: `${seam.wrapHops} custody hops exceeds the ${policy.maxWrapHops} this profile accepts`,
      });
      continue;
    }

    if (seam.yieldKind === "counterparty" && policy.maxCounterpartyBps <= 0) {
      excluded.push({
        seamId: seam.id,
        reason: "counterparty-not-allowed",
        detail: `${stope} allows 0 bps of yield funded by another trader's loss`,
      });
      continue;
    }

    const isLp = seam.kind === "lp";
    const isUncorrelatedLp = isLp && seam.pairVolatilityClass === "uncorrelated";
    if (isUncorrelatedLp && policy.maxUncorrelatedLpBps <= 0) {
      excluded.push({
        seamId: seam.id,
        reason: "uncorrelated-lp-not-allowed",
        detail: `${stope} allows 0 bps of uncorrelated LP exposure`,
      });
      continue;
    }

    const tierCapBps = policy.maxRiskTierBps[seam.riskTier];
    if (tierCapBps <= 0) {
      excluded.push({
        seamId: seam.id,
        reason: "risk-tier-not-allowed",
        detail: `${stope} allows 0 bps of ${seam.riskTier} tier exposure`,
      });
      continue;
    }

    const ilKnown = isFiniteNumber(seam.ilEstimateBps);
    const ilUnknown = isLp && !ilKnown;
    if (ilUnknown && !policy.allowIlUnknown) {
      excluded.push({
        seamId: seam.id,
        reason: "il-unknown",
        detail: `impermanent loss for this pair is unmeasured, and ${stope} does not hold a cost nobody has sized`,
      });
      continue;
    }
    const netApyBps = ilKnown
      ? durable.grossApyBps - (seam.ilEstimateBps as number)
      : isLp
        ? null
        : durable.grossApyBps;

    let durability = 1;
    if (seam.yieldKind === "emissions" && seam.emissionEndsAt !== null && nowMs !== null) {
      const endsAtMs = parseTimestamp(seam.emissionEndsAt, `seams[${index}].emissionEndsAt`);
      const daysRemaining = daysBetween(nowMs, endsAtMs);
      if (daysRemaining <= 0) {
        excluded.push({
          seamId: seam.id,
          reason: "emissions-ended",
          detail: `emission schedule ended at ${seam.emissionEndsAt}`,
        });
        continue;
      }
      durability = clamp(daysRemaining / constraints.emissionsHorizonDays, 0, 1);
    }

    const base = netApyBps ?? durable.grossApyBps;
    const tierFactor = clamp(1 - riskAversion * TIER_PENALTY[seam.riskTier], 0, 1);
    const kindFactor = clamp(1 - riskAversion * KIND_PENALTY[seam.yieldKind], 0, 1);
    const pairFactor =
      isLp && seam.pairVolatilityClass !== null
        ? clamp(1 - riskAversion * PAIR_PENALTY[seam.pairVolatilityClass], 0, 1)
        : 1;
    const ilFactor = ilUnknown ? clamp(1 - riskAversion * IL_UNKNOWN_PENALTY, 0, 1) : 1;
    const weight = Math.max(0, base) * tierFactor * kindFactor * pairFactor * ilFactor * durability;

    if (weight <= 0) {
      excluded.push({
        seamId: seam.id,
        reason: "zero-weight",
        detail: `risk-adjusted score for ${stope} is 0 once impermanent loss and source penalties are applied`,
      });
      continue;
    }

    weights[index] = weight;
    scored[index] = { durable, netApyBps, ilUnknown, weight };
    eligible.push(index);
  }

  eligible.sort(
    (a, b) =>
      weights[b] - weights[a] ||
      (scored[b]?.durable.grossApyBps ?? 0) - (scored[a]?.durable.grossApyBps ?? 0) ||
      (seams[a].id < seams[b].id ? -1 : 1),
  );

  const kept = eligible.slice(0, constraints.maxSeams);
  for (const index of eligible.slice(constraints.maxSeams)) {
    excluded.push({
      seamId: seams[index].id,
      reason: "max-seams",
      detail: `ranked outside the top ${constraints.maxSeams} seams`,
    });
  }

  // Build the ceilings. Every ceiling is expressed in basis points of total capital.
  const groups: CapGroup[] = [];
  const membership: number[][] = seams.map(() => []);

  const register = (group: CapGroup): void => {
    if (group.members.length === 0) return;
    const groupIndex = groups.length;
    groups.push(group);
    for (const member of group.members) membership[member].push(groupIndex);
  };

  for (const index of kept) {
    register({ kind: "seam", capBps: constraints.maxSeamBps, members: [index] });
    // A position larger than a slice of the pool moves the pool. The displayed rate is
    // what the pool paid at its current size, not what it pays once we are most of it.
    const seamCapacityUsd = seams[index].tvlUsd * (constraints.maxShareOfTvlBps / BPS_TOTAL);
    const capBps =
      capitalUsd > 0
        ? Math.min(BPS_TOTAL, Math.floor((seamCapacityUsd / capitalUsd) * BPS_TOTAL))
        : BPS_TOTAL;
    register({ kind: "seam-tvl", capBps, members: [index] });
  }

  const byKey = (pick: (seam: Seam) => string): Map<string, number[]> => {
    const map = new Map<string, number[]>();
    for (const index of kept) {
      const key = pick(seams[index]);
      const bucket = map.get(key);
      if (bucket === undefined) map.set(key, [index]);
      else bucket.push(index);
    }
    return map;
  };

  for (const members of byKey((seam) => seam.venue).values()) {
    register({ kind: "venue", capBps: policy.maxSingleVenueBps, members });
  }
  for (const members of byKey((seam) => seam.asset).values()) {
    register({ kind: "asset", capBps: policy.maxSingleAssetBps, members });
  }
  for (const tier of RISK_TIERS) {
    register({
      kind: "risk-tier",
      capBps: policy.maxRiskTierBps[tier],
      members: kept.filter((index) => seams[index].riskTier === tier),
    });
  }
  register({
    kind: "emissions",
    capBps: policy.maxEmissionsBps,
    members: kept.filter((index) => seams[index].yieldKind === "emissions"),
  });
  register({
    kind: "counterparty",
    capBps: policy.maxCounterpartyBps,
    members: kept.filter((index) => seams[index].yieldKind === "counterparty"),
  });
  register({
    kind: "uncorrelated-lp",
    capBps: policy.maxUncorrelatedLpBps,
    members: kept.filter(
      (index) => seams[index].kind === "lp" && seams[index].pairVolatilityClass === "uncorrelated",
    ),
  });

  // Drop allocations too small to be worth executing, one at a time, re-pouring after
  // each drop so the freed capital lands somewhere useful.
  const dropped = new Set<number>();
  let shares = new Array<number>(seams.length).fill(0);

  for (let pass = 0; pass <= kept.length; pass += 1) {
    const active = kept.filter((index) => !dropped.has(index));
    if (active.length === 0) {
      shares = new Array<number>(seams.length).fill(0);
      break;
    }
    const activeWeights = weights.map((weight, index) => (dropped.has(index) ? 0 : weight));
    shares = waterfill(active, activeWeights, groups, membership, deployableBps, seams.length);

    let dust = -1;
    for (const index of active) {
      const share = shares[index];
      if (share > EPSILON && share < constraints.minSeamBps - 1e-6) {
        if (dust === -1 || shares[index] <= shares[dust]) dust = index;
      }
    }
    if (dust === -1) break;
    dropped.add(dust);
    excluded.push({
      seamId: seams[dust].id,
      reason: "below-min-allocation",
      detail: `share would have been under the ${constraints.minSeamBps} bps floor`,
    });
  }

  const activeOrder = kept.filter((index) => !dropped.has(index));
  const bps = roundToWholeBps(shares, activeOrder, groups, membership, deployableBps);

  for (const index of activeOrder) {
    if (bps[index] === 0) {
      excluded.push({
        seamId: seams[index].id,
        reason: "no-headroom",
        detail: "every ceiling this seam sits under was already full",
      });
    }
  }

  const allocatedOrder = activeOrder.filter((index) => bps[index] > 0);
  const totalAllocatedBps = sum(allocatedOrder.map((index) => bps[index]));
  const idleBps = BPS_TOTAL - totalAllocatedBps;

  // Split satoshis exactly, treating the idle buffer as one more bucket so the parts
  // add up to the deposited amount to the last satoshi.
  const satsParts = largestRemainder(
    [...allocatedOrder.map((index) => bps[index]), idleBps],
    capitalSats,
  );
  const idleSats = satsParts[satsParts.length - 1] ?? 0;

  const allocations: SeamAllocation[] = allocatedOrder.map((index, position) => {
    const seam = seams[index];
    const detail = scored[index];
    const sats = satsParts[position] ?? 0;
    return {
      seamId: seam.id,
      name: seam.name,
      venue: seam.venue,
      asset: seam.asset,
      kind: seam.kind,
      yieldKind: seam.yieldKind,
      riskTier: seam.riskTier,
      wrapHops: seam.wrapHops,
      pairVolatilityClass: seam.pairVolatilityClass,
      grossApyBps: detail?.durable.grossApyBps ?? 0,
      apySource: detail?.durable.apySource ?? "apy7d",
      spotApyBps: seam.apyBps,
      spotRejected: detail?.durable.spotRejected ?? false,
      ilEstimateBps: seam.ilEstimateBps,
      netApyBps: detail?.netApyBps ?? null,
      ilUnknown: detail?.ilUnknown ?? false,
      allocationBps: bps[index],
      capitalBtc: satsToBtc(sats),
      capitalSats: sats,
      weight: weights[index],
      bindingCap: bindingCapFor(index, bps, groups, membership),
    };
  });

  const byRiskTier: Record<RiskTier, number> = { low: 0, medium: 0, high: 0 };
  const byYieldKind: Record<YieldKind, number> = { sustainable: 0, emissions: 0, counterparty: 0 };
  const rawApyByKind: Record<YieldKind, number> = { sustainable: 0, emissions: 0, counterparty: 0 };
  const byVenue: Record<string, number> = {};
  const byAsset: Record<string, number> = {};
  const byWrapHops: Record<string, number> = {};
  let uncorrelatedLpBps = 0;
  let ilUnknownBps = 0;
  let rawGrossApy = 0;
  let rawNetApy = 0;
  let netKnown = true;

  for (const allocation of allocations) {
    byRiskTier[allocation.riskTier] += allocation.allocationBps;
    byYieldKind[allocation.yieldKind] += allocation.allocationBps;
    byVenue[allocation.venue] = (byVenue[allocation.venue] ?? 0) + allocation.allocationBps;
    byAsset[allocation.asset] = (byAsset[allocation.asset] ?? 0) + allocation.allocationBps;
    const hopsKey = String(allocation.wrapHops);
    byWrapHops[hopsKey] = (byWrapHops[hopsKey] ?? 0) + allocation.allocationBps;
    if (allocation.kind === "lp" && allocation.pairVolatilityClass === "uncorrelated") {
      uncorrelatedLpBps += allocation.allocationBps;
    }
    if (allocation.ilUnknown) {
      ilUnknownBps += allocation.allocationBps;
      netKnown = false;
    }

    const share = allocation.allocationBps / BPS_TOTAL;
    const grossContribution = share * allocation.grossApyBps;
    rawGrossApy += grossContribution;
    rawApyByKind[allocation.yieldKind] += grossContribution;
    if (allocation.netApyBps !== null) rawNetApy += share * allocation.netApyBps;
  }

  const apyByYieldKindBps: Record<YieldKind, number> = {
    sustainable: Math.round(rawApyByKind.sustainable),
    emissions: Math.round(rawApyByKind.emissions),
    counterparty: Math.round(rawApyByKind.counterparty),
  };

  return {
    stope,
    capitalBtc,
    capitalSats,
    capitalUsd,
    allocations,
    idleBps,
    idleBtc: satsToBtc(idleSats),
    idleSats,
    totalAllocatedBps,
    byYieldKind,
    sustainableBps: byYieldKind.sustainable,
    emissionsBps: byYieldKind.emissions,
    counterpartyBps: byYieldKind.counterparty,
    uncorrelatedLpBps,
    ilUnknownBps,
    byRiskTier,
    byVenue,
    byAsset,
    byWrapHops,
    blendedGrossApyBps: Math.round(rawGrossApy),
    apyByYieldKindBps,
    blendedNetApyBps: netKnown ? Math.round(rawNetApy) : null,
    excluded,
    constraints,
  };
}
