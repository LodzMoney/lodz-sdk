import assert from "node:assert/strict";
import test from "node:test";

import { SeamRouterError, planRebalance } from "../src/index.js";
import type { AllocationSnapshot } from "../src/index.js";
import { makeRandom } from "./fixtures.js";

const CURRENT: AllocationSnapshot[] = [
  { seamId: "seam-lend-a", allocationBps: 3_000 },
  { seamId: "seam-lend-b", allocationBps: 3_000 },
  { seamId: "seam-basis-a", allocationBps: 2_000 },
  { seamId: "seam-lp-a", allocationBps: 2_000 },
];

function totalOf(snapshots: readonly AllocationSnapshot[]): number {
  return snapshots.reduce((acc, entry) => acc + entry.allocationBps, 0);
}

test("changes under the threshold are skipped and the reason is recorded", () => {
  const result = planRebalance({
    current: CURRENT,
    target: [
      { seamId: "seam-lend-a", allocationBps: 2_990 },
      { seamId: "seam-lend-b", allocationBps: 3_010 },
      { seamId: "seam-basis-a", allocationBps: 2_000 },
      { seamId: "seam-lp-a", allocationBps: 2_000 },
    ],
    minDeltaBps: 100,
    gasCostBps: 8,
  });

  assert.equal(result.moves.length, 0, "a 10 bps drift is not worth an execution");
  assert.equal(result.turnoverBps, 0);
  assert.equal(result.skipped.length, 2);
  for (const entry of result.skipped) {
    assert.equal(entry.reason, "below-min-delta");
    assert.equal(entry.bps, 10);
    assert.ok(entry.detail.length > 0);
  }
  assert.equal(totalOf(result.resulting), totalOf(CURRENT));
});

test("changes above the threshold are executed", () => {
  const result = planRebalance({
    current: CURRENT,
    target: [
      { seamId: "seam-lend-a", allocationBps: 2_000 },
      { seamId: "seam-lend-b", allocationBps: 3_000 },
      { seamId: "seam-basis-a", allocationBps: 3_000 },
      { seamId: "seam-lp-a", allocationBps: 2_000 },
    ],
    minDeltaBps: 100,
    gasCostBps: 8,
    capitalBtc: 10,
  });

  assert.equal(result.moves.length, 1);
  const move = result.moves[0];
  assert.equal(move.fromSeamId, "seam-lend-a");
  assert.equal(move.toSeamId, "seam-basis-a");
  assert.equal(move.bps, 1_000);
  assert.equal(move.btc, 1);
  assert.equal(result.turnoverBps, 1_000);
  assert.equal(result.residualDriftBps, 0);
  assert.equal(totalOf(result.resulting), totalOf(CURRENT));
});

test("a move that cannot earn back its execution cost is refused", () => {
  const shared = {
    current: CURRENT,
    target: [
      { seamId: "seam-lend-a", allocationBps: 2_000 },
      { seamId: "seam-lend-b", allocationBps: 3_000 },
      { seamId: "seam-basis-a", allocationBps: 3_000 },
      { seamId: "seam-lp-a", allocationBps: 2_000 },
    ],
    minDeltaBps: 100,
    apyBpsBySeamId: {
      "seam-lend-a": 420,
      "seam-lend-b": 510,
      "seam-basis-a": 460,
      "seam-lp-a": 1_600,
    },
    horizonDays: 30,
  };

  // 40 bps of APY pickup over 30 days is worth about 3.3 bps; a 25 bps execution
  // charge eats it several times over.
  const refused = planRebalance({ ...shared, gasCostBps: 25 });
  assert.equal(refused.moves.length, 0);
  assert.ok(refused.skipped.some((entry) => entry.reason === "cost-exceeds-gain"));
  assert.equal(totalOf(refused.resulting), totalOf(CURRENT));

  const accepted = planRebalance({ ...shared, gasCostBps: 1 });
  assert.equal(accepted.moves.length, 1);
  const move = accepted.moves[0];
  assert.ok(move.expectedGainBps !== null && move.expectedGainBps > move.costBps);
});

test("the gate compares against the widest spread available before giving up", () => {
  const result = planRebalance({
    current: CURRENT,
    target: [
      { seamId: "seam-lend-a", allocationBps: 1_000 },
      { seamId: "seam-lend-b", allocationBps: 2_000 },
      { seamId: "seam-basis-a", allocationBps: 3_000 },
      { seamId: "seam-lp-a", allocationBps: 4_000 },
    ],
    minDeltaBps: 100,
    gasCostBps: 20,
    apyBpsBySeamId: {
      "seam-lend-a": 420,
      "seam-lend-b": 510,
      "seam-basis-a": 890,
      "seam-lp-a": 1_640,
    },
    horizonDays: 90,
  });

  // Required spread is 20 * 365 / 90 = 81.1 bps. lend-a into lp-a clears it easily.
  assert.ok(result.moves.length > 0);
  assert.equal(result.moves[0].fromSeamId, "seam-lend-a");
  assert.equal(result.moves[0].toSeamId, "seam-lp-a");
  assert.equal(totalOf(result.resulting), totalOf(CURRENT));
});

test("a one-sided threshold outcome trims the other side and says so", () => {
  const result = planRebalance({
    current: [
      { seamId: "a", allocationBps: 5_000 },
      { seamId: "b", allocationBps: 5_000 },
    ],
    target: [
      { seamId: "a", allocationBps: 4_000 },
      { seamId: "b", allocationBps: 5_050 },
      { seamId: "c", allocationBps: 950 },
    ],
    minDeltaBps: 100,
    gasCostBps: 5,
  });

  // b only wants 50 bps, which is under the threshold, so 50 of a's 1000 bps has no
  // counterparty and stays where it is.
  assert.ok(result.skipped.some((entry) => entry.reason === "below-min-delta"));
  assert.ok(result.skipped.some((entry) => entry.reason === "unmatched"));
  assert.equal(totalOf(result.resulting), 10_000);
  assert.equal(result.turnoverBps, 950);
});

test("a ceiling breach is corrected even though the trade loses yield", () => {
  const shared = {
    current: [
      { seamId: "rich", allocationBps: 4_000 },
      { seamId: "plain", allocationBps: 6_000 },
    ],
    target: [
      { seamId: "rich", allocationBps: 1_000 },
      { seamId: "plain", allocationBps: 9_000 },
    ],
    minDeltaBps: 100,
    gasCostBps: 6,
    // Selling the highest-yielding seam into the lowest is negative on spread alone.
    apyBpsBySeamId: { rich: 17_446, plain: 18 },
    horizonDays: 90,
  };

  const gated = planRebalance(shared);
  assert.equal(gated.moves.length, 0, "on spread alone this trade never happens");
  assert.ok(gated.skipped.some((entry) => entry.reason === "cost-exceeds-gain"));

  const forced = planRebalance({ ...shared, forcedExitSeamIds: ["rich"] });
  assert.equal(forced.moves.length, 1, "a ceiling breach is not subject to the cost test");
  assert.equal(forced.moves[0].fromSeamId, "rich");
  assert.equal(forced.moves[0].toSeamId, "plain");
  assert.equal(forced.moves[0].bps, 3_000);
  assert.ok(
    (forced.moves[0].expectedGainBps ?? 0) < 0,
    "the move is reported as yield-negative rather than dressed up",
  );
  assert.equal(forced.residualDriftBps, 0);
  assert.equal(totalOf(forced.resulting), 10_000);
});

test("seams that appear only in the target are funded from scratch", () => {
  const result = planRebalance({
    current: [{ seamId: "a", allocationBps: 10_000 }],
    target: [
      { seamId: "a", allocationBps: 6_000 },
      { seamId: "new-seam", allocationBps: 4_000 },
    ],
    minDeltaBps: 50,
    gasCostBps: 3,
  });
  assert.equal(result.moves.length, 1);
  assert.equal(result.moves[0].toSeamId, "new-seam");
  assert.equal(result.residualDriftBps, 0);
});

test("capital is conserved across generated rebalances", () => {
  const random = makeRandom(4242);
  for (let iteration = 0; iteration < 300; iteration += 1) {
    const ids = ["a", "b", "c", "d", "e"];
    const draw = (): AllocationSnapshot[] => {
      const raw = ids.map(() => Math.floor(random() * 3_000));
      const total = raw.reduce((acc, value) => acc + value, 0);
      if (total === 0) return ids.map((seamId) => ({ seamId, allocationBps: 0 }));
      const scaled = raw.map((value) => Math.floor((value / total) * 9_000));
      return ids.map((seamId, index) => ({ seamId, allocationBps: scaled[index] ?? 0 }));
    };

    const current = draw();
    const target = draw();
    const result = planRebalance({
      current,
      target,
      minDeltaBps: Math.floor(random() * 400),
      gasCostBps: Math.floor(random() * 30),
    });

    assert.equal(totalOf(result.resulting), totalOf(current), "a rebalance never mints capital");
    for (const entry of result.resulting) {
      assert.ok(entry.allocationBps >= 0, "a rebalance never drives an allocation negative");
    }
    const turnover = result.moves.reduce((acc, move) => acc + move.bps, 0);
    assert.equal(turnover, result.turnoverBps);
  }
});

test("invalid input is rejected", () => {
  assert.throws(
    () =>
      planRebalance({
        current: CURRENT,
        target: CURRENT,
        minDeltaBps: -1,
        gasCostBps: 5,
      }),
    (error: unknown) => error instanceof SeamRouterError && error.code === "INVALID_ALLOCATION",
  );
  assert.throws(
    () =>
      planRebalance({
        current: CURRENT,
        target: CURRENT,
        minDeltaBps: 10,
        gasCostBps: 5,
        apyBpsBySeamId: { "seam-lend-a": 400 },
      }),
    (error: unknown) => error instanceof SeamRouterError && error.code === "INVALID_ALLOCATION",
  );
  assert.throws(
    () =>
      planRebalance({
        current: [
          { seamId: "a", allocationBps: 6_000 },
          { seamId: "a", allocationBps: 6_000 },
        ],
        target: [{ seamId: "a", allocationBps: 10_000 }],
        minDeltaBps: 10,
        gasCostBps: 5,
      }),
    (error: unknown) => error instanceof SeamRouterError && error.code === "INVALID_ALLOCATION",
  );
});
