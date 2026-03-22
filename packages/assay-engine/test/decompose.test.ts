import assert from "node:assert/strict";
import test from "node:test";

import { BPS_DENOMINATOR } from "../src/bps.js";
import { decomposeYield } from "../src/decompose.js";
import { AT, MIXED_SEAMS, STAIRCASE_SEAMS, emissionSeam, seam } from "./fixtures.js";

test("the portfolio rate is reported split, never only as a single blended number", () => {
  const result = decomposeYield(STAIRCASE_SEAMS, undefined, AT);
  assert.equal(result.apyBps, 680);
  assert.equal(result.sustainableApyBps, 140);
  assert.equal(result.emissionsApyBps, 540);
  assert.equal(result.sustainableApyBps + result.emissionsApyBps, result.apyBps);
});

test("per seam contributions sum to the portfolio rate exactly", () => {
  const result = decomposeYield(MIXED_SEAMS, undefined, AT);
  const summed = result.components.reduce(
    (sum, component) => sum + component.contributionApyBps,
    0,
  );
  assert.equal(summed, result.apyBps);
  assert.equal(result.apyBps, 680);
  assert.deepEqual(
    result.components.map((component) => component.contributionApyBps),
    [112, 120, 238, 210],
  );
  assert.equal(result.sustainableApyBps, 232);
  assert.equal(result.emissionsApyBps, 448);
});

test("shares of the portfolio rate sum to exactly 10000 bps", () => {
  const result = decomposeYield(MIXED_SEAMS, undefined, AT);
  const summed = result.components.reduce((sum, component) => sum + component.shareOfApyBps, 0);
  assert.equal(summed, BPS_DENOMINATOR);
  assert.equal(
    result.sustainableShareBps + result.emissionsShareBps + result.counterpartyShareBps,
    BPS_DENOMINATOR,
  );
  assert.equal(result.emissionsShareBps, 6_586);
  assert.equal(result.counterpartyShareBps, 0);
});

test("capital shares are reported by yield kind and by venue mechanism", () => {
  const result = decomposeYield(MIXED_SEAMS, undefined, AT);
  assert.deepEqual(result.allocationByYieldKind, {
    sustainable: 6_000,
    emissions: 4_000,
    counterparty: 0,
  });
  assert.deepEqual(result.allocationByVenueKind, { lending: 6_000, lp: 2_500, basis: 1_500 });
});

test("a program that already ended stops counting toward the current rate", () => {
  const seams = [
    seam({ id: "s", apyBps: 400, allocationBps: 5_000 }),
    emissionSeam({
      id: "e",
      apyBps: 2_000,
      allocationBps: 5_000,
      emissionEndsAt: "2026-01-01T00:00:00.000Z",
    }),
  ];
  const result = decomposeYield(seams, undefined, AT);
  assert.equal(result.declaredApyBps, 1_200);
  assert.equal(result.apyBps, 200);
  assert.equal(result.expiredEmissionsApyBps, 1_000);
  assert.equal(result.emissionsApyBps, 0);
  assert.equal(result.components[1]?.emissionActive, false);
  assert.equal(result.components[1]?.effectiveApyBps, 0);
});

test("the next emissions end date and the live incentive tokens are surfaced", () => {
  const result = decomposeYield(MIXED_SEAMS, undefined, AT);
  assert.equal(result.nextEmissionEndsAt, "2026-11-30T00:00:00.000Z");
  assert.deepEqual(result.emissionTokens, ["T", "ZEUS"]);
});

test("an explicit allocation overrides the catalog shares", () => {
  const result = decomposeYield(
    STAIRCASE_SEAMS,
    { s1: 10_000, e1: 0, e2: 0, e3: 0 },
    AT,
  );
  assert.equal(result.apyBps, 350);
  assert.equal(result.emissionsApyBps, 0);
  assert.equal(result.emissionTokens.length, 0);
});
