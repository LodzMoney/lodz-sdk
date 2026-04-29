import { createQueue, enqueueMany } from "../src/index.js";
import type { OrecartQueue, RedemptionFeeParams, TicketInput } from "../src/index.js";

export const NOW = "2026-08-15T00:00:00.000Z";

/** Six redemption requests, one per day, each with a three day cooldown. */
export const SIX_TICKETS: TicketInput[] = [
  {
    id: "ticket-1",
    owner: "owner-a",
    amountBtc: 0.75,
    requestedAt: "2026-08-10T00:00:00.000Z",
    claimableAt: "2026-08-13T00:00:00.000Z",
  },
  {
    id: "ticket-2",
    owner: "owner-b",
    amountBtc: 1.2,
    requestedAt: "2026-08-11T00:00:00.000Z",
    claimableAt: "2026-08-14T00:00:00.000Z",
  },
  {
    id: "ticket-3",
    owner: "owner-c",
    amountBtc: 0.4,
    requestedAt: "2026-08-12T00:00:00.000Z",
    claimableAt: "2026-08-15T00:00:00.000Z",
  },
  {
    id: "ticket-4",
    owner: "owner-d",
    amountBtc: 2.5,
    requestedAt: "2026-08-13T00:00:00.000Z",
    claimableAt: "2026-08-16T00:00:00.000Z",
  },
  {
    id: "ticket-5",
    owner: "owner-e",
    amountBtc: 0.85,
    requestedAt: "2026-08-14T00:00:00.000Z",
    claimableAt: "2026-08-17T00:00:00.000Z",
  },
  {
    id: "ticket-6",
    owner: "owner-f",
    amountBtc: 1.3,
    requestedAt: "2026-08-15T00:00:00.000Z",
    claimableAt: "2026-08-18T00:00:00.000Z",
  },
];

/** Total outstanding across the six tickets, in BTC. */
export const SIX_TICKETS_TOTAL_BTC = 7;

/** Settlement capacity, in BTC per day. */
export const THROUGHPUT_BTC_PER_DAY = 1.5;

export function loadedQueue(): OrecartQueue {
  return enqueueMany(createQueue(), SIX_TICKETS);
}

/**
 * Fee policy used across the tests.
 *
 * These are illustrative values. In production the policy comes from the on-chain vault
 * parameters, which is why nothing in the package carries a default.
 */
export const FEE_PARAMS: RedemptionFeeParams = {
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

/**
 * Deterministic pseudo-random source for property tests. A linear congruential
 * generator is used instead of Math.random so a failing case can be reproduced from
 * its seed.
 */
export function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4_294_967_296;
  };
}

export const MS_PER_DAY = 86_400_000;

export function isoAfterDays(baseIso: string, days: number): string {
  return new Date(Date.parse(baseIso) + Math.round(days * MS_PER_DAY)).toISOString();
}
