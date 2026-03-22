import assert from "node:assert/strict";
import test from "node:test";

import {
  BPS_DENOMINATOR,
  allocateBps,
  allocateUnits,
  roundDivBig,
  roundDivInt,
} from "../src/bps.js";
import { AssayError } from "../src/errors.js";

test("allocateBps totals exactly 10000 for equal weights that do not divide evenly", () => {
  const three = allocateBps([1, 1, 1]);
  assert.equal(three.reduce((sum, value) => sum + value, 0), BPS_DENOMINATOR);
  assert.deepEqual(three, [3_334, 3_333, 3_333]);

  const seven = allocateBps([1, 1, 1, 1, 1, 1, 1]);
  assert.equal(seven.reduce((sum, value) => sum + value, 0), BPS_DENOMINATOR);
  assert.deepEqual(seven, [1_429, 1_429, 1_429, 1_429, 1_428, 1_428, 1_428]);
});

test("allocateBps totals exactly 10000 across awkward fractional weights", () => {
  const cases: number[][] = [
    [1, 2, 3],
    [0.1, 0.2, 0.30000000000000004],
    [7_777, 1_111, 555, 3],
    [1e-6, 1, 1e6],
    [33, 33, 33, 1],
    [1, 0, 0, 0, 1],
  ];
  for (const weights of cases) {
    const shares = allocateBps(weights);
    const total = shares.reduce((sum, value) => sum + value, 0);
    assert.equal(total, BPS_DENOMINATOR, `weights ${JSON.stringify(weights)} totalled ${total}`);
    assert.ok(shares.every((value) => Number.isInteger(value) && value >= 0));
  }
});

test("allocateBps stays exact over many pseudo random weight vectors", () => {
  // Deterministic linear congruential generator: the run must be reproducible.
  let state = 20_260_815;
  const next = (): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  for (let round = 0; round < 500; round += 1) {
    const size = 1 + (round % 9);
    const weights = Array.from({ length: size }, () => next() * 1_000);
    const shares = allocateBps(weights);
    assert.equal(
      shares.reduce((sum, value) => sum + value, 0),
      BPS_DENOMINATOR,
      `round ${round} landed off ${BPS_DENOMINATOR}`,
    );
  }
});

test("allocateUnits rejects zero total weight and negative weights", () => {
  assert.throws(() => allocateUnits([0, 0], 10_000), (error: unknown) => {
    assert.ok(error instanceof AssayError);
    assert.equal(error.code, "INVALID_ALLOCATION");
    return true;
  });
  assert.throws(() => allocateUnits([1, -1], 10_000), (error: unknown) => {
    assert.ok(error instanceof AssayError);
    assert.equal(error.code, "INVALID_INPUT");
    return true;
  });
});

test("rounding is half away from zero for both number and bigint division", () => {
  assert.equal(roundDivInt(5, 2), 3);
  assert.equal(roundDivInt(-5, 2), -3);
  assert.equal(roundDivInt(6_795_000, 10_000), 680);
  assert.equal(roundDivBig(5n, 2n), 3n);
  assert.equal(roundDivBig(-5n, 2n), -3n);
  assert.equal(roundDivBig(4n, 2n), 2n);
  assert.throws(() => roundDivBig(1n, 0n), AssayError);
});
