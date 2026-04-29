import assert from "node:assert/strict";
import test from "node:test";

import { OrecartQueueError, redemptionFeeBps, redemptionFeeBreakdown } from "../src/index.js";
import { FEE_PARAMS, makeRandom } from "./fixtures.js";

test("an immediate exit pays the full urgency premium", () => {
  const breakdown = redemptionFeeBreakdown({ amountBtc: 1, waitDays: 0, params: FEE_PARAMS });

  assert.equal(breakdown.urgency, 1);
  assert.equal(breakdown.baseFeeBps, 10);
  assert.equal(breakdown.urgencyFeeBps, 200);
  assert.equal(breakdown.sizeSurchargeBps, 15);
  assert.equal(breakdown.feeBps, 225);
  assert.equal(breakdown.clampedBy, null);
  assert.equal(breakdown.feeBtc, 0.0225);
  assert.equal(breakdown.netBtc, 0.9775);
  assert.equal(breakdown.feeSats + breakdown.netSats, 100_000_000);
});

test("waiting the standard period removes the urgency premium entirely", () => {
  assert.equal(redemptionFeeBps({ amountBtc: 1, waitDays: 7, params: FEE_PARAMS }), 25);
  assert.equal(redemptionFeeBps({ amountBtc: 1, waitDays: 30, params: FEE_PARAMS }), 25);
});

test("the premium decays across the wait", () => {
  assert.equal(redemptionFeeBps({ amountBtc: 1, waitDays: 3.5, params: FEE_PARAMS }), 125);
  assert.equal(redemptionFeeBps({ amountBtc: 1, waitDays: 1.75, params: FEE_PARAMS }), 175);
});

test("a longer accepted wait never costs more", () => {
  let previous = Number.POSITIVE_INFINITY;
  for (let waitDays = 0; waitDays <= 20; waitDays += 0.25) {
    const feeBps = redemptionFeeBps({ amountBtc: 1, waitDays, params: FEE_PARAMS });
    assert.ok(feeBps <= previous, `fee rose from ${previous} to ${feeBps} at ${waitDays} days`);
    previous = feeBps;
  }
});

test("size bands are applied by the highest band the redemption qualifies for", () => {
  const params = { ...FEE_PARAMS, immediateFeeBps: 0 };
  assert.equal(redemptionFeeBps({ amountBtc: 0.5, waitDays: 0, params }), 10);
  assert.equal(redemptionFeeBps({ amountBtc: 1, waitDays: 0, params }), 25);
  assert.equal(redemptionFeeBps({ amountBtc: 4.99, waitDays: 0, params }), 25);
  assert.equal(redemptionFeeBps({ amountBtc: 5, waitDays: 0, params }), 50);
  assert.equal(redemptionFeeBps({ amountBtc: 500, waitDays: 0, params }), 50);
});

test("the exponential curve decays by half every half life", () => {
  const params = {
    ...FEE_PARAMS,
    decayCurve: "exponential" as const,
    decayHalfLifeDays: 2,
    sizeTiers: [],
  };
  assert.equal(redemptionFeeBps({ amountBtc: 1, waitDays: 0, params }), 210);
  assert.equal(redemptionFeeBps({ amountBtc: 1, waitDays: 2, params }), 110);
  assert.equal(redemptionFeeBps({ amountBtc: 1, waitDays: 4, params }), 60);
  assert.equal(redemptionFeeBps({ amountBtc: 1, waitDays: 6, params }), 35);
});

test("queue pressure raises the fee", () => {
  const calm = redemptionFeeBps({ amountBtc: 1, waitDays: 7, params: FEE_PARAMS });
  const drained = redemptionFeeBps({
    amountBtc: 1,
    waitDays: 7,
    params: { ...FEE_PARAMS, utilizationSurchargeBps: 50 },
  });
  assert.equal(drained - calm, 50);
});

test("the fee is always inside the declared bounds and the clamp is reported", () => {
  const random = makeRandom(90210);

  for (let iteration = 0; iteration < 500; iteration += 1) {
    const minFeeBps = Math.floor(random() * 100);
    const params = {
      baseFeeBps: Math.floor(random() * 200),
      immediateFeeBps: Math.floor(random() * 500),
      standardWaitDays: Math.floor(random() * 30),
      decayCurve: "linear" as const,
      sizeTiers: [{ minAmountBtc: 0, surchargeBps: Math.floor(random() * 100) }],
      utilizationSurchargeBps: Math.floor(random() * 100),
      minFeeBps,
      maxFeeBps: minFeeBps + Math.floor(random() * 400),
    };
    const breakdown = redemptionFeeBreakdown({
      amountBtc: Math.round(random() * 1_000_000) / 10_000,
      waitDays: random() * 40,
      params,
    });

    assert.ok(breakdown.feeBps >= params.minFeeBps, "fee fell below the declared floor");
    assert.ok(breakdown.feeBps <= params.maxFeeBps, "fee rose above the declared ceiling");
    assert.ok(breakdown.urgency >= 0 && breakdown.urgency <= 1);
    assert.equal(breakdown.feeSats + breakdown.netSats, breakdown.feeSats + breakdown.netSats);
    assert.ok(breakdown.netSats >= 0, "a fee must never exceed the redemption itself");

    const raw =
      params.baseFeeBps +
      breakdown.urgencyFeeBps +
      breakdown.sizeSurchargeBps +
      params.utilizationSurchargeBps;
    if (raw < params.minFeeBps) assert.equal(breakdown.clampedBy, "min");
    else if (raw > params.maxFeeBps) assert.equal(breakdown.clampedBy, "max");
    else assert.equal(breakdown.clampedBy, null);
  }
});

test("fee and net always add back to the redemption amount", () => {
  const breakdown = redemptionFeeBreakdown({ amountBtc: 3.14159265, waitDays: 1, params: FEE_PARAMS });

  // Satoshis are the ledger. They add up exactly, with nothing lost to rounding.
  assert.equal(breakdown.feeSats + breakdown.netSats, 314_159_265);

  // The BTC fields are a display convenience derived from those satoshis, so summing
  // them back up is only exact to eight decimal places. This is precisely why every
  // amount in this package is carried as an integer internally.
  assert.equal(Number((breakdown.feeBtc + breakdown.netBtc).toFixed(8)), 3.14159265);
});

test("invalid parameters are rejected", () => {
  assert.throws(
    () =>
      redemptionFeeBps({
        amountBtc: 1,
        waitDays: 0,
        params: { ...FEE_PARAMS, maxFeeBps: 1, minFeeBps: 100 },
      }),
    (error: unknown) => error instanceof OrecartQueueError && error.code === "INVALID_FEE_PARAMS",
  );
  assert.throws(
    () =>
      redemptionFeeBps({
        amountBtc: 1,
        waitDays: 0,
        params: { ...FEE_PARAMS, decayCurve: "exponential" },
      }),
    (error: unknown) => error instanceof OrecartQueueError && error.code === "INVALID_FEE_PARAMS",
  );
  assert.throws(
    () => redemptionFeeBps({ amountBtc: 1, waitDays: -1, params: FEE_PARAMS }),
    (error: unknown) => error instanceof OrecartQueueError && error.code === "INVALID_AMOUNT",
  );
});
