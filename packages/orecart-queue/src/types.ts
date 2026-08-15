/**
 * Types for the LODZ redemption queue.
 *
 * The shared domain vocabulary (`YieldKind`, `RiskTier`, `StopeProfile`, `Seam`) lives
 * in `@lodz/assay-engine`. The queue does not need those types: a redemption ticket is
 * about principal leaving, not about where the yield came from. `StopeProfile` is
 * mirrored here only so callers can key queue parameters by vault posture.
 *
 * `StopeProfile` is also re-exported from `@lodz/assay-engine`. The mirror stays here so
 * a types-only overlap costs this package no runtime dependency.
 */

/** Depositor-selected vault posture. */
export type StopeProfile = "conservative" | "balanced" | "aggressive";

/** Lifecycle of a redemption ticket. Tickets are never removed, only settled. */
export type TicketStatus = "queued" | "released";

/** What a caller supplies when joining the queue. */
export interface TicketInput {
  id: string;
  owner: string;
  /** Principal being redeemed, in BTC. Must be greater than zero. */
  amountBtc: number;
  /** ISO-8601 timestamp the request was made. Must not precede the previous ticket. */
  requestedAt: string;
  /**
   * ISO-8601 timestamp before which this ticket cannot be released, whatever the
   * liquidity situation. This is the published cooldown, and it is enforced.
   */
  claimableAt: string;
}

/**
 * A ticket in the queue.
 *
 * Satoshi fields are canonical; the BTC fields are derived from them. Working in
 * integers is what keeps `released <= enqueued` exactly true instead of approximately
 * true after a few thousand partial fills.
 */
export interface RedemptionTicket {
  readonly id: string;
  readonly owner: string;
  /** Position in the queue. Assigned on enqueue and never changed. */
  readonly seq: number;
  readonly amountSats: number;
  readonly amountBtc: number;
  readonly releasedSats: number;
  readonly releasedBtc: number;
  readonly remainingSats: number;
  readonly remainingBtc: number;
  readonly requestedAt: string;
  readonly claimableAt: string;
  readonly status: TicketStatus;
  /** Set when the ticket is fully settled. */
  readonly releasedAt: string | null;
}

/** The queue itself. Every operation returns a new value; nothing is mutated in place. */
export interface OrecartQueue {
  readonly tickets: readonly RedemptionTicket[];
  readonly nextSeq: number;
  readonly enqueuedSats: number;
  readonly releasedSats: number;
}

// ---------------------------------------------------------------------------
// Advancing the queue
// ---------------------------------------------------------------------------

export interface AdvanceOptions {
  /** ISO-8601 timestamp to evaluate against. Supplied by the caller, never read from the clock. */
  now: string;
  /** Liquidity available to settle redemptions on this pass, in BTC. */
  availableLiquidityBtc: number;
  /**
   * Whether the head ticket may be settled partially when liquidity runs out.
   * Defaults to true. Partial settlement keeps capital flowing to the front of the
   * queue instead of stranding it.
   */
  allowPartialFill?: boolean;
  /** Optional ceiling on how many tickets one pass may touch. */
  maxTickets?: number;
}

export interface ReleaseEvent {
  ticketId: string;
  owner: string;
  seq: number;
  amountSats: number;
  amountBtc: number;
  /** True when this release settled the ticket in full. */
  full: boolean;
  releasedAt: string;
}

/** Why the queue stopped advancing. */
export type BlockReason =
  | "not-yet-claimable"
  | "insufficient-liquidity"
  | "max-tickets-reached";

export interface QueueBlock {
  ticketId: string;
  seq: number;
  reason: BlockReason;
  claimableAt: string;
  /** BTC still needed to settle the blocking ticket. Zero when the block is time-based. */
  shortfallBtc: number;
}

export interface AdvanceResult {
  queue: OrecartQueue;
  releases: ReleaseEvent[];
  releasedBtc: number;
  releasedSats: number;
  remainingLiquidityBtc: number;
  remainingLiquiditySats: number;
  /** The ticket that stopped the pass, or null when the queue drained. */
  blocked: QueueBlock | null;
  at: string;
}

// ---------------------------------------------------------------------------
// Wait estimation
// ---------------------------------------------------------------------------

export interface WaitEstimateInput {
  queue: OrecartQueue;
  /** Size of the redemption being considered, in BTC. */
  amountBtc: number;
  /** Sustained settlement capacity, in BTC per day. Must be greater than zero. */
  throughputBtcPerDay: number;
  now: string;
  /** Cooldown applied to the new ticket before it can be released. Defaults to 0. */
  cooldownDays?: number;
  /**
   * Declared uncertainty in throughput, in basis points. The reported range is the
   * same simulation run at throughput plus and minus this fraction. Defaults to 0.
   */
  throughputVolatilityBps?: number;
}

export interface WaitEstimate {
  /** 1 means this redemption would be served first. */
  positionInQueue: number;
  ticketsAhead: number;
  btcAhead: number;
  amountBtc: number;
  throughputBtcPerDay: number;
  cooldownDays: number;
  expectedWaitDays: number;
  lowWaitDays: number;
  highWaitDays: number;
  throughputVolatilityBps: number;
  throughputRangeBtcPerDay: { low: number; high: number };
  /** Earliest the new ticket could be released, ignoring the queue ahead of it. */
  expectedClaimableAt: string;
  /** When the redemption is expected to be settled in full. */
  expectedCompleteAt: string;
  /** Plain statement of what the range does and does not mean. */
  basis: string;
}

// ---------------------------------------------------------------------------
// Redemption fee
// ---------------------------------------------------------------------------

export interface RedemptionFeeTier {
  /** Lowest redemption size this tier applies to, in BTC. */
  minAmountBtc: number;
  surchargeBps: number;
}

/**
 * Fee policy.
 *
 * Nothing here has a default baked into the code. These values have to match the
 * on-chain vault parameters, and the program is the authority, so they are always
 * supplied by the caller.
 */
export interface RedemptionFeeParams {
  /** Charged on every redemption regardless of timing. */
  baseFeeBps: number;
  /** Additional charge for an immediate exit, decaying to zero as the wait lengthens. */
  immediateFeeBps: number;
  /** Wait at which the urgency charge reaches zero under the linear curve. */
  standardWaitDays: number;
  decayCurve: "linear" | "exponential";
  /** Required when `decayCurve` is "exponential". */
  decayHalfLifeDays?: number;
  /** Size bands, applied by the highest band the redemption qualifies for. */
  sizeTiers?: readonly RedemptionFeeTier[];
  /** Extra charge reflecting how drained the queue currently is. */
  utilizationSurchargeBps?: number;
  minFeeBps: number;
  maxFeeBps: number;
}

export interface RedemptionFeeInput {
  amountBtc: number;
  /** Days the redeemer is willing to wait. Longer waits pay less. */
  waitDays: number;
  params: RedemptionFeeParams;
}

export interface RedemptionFeeBreakdown {
  feeBps: number;
  feeBtc: number;
  feeSats: number;
  netBtc: number;
  netSats: number;
  baseFeeBps: number;
  urgencyFeeBps: number;
  sizeSurchargeBps: number;
  utilizationSurchargeBps: number;
  /** 1 at an immediate exit, 0 once the standard wait is met. */
  urgency: number;
  /** Which bound clipped the result, if either did. */
  clampedBy: "min" | "max" | null;
}

// ---------------------------------------------------------------------------
// Queue depth
// ---------------------------------------------------------------------------

export interface QueueHead {
  id: string;
  seq: number;
  owner: string;
  remainingBtc: number;
  requestedAt: string;
  claimableAt: string;
  /** Days this ticket has been waiting. Null unless `now` was supplied. */
  waitingDays: number | null;
}

export interface QueueDepth {
  /** Tickets still owed something. */
  ticketCount: number;
  totalOutstandingBtc: number;
  totalOutstandingSats: number;
  enqueuedBtc: number;
  enqueuedSats: number;
  releasedBtc: number;
  releasedSats: number;
  releasedTicketCount: number;
  partiallyFilledCount: number;
  /** The longest-waiting outstanding ticket, which under FIFO is also the next to be served. */
  headTicket: QueueHead | null;
  /** Days the head ticket has been waiting. Null unless `now` was supplied. */
  longestWaitDays: number | null;
}
