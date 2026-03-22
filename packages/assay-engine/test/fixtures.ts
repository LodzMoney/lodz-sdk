import type { Seam } from "../src/types.js";

/**
 * Test fixtures.
 *
 * Venue names are real Solana protocols so the shapes stay realistic. Values in
 * the synthetic fixtures below are test data; the fixtures whose names say
 * "measured" carry figures from the project's own on-chain and API survey.
 */

export const AT = "2026-08-15T00:00:00.000Z";

export function seam(overrides: Partial<Seam> & Pick<Seam, "id">): Seam {
  const base: Seam = {
    id: overrides.id,
    name: `Seam ${overrides.id}`,
    venue: "Kamino Finance",
    asset: "cbBTC",
    assetMint: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
    kind: "lending",
    yieldKind: "sustainable",
    apyBps: 300,
    apy7dBps: null,
    apy90dMedianBps: null,
    tvlUsd: 1_000_000,
    allocationBps: 10_000,
    ilEstimateBps: null,
    pairVolatilityClass: null,
    belowLiquidityFloor: false,
    sourceDivergence: false,
    emissionToken: null,
    emissionEndsAt: null,
    riskTier: "low",
    sourceUrl: "https://example.org/lodz-test-fixture",
    updatedAt: AT,
  };
  return { ...base, ...overrides };
}

export function emissionSeam(
  overrides: Partial<Seam> & Pick<Seam, "id" | "emissionEndsAt">,
): Seam {
  return seam({
    yieldKind: "emissions",
    emissionToken: "INCENTIVE",
    riskTier: "high",
    ...overrides,
  });
}

export function counterpartySeam(overrides: Partial<Seam> & Pick<Seam, "id">): Seam {
  return seam({
    yieldKind: "counterparty",
    kind: "basis",
    riskTier: "high",
    ...overrides,
  });
}

/**
 * One sustainable seam plus three emissions seams that end on three different
 * dates. Portfolio rate at AT is 680 bps; the sustainable floor is 140 bps.
 */
export const STAIRCASE_SEAMS: readonly Seam[] = [
  seam({ id: "s1", apyBps: 350, allocationBps: 4_000, tvlUsd: 40_000_000 }),
  emissionSeam({
    id: "e1",
    apyBps: 600,
    allocationBps: 2_000,
    tvlUsd: 8_000_000,
    kind: "lp",
    emissionEndsAt: "2026-10-01T00:00:00.000Z",
  }),
  emissionSeam({
    id: "e2",
    apyBps: 900,
    allocationBps: 2_000,
    tvlUsd: 6_000_000,
    emissionEndsAt: "2027-01-01T00:00:00.000Z",
  }),
  emissionSeam({
    id: "e3",
    apyBps: 1_200,
    allocationBps: 2_000,
    tvlUsd: 4_000_000,
    kind: "basis",
    emissionEndsAt: "2027-06-01T00:00:00.000Z",
  }),
];

/** Two sustainable seams plus two emissions seams ending on different dates. */
export const MIXED_SEAMS: readonly Seam[] = [
  seam({
    id: "kamino-cbbtc-lend",
    name: "Kamino cbBTC borrow interest",
    venue: "Kamino Finance",
    asset: "cbBTC",
    kind: "lending",
    apyBps: 320,
    tvlUsd: 42_000_000,
    allocationBps: 3_500,
    riskTier: "low",
  }),
  seam({
    id: "orca-cbbtc-lp",
    name: "Orca cbBTC/USDC swap fees",
    venue: "Orca",
    asset: "cbBTC",
    kind: "lp",
    apyBps: 480,
    tvlUsd: 12_500_000,
    allocationBps: 2_500,
    riskTier: "medium",
  }),
  emissionSeam({
    id: "zbtc-lend-incentive",
    name: "zBTC lending incentive program",
    venue: "Kamino Finance",
    asset: "zBTC",
    assetMint: "zBTCug3er3tLyffELcvDNrKkCymbPWysGcWihESYfLg",
    kind: "lending",
    apyBps: 950,
    tvlUsd: 6_200_000,
    allocationBps: 2_500,
    emissionToken: "ZEUS",
    emissionEndsAt: "2026-11-30T00:00:00.000Z",
    riskTier: "high",
  }),
  emissionSeam({
    id: "tbtc-basis-incentive",
    name: "tBTC basis incentive program",
    venue: "Orca",
    asset: "tBTC",
    assetMint: "6DNSN2BJsaPFdFFc1zP37kkeNe4Usc1Sqkzr9C9vPWcU",
    kind: "basis",
    apyBps: 1_400,
    tvlUsd: 3_100_000,
    allocationBps: 1_500,
    emissionToken: "T",
    emissionEndsAt: "2027-04-15T00:00:00.000Z",
    riskTier: "high",
  }),
];

/**
 * The market as measured on 2026-08-15: LP swap fees carry the yield, lending
 * interest is effectively nil, there are no incentive programs anywhere, and
 * the highest number on the board is paid by losing traders.
 *
 * Sources: DefiLlama yields, Orca pools API, Kamino market reserve metrics.
 */
export const MEASURED_SEAMS: readonly Seam[] = [
  seam({
    id: "orca-cbbtc-usdc",
    name: "Orca cbBTC/USDC swap fees",
    venue: "Orca",
    asset: "cbBTC",
    kind: "lp",
    apyBps: 1_500,
    apy7dBps: 1_546,
    apy90dMedianBps: 2_850,
    tvlUsd: 6_319_470,
    allocationBps: 3_000,
    pairVolatilityClass: "uncorrelated",
    riskTier: "medium",
    sourceUrl: "https://yields.llama.fi/chart/2651188f-6b05-473e-9cfb-977a4ad094ba",
  }),
  seam({
    id: "orca-sol-cbbtc",
    name: "Orca SOL/cbBTC swap fees",
    venue: "Orca",
    asset: "cbBTC",
    kind: "lp",
    apyBps: 1_605,
    apy7dBps: 2_191,
    apy90dMedianBps: null,
    tvlUsd: 4_582_272,
    allocationBps: 2_500,
    pairVolatilityClass: "uncorrelated",
    riskTier: "medium",
    sourceUrl: "https://yields.llama.fi/chart/6dc30ef3-d497-497c-91f3-b4ccb817a8b9",
  }),
  seam({
    id: "loopscale-zbtc-lend",
    name: "Loopscale zBTC borrow interest",
    venue: "Loopscale",
    asset: "zBTC",
    assetMint: "zBTCug3er3tLyffELcvDNrKkCymbPWysGcWihESYfLg",
    kind: "lending",
    apyBps: 106,
    tvlUsd: 294_950,
    allocationBps: 1_500,
    riskTier: "high",
    sourceUrl: "https://yields.llama.fi/chart/8544e9ed-02b3-4374-84b6-9d0bd380c1c5",
  }),
  counterpartySeam({
    id: "gmtrade-btc-usdc-vault",
    name: "GMTrade BTC/USDC vault",
    venue: "GMTrade",
    asset: "cbBTC",
    kind: "basis",
    apyBps: 21_483,
    tvlUsd: 1_709_236,
    allocationBps: 2_000,
    riskTier: "high",
    sourceUrl: "https://yields.llama.fi/chart/3e6c799e-d07e-45f5-9854-9f0c18fe7646",
  }),
  seam({
    id: "zeus-btc-market-usdc",
    name: "Zeus Bitcoin Market USDC supply",
    venue: "Kamino Finance",
    asset: "zBTC",
    assetMint: "zBTCug3er3tLyffELcvDNrKkCymbPWysGcWihESYfLg",
    kind: "lending",
    apyBps: 10_462,
    tvlUsd: 10_927,
    allocationBps: 1_000,
    riskTier: "high",
    sourceUrl: "https://api.kamino.finance/kamino-market/E6Tq3XV4Dgqx1QwEUT1u4goM7794sPmb1cGvr7V4Xf6J/reserves/metrics",
  }),
];
