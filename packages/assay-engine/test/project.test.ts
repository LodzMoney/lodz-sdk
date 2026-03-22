import assert from "node:assert/strict";
import test from "node:test";

import { BPS_DENOMINATOR } from "../src/bps.js";
import { AssayError } from "../src/errors.js";
import { projectYield, tierFromScore } from "../src/project.js";
import { AT, MIXED_SEAMS, STAIRCASE_SEAMS, seam } from "./fixtures.js";

const BASE = { btcAmount: 1.5, seams: MIXED_SEAMS, horizonDays: 365, at: AT } as const;

test("yield is projected split by source and reconciles to the total", () => {
  const result = projectYield(BASE);
  assert.equal(result.principal.sats, 150_000_000);
  assert.equal(result.yieldFlat.total.sats, 10_192_500);
  assert.equal(
    result.yieldFlat.sustainable.sats + result.yieldFlat.emissions.sats,
    result.yieldFlat.total.sats,
  );
  assert.equal(result.yieldFlat.sustainable.sats, 3_480_000);
  assert.equal(result.yieldFlat.emissions.sats, 6_712_500);
});

test("the scheduled projection stops each program on its declared end date", () => {
  const result = projectYield(BASE);
  assert.equal(result.yieldScheduled.total.sats, 6_621_472);
  assert.equal(result.yieldScheduled.sustainable.sats, 3_480_000);
  assert.equal(result.yieldScheduled.emissions.sats, 3_141_472);
  assert.equal(result.emissionsShortfall.sats, 3_571_028);
  assert.ok(
    result.yieldScheduled.total.sats < result.yieldFlat.total.sats,
    "a flat projection across live programs must overstate the scheduled outcome",
  );
  assert.equal(result.realizedApyBps, 441);
  assert.equal(result.postEmissionsApyBps, 232);
  assert.equal(result.decomposition.apyBps, 680);
});

test("per seam contributions sum to the projected yield and to 10000 bps of share", () => {
  const result = projectYield(BASE);
  assert.equal(result.contributions.length, 4);
  const flatSum = result.contributions.reduce(
    (sum, contribution) => sum + contribution.yieldFlat.sats,
    0,
  );
  const scheduledSum = result.contributions.reduce(
    (sum, contribution) => sum + contribution.yieldScheduled.sats,
    0,
  );
  const shareSum = result.contributions.reduce(
    (sum, contribution) => sum + contribution.shareOfYieldBps,
    0,
  );
  assert.equal(flatSum, result.yieldFlat.total.sats);
  assert.equal(scheduledSum, result.yieldScheduled.total.sats);
  assert.equal(shareSum, BPS_DENOMINATOR);

  const principalSum = result.contributions.reduce(
    (sum, contribution) => sum + contribution.principal.sats,
    0,
  );
  assert.equal(principalSum, result.principal.sats);
});

test("the weighted risk tier never hides the worst tier holding capital", () => {
  const result = projectYield(BASE);
  assert.equal(result.risk.weightedScore, 205);
  assert.equal(result.risk.weightedTier, "medium");
  assert.equal(result.risk.worstTier, "high");
  assert.deepEqual(result.risk.allocationByTier, { low: 3_500, medium: 2_500, high: 4_000 });
  assert.equal(tierFromScore(100), "low");
  assert.equal(tierFromScore(151), "medium");
  assert.equal(tierFromScore(300), "high");
});

test("every contribution carries a draw width and emissions carry a fade", () => {
  const result = projectYield({ ...BASE, seams: STAIRCASE_SEAMS });
  for (const contribution of result.contributions) {
    assert.ok(contribution.thickness > 0 && contribution.thickness <= 1);
    if (contribution.yieldKind === "sustainable") assert.equal(contribution.fade, 0);
    else assert.ok(contribution.fade >= 0.35 && contribution.fade <= 1);
  }
});

test("a stope profile derives the allocation and reports its emissions ceiling", () => {
  const result = projectYield({ ...BASE, stope: "conservative" });
  assert.equal(result.stope, "conservative");
  assert.ok(result.stopeAllocation !== null);
  assert.deepEqual(result.allocation, {
    "kamino-cbbtc-lend": 8_077,
    "orca-cbbtc-lp": 1_923,
    "zbtc-lend-incentive": 0,
    "tbtc-basis-incentive": 0,
  });
  assert.equal(result.stopeAllocation?.emissionsShareBps, 0);
  assert.equal(result.stopeAllocation?.capsSatisfied, true);
  assert.equal(result.decomposition.emissionsApyBps, 0);
  assert.equal(result.emissionsShortfall.sats, 0);
});

test("an explicit allocation wins over a stope profile", () => {
  const explicit = {
    "kamino-cbbtc-lend": 10_000,
    "orca-cbbtc-lp": 0,
    "zbtc-lend-incentive": 0,
    "tbtc-basis-incentive": 0,
  };
  const result = projectYield({ ...BASE, stope: "aggressive", allocation: explicit });
  assert.deepEqual(result.allocation, explicit);
  assert.equal(result.stopeAllocation, null);
  assert.equal(result.decomposition.apyBps, 320);
});

test("a horizon shorter than the first end date matches the flat projection", () => {
  const result = projectYield({ ...BASE, horizonDays: 30 });
  assert.equal(result.yieldFlat.total.sats, result.yieldScheduled.total.sats);
  assert.equal(result.emissionsShortfall.sats, 0);
});

test("invalid deposits and horizons are rejected", () => {
  assert.throws(() => projectYield({ ...BASE, horizonDays: 0 }), AssayError);
  assert.throws(() => projectYield({ ...BASE, horizonDays: -1 }), AssayError);
  assert.throws(() => projectYield({ ...BASE, btcAmount: -0.5 }), AssayError);
  assert.throws(
    () => projectYield({ ...BASE, seams: [seam({ id: "x", allocationBps: 5_000 })] }),
    AssayError,
  );
});
