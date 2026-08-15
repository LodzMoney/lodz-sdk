import type { Seam } from "@lodz/assay-engine";

import type { RiskFactor, RiskLayer, Severity } from "../src/types.js";
import { RISK_LAYERS } from "../src/types.js";

/**
 * Test fixtures. Venue names are real Solana protocols so the shapes stay
 * realistic; every rate, TVL and severity below is synthetic test data.
 */

export const AT = "2026-08-15T00:00:00.000Z";

export function seam(overrides: Partial<Seam> & Pick<Seam, "id">): Seam {
  const base: Seam = {
    id: overrides.id,
    name: `Seam ${overrides.id}`,
    venue: "Kamino Finance",
    asset: "cbBTC",
    assetMint: "cbbtc111111111111111111111111111111111111111",
    kind: "lending",
    yieldKind: "sustainable",
    apyBps: 320,
    apy7dBps: null,
    apy90dMedianBps: null,
    tvlUsd: 10_000_000,
    allocationBps: 10_000,
    ilEstimateBps: null,
    pairVolatilityClass: null,
    belowLiquidityFloor: false,
    sourceDivergence: false,
    emissionToken: null,
    emissionEndsAt: null,
    riskTier: "medium",
    sourceUrl: "https://example.org/lodz-test-fixture",
    updatedAt: AT,
  };
  return { ...base, ...overrides };
}

export function factor(
  layer: RiskLayer,
  severity: Severity,
  overrides: Partial<RiskFactor> = {},
): RiskFactor {
  return {
    layer,
    label: `${layer} exposure`,
    severity,
    rationale: `Observed ${layer} exposure at severity ${severity}.`,
    evidenceUrl: "https://example.org/lodz-evidence",
    ...overrides,
  };
}

/** One factor per layer, all at the same severity. */
export function everyLayerAt(severity: Severity): RiskFactor[] {
  return RISK_LAYERS.map((layer) => factor(layer, severity));
}
