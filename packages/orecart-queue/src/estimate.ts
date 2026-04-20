import { fail } from "./errors.js";
import {
  BPS_TOTAL,
  MAX_AMOUNT_BTC,
  btcToSats,
  isBps,
  isNonNegativeNumber,
  isPositiveNumber,
  roundTo,
  satsToBtc,
} from "./math.js";
import { assertQueue } from "./queue.js";
import { addDays, daysBetween, formatTimestamp, parseTimestamp } from "./time.js";
import type { WaitEstimate, WaitEstimateInput } from "./types.js";

/** Widest throughput uncertainty accepted. Beyond this the low bound approaches zero. */
const MAX_VOLATILITY_BPS = 9_000;

const BASIS =
  "Range is the same first-in-first-out simulation run at the declared throughput plus and minus the declared volatility. It is not a statistical confidence interval, and it does not account for tickets that join the queue after this estimate.";

/**
 * Estimate how long a redemption of a given size would wait.
 *
 * The estimate is a replay of the same rule {@link advance} follows: walk the queue in
 * sequence order, respect each ticket's cooldown, and drain at the declared throughput.
 * A ticket ahead whose cooldown has not expired holds up everything behind it, and the
 * estimate says so rather than assuming it can be stepped over.
 */
export function estimateWait(input: WaitEstimateInput): WaitEstimate {
  const { queue, amountBtc, throughputBtcPerDay, now } = input;
  assertQueue(queue);

  if (!isPositiveNumber(amountBtc) || amountBtc > MAX_AMOUNT_BTC) {
    fail("INVALID_AMOUNT", "amountBtc must be greater than 0 and within supply", { amountBtc });
  }
  if (!isPositiveNumber(throughputBtcPerDay)) {
    fail(
      "INVALID_THROUGHPUT",
      "throughputBtcPerDay must be greater than 0; a queue that never drains has no finite wait",
      { throughputBtcPerDay },
    );
  }
  const cooldownDays = input.cooldownDays ?? 0;
  if (!isNonNegativeNumber(cooldownDays)) {
    fail("INVALID_AMOUNT", "cooldownDays must be a non-negative finite number", { cooldownDays });
  }
  const throughputVolatilityBps = input.throughputVolatilityBps ?? 0;
  if (!isBps(throughputVolatilityBps) || throughputVolatilityBps > MAX_VOLATILITY_BPS) {
    fail(
      "INVALID_THROUGHPUT",
      `throughputVolatilityBps must be an integer between 0 and ${MAX_VOLATILITY_BPS}`,
      { throughputVolatilityBps },
    );
  }

  const nowMs = parseTimestamp(now, "now");
  const amountSats = btcToSats(amountBtc);

  const ahead = queue.tickets.filter((ticket) => ticket.status === "queued");
  const aheadSats = ahead.reduce((acc, ticket) => acc + ticket.remainingSats, 0);

  const simulate = (throughputPerDay: number): number => {
    const satsPerDay = throughputPerDay * 100_000_000;
    let days = 0;
    for (const ticket of ahead) {
      const readyDays = Math.max(
        0,
        daysBetween(nowMs, parseTimestamp(ticket.claimableAt, "ticket.claimableAt")),
      );
      days = Math.max(days, readyDays) + ticket.remainingSats / satsPerDay;
    }
    return Math.max(days, cooldownDays) + amountSats / satsPerDay;
  };

  const volatility = throughputVolatilityBps / BPS_TOTAL;
  const fastThroughput = throughputBtcPerDay * (1 + volatility);
  const slowThroughput = throughputBtcPerDay * (1 - volatility);

  const expectedWaitDays = roundTo(simulate(throughputBtcPerDay), 4);
  const lowWaitDays = roundTo(simulate(fastThroughput), 4);
  const highWaitDays = roundTo(simulate(slowThroughput), 4);

  return {
    positionInQueue: ahead.length + 1,
    ticketsAhead: ahead.length,
    btcAhead: satsToBtc(aheadSats),
    amountBtc,
    throughputBtcPerDay,
    cooldownDays,
    expectedWaitDays,
    lowWaitDays,
    highWaitDays,
    throughputVolatilityBps,
    throughputRangeBtcPerDay: {
      low: roundTo(slowThroughput, 8),
      high: roundTo(fastThroughput, 8),
    },
    expectedClaimableAt: formatTimestamp(addDays(nowMs, cooldownDays)),
    expectedCompleteAt: formatTimestamp(addDays(nowMs, expectedWaitDays)),
    basis: BASIS,
  };
}
