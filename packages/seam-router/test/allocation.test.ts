import assert from "node:assert/strict";
import test from "node:test";

import { BPS_TOTAL, DEFAULT_CONSTRAINTS, SeamRouterError, planAllocation } from "../src/index.js";
import type { AllocationPlan, RiskTier, Seam, StopeProfile } from "../src/index.js";
import {
  BTC_PRICE_USD,
  FIXTURE_NOW,
  MEASURED_SEAMS,
  SPOT_SPIKE_BPS,
  makeRandom,
  seam,
} from "./fixtures.js";

const PROFILES: StopeProfile[] = ["conservative", "balanced", "aggressive"];
const CAPITAL_BTC = 12.5;

function plan(stope: StopeProfile, seams: Seam[] = MEASURED_SEAMS): AllocationPlan {
  return planAllocation({
    seams,
    stope,
    capitalBtc: CAPITAL_BTC,
    btcPriceUsd: BTC_PRICE_USD,
    now: FIXTURE_NOW,
  });
}

function reasonFor(result: AllocationPlan, seamId: string): string | undefined {
  return result.excluded.find((entry) => entry.seamId === seamId)?.reason;
}

function bpsOf(result: AllocationPlan, seamId: string): number {
  return result.allocations.find((entry) => entry.seamId === seamId)?.allocationBps ?? 0;
}

function checkInvariants(result: AllocationPlan, seams: readonly Seam[]): void {
  const total = result.allocations.reduce((acc, entry) => acc + entry.allocationBps, 0);
  assert.equal(total + result.idleBps, BPS_TOTAL, `allocations plus idle must be exactly ${BPS_TOTAL} bps`);
  assert.equal(total, result.totalAllocatedBps);

  const policy = result.constraints.profiles[result.stope];
  assert.ok(result.idleBps >= policy.liquidityBufferBps, "idle must cover the liquidity buffer");
  assert.ok(result.counterpartyBps <= policy.maxCounterpartyBps, "counterparty ceiling breached");
  assert.ok(result.emissionsBps <= policy.maxEmissionsBps, "emissions ceiling breached");
  assert.ok(result.uncorrelatedLpBps <= policy.maxUncorrelatedLpBps, "uncorrelated LP ceiling breached");

  const byTier: Record<RiskTier, number> = { low: 0, medium: 0, high: 0 };
  const byVenue = new Map<string, number>();
  const byAsset = new Map<string, number>();
  const byId = new Map(seams.map((entry) => [entry.id, entry]));

  for (const entry of result.allocations) {
    assert.ok(entry.allocationBps > 0, "a listed allocation must be greater than zero");
    assert.ok(entry.allocationBps <= result.constraints.maxSeamBps, `${entry.seamId} over seam ceiling`);
    assert.ok(entry.allocationBps >= result.constraints.minSeamBps, `${entry.seamId} under seam floor`);
    assert.ok(entry.wrapHops <= policy.maxWrapHops, `${entry.seamId} exceeds the custody hop limit`);

    const source = byId.get(entry.seamId);
    assert.ok(source, "every allocation must trace to an input seam");
    assert.ok(source.tvlUsd >= result.constraints.minTvlUsd, `${entry.seamId} is under the liquidity floor`);

    // The position must not exceed the allowed share of the pool it sits in.
    const positionUsd = (entry.allocationBps / BPS_TOTAL) * result.capitalUsd;
    const allowedUsd = source.tvlUsd * (result.constraints.maxShareOfTvlBps / BPS_TOTAL);
    assert.ok(
      positionUsd <= allowedUsd + 1e-6,
      `${entry.seamId} would take ${positionUsd} USD of a pool that allows ${allowedUsd}`,
    );

    // The routed rate is always a trailing figure, never the spot reading.
    assert.ok(
      entry.grossApyBps === source.apy7dBps ||
        entry.grossApyBps === source.apy30dBps ||
        entry.grossApyBps === source.apy90dMedianBps,
      `${entry.seamId} routed on a rate that is not one of its trailing windows`,
    );

    if (entry.ilUnknown) assert.equal(entry.netApyBps, null, "unmeasured IL must not produce a net figure");
    if (entry.ilUnknown) assert.ok(policy.allowIlUnknown, "this profile must not hold unmeasured IL");

    byTier[entry.riskTier] += entry.allocationBps;
    byVenue.set(entry.venue, (byVenue.get(entry.venue) ?? 0) + entry.allocationBps);
    byAsset.set(entry.asset, (byAsset.get(entry.asset) ?? 0) + entry.allocationBps);
  }

  for (const tier of ["low", "medium", "high"] as RiskTier[]) {
    assert.ok(byTier[tier] <= policy.maxRiskTierBps[tier], `${tier} tier exposure over ceiling`);
  }
  for (const [venue, bps] of byVenue) {
    assert.ok(bps <= policy.maxSingleVenueBps, `venue ${venue} over ceiling`);
  }
  for (const [asset, bps] of byAsset) {
    assert.ok(bps <= policy.maxSingleAssetBps, `asset ${asset} over ceiling`);
  }

  const satsTotal =
    result.allocations.reduce((acc, entry) => acc + entry.capitalSats, 0) + result.idleSats;
  assert.equal(satsTotal, result.capitalSats, "satoshi split must be exact");

  if (result.ilUnknownBps > 0) {
    assert.equal(result.blendedNetApyBps, null, "a net rate cannot be stated over unmeasured IL");
  }
}

test("allocations plus idle always add up to exactly 10000 bps", () => {
  for (const profile of PROFILES) {
    checkInvariants(plan(profile), MEASURED_SEAMS);
  }
});

test("counterparty exposure differs by profile and never breaches its ceiling", () => {
  const conservative = plan("conservative");
  const balanced = plan("balanced");
  const aggressive = plan("aggressive");

  assert.equal(conservative.counterpartyBps, 0, "a conservative book takes none of another trader's losses");
  assert.ok(balanced.counterpartyBps > 0, "a balanced book takes some");
  assert.ok(
    aggressive.counterpartyBps > balanced.counterpartyBps,
    "an aggressive book takes more than a balanced one",
  );

  assert.ok(conservative.counterpartyBps <= DEFAULT_CONSTRAINTS.profiles.conservative.maxCounterpartyBps);
  assert.ok(balanced.counterpartyBps <= DEFAULT_CONSTRAINTS.profiles.balanced.maxCounterpartyBps);
  assert.ok(aggressive.counterpartyBps <= DEFAULT_CONSTRAINTS.profiles.aggressive.maxCounterpartyBps);

  assert.equal(reasonFor(conservative, "X1"), "counterparty-not-allowed");
  assert.equal(bpsOf(balanced, "X1"), DEFAULT_CONSTRAINTS.profiles.balanced.maxCounterpartyBps);
});

test("a seam under the liquidity floor is excluded with its reason recorded", () => {
  for (const profile of PROFILES) {
    const result = plan(profile);
    assert.equal(
      reasonFor(result, "Z1"),
      "below-min-tvl",
      "104 percent against 10,927 USD of capacity is not a seam at any posture",
    );
    assert.equal(bpsOf(result, "Z1"), 0);
  }
  assert.equal(DEFAULT_CONSTRAINTS.minTvlUsd, 100_000);
});

test("a seam the indexer flagged as unable to absorb capital is excluded on that flag alone", () => {
  const flagged = seam({
    id: "flagged",
    tvlUsd: 40_000_000,
    belowLiquidityFloor: true,
    apy7dBps: 2_000,
    apy30dBps: 2_000,
  });
  const result = planAllocation({
    seams: [flagged, seam({ id: "ok", tvlUsd: 40_000_000 })],
    stope: "balanced",
    capitalBtc: 1,
    btcPriceUsd: BTC_PRICE_USD,
  });

  assert.equal(bpsOf(result, "flagged"), 0, "40m USD of TVL does not override the flag");
  assert.equal(reasonFor(result, "flagged"), "below-min-tvl");
  assert.ok(bpsOf(result, "ok") > 0);
});

test("a seam two sources disagree about is withheld rather than published", () => {
  const disputed = seam({
    id: "disputed",
    sourceDivergence: true,
    apy7dBps: 5_000,
    apy30dBps: 5_000,
    tvlUsd: 40_000_000,
  });
  const result = planAllocation({
    seams: [disputed, seam({ id: "agreed", tvlUsd: 40_000_000 })],
    stope: "aggressive",
    capitalBtc: 1,
    btcPriceUsd: BTC_PRICE_USD,
  });

  assert.equal(bpsOf(result, "disputed"), 0, "the highest rate on offer does not buy its way past a disputed feed");
  assert.equal(reasonFor(result, "disputed"), "source-divergence");
  assert.ok(bpsOf(result, "agreed") > 0);
});

test("no position exceeds the allowed share of its own pool", () => {
  for (const profile of PROFILES) {
    const result = plan(profile);
    for (const entry of result.allocations) {
      const source = MEASURED_SEAMS.find((candidate) => candidate.id === entry.seamId);
      assert.ok(source);
      const positionUsd = (entry.allocationBps / BPS_TOTAL) * result.capitalUsd;
      assert.ok(
        positionUsd <= source.tvlUsd * 0.1 + 1e-6,
        `${entry.seamId} takes ${positionUsd} USD of a ${source.tvlUsd} USD pool`,
      );
    }
  }
});

test("the share-of-pool ceiling binds as capital grows", () => {
  const small = planAllocation({
    seams: MEASURED_SEAMS,
    stope: "aggressive",
    capitalBtc: 1,
    btcPriceUsd: BTC_PRICE_USD,
    now: FIXTURE_NOW,
  });
  const medium = plan("aggressive");

  assert.equal(small.idleBps, 0, "100k USD fits inside this market without touching the pool ceiling");
  assert.ok(!small.allocations.some((entry) => entry.bindingCap === "seam-tvl"));

  assert.ok(medium.idleBps > small.idleBps, "1.25m USD starts running into the pool ceiling");
  assert.ok(
    medium.allocations.some((entry) => entry.bindingCap === "seam-tvl"),
    "at this size the pool ceiling is what stops several positions from growing",
  );
  checkInvariants(medium, MEASURED_SEAMS);
});

test("capital too large for the market is left idle rather than forced into it", () => {
  const oversized = planAllocation({
    seams: MEASURED_SEAMS,
    stope: "aggressive",
    capitalBtc: 500,
    btcPriceUsd: BTC_PRICE_USD,
    now: FIXTURE_NOW,
  });

  // 50m USD against a market whose largest BTC pool holds 6.3m. Ten percent of every
  // pool combined does not reach the minimum position size, so nothing is deployed.
  assert.equal(oversized.allocations.length, 0);
  assert.equal(oversized.idleBps, BPS_TOTAL);
  assert.equal(oversized.idleSats, oversized.capitalSats);
  assert.ok(
    oversized.excluded.some((entry) => entry.reason === "below-min-allocation"),
    "the reason must be recorded, not left as a silent empty book",
  );
  checkInvariants(oversized, MEASURED_SEAMS);
});

test("a spot rate far above the trailing week is rejected and flagged", () => {
  const spiked = MEASURED_SEAMS.map((entry) =>
    entry.id === "S2" ? { ...entry, apyBps: SPOT_SPIKE_BPS } : entry,
  );
  const result = planAllocation({
    seams: spiked,
    stope: "aggressive",
    capitalBtc: CAPITAL_BTC,
    btcPriceUsd: BTC_PRICE_USD,
    now: FIXTURE_NOW,
  });

  const allocation = result.allocations.find((entry) => entry.seamId === "S2");
  assert.ok(allocation, "the seam must still be routable, just not on its spot reading");
  assert.equal(allocation.spotRejected, true);
  assert.equal(allocation.spotApyBps, SPOT_SPIKE_BPS);
  assert.equal(allocation.grossApyBps, 1_546, "the 7 day figure is used instead");
  assert.equal(allocation.apySource, "apy7d");

  const clean = plan("aggressive");
  assert.equal(clean.allocations.find((entry) => entry.seamId === "S2")?.spotRejected, false);
  assert.equal(
    bpsOf(result, "S2"),
    bpsOf(clean, "S2"),
    "a 74,187 percent spot reading must not move a single basis point",
  );
  checkInvariants(result, spiked);
});

test("no seam is ever routed on its spot rate", () => {
  for (const profile of PROFILES) {
    for (const entry of plan(profile).allocations) {
      assert.notEqual(entry.apySource, undefined);
      assert.ok(["apy7d", "apy30d", "apy90dMedian"].includes(entry.apySource));
    }
  }
});

test("a seam with no trailing figure at all is excluded rather than routed on spot", () => {
  for (const profile of PROFILES) {
    assert.equal(reasonFor(plan(profile), "S14"), "no-durable-apy");
  }
});

test("the most conservative trailing window is the one that gets used", () => {
  const result = plan("aggressive");
  const s2 = result.allocations.find((entry) => entry.seamId === "S2");
  assert.ok(s2);
  // S2 reports 15.46 percent over 7d, 22.01 percent over 30d and a 28.50 percent 90d
  // median. Routing on the highest of those would overstate what the pool pays now.
  assert.equal(s2.grossApyBps, 1_546);
  assert.equal(s2.apySource, "apy7d");
});

test("conservative refuses a doubly wrapped asset", () => {
  const conservative = plan("conservative");
  for (const seamId of ["S3", "S4", "S6"]) {
    assert.equal(
      reasonFor(conservative, seamId),
      "wrap-hops-exceeded",
      `${seamId} is WBTC, bridged through Portal, and carries two custody hops`,
    );
    assert.equal(bpsOf(conservative, seamId), 0);
  }
  assert.equal(DEFAULT_CONSTRAINTS.profiles.conservative.maxWrapHops, 1);
  for (const entry of conservative.allocations) assert.ok(entry.wrapHops <= 1);
});

test("a profile that accepts two hops can hold the same asset", () => {
  const aggressive = plan("aggressive");
  assert.ok(
    aggressive.allocations.some((entry) => entry.wrapHops === 2),
    "the hop limit is what excluded it for conservative, not the seam itself",
  );
});

test("conservative refuses an LP seam whose impermanent loss is unmeasured", () => {
  const conservative = plan("conservative");
  for (const seamId of ["S1", "S2", "S7", "S8", "S10"]) {
    assert.equal(reasonFor(conservative, seamId), "il-unknown");
  }
  assert.equal(conservative.ilUnknownBps, 0);
  assert.notEqual(conservative.blendedNetApyBps, null, "with no unmeasured IL a net rate can be stated");
});

test("a measured impermanent loss is deducted, an unmeasured one is not invented", () => {
  const measured = seam({
    id: "lp-measured",
    kind: "lp",
    pairVolatilityClass: "uncorrelated",
    apy7dBps: 1_500,
    apy30dBps: 1_500,
    ilEstimateBps: 900,
    tvlUsd: 50_000_000,
    riskTier: "medium",
  });
  const unmeasured = seam({
    id: "lp-unmeasured",
    kind: "lp",
    pairVolatilityClass: "uncorrelated",
    apy7dBps: 1_500,
    apy30dBps: 1_500,
    ilEstimateBps: null,
    tvlUsd: 50_000_000,
    riskTier: "medium",
  });

  const result = planAllocation({
    seams: [measured, unmeasured],
    stope: "balanced",
    capitalBtc: 1,
    btcPriceUsd: BTC_PRICE_USD,
    now: FIXTURE_NOW,
  });

  const withIl = result.allocations.find((entry) => entry.seamId === "lp-measured");
  const withoutIl = result.allocations.find((entry) => entry.seamId === "lp-unmeasured");
  assert.ok(withIl && withoutIl);

  assert.equal(withIl.grossApyBps, 1_500);
  assert.equal(withIl.netApyBps, 600, "1500 bps of fees less 900 bps of impermanent loss");
  assert.equal(withIl.ilUnknown, false);

  assert.equal(withoutIl.netApyBps, null, "no net figure is stated for an unmeasured cost");
  assert.equal(withoutIl.ilUnknown, true);
  assert.equal(result.blendedNetApyBps, null, "one unmeasured seam makes the book's net rate unstatable");

  // Ranking runs on the net figure where it exists, so the seam that discloses a large
  // loss ranks below the one that does not, only because its disclosed number is worse.
  assert.ok(withIl.weight < withoutIl.weight);
});

test("an uncorrelated pair is discounted against a correlated one at equal headline rate", () => {
  const correlated = seam({
    id: "lp-correlated",
    kind: "lp",
    pairVolatilityClass: "correlated",
    apy7dBps: 1_000,
    apy30dBps: 1_000,
    ilEstimateBps: 0,
    riskTier: "medium",
  });
  const uncorrelated = seam({
    id: "lp-uncorrelated",
    kind: "lp",
    pairVolatilityClass: "uncorrelated",
    apy7dBps: 1_000,
    apy30dBps: 1_000,
    ilEstimateBps: 0,
    riskTier: "medium",
  });
  const result = planAllocation({
    seams: [correlated, uncorrelated],
    stope: "balanced",
    capitalBtc: 1,
    btcPriceUsd: BTC_PRICE_USD,
  });
  assert.ok(bpsOf(result, "lp-correlated") > bpsOf(result, "lp-uncorrelated"));
});

test("the emissions ceiling survives even though the measured market has no emissions", () => {
  assert.equal(
    MEASURED_SEAMS.filter((entry) => entry.yieldKind === "emissions").length,
    0,
    "the measured Solana BTC market has zero emission programmes",
  );
  for (const profile of PROFILES) {
    assert.equal(plan(profile).emissionsBps, 0);
  }

  const withEmissions = [
    ...MEASURED_SEAMS,
    seam({
      id: "E-new",
      venue: "future-venue",
      kind: "lp",
      yieldKind: "emissions",
      pairVolatilityClass: "correlated",
      ilEstimateBps: 0,
      apyBps: 8_000,
      apy7dBps: 8_000,
      apy30dBps: 8_000,
      tvlUsd: 40_000_000,
      riskTier: "medium",
      emissionToken: "future-token",
      emissionEndsAt: "2027-01-01T00:00:00.000Z",
    }),
  ];
  const result = planAllocation({
    seams: withEmissions,
    stope: "balanced",
    capitalBtc: CAPITAL_BTC,
    btcPriceUsd: BTC_PRICE_USD,
    now: FIXTURE_NOW,
  });
  assert.ok(result.emissionsBps > 0);
  assert.ok(result.emissionsBps <= DEFAULT_CONSTRAINTS.profiles.balanced.maxEmissionsBps);
  checkInvariants(result, withEmissions);
});

test("an emission schedule that already ended removes the seam", () => {
  const expired = [
    ...MEASURED_SEAMS,
    seam({
      id: "E-expired",
      kind: "lp",
      yieldKind: "emissions",
      pairVolatilityClass: "correlated",
      ilEstimateBps: 0,
      apy7dBps: 8_000,
      apy30dBps: 8_000,
      tvlUsd: 40_000_000,
      emissionToken: "dead-token",
      emissionEndsAt: "2024-11-20T00:00:00.000Z",
    }),
  ];
  const result = planAllocation({
    seams: expired,
    stope: "aggressive",
    capitalBtc: CAPITAL_BTC,
    btcPriceUsd: BTC_PRICE_USD,
    now: FIXTURE_NOW,
  });
  assert.equal(reasonFor(result, "E-expired"), "emissions-ended");
  assert.equal(result.emissionsBps, 0);
});

test("a zero rate is excluded rather than held for its size", () => {
  for (const profile of PROFILES) {
    assert.equal(
      reasonFor(plan(profile), "S15"),
      "non-positive-apy",
      "6.2m USD of TVL earning nothing is not a seam",
    );
  }
});

test("raising a ceiling changes the result, proving the ceiling is doing the work", () => {
  const base = plan("balanced");
  const loosened = planAllocation({
    seams: MEASURED_SEAMS,
    stope: "balanced",
    capitalBtc: CAPITAL_BTC,
    btcPriceUsd: BTC_PRICE_USD,
    now: FIXTURE_NOW,
    constraints: { profiles: { balanced: { maxCounterpartyBps: 2_500 } } },
  });
  assert.ok(loosened.counterpartyBps > base.counterpartyBps);
  assert.equal(loosened.constraints.profiles.balanced.maxCounterpartyBps, 2_500);
  checkInvariants(loosened, MEASURED_SEAMS);
});

test("identical inputs produce identical plans", () => {
  for (const profile of PROFILES) {
    assert.deepEqual(plan(profile), plan(profile));
  }
});

test("zero capital still produces a well formed plan", () => {
  const result = planAllocation({
    seams: MEASURED_SEAMS,
    stope: "balanced",
    capitalBtc: 0,
    btcPriceUsd: BTC_PRICE_USD,
  });
  checkInvariants(result, MEASURED_SEAMS);
  assert.equal(result.capitalSats, 0);
  assert.equal(result.idleSats, 0);
});

test("an empty seam catalogue leaves everything idle", () => {
  const result = planAllocation({
    seams: [],
    stope: "balanced",
    capitalBtc: 3,
    btcPriceUsd: BTC_PRICE_USD,
  });
  assert.equal(result.allocations.length, 0);
  assert.equal(result.idleBps, BPS_TOTAL);
  assert.equal(result.idleSats, result.capitalSats);
});

test("invalid input is rejected rather than silently corrected", () => {
  const base = { seams: MEASURED_SEAMS, capitalBtc: 1, btcPriceUsd: BTC_PRICE_USD };
  assert.throws(
    () => planAllocation({ ...base, stope: "reckless" as StopeProfile }),
    (error: unknown) => error instanceof SeamRouterError && error.code === "INVALID_PROFILE",
  );
  assert.throws(
    () => planAllocation({ ...base, stope: "balanced", capitalBtc: -1 }),
    (error: unknown) => error instanceof SeamRouterError && error.code === "INVALID_CAPITAL",
  );
  assert.throws(
    () => planAllocation({ ...base, stope: "balanced", btcPriceUsd: 0 }),
    (error: unknown) => error instanceof SeamRouterError && error.code === "INVALID_CAPITAL",
  );
  assert.throws(
    () => planAllocation({ ...base, stope: "balanced", seams: [...MEASURED_SEAMS, MEASURED_SEAMS[0]] }),
    (error: unknown) => error instanceof SeamRouterError && error.code === "DUPLICATE_SEAM",
  );
  assert.throws(
    () => planAllocation({ ...base, stope: "balanced", seams: [seam({ id: "bad", wrapHops: -1 })] }),
    (error: unknown) => error instanceof SeamRouterError && error.code === "INVALID_SEAM",
  );
  assert.throws(
    () => planAllocation({ ...base, stope: "balanced", constraints: { maxSeamBps: 20_000 } }),
    (error: unknown) => error instanceof SeamRouterError && error.code === "INVALID_CONSTRAINT",
  );
});

test("generated catalogues never breach a ceiling and always add up", () => {
  const random = makeRandom(20260815);
  const tiers: RiskTier[] = ["low", "medium", "high"];
  const kinds = ["lending", "lp", "basis"] as const;
  const yieldKinds = ["sustainable", "emissions", "counterparty"] as const;
  const pairs = ["correlated", "mixed", "uncorrelated", null] as const;
  const venues = ["Orca", "Kamino Lend", "Save", "Loopscale", "GMTrade"];
  const assets = ["cbBTC", "WBTC", "zBTC", "xBTC", "USDC"];

  for (let iteration = 0; iteration < 300; iteration += 1) {
    const count = 1 + Math.floor(random() * 16);
    const seams: Seam[] = [];
    for (let index = 0; index < count; index += 1) {
      const durable = Math.round(random() * 4_000);
      seams.push(
        seam({
          id: `generated-${index}`,
          venue: venues[Math.floor(random() * venues.length)] ?? "Orca",
          asset: assets[Math.floor(random() * assets.length)] ?? "cbBTC",
          kind: kinds[Math.floor(random() * kinds.length)] ?? "lending",
          yieldKind: yieldKinds[Math.floor(random() * yieldKinds.length)] ?? "sustainable",
          pairVolatilityClass: pairs[Math.floor(random() * pairs.length)] ?? null,
          riskTier: tiers[Math.floor(random() * tiers.length)] ?? "low",
          apyBps: Math.round(random() * 100_000),
          apy7dBps: random() < 0.2 ? null : durable,
          apy30dBps: random() < 0.3 ? null : Math.round(random() * 4_000),
          apy90dMedianBps: random() < 0.7 ? null : Math.round(random() * 4_000),
          ilEstimateBps: random() < 0.5 ? null : Math.round(random() * 800),
          wrapHops: Math.floor(random() * 4),
          belowLiquidityFloor: random() < 0.1,
          sourceDivergence: random() < 0.1,
          tvlUsd: Math.round(random() * 80_000_000),
          emissionToken: "generated-token",
          emissionEndsAt: random() < 0.5 ? "2026-12-31T00:00:00.000Z" : null,
        }),
      );
    }
    const profile = PROFILES[Math.floor(random() * PROFILES.length)] ?? "balanced";
    checkInvariants(
      planAllocation({
        seams,
        stope: profile,
        capitalBtc: Math.round(random() * 100_000) / 100,
        btcPriceUsd: BTC_PRICE_USD,
        now: FIXTURE_NOW,
      }),
      seams,
    );
  }
});
