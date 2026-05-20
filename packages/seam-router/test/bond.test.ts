import assert from "node:assert/strict";
import test from "node:test";

import { SeamRouterError, keeperBondRequirement } from "../src/index.js";
import type { KeeperBondParams } from "../src/index.js";

const PARAMS: KeeperBondParams = {
  btcPriceUsd: 100_000,
  lodzPriceUsd: 0.25,
  bondRateBps: 200,
  minBondUsd: 5_000,
  maxBondUsd: 2_000_000,
  slashConditions: [
    {
      code: "allocation-cap-breach",
      description: "Submitted an allocation that breaches a vault ceiling",
      slashBps: 2_500,
      graceSeconds: 0,
    },
    {
      code: "stale-rebalance",
      description: "Left the book outside its target band past the agreed window",
      slashBps: 1_000,
      graceSeconds: 86_400,
    },
    {
      code: "queue-starvation",
      description: "Failed to release liquidity for a claimable redemption ticket",
      slashBps: 4_000,
      graceSeconds: 3_600,
    },
  ],
};

test("the bond scales with the notional a keeper can move", () => {
  const small = keeperBondRequirement(10, PARAMS);
  const large = keeperBondRequirement(100, PARAMS);

  assert.equal(small.managedNotionalUsd, 1_000_000);
  assert.equal(small.bondUsd, 20_000);
  assert.equal(small.bondLodz, 80_000);
  assert.equal(small.binding, "rate");
  assert.equal(small.coverageBps, 200);

  assert.equal(large.bondUsd, 200_000);
  assert.equal(large.coverageBps, 200);
});

test("the floor and the ceiling both bind and are reported", () => {
  const tiny = keeperBondRequirement(0.1, PARAMS);
  assert.equal(tiny.binding, "min");
  assert.equal(tiny.bondUsd, 5_000);

  const huge = keeperBondRequirement(5_000, PARAMS);
  assert.equal(huge.binding, "max");
  assert.equal(huge.bondUsd, 2_000_000);
});

test("every slash condition is priced against the posted bond", () => {
  const result = keeperBondRequirement(10, PARAMS);

  assert.equal(result.slashConditions.length, 3);
  const starvation = result.slashConditions.find((entry) => entry.code === "queue-starvation");
  assert.ok(starvation);
  assert.equal(starvation.slashBps, 4_000);
  assert.equal(starvation.slashUsd, 8_000);
  assert.equal(starvation.slashLodz, 32_000);
  assert.equal(starvation.graceSeconds, 3_600);

  assert.equal(result.maxSlashBps, 7_500);
  assert.equal(result.maxSlashUsd, 15_000);
});

test("stacked slash conditions cannot exceed the whole bond", () => {
  const result = keeperBondRequirement(10, {
    ...PARAMS,
    slashConditions: [
      { code: "a", description: "first", slashBps: 8_000 },
      { code: "b", description: "second", slashBps: 6_000 },
    ],
  });
  assert.equal(result.maxSlashBps, 10_000);
  assert.equal(result.maxSlashUsd, result.bondUsd);
});

test("posture and queue pressure raise the required bond", () => {
  const base = keeperBondRequirement(10, PARAMS);
  const aggressive = keeperBondRequirement(10, {
    ...PARAMS,
    stope: "aggressive",
    profileMultiplierBps: { conservative: 8_000, balanced: 10_000, aggressive: 15_000 },
  });
  const drained = keeperBondRequirement(10, { ...PARAMS, utilizationSurchargeBps: 5_000 });

  assert.equal(aggressive.effectiveRateBps, 300);
  assert.equal(aggressive.bondUsd, 30_000);
  assert.ok(aggressive.bondUsd > base.bondUsd);

  assert.equal(drained.effectiveRateBps, 300);
  assert.equal(drained.bondUsd, 30_000);
});

test("invalid parameters are rejected", () => {
  assert.throws(
    () => keeperBondRequirement(10, { ...PARAMS, lodzPriceUsd: 0 }),
    (error: unknown) => error instanceof SeamRouterError && error.code === "INVALID_BOND_PARAMS",
  );
  assert.throws(
    () => keeperBondRequirement(10, { ...PARAMS, slashConditions: [] }),
    (error: unknown) => error instanceof SeamRouterError && error.code === "INVALID_BOND_PARAMS",
  );
  assert.throws(
    () => keeperBondRequirement(10, { ...PARAMS, maxBondUsd: 1 }),
    (error: unknown) => error instanceof SeamRouterError && error.code === "INVALID_BOND_PARAMS",
  );
  assert.throws(
    () =>
      keeperBondRequirement(10, {
        ...PARAMS,
        profileMultiplierBps: { conservative: 8_000, balanced: 10_000, aggressive: 15_000 },
      }),
    (error: unknown) => error instanceof SeamRouterError && error.code === "INVALID_BOND_PARAMS",
  );
  assert.throws(
    () => keeperBondRequirement(-1, PARAMS),
    (error: unknown) => error instanceof SeamRouterError && error.code === "INVALID_CAPITAL",
  );
});
