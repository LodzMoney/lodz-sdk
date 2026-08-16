import assert from "node:assert/strict";
import test from "node:test";

import { BPS_DENOMINATOR } from "../src/bps.js";
import { AssayError } from "../src/errors.js";
import { DEFAULT_STOPE_POLICIES, deriveStopeAllocation } from "../src/stope.js";
import { MIXED_SEAMS, emissionSeam, seam } from "./fixtures.js";

function total(allocation: Readonly<Record<string, number>>): number {
  return Object.values(allocation).reduce((sum, value) => sum + value, 0);
}

/**
 * These six numbers must equal `RiskProfile::max_emissions_bps` and
 * `RiskProfile::max_counterparty_bps` in
 * `packages/anchor-program/programs/lodz-vault/src/state/mod.rs`. They are not a
 * house preference: the program rejects allocations above them with
 * `EmissionsAllocationExceeded` (6030) and `CounterpartyAllocationExceeded`
 * (6053), so the chain is the authority and this table only restates it.
 *
 * Pinned as exact literals on purpose. Every other assertion in this file
 * compares a derived share against `DEFAULT_STOPE_POLICIES` with `<=`, which
 * stays green whatever the table says -- which is how @lodz/assay-engine 0.1.1
 * shipped balanced and aggressive ceilings that disagreed with the chain. Note
 * that quoting a ceiling below the chain's is not the safe direction to be
 * wrong in: it makes a caller under-report how far a stope may actually go.
 */
test("the default ceilings match the on-chain RiskProfile exactly", () => {
  assert.equal(
    DEFAULT_STOPE_POLICIES.conservative.maxEmissionsShareBps,
    2_000,
    "conservative maxEmissionsShareBps must equal RiskProfile::Conservative max_emissions_bps",
  );
  assert.equal(
    DEFAULT_STOPE_POLICIES.balanced.maxEmissionsShareBps,
    5_000,
    "balanced maxEmissionsShareBps must equal RiskProfile::Balanced max_emissions_bps",
  );
  assert.equal(
    DEFAULT_STOPE_POLICIES.aggressive.maxEmissionsShareBps,
    10_000,
    "aggressive maxEmissionsShareBps must equal RiskProfile::Aggressive max_emissions_bps",
  );
  assert.equal(
    DEFAULT_STOPE_POLICIES.conservative.maxCounterpartyShareBps,
    0,
    "conservative maxCounterpartyShareBps must equal RiskProfile::Conservative max_counterparty_bps",
  );
  assert.equal(
    DEFAULT_STOPE_POLICIES.balanced.maxCounterpartyShareBps,
    0,
    "balanced maxCounterpartyShareBps must equal RiskProfile::Balanced max_counterparty_bps",
  );
  assert.equal(
    DEFAULT_STOPE_POLICIES.aggressive.maxCounterpartyShareBps,
    3_000,
    "aggressive maxCounterpartyShareBps must equal RiskProfile::Aggressive max_counterparty_bps",
  );
});

/**
 * Spelled out separately because it is the fact most likely to be skimmed past,
 * and the docstring on `DEFAULT_STOPE_POLICIES` used to deny it outright.
 * `10_000` bps is the whole denominator, so an aggressive stope is permitted to
 * sit entirely on yield that has an end date. The engine's job is to report
 * that share, not to pretend a ceiling forbids it.
 */
test("the aggressive emissions ceiling permits a fully emissions funded stope", () => {
  assert.equal(DEFAULT_STOPE_POLICIES.aggressive.maxEmissionsShareBps, BPS_DENOMINATOR);

  const allEmissions = [
    emissionSeam({
      id: "emit-a",
      riskTier: "low",
      allocationBps: 5_000,
      emissionEndsAt: "2027-01-01T00:00:00.000Z",
    }),
    emissionSeam({
      id: "emit-b",
      riskTier: "low",
      allocationBps: 5_000,
      emissionEndsAt: "2027-02-01T00:00:00.000Z",
    }),
  ];
  const result = deriveStopeAllocation(allEmissions, "aggressive");
  assert.equal(result.emissionsShareBps, BPS_DENOMINATOR);
  // Not a breach: the ceiling is 10000, so nothing had to be moved and the
  // engine must not claim the caps went unmet.
  assert.equal(result.capsSatisfied, true);
});

test("every profile derives an allocation totalling exactly 10000 bps", () => {
  for (const profile of ["conservative", "balanced", "aggressive"] as const) {
    const result = deriveStopeAllocation(MIXED_SEAMS, profile);
    assert.equal(total(result.allocation), BPS_DENOMINATOR, `${profile} landed off 10000`);
  }
});

test("the conservative profile refuses high tier seams", () => {
  const result = deriveStopeAllocation(MIXED_SEAMS, "conservative");
  assert.deepEqual(result.allocation, {
    "kamino-cbbtc-lend": 8_077,
    "orca-cbbtc-lp": 1_923,
    "zbtc-lend-incentive": 0,
    "tbtc-basis-incentive": 0,
  });
  assert.deepEqual(result.excludedSeamIds, ["zbtc-lend-incentive", "tbtc-basis-incentive"]);
  assert.equal(result.emissionsShareBps, 0);
});

test("the aggressive profile holds more emissions exposure than the balanced one", () => {
  const balanced = deriveStopeAllocation(MIXED_SEAMS, "balanced");
  const aggressive = deriveStopeAllocation(MIXED_SEAMS, "aggressive");
  assert.ok(aggressive.emissionsShareBps > balanced.emissionsShareBps);
  assert.ok(aggressive.emissionsShareBps <= DEFAULT_STOPE_POLICIES.aggressive.maxEmissionsShareBps);
  assert.ok(balanced.emissionsShareBps <= DEFAULT_STOPE_POLICIES.balanced.maxEmissionsShareBps);
});

test("the emissions ceiling moves capital back into sustainable seams", () => {
  const emissionsHeavy = [
    seam({ id: "sust", apyBps: 300, allocationBps: 1_000 }),
    emissionSeam({
      id: "emit-a",
      riskTier: "low",
      apyBps: 1_500,
      allocationBps: 4_500,
      emissionEndsAt: "2027-01-01T00:00:00.000Z",
    }),
    emissionSeam({
      id: "emit-b",
      riskTier: "low",
      apyBps: 1_800,
      allocationBps: 4_500,
      emissionEndsAt: "2027-03-01T00:00:00.000Z",
    }),
  ];
  const result = deriveStopeAllocation(emissionsHeavy, "conservative");
  assert.equal(total(result.allocation), BPS_DENOMINATOR);
  assert.equal(result.emissionsShareBps, 2_000);
  assert.equal(result.capsSatisfied, true);
  assert.equal(result.allocation["sust"], 8_000);
  assert.equal(result.allocation["emit-a"], 1_000);
  assert.equal(result.allocation["emit-b"], 1_000);
});

test("a catalog with no sustainable seam reports the ceiling as unmet instead of faking it", () => {
  const allEmissions = [
    emissionSeam({
      id: "a",
      riskTier: "low",
      allocationBps: 5_000,
      emissionEndsAt: "2027-01-01T00:00:00.000Z",
    }),
    emissionSeam({
      id: "b",
      riskTier: "low",
      allocationBps: 5_000,
      emissionEndsAt: "2027-02-01T00:00:00.000Z",
    }),
  ];
  const result = deriveStopeAllocation(allEmissions, "conservative");
  assert.equal(result.emissionsShareBps, BPS_DENOMINATOR);
  assert.equal(result.capsSatisfied, false);
  assert.equal(total(result.allocation), BPS_DENOMINATOR);
});

test("a profile that excludes every seam throws instead of returning an empty vault", () => {
  const allHigh = [
    seam({ id: "a", riskTier: "high", allocationBps: 5_000 }),
    seam({ id: "b", riskTier: "high", allocationBps: 5_000 }),
  ];
  assert.throws(
    () => deriveStopeAllocation(allHigh, "conservative"),
    (error: unknown) => {
      assert.ok(error instanceof AssayError);
      assert.equal(error.code, "STOPE_EXCLUDES_EVERY_SEAM");
      return true;
    },
  );
});

test("an unknown profile is rejected", () => {
  assert.throws(
    () => deriveStopeAllocation(MIXED_SEAMS, "reckless" as unknown as "balanced"),
    AssayError,
  );
});

test("a caller supplied policy table is used verbatim", () => {
  const policies = {
    ...DEFAULT_STOPE_POLICIES,
    balanced: {
      profile: "balanced" as const,
      riskTierWeights: { low: 1, medium: 0, high: 0 },
      excludedRiskTiers: ["medium", "high"] as const,
      maxEmissionsShareBps: 0,
      maxCounterpartyShareBps: 0,
    },
  };
  const result = deriveStopeAllocation(MIXED_SEAMS, "balanced", policies);
  assert.equal(result.allocation["kamino-cbbtc-lend"], BPS_DENOMINATOR);
  assert.equal(result.emissionsShareBps, 0);
});
