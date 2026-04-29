import assert from "node:assert/strict";
import test from "node:test";

import {
  OrecartQueueError,
  advance,
  createQueue,
  enqueue,
  enqueueMany,
  queueDepth,
} from "../src/index.js";
import { NOW, SIX_TICKETS, SIX_TICKETS_TOTAL_BTC, loadedQueue } from "./fixtures.js";

test("an empty queue reports nothing outstanding", () => {
  const depth = queueDepth(createQueue());
  assert.equal(depth.ticketCount, 0);
  assert.equal(depth.totalOutstandingBtc, 0);
  assert.equal(depth.headTicket, null);
  assert.equal(depth.longestWaitDays, null);
});

test("enqueue assigns sequence numbers and preserves arrival order", () => {
  const queue = loadedQueue();
  assert.deepEqual(
    queue.tickets.map((ticket) => ticket.seq),
    [1, 2, 3, 4, 5, 6],
  );
  assert.deepEqual(
    queue.tickets.map((ticket) => ticket.id),
    SIX_TICKETS.map((ticket) => ticket.id),
  );
  assert.equal(queue.nextSeq, 7);
});

test("enqueue leaves the input queue untouched", () => {
  const queue = createQueue();
  const snapshot = JSON.stringify(queue);
  const next = enqueue(queue, SIX_TICKETS[0]);
  assert.equal(JSON.stringify(queue), snapshot);
  assert.equal(next.tickets.length, 1);
  assert.equal(queue.tickets.length, 0);
});

test("queue depth reports outstanding capital, the head and its wait", () => {
  const depth = queueDepth(loadedQueue(), NOW);

  assert.equal(depth.ticketCount, 6);
  assert.equal(depth.totalOutstandingBtc, SIX_TICKETS_TOTAL_BTC);
  assert.equal(depth.enqueuedBtc, SIX_TICKETS_TOTAL_BTC);
  assert.equal(depth.releasedBtc, 0);
  assert.ok(depth.headTicket);
  assert.equal(depth.headTicket.id, "ticket-1");
  assert.equal(depth.headTicket.remainingBtc, 0.75);
  assert.equal(depth.longestWaitDays, 5, "ticket-1 was requested five days before now");
});

test("queue depth tracks partial settlement", () => {
  const result = advance(loadedQueue(), { now: NOW, availableLiquidityBtc: 1.5 });
  const depth = queueDepth(result.queue, NOW);

  assert.equal(depth.ticketCount, 5);
  assert.equal(depth.releasedTicketCount, 1);
  assert.equal(depth.partiallyFilledCount, 1);
  assert.equal(depth.releasedBtc, 1.5);
  assert.equal(depth.totalOutstandingBtc, 5.5);
  assert.ok(depth.headTicket);
  assert.equal(depth.headTicket.id, "ticket-2");
  assert.equal(depth.headTicket.remainingBtc, 0.45);
});

test("maxTickets caps how many tickets one pass may touch", () => {
  const result = advance(loadedQueue(), {
    now: NOW,
    availableLiquidityBtc: 100,
    maxTickets: 2,
  });

  assert.deepEqual(
    result.releases.map((entry) => entry.ticketId),
    ["ticket-1", "ticket-2"],
  );
  assert.ok(result.blocked);
  assert.equal(result.blocked.reason, "max-tickets-reached");
  assert.equal(result.blocked.ticketId, "ticket-3");
});

test("a drained queue reports no blocker", () => {
  const result = advance(loadedQueue(), {
    now: "2026-08-20T00:00:00.000Z",
    availableLiquidityBtc: 100,
  });
  assert.equal(result.releases.length, 6);
  assert.equal(result.blocked, null);
  assert.equal(result.releasedBtc, SIX_TICKETS_TOTAL_BTC);
  assert.equal(queueDepth(result.queue).ticketCount, 0);
});

test("advancing a drained queue is a no-op", () => {
  const first = advance(loadedQueue(), {
    now: "2026-08-20T00:00:00.000Z",
    availableLiquidityBtc: 100,
  });
  const second = advance(first.queue, {
    now: "2026-08-21T00:00:00.000Z",
    availableLiquidityBtc: 100,
  });
  assert.equal(second.releases.length, 0);
  assert.equal(second.releasedBtc, 0);
  assert.equal(second.remainingLiquidityBtc, 100);
});

test("zero liquidity releases nothing and names the head as blocked", () => {
  const result = advance(loadedQueue(), { now: NOW, availableLiquidityBtc: 0 });
  assert.equal(result.releases.length, 0);
  assert.ok(result.blocked);
  assert.equal(result.blocked.reason, "insufficient-liquidity");
  assert.equal(result.blocked.ticketId, "ticket-1");
  assert.equal(result.blocked.shortfallBtc, 0.75);
});

test("out of order or duplicate tickets are rejected", () => {
  const queue = loadedQueue();

  assert.throws(
    () => enqueue(queue, SIX_TICKETS[0]),
    (error: unknown) => error instanceof OrecartQueueError && error.code === "DUPLICATE_TICKET",
  );
  assert.throws(
    () =>
      enqueue(queue, {
        id: "ticket-late",
        owner: "owner-z",
        amountBtc: 1,
        requestedAt: "2026-08-01T00:00:00.000Z",
        claimableAt: "2026-08-04T00:00:00.000Z",
      }),
    (error: unknown) => error instanceof OrecartQueueError && error.code === "ORDER_VIOLATION",
  );
  assert.throws(
    () =>
      enqueue(queue, {
        id: "ticket-7",
        owner: "owner-g",
        amountBtc: 1,
        requestedAt: "2026-08-16T00:00:00.000Z",
        claimableAt: "2026-08-15T00:00:00.000Z",
      }),
    (error: unknown) => error instanceof OrecartQueueError && error.code === "INVALID_TIMESTAMP",
  );
  assert.throws(
    () =>
      enqueue(queue, {
        id: "ticket-8",
        owner: "owner-h",
        amountBtc: 0,
        requestedAt: "2026-08-16T00:00:00.000Z",
        claimableAt: "2026-08-19T00:00:00.000Z",
      }),
    (error: unknown) => error instanceof OrecartQueueError && error.code === "INVALID_AMOUNT",
  );
});

test("a queue whose totals disagree with its tickets is rejected", () => {
  const queue = enqueueMany(createQueue(), SIX_TICKETS.slice(0, 2));
  const tampered = { ...queue, enqueuedSats: queue.enqueuedSats + 1 };

  assert.throws(
    () => queueDepth(tampered),
    (error: unknown) => error instanceof OrecartQueueError && error.code === "INVALID_QUEUE",
  );
});

test("negative liquidity is rejected", () => {
  assert.throws(
    () => advance(loadedQueue(), { now: NOW, availableLiquidityBtc: -1 }),
    (error: unknown) => error instanceof OrecartQueueError && error.code === "INVALID_AMOUNT",
  );
  assert.throws(
    () => advance(loadedQueue(), { now: "yesterday", availableLiquidityBtc: 1 }),
    (error: unknown) => error instanceof OrecartQueueError && error.code === "INVALID_TIMESTAMP",
  );
});
