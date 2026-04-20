/**
 * lodz-orecart-queue
 *
 * The LODZ redemption queue.
 *
 * Deposits are easy everywhere. What separates an honest yield layer from a trap is
 * whether the exit is stated up front and then enforced. This package publishes the
 * wait and the fee before a depositor commits, and settles strictly first in, first
 * out afterwards.
 *
 * Every function is pure: no network, no filesystem, no clock, no random source.
 * Timestamps arrive as arguments, so a queue replays identically for a given input.
 */

export { advance, assertQueue, createQueue, enqueue, enqueueMany, queueDepth } from "./queue.js";
export { estimateWait } from "./estimate.js";
export { redemptionFeeBps, redemptionFeeBreakdown } from "./fees.js";

export { OrecartQueueError } from "./errors.js";
export type { OrecartQueueErrorCode } from "./errors.js";

export { BPS_TOTAL, MAX_AMOUNT_BTC, SATS_PER_BTC, btcToSats, satsToBtc } from "./math.js";

export type {
  AdvanceOptions,
  AdvanceResult,
  BlockReason,
  OrecartQueue,
  QueueBlock,
  QueueDepth,
  QueueHead,
  RedemptionFeeBreakdown,
  RedemptionFeeInput,
  RedemptionFeeParams,
  RedemptionFeeTier,
  RedemptionTicket,
  ReleaseEvent,
  StopeProfile,
  TicketInput,
  TicketStatus,
  WaitEstimate,
  WaitEstimateInput,
} from "./types.js";
