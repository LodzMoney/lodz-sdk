import { fail } from "./errors.js";
import {
  MAX_AMOUNT_BTC,
  btcToSats,
  isNonNegativeInteger,
  isNonNegativeNumber,
  isObject,
  isPositiveNumber,
  satsToBtc,
} from "./math.js";
import { daysBetween, parseTimestamp } from "./time.js";
import type {
  AdvanceOptions,
  AdvanceResult,
  OrecartQueue,
  QueueBlock,
  QueueDepth,
  QueueHead,
  RedemptionTicket,
  ReleaseEvent,
  TicketInput,
} from "./types.js";

function buildTicket(
  base: Omit<
    RedemptionTicket,
    "amountBtc" | "releasedBtc" | "remainingSats" | "remainingBtc" | "status"
  >,
): RedemptionTicket {
  const remainingSats = base.amountSats - base.releasedSats;
  return {
    id: base.id,
    owner: base.owner,
    seq: base.seq,
    amountSats: base.amountSats,
    amountBtc: satsToBtc(base.amountSats),
    releasedSats: base.releasedSats,
    releasedBtc: satsToBtc(base.releasedSats),
    remainingSats,
    remainingBtc: satsToBtc(remainingSats),
    requestedAt: base.requestedAt,
    claimableAt: base.claimableAt,
    status: remainingSats === 0 ? "released" : "queued",
    releasedAt: base.releasedAt,
  };
}

/** An empty queue. */
export function createQueue(): OrecartQueue {
  return { tickets: [], nextSeq: 1, enqueuedSats: 0, releasedSats: 0 };
}

/**
 * Check that a queue value is internally consistent.
 *
 * Called at the entry of every public function. Queue state can arrive from storage or
 * across an RPC boundary, and a queue whose totals do not match its tickets would
 * silently corrupt every wait estimate computed from it.
 */
export function assertQueue(queue: OrecartQueue): void {
  if (!isObject(queue)) {
    fail("INVALID_QUEUE", "queue must be an object");
  }
  if (!Array.isArray(queue.tickets)) {
    fail("INVALID_QUEUE", "queue.tickets must be an array");
  }
  if (!isNonNegativeInteger(queue.nextSeq) || queue.nextSeq < 1) {
    fail("INVALID_QUEUE", "queue.nextSeq must be an integer of at least 1");
  }

  let enqueued = 0;
  let released = 0;
  let previousSeq = 0;
  const seen = new Set<string>();

  for (let index = 0; index < queue.tickets.length; index += 1) {
    const ticket = queue.tickets[index];
    const at = `queue.tickets[${index}]`;
    if (!isObject(ticket)) {
      fail("INVALID_QUEUE", `${at} must be an object`);
    }
    if (typeof ticket.id !== "string" || ticket.id.length === 0) {
      fail("INVALID_QUEUE", `${at}.id must be a non-empty string`);
    }
    if (seen.has(ticket.id)) {
      fail("DUPLICATE_TICKET", `${at}.id "${ticket.id}" appears more than once`);
    }
    seen.add(ticket.id);
    if (!isNonNegativeInteger(ticket.seq) || ticket.seq <= previousSeq) {
      fail("ORDER_VIOLATION", `${at}.seq must increase strictly along the queue`, {
        id: ticket.id,
        seq: ticket.seq,
        previousSeq,
      });
    }
    previousSeq = ticket.seq;
    if (!isNonNegativeInteger(ticket.amountSats) || ticket.amountSats <= 0) {
      fail("INVALID_TICKET", `${at}.amountSats must be a positive integer`, { id: ticket.id });
    }
    if (!isNonNegativeInteger(ticket.releasedSats) || ticket.releasedSats > ticket.amountSats) {
      fail("INVALID_TICKET", `${at}.releasedSats must be between 0 and amountSats`, {
        id: ticket.id,
      });
    }
    parseTimestamp(ticket.requestedAt, `${at}.requestedAt`);
    parseTimestamp(ticket.claimableAt, `${at}.claimableAt`);
    enqueued += ticket.amountSats;
    released += ticket.releasedSats;
  }

  if (queue.nextSeq <= previousSeq) {
    fail("INVALID_QUEUE", "queue.nextSeq must be greater than every ticket sequence");
  }
  if (queue.enqueuedSats !== enqueued) {
    fail("INVALID_QUEUE", "queue.enqueuedSats does not match the sum of its tickets", {
      declared: queue.enqueuedSats,
      actual: enqueued,
    });
  }
  if (queue.releasedSats !== released) {
    fail("INVALID_QUEUE", "queue.releasedSats does not match the sum of its tickets", {
      declared: queue.releasedSats,
      actual: released,
    });
  }
}

/**
 * Add a ticket to the back of the queue.
 *
 * Returns a new queue; the input is left untouched. Requests must arrive in
 * non-decreasing time order, which is what makes the sequence number and the wall clock
 * agree and lets a FIFO guarantee mean something.
 */
export function enqueue(queue: OrecartQueue, ticket: TicketInput): OrecartQueue {
  assertQueue(queue);

  if (!isObject(ticket)) {
    fail("INVALID_TICKET", "ticket must be an object");
  }
  if (typeof ticket.id !== "string" || ticket.id.length === 0) {
    fail("INVALID_TICKET", "ticket.id must be a non-empty string");
  }
  if (typeof ticket.owner !== "string" || ticket.owner.length === 0) {
    fail("INVALID_TICKET", "ticket.owner must be a non-empty string", { id: ticket.id });
  }
  if (queue.tickets.some((existing) => existing.id === ticket.id)) {
    fail("DUPLICATE_TICKET", `ticket "${ticket.id}" is already in the queue`, { id: ticket.id });
  }
  if (!isPositiveNumber(ticket.amountBtc) || ticket.amountBtc > MAX_AMOUNT_BTC) {
    fail("INVALID_AMOUNT", "ticket.amountBtc must be greater than 0 and within supply", {
      id: ticket.id,
      amountBtc: ticket.amountBtc,
    });
  }

  const requestedAtMs = parseTimestamp(ticket.requestedAt, "ticket.requestedAt");
  const claimableAtMs = parseTimestamp(ticket.claimableAt, "ticket.claimableAt");
  if (claimableAtMs < requestedAtMs) {
    fail("INVALID_TIMESTAMP", "ticket.claimableAt must not precede ticket.requestedAt", {
      id: ticket.id,
    });
  }

  const last = queue.tickets[queue.tickets.length - 1];
  if (last !== undefined) {
    const lastRequestedAtMs = parseTimestamp(last.requestedAt, "queue tail requestedAt");
    if (requestedAtMs < lastRequestedAtMs) {
      fail("ORDER_VIOLATION", "ticket.requestedAt precedes the ticket already at the back", {
        id: ticket.id,
        requestedAt: ticket.requestedAt,
        tailRequestedAt: last.requestedAt,
      });
    }
  }

  const amountSats = btcToSats(ticket.amountBtc);
  if (amountSats <= 0) {
    fail("INVALID_AMOUNT", "ticket.amountBtc rounds to zero satoshis", {
      id: ticket.id,
      amountBtc: ticket.amountBtc,
    });
  }

  const appended = buildTicket({
    id: ticket.id,
    owner: ticket.owner,
    seq: queue.nextSeq,
    amountSats,
    releasedSats: 0,
    requestedAt: ticket.requestedAt,
    claimableAt: ticket.claimableAt,
    releasedAt: null,
  });

  return {
    tickets: [...queue.tickets, appended],
    nextSeq: queue.nextSeq + 1,
    enqueuedSats: queue.enqueuedSats + amountSats,
    releasedSats: queue.releasedSats,
  };
}

/** Add several tickets in order. */
export function enqueueMany(
  queue: OrecartQueue,
  tickets: readonly TicketInput[],
): OrecartQueue {
  let next = queue;
  for (const ticket of tickets) next = enqueue(next, ticket);
  return next;
}

/**
 * Settle as much of the queue as the available liquidity and the clock permit.
 *
 * Strictly first in, first out. The pass stops at the first ticket that cannot be
 * settled, and it does not step over that ticket to reach a smaller one behind it.
 * Head-of-line blocking is the honest behaviour here: skipping ahead would mean the
 * published queue position was not the thing that determined who got paid.
 *
 * Three properties hold for every input:
 *
 * - nothing is released before its `claimableAt`;
 * - nothing is released beyond `availableLiquidityBtc`;
 * - total released never exceeds total enqueued.
 */
export function advance(queue: OrecartQueue, options: AdvanceOptions): AdvanceResult {
  assertQueue(queue);

  if (!isObject(options)) {
    fail("INVALID_QUEUE", "options must be an object");
  }
  const nowMs = parseTimestamp(options.now, "options.now");
  if (!isNonNegativeNumber(options.availableLiquidityBtc)) {
    fail("INVALID_AMOUNT", "options.availableLiquidityBtc must be a non-negative finite number", {
      availableLiquidityBtc: options.availableLiquidityBtc,
    });
  }
  if (options.availableLiquidityBtc > MAX_AMOUNT_BTC) {
    fail("INVALID_AMOUNT", "options.availableLiquidityBtc must be within supply");
  }
  if (options.maxTickets !== undefined && (!isNonNegativeInteger(options.maxTickets) || options.maxTickets < 1)) {
    fail("INVALID_QUEUE", "options.maxTickets must be an integer of at least 1", {
      maxTickets: options.maxTickets,
    });
  }

  const allowPartialFill = options.allowPartialFill ?? true;
  let liquiditySats = btcToSats(options.availableLiquidityBtc);
  const startingLiquiditySats = liquiditySats;

  const tickets = [...queue.tickets];
  const releases: ReleaseEvent[] = [];
  let blocked: QueueBlock | null = null;
  let touched = 0;

  for (let index = 0; index < tickets.length; index += 1) {
    const ticket = tickets[index];
    if (ticket.status === "released") continue;

    if (options.maxTickets !== undefined && touched >= options.maxTickets) {
      blocked = {
        ticketId: ticket.id,
        seq: ticket.seq,
        reason: "max-tickets-reached",
        claimableAt: ticket.claimableAt,
        shortfallBtc: 0,
      };
      break;
    }

    const claimableAtMs = parseTimestamp(ticket.claimableAt, `queue.tickets[${index}].claimableAt`);
    if (claimableAtMs > nowMs) {
      blocked = {
        ticketId: ticket.id,
        seq: ticket.seq,
        reason: "not-yet-claimable",
        claimableAt: ticket.claimableAt,
        shortfallBtc: 0,
      };
      break;
    }

    if (liquiditySats <= 0) {
      blocked = {
        ticketId: ticket.id,
        seq: ticket.seq,
        reason: "insufficient-liquidity",
        claimableAt: ticket.claimableAt,
        shortfallBtc: satsToBtc(ticket.remainingSats),
      };
      break;
    }

    const fillSats = Math.min(ticket.remainingSats, liquiditySats);
    if (fillSats < ticket.remainingSats && !allowPartialFill) {
      blocked = {
        ticketId: ticket.id,
        seq: ticket.seq,
        reason: "insufficient-liquidity",
        claimableAt: ticket.claimableAt,
        shortfallBtc: satsToBtc(ticket.remainingSats - liquiditySats),
      };
      break;
    }

    const releasedSats = ticket.releasedSats + fillSats;
    const full = releasedSats === ticket.amountSats;
    tickets[index] = buildTicket({
      id: ticket.id,
      owner: ticket.owner,
      seq: ticket.seq,
      amountSats: ticket.amountSats,
      releasedSats,
      requestedAt: ticket.requestedAt,
      claimableAt: ticket.claimableAt,
      releasedAt: full ? options.now : ticket.releasedAt,
    });

    releases.push({
      ticketId: ticket.id,
      owner: ticket.owner,
      seq: ticket.seq,
      amountSats: fillSats,
      amountBtc: satsToBtc(fillSats),
      full,
      releasedAt: options.now,
    });

    liquiditySats -= fillSats;
    touched += 1;

    if (!full) {
      blocked = {
        ticketId: ticket.id,
        seq: ticket.seq,
        reason: "insufficient-liquidity",
        claimableAt: ticket.claimableAt,
        shortfallBtc: satsToBtc(ticket.amountSats - releasedSats),
      };
      break;
    }
  }

  const releasedSats = startingLiquiditySats - liquiditySats;

  return {
    queue: {
      tickets,
      nextSeq: queue.nextSeq,
      enqueuedSats: queue.enqueuedSats,
      releasedSats: queue.releasedSats + releasedSats,
    },
    releases,
    releasedBtc: satsToBtc(releasedSats),
    releasedSats,
    remainingLiquidityBtc: satsToBtc(liquiditySats),
    remainingLiquiditySats: liquiditySats,
    blocked,
    at: options.now,
  };
}

/** Outstanding size and shape of the queue. */
export function queueDepth(queue: OrecartQueue, now?: string): QueueDepth {
  assertQueue(queue);
  const nowMs = now === undefined ? null : parseTimestamp(now, "now");

  let outstandingSats = 0;
  let ticketCount = 0;
  let releasedTicketCount = 0;
  let partiallyFilledCount = 0;
  let head: QueueHead | null = null;

  for (const ticket of queue.tickets) {
    if (ticket.status === "released") {
      releasedTicketCount += 1;
      continue;
    }
    ticketCount += 1;
    outstandingSats += ticket.remainingSats;
    if (ticket.releasedSats > 0) partiallyFilledCount += 1;
    if (head === null) {
      head = {
        id: ticket.id,
        seq: ticket.seq,
        owner: ticket.owner,
        remainingBtc: ticket.remainingBtc,
        requestedAt: ticket.requestedAt,
        claimableAt: ticket.claimableAt,
        waitingDays:
          nowMs === null
            ? null
            : Math.max(0, daysBetween(parseTimestamp(ticket.requestedAt, "requestedAt"), nowMs)),
      };
    }
  }

  return {
    ticketCount,
    totalOutstandingBtc: satsToBtc(outstandingSats),
    totalOutstandingSats: outstandingSats,
    enqueuedBtc: satsToBtc(queue.enqueuedSats),
    enqueuedSats: queue.enqueuedSats,
    releasedBtc: satsToBtc(queue.releasedSats),
    releasedSats: queue.releasedSats,
    releasedTicketCount,
    partiallyFilledCount,
    headTicket: head,
    longestWaitDays: head?.waitingDays ?? null,
  };
}
