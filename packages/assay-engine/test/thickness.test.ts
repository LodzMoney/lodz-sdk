import assert from "node:assert/strict";
import test from "node:test";

import { MIN_EMISSION_FADE, MIN_THICKNESS, seamThickness, seamThicknessSet } from "../src/thickness.js";
import { AT, STAIRCASE_SEAMS, emissionSeam, seam } from "./fixtures.js";

test("thickness tracks realized yield and peaks at the largest seam", () => {
  const widths = seamThicknessSet(STAIRCASE_SEAMS, { at: AT });
  const byId = new Map(widths.map((entry) => [entry.seamId, entry]));

  assert.equal(byId.get("s1")?.annualYieldUsd, 1_400_000);
  assert.equal(byId.get("e1")?.annualYieldUsd, 480_000);
  assert.equal(byId.get("e2")?.annualYieldUsd, 540_000);

  assert.equal(byId.get("s1")?.thickness, 1);
  const e1 = byId.get("e1")?.thickness ?? 0;
  const e2 = byId.get("e2")?.thickness ?? 0;
  assert.ok(e2 > e1, "the seam producing more yield must draw thicker");
  for (const entry of widths) {
    assert.ok(entry.thickness >= MIN_THICKNESS && entry.thickness <= 1);
  }
});

test("a high rate on a small pool draws thinner than a low rate on a large pool", () => {
  const widths = seamThicknessSet(
    [
      seam({ id: "big", apyBps: 400, tvlUsd: 40_000_000, allocationBps: 5_000 }),
      seam({ id: "small", apyBps: 4_000, tvlUsd: 200_000, allocationBps: 5_000 }),
    ],
    { at: AT },
  );
  const big = widths.find((entry) => entry.seamId === "big");
  const small = widths.find((entry) => entry.seamId === "small");
  assert.ok((big?.thickness ?? 0) > (small?.thickness ?? 0));
});

test("sustainable seams never fade and emissions seams always do", () => {
  const widths = seamThicknessSet(STAIRCASE_SEAMS, { at: AT });
  for (const entry of widths) {
    if (entry.yieldKind === "sustainable") {
      assert.equal(entry.fade, 0);
      assert.equal(entry.daysUntilEmissionEnd, null);
    } else {
      assert.ok(entry.fade >= MIN_EMISSION_FADE && entry.fade <= 1);
    }
  }
  const byId = new Map(widths.map((entry) => [entry.seamId, entry]));
  const soon = byId.get("e1")?.fade ?? 0;
  const later = byId.get("e3")?.fade ?? 0;
  assert.ok(soon > later, "a program closer to its end date must draw fainter");
});

test("a program with more than a year left sits at the floor fade", () => {
  const distant = emissionSeam({
    id: "distant",
    emissionEndsAt: "2030-01-01T00:00:00.000Z",
    allocationBps: 10_000,
  });
  const width = seamThickness(distant, distant.tvlUsd, { at: AT });
  assert.equal(width.fade, MIN_EMISSION_FADE);
});

test("an expired program draws fully faded", () => {
  const expired = emissionSeam({
    id: "expired",
    emissionEndsAt: "2026-01-01T00:00:00.000Z",
    allocationBps: 10_000,
  });
  const width = seamThickness(expired, expired.tvlUsd, { at: AT });
  assert.equal(width.fade, 1);
});

test("a zero yield seam still draws at the visible floor", () => {
  const idle = seam({ id: "idle", apyBps: 0, tvlUsd: 0, allocationBps: 10_000 });
  const width = seamThickness(idle, 10_000_000, { at: AT, maxAnnualYieldUsd: 500_000 });
  assert.equal(width.thickness, MIN_THICKNESS);
  assert.equal(width.annualYieldUsd, 0);
});
