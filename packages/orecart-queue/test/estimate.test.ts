import assert from "node:assert/strict";
import test from "node:test";

import { OrecartQueueError, advance, createQueue, estimateWait } from "../src/index.js";
import { NOW, SIX_TICKETS_TOTAL_BTC, THROUGHPUT_BTC_PER_DAY, loadedQueue } from "./fixtures.js";

test("an empty queue waits only for its own cooldown and drain time", () => {
  const estimate = estimateWait({
    queue: createQueue(),
    amountBtc: 1.5,
    throughputBtcPerDay: THROUGHPUT_BTC_PER_DAY,
    now: NOW,
  });

  assert.equal(estimate.positionInQueue, 1);
  assert.equal(estimate.ticketsAhead, 0);
  assert.equal(estimate.btcAhead, 0);
  assert.equal(estimate.expectedWaitDays, 1, "1.5 BTC at 1.5 BTC per day is one day");
  assert.equal(estimate.expectedCompleteAt, "2026-08-16T00:00:00.000Z");
});

test("the wait accounts for every ticket already in the queue", () => {
  const estimate = estimateWait({
    queue: loadedQueue(),
    amountBtc: 1,
    throughputBtcPerDay: THROUGHPUT_BTC_PER_DAY,
    now: NOW,
    cooldownDays: 3,
  });

  assert.equal(estimate.positionInQueue, 7);
  assert.equal(estimate.ticketsAhead, 6);
  assert.equal(estimate.btcAhead, SIX_TICKETS_TOTAL_BTC);
  // 7 BTC ahead plus 1 BTC of our own, drained at 1.5 BTC per day, and no cooldown in
  // the queue is late enough to add to that.
  assert.equal(estimate.expectedWaitDays, 5.3333);
  assert.equal(estimate.cooldownDays, 3);
  assert.equal(estimate.expectedClaimableAt, "2026-08-18T00:00:00.000Z");
});

test("a cooldown longer than the drain time is what sets the wait", () => {
  const estimate = estimateWait({
    queue: createQueue(),
    amountBtc: 0.1,
    throughputBtcPerDay: THROUGHPUT_BTC_PER_DAY,
    now: NOW,
    cooldownDays: 7,
  });

  assert.ok(estimate.expectedWaitDays > 7, "the cooldown must elapse before draining begins");
  assert.equal(estimate.expectedWaitDays, 7.0667);
});

test("a ticket ahead whose cooldown has not expired pushes the wait out", () => {
  const now = "2026-08-11T00:00:00.000Z";
  const withoutBlocker = estimateWait({
    queue: createQueue(),
    amountBtc: 0.1,
    throughputBtcPerDay: 100,
    now,
  });
  const withBlocker = estimateWait({
    queue: loadedQueue(),
    amountBtc: 0.1,
    throughputBtcPerDay: 100,
    now,
  });

  assert.ok(withoutBlocker.expectedWaitDays < 0.1);
  assert.ok(
    withBlocker.expectedWaitDays > 6,
    "the last ticket is not claimable until 2026-08-18, and first in first out means waiting for it",
  );
});

test("a larger redemption waits longer, and a later position waits longer", () => {
  const base = {
    queue: loadedQueue(),
    throughputBtcPerDay: THROUGHPUT_BTC_PER_DAY,
    now: NOW,
  };
  const small = estimateWait({ ...base, amountBtc: 0.1 });
  const large = estimateWait({ ...base, amountBtc: 5 });
  assert.ok(large.expectedWaitDays > small.expectedWaitDays);

  const drained = advance(loadedQueue(), { now: NOW, availableLiquidityBtc: 2.35 });
  const shorterQueue = estimateWait({
    queue: drained.queue,
    amountBtc: 0.1,
    throughputBtcPerDay: THROUGHPUT_BTC_PER_DAY,
    now: NOW,
  });
  assert.ok(
    shorterQueue.expectedWaitDays < small.expectedWaitDays,
    "settling the front of the queue must shorten the wait behind it",
  );
  assert.equal(shorterQueue.ticketsAhead, 3);
});

test("the reported range brackets the expected wait and says what it is", () => {
  const estimate = estimateWait({
    queue: loadedQueue(),
    amountBtc: 1,
    throughputBtcPerDay: THROUGHPUT_BTC_PER_DAY,
    now: NOW,
    throughputVolatilityBps: 2_500,
  });

  assert.ok(estimate.lowWaitDays < estimate.expectedWaitDays);
  assert.ok(estimate.highWaitDays > estimate.expectedWaitDays);
  assert.equal(estimate.throughputRangeBtcPerDay.low, 1.125);
  assert.equal(estimate.throughputRangeBtcPerDay.high, 1.875);
  assert.ok(estimate.basis.includes("not a statistical confidence interval"));
});

test("identical inputs produce identical estimates", () => {
  const input = {
    queue: loadedQueue(),
    amountBtc: 2,
    throughputBtcPerDay: THROUGHPUT_BTC_PER_DAY,
    now: NOW,
    cooldownDays: 3,
    throughputVolatilityBps: 1_000,
  };
  assert.deepEqual(estimateWait(input), estimateWait(input));
});

test("invalid input is rejected", () => {
  assert.throws(
    () =>
      estimateWait({
        queue: loadedQueue(),
        amountBtc: 1,
        throughputBtcPerDay: 0,
        now: NOW,
      }),
    (error: unknown) => error instanceof OrecartQueueError && error.code === "INVALID_THROUGHPUT",
  );
  assert.throws(
    () =>
      estimateWait({
        queue: loadedQueue(),
        amountBtc: 0,
        throughputBtcPerDay: 1,
        now: NOW,
      }),
    (error: unknown) => error instanceof OrecartQueueError && error.code === "INVALID_AMOUNT",
  );
  assert.throws(
    () =>
      estimateWait({
        queue: loadedQueue(),
        amountBtc: 1,
        throughputBtcPerDay: 1,
        now: NOW,
        throughputVolatilityBps: 9_500,
      }),
    (error: unknown) => error instanceof OrecartQueueError && error.code === "INVALID_THROUGHPUT",
  );
});
