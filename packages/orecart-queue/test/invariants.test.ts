import assert from "node:assert/strict";
import test from "node:test";

import { advance, btcToSats, createQueue, enqueue } from "../src/index.js";
import type { AdvanceResult, OrecartQueue } from "../src/index.js";
import { NOW, isoAfterDays, loadedQueue, makeRandom } from "./fixtures.js";

/**
 * First in, first out, stated exactly: once a ticket is not fully settled, no ticket
 * behind it may have received anything.
 */
function assertFifo(queue: OrecartQueue): void {
  let sawUnfinished = false;
  for (const ticket of queue.tickets) {
    if (sawUnfinished) {
      assert.equal(
        ticket.releasedSats,
        0,
        `${ticket.id} was paid while ticket ahead of it was still owed capital`,
      );
    }
    if (ticket.remainingSats > 0) sawUnfinished = true;
  }
}

function assertConservation(queue: OrecartQueue): void {
  const enqueued = queue.tickets.reduce((acc, ticket) => acc + ticket.amountSats, 0);
  const released = queue.tickets.reduce((acc, ticket) => acc + ticket.releasedSats, 0);
  assert.equal(queue.enqueuedSats, enqueued, "declared enqueued total must match the tickets");
  assert.equal(queue.releasedSats, released, "declared released total must match the tickets");
  assert.ok(released <= enqueued, "total released must never exceed total enqueued");
  for (const ticket of queue.tickets) {
    assert.ok(ticket.releasedSats <= ticket.amountSats, `${ticket.id} was overpaid`);
    assert.ok(ticket.releasedSats >= 0, `${ticket.id} has a negative release`);
  }
}

function assertReleaseLegality(
  before: OrecartQueue,
  result: AdvanceResult,
  liquidityBtc: number,
): void {
  const nowMs = Date.parse(result.at);
  const byId = new Map(before.tickets.map((ticket) => [ticket.id, ticket]));

  let releasedSats = 0;
  let previousSeq = -1;
  for (const release of result.releases) {
    const ticket = byId.get(release.ticketId);
    assert.ok(ticket, "a release must refer to a ticket that was already in the queue");
    assert.ok(
      Date.parse(ticket.claimableAt) <= nowMs,
      `${ticket.id} was released before its claimableAt of ${ticket.claimableAt}`,
    );
    assert.ok(release.seq > previousSeq, "releases must come out in queue order");
    previousSeq = release.seq;
    assert.ok(release.amountSats > 0, "a release event must move a positive amount");
    releasedSats += release.amountSats;
  }

  assert.equal(releasedSats, result.releasedSats, "release events must sum to the reported total");
  assert.ok(
    releasedSats <= btcToSats(liquidityBtc),
    `released ${releasedSats} sats against ${btcToSats(liquidityBtc)} sats of liquidity`,
  );
  assert.equal(
    result.remainingLiquiditySats,
    btcToSats(liquidityBtc) - releasedSats,
    "remaining liquidity must account for exactly what was paid out",
  );
}

test("nothing is released before its claimable time", () => {
  const queue = loadedQueue();
  // At 2026-08-12 only ticket-1 has passed its cooldown, and ticket-2 blocks the rest.
  const result = advance(queue, {
    now: "2026-08-12T00:00:00.000Z",
    availableLiquidityBtc: 100,
  });

  assert.equal(result.releases.length, 0);
  assert.ok(result.blocked);
  assert.equal(result.blocked.ticketId, "ticket-1");
  assert.equal(result.blocked.reason, "not-yet-claimable");
  assertReleaseLegality(queue, result, 100);
});

test("a ticket whose cooldown has not expired holds up the queue behind it", () => {
  const queue = loadedQueue();
  // ticket-4 is not claimable until 2026-08-16 even though liquidity is abundant.
  const result = advance(queue, { now: NOW, availableLiquidityBtc: 100 });

  assert.deepEqual(
    result.releases.map((entry) => entry.ticketId),
    ["ticket-1", "ticket-2", "ticket-3"],
  );
  assert.ok(result.blocked);
  assert.equal(result.blocked.ticketId, "ticket-4");
  assert.equal(result.blocked.reason, "not-yet-claimable");
  assertFifo(result.queue);
  assertConservation(result.queue);
});

test("more is never released than the liquidity supplied", () => {
  const queue = loadedQueue();
  const result = advance(queue, { now: NOW, availableLiquidityBtc: 1.5 });

  assert.equal(result.releasedBtc, 1.5);
  assert.equal(result.remainingLiquidityBtc, 0);
  assert.deepEqual(
    result.releases.map((entry) => [entry.ticketId, entry.amountBtc, entry.full]),
    [
      ["ticket-1", 0.75, true],
      ["ticket-2", 0.75, false],
    ],
  );
  assert.ok(result.blocked);
  assert.equal(result.blocked.ticketId, "ticket-2");
  assert.equal(result.blocked.reason, "insufficient-liquidity");
  assert.equal(result.blocked.shortfallBtc, 0.45);
  assertReleaseLegality(queue, result, 1.5);
  assertFifo(result.queue);
  assertConservation(result.queue);
});

test("partial settlement can be refused, leaving the head untouched", () => {
  const queue = loadedQueue();
  const result = advance(queue, {
    now: NOW,
    availableLiquidityBtc: 1,
    allowPartialFill: false,
  });

  assert.deepEqual(
    result.releases.map((entry) => entry.ticketId),
    ["ticket-1"],
  );
  assert.ok(result.blocked);
  assert.equal(result.blocked.ticketId, "ticket-2");
  assert.equal(result.blocked.shortfallBtc, 0.95);
  assert.equal(result.remainingLiquidityBtc, 0.25);
});

test("advance leaves the input queue untouched", () => {
  const queue = loadedQueue();
  const snapshot = JSON.stringify(queue);
  advance(queue, { now: NOW, availableLiquidityBtc: 5 });
  assert.equal(JSON.stringify(queue), snapshot, "advance must not mutate its input");
});

test("total released never exceeds total enqueued across a generated run", () => {
  const random = makeRandom(20260815);

  for (let iteration = 0; iteration < 120; iteration += 1) {
    let queue = createQueue();
    let dayCursor = 0;
    let ticketCounter = 0;

    for (let step = 0; step < 25; step += 1) {
      if (random() < 0.55) {
        dayCursor += random() * 2;
        ticketCounter += 1;
        const cooldownDays = random() * 4;
        queue = enqueue(queue, {
          id: `generated-${ticketCounter}`,
          owner: `owner-${ticketCounter % 5}`,
          amountBtc: Math.max(0.00001, Math.round(random() * 300_000) / 100_000),
          requestedAt: isoAfterDays(NOW, dayCursor),
          claimableAt: isoAfterDays(NOW, dayCursor + cooldownDays),
        });
      } else {
        dayCursor += random() * 3;
        const liquidityBtc = Math.round(random() * 400_000) / 100_000;
        const before = queue;
        const result = advance(before, {
          now: isoAfterDays(NOW, dayCursor),
          availableLiquidityBtc: liquidityBtc,
          allowPartialFill: random() < 0.7,
        });
        assertReleaseLegality(before, result, liquidityBtc);
        assertFifo(result.queue);
        assertConservation(result.queue);
        queue = result.queue;
      }
    }

    assert.ok(
      queue.releasedSats <= queue.enqueuedSats,
      "a queue can never pay out more than was put in",
    );
  }
});

test("draining day by day settles every ticket exactly once, in order", () => {
  let queue = loadedQueue();
  const completions: Array<{ ticketId: string; seq: number; day: number }> = [];
  let totalReleasedSats = 0;

  for (let day = 0; day <= 40; day += 1) {
    const result = advance(queue, {
      now: isoAfterDays(NOW, day),
      availableLiquidityBtc: 1.5,
    });
    for (const release of result.releases) {
      totalReleasedSats += release.amountSats;
      if (release.full) completions.push({ ticketId: release.ticketId, seq: release.seq, day });
    }
    queue = result.queue;
    assertFifo(queue);
    assertConservation(queue);
  }

  assert.deepEqual(
    completions.map((entry) => entry.ticketId),
    ["ticket-1", "ticket-2", "ticket-3", "ticket-4", "ticket-5", "ticket-6"],
    "tickets must complete in the order they joined",
  );
  for (let index = 1; index < completions.length; index += 1) {
    assert.ok(
      completions[index].day >= completions[index - 1].day,
      "a later ticket must never finish on an earlier day",
    );
  }
  assert.equal(totalReleasedSats, queue.enqueuedSats, "every satoshi owed is eventually paid");
  assert.equal(queue.releasedSats, queue.enqueuedSats);
});
