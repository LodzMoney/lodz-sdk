/**
 * Worked example: route the measured Solana BTC seam table for three vault postures.
 *
 * The catalogue is transcribed from `docs/research/btc-on-solana.md` (snapshot
 * 2026-08-15), which measured every BTC-related pool on Solana. This package ships no
 * catalogue of its own; the live one comes from the indexer and is injected.
 *
 * Run with: npm run demo
 */
import {
  BPS_TOTAL,
  aggregateRealizedYield,
  keeperBondRequirement,
  planAllocation,
  planRebalance,
} from "../src/index.js";
import type { AllocationPlan, RealizedYieldEntry, Seam, StopeProfile } from "../src/index.js";
import { MEASURED_SEAMS, REALIZED_ENTRIES, SPOT_SPIKE_BPS } from "../test/fixtures.js";

const NOW = "2026-08-15T00:00:00.000Z";
const CAPITAL_BTC = 12.5;
const BTC_PRICE_USD = 100_000;
const PROFILES: StopeProfile[] = ["conservative", "balanced", "aggressive"];

function pct(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

function run(stope: StopeProfile, seams: Seam[] = MEASURED_SEAMS): AllocationPlan {
  return planAllocation({ seams, stope, capitalBtc: CAPITAL_BTC, btcPriceUsd: BTC_PRICE_USD, now: NOW });
}

function printPlan(result: AllocationPlan): void {
  const policy = result.constraints.profiles[result.stope];
  console.log(`\n=== ${result.stope.toUpperCase()} ===`);
  console.log(
    `ceilings: counterparty ${policy.maxCounterpartyBps} / uncorrelated LP ${policy.maxUncorrelatedLpBps} / emissions ${policy.maxEmissionsBps} / venue ${policy.maxSingleVenueBps} / asset ${policy.maxSingleAssetBps} bps, wrapHops <= ${policy.maxWrapHops}, unmeasured IL ${policy.allowIlUnknown ? "allowed" : "refused"}`,
  );
  console.log(
    "seam  venue              asset   source        hops  rate    window        IL      bps    BTC          binding",
  );
  for (const entry of result.allocations) {
    console.log(
      [
        entry.seamId.padEnd(5),
        entry.venue.padEnd(18),
        entry.asset.padEnd(7),
        entry.yieldKind.padEnd(13),
        String(entry.wrapHops).padStart(4),
        pct(entry.grossApyBps).padStart(7),
        entry.apySource.padEnd(13),
        (entry.ilUnknown ? "unknown" : `${entry.ilEstimateBps ?? 0}bps`).padEnd(7),
        String(entry.allocationBps).padStart(5),
        entry.capitalBtc.toFixed(8).padStart(12),
        `  ${entry.bindingCap ?? "-"}`,
      ].join(" "),
    );
  }
  console.log(
    ["idle".padEnd(5), "".padEnd(18), "".padEnd(7), "".padEnd(13), "".padStart(4), "".padStart(7), "".padEnd(13), "".padEnd(7), String(result.idleBps).padStart(5), result.idleBtc.toFixed(8).padStart(12)].join(" "),
  );

  const total = result.allocations.reduce((acc, entry) => acc + entry.allocationBps, 0);
  console.log(
    `sum check:     ${total} allocated + ${result.idleBps} idle = ${total + result.idleBps} bps (must be ${BPS_TOTAL})`,
  );
  console.log(
    `satoshi check: ${result.allocations.reduce((acc, entry) => acc + entry.capitalSats, 0)} + ${result.idleSats} = ${result.capitalSats} sats`,
  );
  console.log(
    `by source:     sustainable ${result.sustainableBps} / emissions ${result.emissionsBps} / counterparty ${result.counterpartyBps} bps`,
  );
  console.log(
    `uncorrelated LP ${result.uncorrelatedLpBps} bps   unmeasured IL ${result.ilUnknownBps} bps   wrapHops ${JSON.stringify(result.byWrapHops)}`,
  );
  console.log(
    `blended gross ${result.blendedGrossApyBps} bps (${pct(result.blendedGrossApyBps)})   net of IL ${result.blendedNetApyBps === null ? "not stateable, some IL unmeasured" : `${result.blendedNetApyBps} bps`}`,
  );
  console.log(`risk tiers: ${JSON.stringify(result.byRiskTier)}`);
  const grouped = new Map<string, string[]>();
  for (const entry of result.excluded) {
    const bucket = grouped.get(entry.reason);
    if (bucket === undefined) grouped.set(entry.reason, [entry.seamId]);
    else bucket.push(entry.seamId);
  }
  for (const [reason, ids] of grouped) console.log(`excluded [${reason}]: ${ids.join(" ")}`);
}

console.log(`LODZ seam router, ${CAPITAL_BTC} BTC at ${BTC_PRICE_USD} USD, valuation time ${NOW}`);
console.log(
  `Measured Solana BTC catalogue: ${MEASURED_SEAMS.length} seams (${MEASURED_SEAMS.filter((s) => s.yieldKind === "sustainable").length} sustainable, ${MEASURED_SEAMS.filter((s) => s.yieldKind === "emissions").length} emissions, ${MEASURED_SEAMS.filter((s) => s.yieldKind === "counterparty").length} counterparty).`,
);

const plans = new Map<StopeProfile, AllocationPlan>();
for (const profile of PROFILES) {
  const result = run(profile);
  plans.set(profile, result);
  printPlan(result);
}

console.log("\n=== COUNTERPARTY EXPOSURE BY PROFILE ===");
console.log("profile        counterparty  ceiling   status");
for (const profile of PROFILES) {
  const result = plans.get(profile);
  if (result === undefined) continue;
  const ceiling = result.constraints.profiles[profile].maxCounterpartyBps;
  const status =
    ceiling === 0
      ? "X1 refused outright"
      : result.counterpartyBps >= ceiling
        ? "ceiling is binding"
        : "under ceiling";
  console.log(
    `${profile.padEnd(14)} ${String(result.counterpartyBps).padStart(5)} bps    ${String(ceiling).padStart(5)}   ${status}`,
  );
}

console.log("\n=== LIQUIDITY FLOOR AND SPOT GUARD ===");
const aggressive = plans.get("aggressive");
if (aggressive !== undefined) {
  const z1 = MEASURED_SEAMS.find((entry) => entry.id === "Z1");
  const floored = aggressive.excluded.find((entry) => entry.seamId === "Z1");
  console.log(
    `Z1 ${z1?.name}: spot ${pct(z1?.apyBps ?? 0)} against ${z1?.tvlUsd} USD of capacity, indexer flag belowLiquidityFloor=${z1?.belowLiquidityFloor} -> [${floored?.reason}] ${floored?.detail}`,
  );
  const s14 = aggressive.excluded.find((entry) => entry.seamId === "S14");
  console.log(`S14 Kamino Lend WBTC: [${s14?.reason}] ${s14?.detail}`);
  const s15 = aggressive.excluded.find((entry) => entry.seamId === "S15");
  console.log(`S15 Jupiter Lend cbBTC: [${s15?.reason}] ${s15?.detail}`);
}

const spiked = MEASURED_SEAMS.map((entry) =>
  entry.id === "S2" ? { ...entry, apyBps: SPOT_SPIKE_BPS } : entry,
);
const spikedPlan = run("aggressive", spiked);
const cleanS2 = aggressive?.allocations.find((entry) => entry.seamId === "S2");
const spikedS2 = spikedPlan.allocations.find((entry) => entry.seamId === "S2");
console.log(
  `\nS2 spot replaced with the documented 74,187% artifact day (${SPOT_SPIKE_BPS} bps):`,
);
console.log(
  `  spotRejected ${spikedS2?.spotRejected}   routed rate ${spikedS2?.grossApyBps} bps from ${spikedS2?.apySource}   allocation ${spikedS2?.allocationBps} bps`,
);
console.log(
  `  same seam without the artifact: routed rate ${cleanS2?.grossApyBps} bps, allocation ${cleanS2?.allocationBps} bps`,
);
console.log(
  `  allocation moved by ${(spikedS2?.allocationBps ?? 0) - (cleanS2?.allocationBps ?? 0)} bps -> ${(spikedS2?.allocationBps ?? 0) === (cleanS2?.allocationBps ?? 0) ? "PASS" : "FAIL"}`,
);

console.log("\n=== REBALANCE: A DRIFTED BALANCED BOOK BACK TO ITS TARGET ===");
const balanced = plans.get("balanced");
if (balanced !== undefined && aggressive !== undefined) {
  const apyBpsBySeamId: Record<string, number> = {};
  for (const entry of [...balanced.allocations, ...aggressive.allocations]) {
    apyBpsBySeamId[entry.seamId] = entry.grossApyBps;
  }

  const target = balanced.allocations.map((entry) => ({
    seamId: entry.seamId,
    allocationBps: entry.allocationBps,
  }));
  // Prices moved: the counterparty vault ran up while the cbBTC LP positions bled, and
  // one position drifted only slightly. Conservation is preserved by construction.
  const drift: Record<string, number> = { X1: 900, S1: -600, S2: -260, S4: -40 };
  const current = target.map((entry) => ({
    seamId: entry.seamId,
    allocationBps: entry.allocationBps + (drift[entry.seamId] ?? 0),
  }));
  console.log(
    `drifted book: ${current.map((entry) => `${entry.seamId} ${entry.allocationBps}`).join("  ")}`,
  );
  console.log(`target book:  ${target.map((entry) => `${entry.seamId} ${entry.allocationBps}`).join("  ")}`);

  const rebalance = planRebalance({
    current,
    target,
    minDeltaBps: 250,
    gasCostBps: 6,
    capitalBtc: CAPITAL_BTC,
    apyBpsBySeamId,
    horizonDays: 90,
    // X1 drifted past the counterparty ceiling. It comes down whether or not the trade
    // pays for itself, which it does not: X1 is the highest-yielding seam in the book.
    forcedExitSeamIds: ["X1"],
  });
  for (const move of rebalance.moves) {
    console.log(
      `move ${String(move.bps).padStart(5)} bps  ${move.fromSeamId.padEnd(4)} -> ${move.toSeamId.padEnd(4)}  cost ${move.costBps} bps  expected gain ${move.expectedGainBps} bps`,
    );
  }
  for (const entry of rebalance.skipped) {
    console.log(`skip ${String(entry.bps).padStart(5)} bps  ${(entry.seamId ?? "-").padEnd(4)}  [${entry.reason}]`);
  }
  const before = current.reduce((acc, entry) => acc + entry.allocationBps, 0);
  const after = rebalance.resulting.reduce((acc, entry) => acc + entry.allocationBps, 0);
  console.log(
    `turnover ${rebalance.turnoverBps} bps  cost ${rebalance.estimatedCostBps} bps  expected gain ${rebalance.expectedGainBps} bps  conservation ${before} -> ${after}`,
  );
}

console.log("\n=== REALIZED YIELD, SPLIT BY SOURCE ===");
const entries: RealizedYieldEntry[] = REALIZED_ENTRIES;
const report = aggregateRealizedYield(entries);
console.log(
  `total ${report.totalBtc} BTC = ${report.byYieldKind.sustainable.btc} sustainable (${pct(report.sustainableShareBps)}) + ${report.byYieldKind.emissions.btc} emissions (${pct(report.emissionsShareBps)}) + ${report.byYieldKind.counterparty.btc} counterparty (${pct(report.counterpartyShareBps)})`,
);
for (const [seamId, bucket] of Object.entries(report.bySeam)) {
  console.log(
    `  ${seamId.padEnd(4)} ${bucket.btc.toFixed(8)} BTC  sustainable ${bucket.sustainableBtc.toFixed(8)}  emissions ${bucket.emissionsBtc.toFixed(8)}  counterparty ${bucket.counterpartyBtc.toFixed(8)}`,
  );
}

console.log("\n=== KEEPER BOND ===");
const bond = keeperBondRequirement(CAPITAL_BTC, {
  btcPriceUsd: BTC_PRICE_USD,
  lodzPriceUsd: 0.25,
  bondRateBps: 200,
  minBondUsd: 5_000,
  maxBondUsd: 2_000_000,
  stope: "balanced",
  profileMultiplierBps: { conservative: 8_000, balanced: 10_000, aggressive: 15_000 },
  slashConditions: [
    { code: "allocation-cap-breach", description: "Submitted an allocation that breaches a vault ceiling", slashBps: 2_500, graceSeconds: 0 },
    { code: "spot-rate-routing", description: "Routed capital on a spot rate the planner had rejected", slashBps: 2_000, graceSeconds: 0 },
    { code: "queue-starvation", description: "Failed to release liquidity for a claimable redemption ticket", slashBps: 4_000, graceSeconds: 3_600 },
  ],
});
console.log(
  `notional ${bond.managedNotionalUsd} USD  bond ${bond.bondUsd} USD (${bond.bondLodz} LODZ)  rate ${bond.effectiveRateBps} bps  binding ${bond.binding}`,
);
for (const condition of bond.slashConditions) {
  console.log(
    `  ${condition.code.padEnd(22)} ${String(condition.slashBps).padStart(5)} bps  ${condition.slashUsd} USD`,
  );
}
console.log(`  worst case if every condition trips: ${bond.maxSlashBps} bps, ${bond.maxSlashUsd} USD`);
