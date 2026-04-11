import assert from "node:assert/strict";
import test from "node:test";

import { assessSeam, compositeScore, tierFromScore, validateRiskFactor } from "../src/assess.js";
import { HeadlampError } from "../src/errors.js";
import { MIN_SEVERITY, RISK_LAYERS, UNEVIDENCED_SEVERITY } from "../src/types.js";
import type { Severity } from "../src/types.js";
import { everyLayerAt, factor, seam } from "./fixtures.js";

test("a seam with no evidence at all is scored as unknown, never as clear", () => {
  const result = assessSeam(seam({ id: "bare" }), []);
  assert.equal(result.layers.length, RISK_LAYERS.length);
  assert.deepEqual(result.unevidencedLayers, [...RISK_LAYERS]);
  assert.deepEqual(result.evidencedLayers, []);
  for (const layer of result.layers) {
    assert.equal(layer.severity, UNEVIDENCED_SEVERITY);
    assert.equal(layer.evidenced, false);
  }
  assert.equal(result.compositeScore, 300);
  assert.equal(result.tier, "medium");
  assert.equal(result.worstLayer.evidenced, false);
});

test("no assessment can score zero, and the floor is severity 1", () => {
  const best = assessSeam(seam({ id: "best", riskTier: "low" }), everyLayerAt(1));
  assert.equal(best.compositeScore, 100);
  assert.equal(best.tier, "low");
  assert.ok(best.compositeScore > 0);
  for (const layer of best.layers) {
    assert.ok(layer.severity >= MIN_SEVERITY, "no layer may drop below severity 1");
  }

  // Sweep every uniform severity: the score must stay on the 100..500 scale.
  for (const severity of [1, 2, 3, 4, 5] as Severity[]) {
    const result = assessSeam(seam({ id: `s${severity}` }), everyLayerAt(severity));
    assert.equal(result.compositeScore, severity * 100);
    assert.ok(result.compositeScore >= 100 && result.compositeScore <= 500);
  }
});

test("one severe layer is not averaged away by four calm ones", () => {
  const factors = [
    factor("bridge", 5),
    factor("custody", 1),
    factor("protocol", 1),
    factor("oracle", 1),
    factor("liquidity", 1),
  ];
  const result = assessSeam(seam({ id: "one-bad-layer", riskTier: "low" }), factors);
  assert.equal(result.worstLayer.layer, "bridge");
  assert.equal(result.worstLayer.severity, 5);
  assert.equal(result.compositeScore, 372);
  assert.equal(result.tier, "high");
  assert.equal(result.measuredWorseThanDeclared, true);
  assert.deepEqual(result.highSeverityLayers, ["bridge"]);

  // A plain mean would have called this low risk.
  const plainMean = factors.reduce((sum, entry) => sum + entry.severity, 0) / factors.length;
  assert.equal(tierFromScore(Math.round(plainMean * 100)), "low");
});

test("the worst factor in a layer sets that layer's severity", () => {
  const result = assessSeam(seam({ id: "multi" }), [
    factor("protocol", 2, { label: "audited contracts" }),
    factor("protocol", 4, { label: "upgrade authority is not renounced" }),
    factor("protocol", 3),
  ]);
  const protocolLayer = result.layers.find((layer) => layer.layer === "protocol");
  assert.equal(protocolLayer?.severity, 4);
  assert.equal(protocolLayer?.factorCount, 3);
  assert.equal(protocolLayer?.worstFactor?.label, "upgrade authority is not renounced");
});

test("a thin evidence set cannot make a seam look safer than a documented one", () => {
  const documented = assessSeam(seam({ id: "documented" }), everyLayerAt(2));
  const thin = assessSeam(seam({ id: "thin" }), [factor("bridge", 2)]);
  assert.ok(
    thin.compositeScore > documented.compositeScore,
    "unevidenced layers must not score better than evidenced calm ones",
  );
  assert.equal(thin.unevidencedLayers.length, 4);
});

test("the measured tier is compared against the tier the catalog claims", () => {
  const claimedLow = assessSeam(seam({ id: "claim", riskTier: "low" }), everyLayerAt(4));
  assert.equal(claimedLow.declaredTier, "low");
  assert.equal(claimedLow.tier, "high");
  assert.equal(claimedLow.tierMatchesDeclared, false);
  assert.equal(claimedLow.measuredWorseThanDeclared, true);

  const honest = assessSeam(seam({ id: "honest", riskTier: "medium" }), everyLayerAt(3));
  assert.equal(honest.tierMatchesDeclared, true);
  assert.equal(honest.measuredWorseThanDeclared, false);
});

test("factors carrying no checkable source are counted", () => {
  const result = assessSeam(seam({ id: "unsourced" }), [
    factor("bridge", 3, { evidenceUrl: null }),
    factor("custody", 2, { evidenceUrl: null }),
    factor("oracle", 2),
  ]);
  assert.equal(result.factorsWithoutEvidence, 2);
});

test("malformed factors are rejected instead of dropped", () => {
  const target = seam({ id: "guard" });
  const cases: [string, unknown][] = [
    ["layer", { ...factor("bridge", 3), layer: "weather" }],
    ["severity", { ...factor("bridge", 3), severity: 0 }],
    ["severity", { ...factor("bridge", 3), severity: 6 }],
    ["severity", { ...factor("bridge", 3), severity: 2.5 }],
    ["label", { ...factor("bridge", 3), label: "  " }],
    ["rationale", { ...factor("bridge", 3), rationale: "" }],
    ["evidenceUrl", { ...factor("bridge", 3), evidenceUrl: "not a url" }],
  ];
  for (const [field, broken] of cases) {
    assert.throws(
      () => assessSeam(target, [broken as never]),
      (error: unknown) => {
        assert.ok(error instanceof HeadlampError, `expected HeadlampError for ${field}`);
        assert.equal(error.code, "INVALID_FACTOR");
        assert.equal(error.field, field);
        assert.equal(error.seamId, "guard");
        return true;
      },
    );
  }
});

test("an invalid seam is rejected before any scoring happens", () => {
  assert.throws(() => assessSeam(seam({ id: "bad", apyBps: -1 }), []));
  assert.throws(() => validateRiskFactor({} as never));
});

test("the composite score needs at least one layer severity", () => {
  assert.throws(() => compositeScore([]), HeadlampError);
});
