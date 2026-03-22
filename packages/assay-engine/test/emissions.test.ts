import assert from "node:assert/strict";
import test from "node:test";

import { simulatePostEmissions } from "../src/emissions.js";
import { AT, STAIRCASE_SEAMS, emissionSeam, seam } from "./fixtures.js";

test("the rate falls once the incentive programs end", () => {
  const result = simulatePostEmissions(STAIRCASE_SEAMS, AT);
  assert.equal(result.currentApyBps, 680);
  assert.equal(result.postEmissionsApyBps, 140);
  assert.ok(
    result.postEmissionsApyBps < result.currentApyBps,
    "post emissions rate must be lower than the current rate",
  );
  assert.equal(result.totalDropBps, 540);
  assert.equal(result.retainedRatioBps, 2_059);
  assert.equal(result.finalEmissionEndsAt, "2027-06-01T00:00:00.000Z");
});

test("three programs ending on three dates produce an exact four step curve", () => {
  const result = simulatePostEmissions(STAIRCASE_SEAMS, AT);
  assert.equal(result.steps.length, 4);

  const expected = [
    {
      at: "2026-08-15T00:00:00.000Z",
      endsAt: "2026-10-01T00:00:00.000Z",
      apyBps: 680,
      sustainableApyBps: 140,
      emissionsApyBps: 540,
      dropBps: 0,
      endedSeamIds: [] as string[],
      activeEmissionSeamIds: ["e1", "e2", "e3"],
    },
    {
      at: "2026-10-01T00:00:00.000Z",
      endsAt: "2027-01-01T00:00:00.000Z",
      apyBps: 560,
      sustainableApyBps: 140,
      emissionsApyBps: 420,
      dropBps: 120,
      endedSeamIds: ["e1"],
      activeEmissionSeamIds: ["e2", "e3"],
    },
    {
      at: "2027-01-01T00:00:00.000Z",
      endsAt: "2027-06-01T00:00:00.000Z",
      apyBps: 380,
      sustainableApyBps: 140,
      emissionsApyBps: 240,
      dropBps: 180,
      endedSeamIds: ["e2"],
      activeEmissionSeamIds: ["e3"],
    },
    {
      at: "2027-06-01T00:00:00.000Z",
      endsAt: null,
      apyBps: 140,
      sustainableApyBps: 140,
      emissionsApyBps: 0,
      dropBps: 240,
      endedSeamIds: ["e3"],
      activeEmissionSeamIds: [] as string[],
    },
  ];

  result.steps.forEach((step, index) => {
    const want = expected[index];
    assert.ok(want !== undefined, `unexpected extra step at index ${index}`);
    assert.equal(step.at, want.at, `step ${index} start`);
    assert.equal(step.endsAt, want.endsAt, `step ${index} end`);
    assert.equal(step.apyBps, want.apyBps, `step ${index} rate`);
    assert.equal(step.sustainableApyBps, want.sustainableApyBps, `step ${index} sustainable`);
    assert.equal(step.emissionsApyBps, want.emissionsApyBps, `step ${index} emissions`);
    assert.equal(step.dropBps, want.dropBps, `step ${index} drop`);
    assert.deepEqual(step.endedSeamIds, want.endedSeamIds, `step ${index} ended seams`);
    assert.deepEqual(
      step.activeEmissionSeamIds,
      want.activeEmissionSeamIds,
      `step ${index} active seams`,
    );
    assert.equal(
      step.sustainableApyBps + step.emissionsApyBps,
      step.apyBps,
      `step ${index} split must reconstruct the rate`,
    );
  });

  const totalDrop = result.steps.reduce((sum, step) => sum + step.dropBps, 0);
  assert.equal(totalDrop, result.totalDropBps);
  assert.deepEqual(
    result.steps.map((step) => step.dayOffset),
    [0, 47, 139, 290],
  );
});

test("two programs ending on the same date collapse into one step", () => {
  const seams = [
    seam({ id: "s", apyBps: 400, allocationBps: 4_000 }),
    emissionSeam({
      id: "e1",
      apyBps: 800,
      allocationBps: 3_000,
      emissionEndsAt: "2027-01-01T00:00:00.000Z",
    }),
    emissionSeam({
      id: "e2",
      apyBps: 1_000,
      allocationBps: 3_000,
      emissionEndsAt: "2027-01-01T00:00:00.000Z",
    }),
  ];
  const result = simulatePostEmissions(seams, AT);
  assert.equal(result.steps.length, 2);
  assert.deepEqual(result.steps[1]?.endedSeamIds, ["e1", "e2"]);
  assert.equal(result.currentApyBps, 700);
  assert.equal(result.postEmissionsApyBps, 160);
});

test("a portfolio with no live programs has a flat single step curve", () => {
  const seams = [
    seam({ id: "a", apyBps: 300, allocationBps: 5_000 }),
    seam({ id: "b", apyBps: 500, allocationBps: 5_000 }),
  ];
  const result = simulatePostEmissions(seams, AT);
  assert.equal(result.steps.length, 1);
  assert.equal(result.currentApyBps, 400);
  assert.equal(result.postEmissionsApyBps, 400);
  assert.equal(result.totalDropBps, 0);
  assert.equal(result.retainedRatioBps, 10_000);
  assert.equal(result.finalEmissionEndsAt, null);
});

test("an unallocated program cannot create a phantom step", () => {
  const seams = [
    seam({ id: "s", apyBps: 400, allocationBps: 10_000 }),
    emissionSeam({
      id: "e",
      apyBps: 5_000,
      allocationBps: 0,
      emissionEndsAt: "2027-01-01T00:00:00.000Z",
    }),
  ];
  const result = simulatePostEmissions(seams, AT);
  assert.equal(result.steps.length, 1);
  assert.equal(result.currentApyBps, 400);
});
