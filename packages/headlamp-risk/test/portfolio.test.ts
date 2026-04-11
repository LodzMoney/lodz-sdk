import assert from "node:assert/strict";
import test from "node:test";

import { AssayError } from "lodz-assay-engine";

import { HeadlampError } from "../src/errors.js";
import { assessPortfolio } from "../src/portfolio.js";
import type { SeamRiskEntry } from "../src/portfolio.js";
import { everyLayerAt, factor, seam } from "./fixtures.js";

/**
 * 95% of capital in a calm seam, 5% behind a severity 5 bridge. The weighted
 * average barely moves; the exposure is still real.
 */
const LOPSIDED: SeamRiskEntry[] = [
  {
    seam: seam({
      id: "calm",
      allocationBps: 9_500,
      venue: "Kamino Finance",
      asset: "cbBTC",
      riskTier: "low",
    }),
    factors: everyLayerAt(1),
  },
  {
    seam: seam({
      id: "fragile",
      allocationBps: 500,
      venue: "Orca",
      asset: "zBTC",
      assetMint: "zbtc11111111111111111111111111111111111111111",
      riskTier: "high",
    }),
    factors: [
      factor("bridge", 5, { label: "bridge signer set is unaudited" }),
      factor("custody", 1),
      factor("protocol", 1),
      factor("oracle", 1),
      factor("liquidity", 1),
    ],
  },
];

test("the worst layer survives allocation weighting", () => {
  const result = assessPortfolio(LOPSIDED);
  assert.equal(result.weightedScore, 114);
  assert.equal(result.weightedTier, "low");

  // The average says low. The worst layer says otherwise, and it is reported.
  assert.equal(result.worstLayer.layer, "bridge");
  assert.equal(result.worstLayer.severity, 5);
  assert.equal(result.worstLayer.seamId, "fragile");
  assert.equal(result.worstLayer.label, "bridge signer set is unaudited");
  assert.equal(result.worstSeam.seamId, "fragile");
  assert.equal(result.worstSeam.compositeScore, 372);
  assert.equal(result.worstSeam.tier, "high");
});

test("per layer exposure keeps both the weighted and the worst severity", () => {
  const result = assessPortfolio(LOPSIDED);
  const bridge = result.layers.find((layer) => layer.layer === "bridge");
  assert.equal(bridge?.weightedSeverity, 120);
  assert.equal(bridge?.worstSeverity, 5);
  assert.equal(bridge?.worstSeamId, "fragile");
  assert.equal(bridge?.highSeverityAllocationBps, 500);

  const custody = result.layers.find((layer) => layer.layer === "custody");
  assert.equal(custody?.weightedSeverity, 100);
  assert.equal(custody?.worstSeverity, 1);

  assert.equal(result.highSeverityAllocationBps, 500);
  assert.equal(result.unevidencedAllocationBps, 0);
  assert.equal(result.layers.length, 5);
});

test("capital with no evidence behind it is counted, not ignored", () => {
  const result = assessPortfolio([
    { seam: seam({ id: "documented", allocationBps: 4_000 }), factors: everyLayerAt(2) },
    { seam: seam({ id: "undocumented", allocationBps: 6_000 }), factors: [] },
  ]);
  assert.equal(result.unevidencedAllocationBps, 6_000);
  const oracle = result.layers.find((layer) => layer.layer === "oracle");
  assert.equal(oracle?.unevidencedAllocationBps, 6_000);
  assert.equal(result.weightedTier, "medium");
});

test("concentration by seam, asset and venue is reported", () => {
  const result = assessPortfolio(LOPSIDED);
  assert.equal(result.concentration.topSeamId, "calm");
  assert.equal(result.concentration.topSeamBps, 9_500);
  assert.equal(result.concentration.topAsset, "cbBTC");
  assert.equal(result.concentration.topAssetBps, 9_500);
  assert.equal(result.concentration.topVenue, "Kamino Finance");
  assert.equal(result.concentration.topVenueBps, 9_500);
});

test("assets and venues are aggregated across seams", () => {
  const result = assessPortfolio([
    { seam: seam({ id: "a", allocationBps: 3_000, venue: "Kamino Finance", asset: "cbBTC" }), factors: everyLayerAt(2) },
    { seam: seam({ id: "b", allocationBps: 3_000, venue: "Kamino Finance", asset: "cbBTC" }), factors: everyLayerAt(2) },
    { seam: seam({ id: "c", allocationBps: 4_000, venue: "Orca", asset: "tBTC" }), factors: everyLayerAt(2) },
  ]);
  assert.equal(result.concentration.topSeamId, "c");
  assert.equal(result.concentration.topSeamBps, 4_000);
  assert.equal(result.concentration.topAsset, "cbBTC");
  assert.equal(result.concentration.topAssetBps, 6_000);
  assert.equal(result.concentration.topVenue, "Kamino Finance");
  assert.equal(result.concentration.topVenueBps, 6_000);
});

test("an explicit allocation reweights the portfolio", () => {
  const result = assessPortfolio(LOPSIDED, { calm: 1_000, fragile: 9_000 });
  assert.equal(result.weightedScore, 345);
  assert.equal(result.weightedTier, "high");
  assert.equal(result.worstLayer.severity, 5);
});

test("a seam holding no capital cannot become the portfolio worst", () => {
  const result = assessPortfolio(LOPSIDED, { calm: 10_000, fragile: 0 });
  assert.equal(result.worstSeam.seamId, "calm");
  assert.equal(result.worstLayer.seamId, "calm");
  assert.equal(result.worstLayer.severity, 1);
});

test("an allocation that does not total 10000 bps is rejected", () => {
  assert.throws(
    () => assessPortfolio(LOPSIDED, { calm: 9_000, fragile: 500 }),
    (error: unknown) => {
      assert.ok(error instanceof AssayError);
      assert.equal(error.code, "INVALID_ALLOCATION");
      return true;
    },
  );
});

test("an empty or malformed portfolio is rejected", () => {
  assert.throws(() => assessPortfolio([]), (error: unknown) => {
    assert.ok(error instanceof HeadlampError);
    assert.equal(error.code, "EMPTY_PORTFOLIO");
    return true;
  });
  assert.throws(
    () => assessPortfolio([{ factors: [] } as unknown as SeamRiskEntry]),
    HeadlampError,
  );
});
