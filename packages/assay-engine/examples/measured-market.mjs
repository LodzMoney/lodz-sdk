// Worked example over the Solana BTC market as measured on 2026-08-15.
//
// Run: node examples/measured-market.mjs   (after npm run build)
//
// Every rate, TVL and pool below comes from the project's own survey:
// DefiLlama yields charts, the Orca pools API and Kamino market reserve
// metrics. Nothing here is invented, including the parts that are missing.
import {
  decomposeYield,
  projectYield,
  seamDataQuality,
  simulatePostEmissions,
} from "../dist/index.js";

const AT = "2026-08-15T00:00:00.000Z";
const SOURCE = "https://yields.llama.fi/chart";

const base = {
  apy7dBps: null,
  apy90dMedianBps: null,
  ilEstimateBps: null,
  pairVolatilityClass: null,
  belowLiquidityFloor: false,
  sourceDivergence: false,
  emissionToken: null,
  emissionEndsAt: null,
  updatedAt: AT,
};

const seams = [
  {
    ...base,
    id: "orca-cbbtc-usdc",
    name: "Orca cbBTC/USDC swap fees",
    venue: "Orca",
    asset: "cbBTC",
    assetMint: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
    kind: "lp",
    yieldKind: "sustainable",
    apyBps: 1_500, // spot 14.996%
    apy7dBps: 1_546, // 7d 15.463%
    apy90dMedianBps: 2_850, // 90d median 28.502%
    tvlUsd: 6_319_470,
    allocationBps: 3_000,
    pairVolatilityClass: "uncorrelated",
    riskTier: "medium",
    sourceUrl: `${SOURCE}/2651188f-6b05-473e-9cfb-977a4ad094ba`,
  },
  {
    ...base,
    id: "orca-sol-cbbtc",
    name: "Orca SOL/cbBTC swap fees",
    venue: "Orca",
    asset: "cbBTC",
    assetMint: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
    kind: "lp",
    yieldKind: "sustainable",
    apyBps: 1_605, // spot 16.046%
    apy7dBps: 2_191, // 7d 21.908%
    tvlUsd: 4_582_272,
    allocationBps: 2_500,
    pairVolatilityClass: "uncorrelated",
    riskTier: "medium",
    sourceUrl: `${SOURCE}/6dc30ef3-d497-497c-91f3-b4ccb817a8b9`,
  },
  {
    ...base,
    id: "loopscale-zbtc-lend",
    name: "Loopscale zBTC borrow interest",
    venue: "Loopscale",
    asset: "zBTC",
    assetMint: "zBTCug3er3tLyffELcvDNrKkCymbPWysGcWihESYfLg",
    kind: "lending",
    yieldKind: "sustainable",
    apyBps: 106, // 1.057%, the only BTC lending rate on Solana that is not ~0
    tvlUsd: 294_950,
    allocationBps: 1_500,
    riskTier: "high",
    sourceUrl: `${SOURCE}/8544e9ed-02b3-4374-84b6-9d0bd380c1c5`,
  },
  {
    ...base,
    id: "gmtrade-btc-usdc-vault",
    name: "GMTrade BTC/USDC vault",
    venue: "GMTrade",
    asset: "cbBTC",
    assetMint: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
    kind: "basis",
    yieldKind: "counterparty", // paid out of trader losses, not out of fees
    apyBps: 21_483, // 214.828%
    tvlUsd: 1_709_236,
    allocationBps: 2_000,
    riskTier: "high",
    sourceUrl: `${SOURCE}/3e6c799e-d07e-45f5-9854-9f0c18fe7646`,
  },
  {
    ...base,
    id: "zeus-btc-market-usdc",
    name: "Zeus Bitcoin Market USDC supply",
    venue: "Kamino Finance",
    asset: "zBTC",
    assetMint: "zBTCug3er3tLyffELcvDNrKkCymbPWysGcWihESYfLg",
    kind: "lending",
    yieldKind: "sustainable",
    apyBps: 10_462, // 104.621% on a reserve holding 10,927 USD
    tvlUsd: 10_927,
    allocationBps: 1_000,
    riskTier: "high",
    sourceUrl:
      "https://api.kamino.finance/kamino-market/E6Tq3XV4Dgqx1QwEUT1u4goM7794sPmb1cGvr7V4Xf6J/reserves/metrics",
  },
];

const pct = (bps) => `${(bps / 100).toFixed(2)}%`;

console.log("Catalog as supplied");
for (const seam of seams) {
  const quality = seamDataQuality(seam);
  console.log(
    `  ${seam.id.padEnd(23)} ${seam.yieldKind.padEnd(12)} spot ${pct(seam.apyBps).padStart(9)}  ` +
      `quoted ${pct(quality.quotedApyBps).padStart(8)} (${quality.apyBasis.padEnd(10)})  ` +
      `tvl ${seam.tvlUsd.toLocaleString("en-US").padStart(11)}  ` +
      `${quality.belowLiquidityFloor ? "BELOW FLOOR" : ""}${quality.ilUnknown ? " IL UNKNOWN" : ""}`,
  );
}

const projection = projectYield({ btcAmount: 1, seams, horizonDays: 365, at: AT });
const decomposition = projection.decomposition;

console.log("\nLiquidity floor");
console.log(`  dropped ${projection.liquidityFloor.excludedSeamIds.join(", ")}`);
console.log(`  ${pct(projection.liquidityFloor.reallocatedBps)} of capital redistributed`);

console.log("\nRate, split by who pays it");
console.log(`  headline      ${pct(decomposition.apyBps)}`);
console.log(
  `  sustainable   ${pct(decomposition.sustainableApyBps)} (${pct(decomposition.sustainableShareBps)} of the rate)`,
);
console.log(
  `  emissions     ${pct(decomposition.emissionsApyBps)} (${pct(decomposition.emissionsShareBps)} of the rate)`,
);
console.log(
  `  counterparty  ${pct(decomposition.counterpartyApyBps)} (${pct(decomposition.counterpartyShareBps)} of the rate)`,
);

const emissions = simulatePostEmissions(seams, AT, projection.allocation);
console.log("\nEmissions");
console.log(`  live programs        ${emissions.hasLiveEmissions ? "yes" : "no"}`);
console.log(`  capital exposed      ${pct(emissions.emissionExposureBps)}`);
console.log(`  rate after they end  ${pct(emissions.postEmissionsApyBps)}`);
console.log(`  steps in the curve   ${emissions.steps.length}`);

console.log("\nImpermanent loss");
console.log(`  known?          ${projection.il.ilUnknown ? "no, not calculated" : "yes"}`);
console.log(`  drag applied    ${pct(projection.il.ilDragBps)}`);
console.log(`  net of IL       ${pct(projection.il.netOfIlBps)}`);
console.log(`  LP capital with no estimate ${pct(projection.il.unknownIlAllocationBps)}`);
console.log(`  seams missing an estimate   ${projection.il.unknownIlSeamIds.join(", ")}`);

console.log("\n1 BTC over 365 days");
console.log(
  `  total ${projection.yieldFlat.total.btc} BTC  ` +
    `(sustainable ${projection.yieldFlat.sustainable.btc} / ` +
    `emissions ${projection.yieldFlat.emissions.btc} / ` +
    `counterparty ${projection.yieldFlat.counterparty.btc})`,
);
console.log(`  weighted risk ${projection.risk.weightedTier} / worst tier ${projection.risk.worstTier}`);

console.log("\nPer seam");
for (const contribution of projection.contributions) {
  console.log(
    `  ${contribution.seamId.padEnd(23)} alloc ${pct(contribution.allocationBps).padStart(7)}  ` +
      `quoted ${pct(contribution.apyBps).padStart(8)} (${contribution.apyBasis.padEnd(10)})  ` +
      `yield ${String(contribution.yieldFlat.btc).padEnd(11)} ` +
      `share ${pct(contribution.shareOfYieldBps).padStart(7)}  ` +
      `thickness ${String(contribution.thickness).padEnd(6)} fade ${contribution.fade}`,
  );
}

console.log("\nThe spot rate the engine refused to quote");
const spike = { ...seams[0], id: "spike", apyBps: 7_418_700 };
const spikeQuality = seamDataQuality(spike);
console.log(
  `  spot ${pct(spikeQuality.spotApyBps)} -> quoted ${pct(spikeQuality.quotedApyBps)} ` +
    `(${spikeQuality.apyBasis}), rejected: ${spikeQuality.spotRejected}, ` +
    `${spikeQuality.spotMultiple}x the smoothed rate`,
);
