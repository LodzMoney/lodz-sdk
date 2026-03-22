import assert from "node:assert/strict";
import test from "node:test";

import { BPS_DENOMINATOR } from "../src/bps.js";
import { decomposeYield } from "../src/decompose.js";
import { AssayError } from "../src/errors.js";
import { simulatePostEmissions } from "../src/emissions.js";
import { projectYield } from "../src/project.js";
import {
  LIQUIDITY_FLOOR_USD,
  SPOT_ARTIFACT_MULTIPLE,
  detectSourceDivergence,
  selectQuotedApy,
} from "../src/quality.js";
import { deriveStopeAllocation } from "../src/stope.js";
import { applyLiquidityFloor } from "../src/validate.js";
import * as publicSurface from "../src/index.js";
import { AT, MEASURED_SEAMS, STAIRCASE_SEAMS, counterpartySeam, seam } from "./fixtures.js";

const MEASURED = { btcAmount: 1, seams: MEASURED_SEAMS, horizonDays: 365, at: AT } as const;

test("counterparty yield is never folded into sustainable", () => {
  const result = projectYield(MEASURED).decomposition;
  assert.equal(result.apyBps, 5_915);
  assert.equal(result.sustainableApyBps, 1_142);
  assert.equal(result.counterpartyApyBps, 4_773);
  assert.equal(result.emissionsApyBps, 0);
  assert.equal(
    result.sustainableApyBps + result.emissionsApyBps + result.counterpartyApyBps,
    result.apyBps,
  );

  // The number that matters: most of this headline is paid by losing traders.
  assert.equal(result.counterpartyShareBps, 8_070);
  assert.ok(
    result.counterpartyApyBps > result.sustainableApyBps * 4,
    "the counterparty share must stay visible, not be blended away",
  );
  assert.deepEqual(result.allocationByYieldKind, {
    sustainable: 7_778,
    emissions: 0,
    counterparty: 2_222,
  });
});

test("counterparty yield is split out of the projected amounts too", () => {
  const result = projectYield(MEASURED);
  assert.equal(
    result.yieldFlat.sustainable.sats +
      result.yieldFlat.emissions.sats +
      result.yieldFlat.counterparty.sats,
    result.yieldFlat.total.sats,
  );
  assert.ok(result.yieldFlat.counterparty.sats > result.yieldFlat.sustainable.sats);
  assert.equal(result.yieldFlat.emissions.sats, 0);
});

test("a market with no incentive programs simulates without error and says so", () => {
  const result = simulatePostEmissions(MEASURED_SEAMS, AT);
  assert.equal(result.hasLiveEmissions, false);
  assert.equal(result.emissionExposureBps, 0);
  assert.equal(result.emissionsRateShareBps, 0);
  assert.equal(result.currentEmissionsApyBps, 0);
  assert.equal(result.steps.length, 1);
  assert.equal(result.totalDropBps, 0);
  assert.equal(result.retainedRatioBps, BPS_DENOMINATOR);
  assert.equal(result.finalEmissionEndsAt, null);
  assert.equal(
    result.postEmissionsApyBps,
    result.currentApyBps,
    "with nothing to expire, the rate after emissions equals the rate now",
  );
});

test("emission exposure is reported even when it is not zero", () => {
  const result = simulatePostEmissions(STAIRCASE_SEAMS, AT);
  assert.equal(result.hasLiveEmissions, true);
  assert.equal(result.emissionExposureBps, 6_000);
  assert.equal(result.emissionsRateShareBps, 7_941);
});

test("impermanent loss is reported as unknown rather than estimated", () => {
  const result = projectYield(MEASURED);
  assert.equal(result.il.ilUnknown, true);
  assert.equal(result.il.ilDragBps, 0);
  assert.equal(result.il.ilDrag.sats, 0);
  assert.equal(result.il.ilCoverageBps, 0);
  assert.equal(result.il.unknownIlAllocationBps, 6_111);
  assert.deepEqual(result.il.unknownIlSeamIds, ["orca-cbbtc-usdc", "orca-sol-cbbtc"]);
  assert.equal(
    result.il.netOfIlBps,
    result.decomposition.apyBps,
    "with no estimate there is no drag to take off, and the flag says why",
  );
  assert.equal(result.yieldScheduledNetOfIl.sats, result.yieldScheduled.total.sats);
});

test("a supplied impermanent loss estimate is deducted and the flag clears", () => {
  const withIl = MEASURED_SEAMS.map((entry) =>
    entry.kind === "lp" ? { ...entry, ilEstimateBps: 900 } : entry,
  );
  const result = projectYield({ ...MEASURED, seams: withIl });
  assert.equal(result.il.ilUnknown, false);
  assert.equal(result.il.ilCoverageBps, BPS_DENOMINATOR);
  assert.equal(result.il.ilDragBps, 550);
  assert.equal(result.il.netOfIlBps, result.decomposition.apyBps - 550);
  assert.ok(result.il.ilDrag.sats > 0);
  assert.equal(
    result.yieldScheduledNetOfIl.sats,
    result.yieldScheduled.total.sats - result.il.ilDrag.sats,
  );
});

test("impermanent loss can exceed the rate and the result is allowed to go negative", () => {
  const ruinous = MEASURED_SEAMS.map((entry) =>
    entry.kind === "lp" ? { ...entry, ilEstimateBps: 40_000 } : entry,
  );
  const result = projectYield({ ...MEASURED, seams: ruinous });
  assert.ok(result.il.ilDragBps > result.decomposition.apyBps);
  assert.ok(result.il.netOfIlBps < 0, "a losing position must be allowed to report as losing");
});

test("a spot rate far above the smoothed rate is not the rate that gets quoted", () => {
  // Observed in the pool history: a single day printed apyBase 74,187%.
  const artifact = seam({
    id: "spike",
    kind: "lp",
    apyBps: 7_418_700,
    apy7dBps: 1_546,
    apy90dMedianBps: null,
    tvlUsd: 6_319_470,
  });
  const quoted = selectQuotedApy(artifact);
  assert.equal(quoted.apyBps, 1_546);
  assert.equal(quoted.basis, "7d");
  assert.equal(quoted.spotBps, 7_418_700);
  assert.equal(quoted.spotRejected, true);
  assert.ok((quoted.spotMultiple ?? 0) >= SPOT_ARTIFACT_MULTIPLE);

  const result = decomposeYield([artifact], undefined, AT);
  assert.equal(result.apyBps, 1_546, "the portfolio rate must use the smoothed observation");
  assert.equal(result.components[0]?.apyBasis, "7d");
  assert.equal(result.components[0]?.quality.spotRejected, true);
});

test("the engine quotes the more conservative of the two smoothed observations", () => {
  const pool = seam({ id: "orca", kind: "lp", apyBps: 1_500, apy7dBps: 1_546, apy90dMedianBps: 2_850 });
  const quoted = selectQuotedApy(pool);
  assert.equal(quoted.apyBps, 1_546);
  assert.equal(quoted.basis, "7d");
  assert.equal(quoted.spotRejected, false);

  const calmer = seam({ id: "calm", kind: "lp", apyBps: 900, apy7dBps: 1_546, apy90dMedianBps: 800 });
  assert.equal(selectQuotedApy(calmer).apyBps, 800);
  assert.equal(selectQuotedApy(calmer).basis, "90d-median");
});

test("a seam with only a spot observation is flagged rather than trusted quietly", () => {
  const spotOnly = seam({ id: "spot", apyBps: 500 });
  const quoted = selectQuotedApy(spotOnly);
  assert.equal(quoted.basis, "spot");
  assert.equal(quoted.spotOnly, true);
  assert.equal(quoted.apyBps, 500);
  assert.equal(quoted.spotMultiple, null);
});

test("a venue too small to absorb capital is dropped from the allocation", () => {
  const result = projectYield(MEASURED);
  assert.equal(result.liquidityFloor.applied, true);
  assert.equal(result.liquidityFloor.floorUsd, LIQUIDITY_FLOOR_USD);
  assert.deepEqual(result.liquidityFloor.excludedSeamIds, ["zeus-btc-market-usdc"]);
  assert.equal(result.liquidityFloor.reallocatedBps, 1_000);
  assert.equal(result.allocation["zeus-btc-market-usdc"], 0);
  assert.deepEqual(result.allocation, {
    "orca-cbbtc-usdc": 3_333,
    "orca-sol-cbbtc": 2_778,
    "loopscale-zbtc-lend": 1_667,
    "gmtrade-btc-usdc-vault": 2_222,
    "zeus-btc-market-usdc": 0,
  });
  assert.equal(
    Object.values(result.allocation).reduce((sum, value) => sum + value, 0),
    BPS_DENOMINATOR,
  );
  // The excluded venue quoted 104.62%. Routing to it would have dominated.
  assert.ok(result.decomposition.apyBps < 10_462);
});

test("the liquidity floor can be waived, and the difference is visible", () => {
  const enforced = projectYield(MEASURED);
  const waived = projectYield({ ...MEASURED, enforceLiquidityFloor: false });
  assert.equal(waived.liquidityFloor.applied, false);
  assert.equal(waived.allocation["zeus-btc-market-usdc"], 1_000);
  assert.ok(waived.decomposition.apyBps > enforced.decomposition.apyBps);
  assert.equal(waived.decomposition.belowLiquidityFloorBps, 1_000);
});

test("a catalog with nothing above the floor refuses to allocate", () => {
  const tiny = [
    seam({ id: "a", tvlUsd: 5_000, allocationBps: 5_000 }),
    seam({ id: "b", tvlUsd: 9_000, allocationBps: 5_000 }),
  ];
  assert.throws(
    () => projectYield({ btcAmount: 1, seams: tiny, horizonDays: 365, at: AT }),
    (error: unknown) => {
      assert.ok(error instanceof AssayError);
      assert.equal(error.code, "ALL_SEAMS_BELOW_LIQUIDITY_FLOOR");
      return true;
    },
  );
});

test("an explicitly flagged seam is dropped even when its TVL clears the floor", () => {
  const flagged = [
    seam({ id: "ok", tvlUsd: 5_000_000, allocationBps: 6_000 }),
    seam({ id: "stale", tvlUsd: 5_000_000, allocationBps: 4_000, belowLiquidityFloor: true }),
  ];
  const result = applyLiquidityFloor(flagged, { ok: 6_000, stale: 4_000 });
  assert.deepEqual(result.excludedSeamIds, ["stale"]);
  assert.equal(result.allocation["ok"], BPS_DENOMINATOR);
});

test("stope profiles cap counterparty exposure separately from emissions", () => {
  const conservative = deriveStopeAllocation(MEASURED_SEAMS, "conservative");
  assert.equal(conservative.counterpartyShareBps, 0);
  assert.equal(conservative.counterpartyCapBps, 0);
  assert.equal(conservative.capsSatisfied, true);
  assert.ok(conservative.belowLiquidityFloorSeamIds.includes("zeus-btc-market-usdc"));

  const aggressive = deriveStopeAllocation(MEASURED_SEAMS, "aggressive");
  assert.ok(aggressive.counterpartyShareBps > 0);
  assert.ok(aggressive.counterpartyShareBps <= aggressive.counterpartyCapBps);
  assert.equal(
    Object.values(aggressive.allocation).reduce((sum, value) => sum + value, 0),
    BPS_DENOMINATOR,
  );
});

test("a catalog that is entirely counterparty reports the ceiling as unmet", () => {
  const allCounterparty = [
    counterpartySeam({ id: "a", allocationBps: 5_000, riskTier: "low" }),
    counterpartySeam({ id: "b", allocationBps: 5_000, riskTier: "low" }),
  ];
  const result = deriveStopeAllocation(allCounterparty, "balanced");
  assert.equal(result.counterpartyShareBps, BPS_DENOMINATOR);
  assert.equal(result.capsSatisfied, false);
});

test("source divergence is detected on the relative gap between two readings", () => {
  assert.equal(detectSourceDivergence(1_500, 1_546), false);
  assert.equal(detectSourceDivergence(1_500, 2_850), true);
  assert.equal(detectSourceDivergence(0, 0), false);
  assert.equal(detectSourceDivergence(100, 100), false);
  assert.throws(() => detectSourceDivergence(Number.NaN, 1), AssayError);
});

test("a diverging seam is flagged through to the component quality block", () => {
  const conflicted = seam({ id: "conflict", sourceDivergence: true });
  const result = decomposeYield([conflicted], undefined, AT);
  assert.equal(result.sourceDivergenceBps, BPS_DENOMINATOR);
  assert.equal(result.components[0]?.quality.sourceDivergence, true);
  assert.equal(result.components[0]?.quality.hasCaveats, true);
});

test("the public API offers no way to turn points into a rate", () => {
  // Pricing unissued points would disguise an incentive program as fee income.
  const exported = Object.keys(publicSurface);
  assert.ok(exported.length > 40, "the barrel must actually have been loaded");
  assert.deepEqual(
    exported.filter((name) => /point|airdrop/i.test(name)),
    [],
    "no export may convert points or airdrop expectations into a rate",
  );
});
