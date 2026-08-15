/**
 * Worked example: six redemption tickets against a daily throughput limit.
 *
 * Drains the queue one day at a time, records when each ticket is settled, and checks
 * that settlement order matches arrival order. Then prices the exit for a depositor
 * deciding how long to wait.
 *
 * Run with: npm run demo
 */
import {
  advance,
  createQueue,
  enqueueMany,
  estimateWait,
  queueDepth,
  redemptionFeeBreakdown,
} from "../src/index.js";
import type { OrecartQueue, RedemptionFeeParams, TicketInput } from "../src/index.js";

const NOW = "2026-08-15T00:00:00.000Z";
const MS_PER_DAY = 86_400_000;
const THROUGHPUT_BTC_PER_DAY = 1.5;

function isoAfterDays(baseIso: string, days: number): string {
  return new Date(Date.parse(baseIso) + Math.round(days * MS_PER_DAY)).toISOString();
}

const TICKETS: TicketInput[] = [
  { id: "ticket-1", owner: "owner-a", amountBtc: 0.75, requestedAt: "2026-08-10T00:00:00.000Z", claimableAt: "2026-08-13T00:00:00.000Z" },
  { id: "ticket-2", owner: "owner-b", amountBtc: 1.2, requestedAt: "2026-08-11T00:00:00.000Z", claimableAt: "2026-08-14T00:00:00.000Z" },
  { id: "ticket-3", owner: "owner-c", amountBtc: 0.4, requestedAt: "2026-08-12T00:00:00.000Z", claimableAt: "2026-08-15T00:00:00.000Z" },
  { id: "ticket-4", owner: "owner-d", amountBtc: 2.5, requestedAt: "2026-08-13T00:00:00.000Z", claimableAt: "2026-08-16T00:00:00.000Z" },
  { id: "ticket-5", owner: "owner-e", amountBtc: 0.85, requestedAt: "2026-08-14T00:00:00.000Z", claimableAt: "2026-08-17T00:00:00.000Z" },
  { id: "ticket-6", owner: "owner-f", amountBtc: 1.3, requestedAt: "2026-08-15T00:00:00.000Z", claimableAt: "2026-08-18T00:00:00.000Z" },
];

const FEE_PARAMS: RedemptionFeeParams = {
  baseFeeBps: 10,
  immediateFeeBps: 200,
  standardWaitDays: 7,
  decayCurve: "linear",
  sizeTiers: [
    { minAmountBtc: 0, surchargeBps: 0 },
    { minAmountBtc: 1, surchargeBps: 15 },
    { minAmountBtc: 5, surchargeBps: 40 },
  ],
  utilizationSurchargeBps: 0,
  minFeeBps: 5,
  maxFeeBps: 300,
};

let queue: OrecartQueue = enqueueMany(createQueue(), TICKETS);

console.log(`LODZ redemption queue, valuation time ${NOW}`);
console.log(`Throughput limit ${THROUGHPUT_BTC_PER_DAY} BTC per day. Cooldown three days per ticket.`);

const opening = queueDepth(queue, NOW);
console.log(
  `\nOpening depth: ${opening.ticketCount} tickets, ${opening.totalOutstandingBtc} BTC outstanding, head ${opening.headTicket?.id} waiting ${opening.longestWaitDays} days`,
);

console.log("\n=== PROJECTED WAIT PER TICKET, BEFORE ANY SETTLEMENT ===");
console.log("ticket    owner     BTC     claimable at              position   projected wait");
let projectionQueue = createQueue();
for (const ticket of TICKETS) {
  const cooldownDays = (Date.parse(ticket.claimableAt) - Date.parse(NOW)) / MS_PER_DAY;
  const estimate = estimateWait({
    queue: projectionQueue,
    amountBtc: ticket.amountBtc,
    throughputBtcPerDay: THROUGHPUT_BTC_PER_DAY,
    now: NOW,
    cooldownDays: Math.max(0, cooldownDays),
  });
  console.log(
    [
      ticket.id.padEnd(9),
      ticket.owner.padEnd(9),
      ticket.amountBtc.toFixed(2).padStart(5),
      `   ${ticket.claimableAt}`,
      String(estimate.positionInQueue).padStart(9),
      `${estimate.expectedWaitDays.toFixed(4).padStart(10)} days`,
    ].join(" "),
  );
  projectionQueue = enqueueMany(projectionQueue, [ticket]);
}

console.log("\n=== DAILY DRAIN ===");
console.log("day  released BTC  events                                        blocked by");
const completions: Array<{ ticketId: string; seq: number; day: number }> = [];
let totalReleasedBtc = 0;

for (let day = 0; day <= 10; day += 1) {
  const at = isoAfterDays(NOW, day);
  const result = advance(queue, { now: at, availableLiquidityBtc: THROUGHPUT_BTC_PER_DAY });
  queue = result.queue;
  totalReleasedBtc += result.releasedBtc;

  for (const release of result.releases) {
    if (release.full) completions.push({ ticketId: release.ticketId, seq: release.seq, day });
  }

  const events =
    result.releases
      .map((release) => `${release.ticketId} ${release.amountBtc.toFixed(4)}${release.full ? " full" : " part"}`)
      .join(", ") || "none";
  const blocked = result.blocked === null ? "queue drained" : `${result.blocked.ticketId} (${result.blocked.reason})`;
  console.log(
    [String(day).padStart(3), result.releasedBtc.toFixed(4).padStart(13), ` ${events.padEnd(44)}`, blocked].join(" "),
  );

  if (queueDepth(queue).ticketCount === 0) break;
}

console.log("\n=== SETTLEMENT ORDER ===");
console.log("ticket    seq  settled on day");
let fifoHeld = true;
for (let index = 0; index < completions.length; index += 1) {
  const entry = completions[index];
  const previous = completions[index - 1];
  if (previous !== undefined && (entry.seq < previous.seq || entry.day < previous.day)) fifoHeld = false;
  console.log(`${entry.ticketId.padEnd(9)} ${String(entry.seq).padStart(3)}  ${String(entry.day).padStart(13)}`);
}
console.log(
  `arrival order: ${TICKETS.map((ticket) => ticket.id).join(" ")}\nsettled order: ${completions.map((entry) => entry.ticketId).join(" ")}`,
);
console.log(`FIFO respected: ${fifoHeld ? "PASS" : "FAIL"}`);
console.log(
  `total released ${totalReleasedBtc.toFixed(8)} BTC of ${TICKETS.reduce((acc, ticket) => acc + ticket.amountBtc, 0).toFixed(8)} BTC enqueued`,
);
console.log(`released never exceeded enqueued: ${queue.releasedSats <= queue.enqueuedSats ? "PASS" : "FAIL"}`);

console.log("\n=== EXIT PRICE BY ACCEPTED WAIT, 1.00 BTC ===");
console.log("wait days   fee bps   base   urgency   size   fee BTC      net BTC");
for (const waitDays of [0, 1, 2, 3.5, 5, 7, 14]) {
  const breakdown = redemptionFeeBreakdown({ amountBtc: 1, waitDays, params: FEE_PARAMS });
  console.log(
    [
      waitDays.toFixed(2).padStart(9),
      String(breakdown.feeBps).padStart(9),
      String(breakdown.baseFeeBps).padStart(7),
      String(breakdown.urgencyFeeBps).padStart(9),
      String(breakdown.sizeSurchargeBps).padStart(7),
      breakdown.feeBtc.toFixed(8).padStart(12),
      breakdown.netBtc.toFixed(8).padStart(12),
    ].join(" "),
  );
}
