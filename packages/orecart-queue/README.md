# lodz-orecart-queue

The LODZ redemption queue: first in, first out, with the wait and the fee published
before anyone commits.

Deposits are easy everywhere. What separates a yield layer you can leave from one you
cannot is whether the exit is stated up front and then actually enforced. This package
is that enforcement. It answers three questions with the same arithmetic every time:
how long will this redemption wait, what will it cost, and who gets paid next.

Every function is pure. No network, no filesystem, no clock, no random source.
Timestamps arrive as arguments, so a queue replays identically for a given input. A wait
estimate that changed between two calls on the same data would not be a promise anyone
could hold the protocol to.

## Install

```sh
npm install lodz-orecart-queue
```

Node 18 or newer. Ships ESM and CommonJS builds with type declarations for both.

## Invariants

Four properties hold for every input, and each is covered by a test that tries to break
it with generated sequences:

1. **First in, first out.** Once a ticket is not fully settled, no ticket behind it has
   received anything.
2. **Never more than the liquidity supplied.** A pass cannot release more than
   `availableLiquidityBtc`.
3. **Never before `claimableAt`.** The published cooldown is enforced regardless of how
   much liquidity is sitting there.
4. **Total released never exceeds total enqueued.** Amounts are carried as integer
   satoshis internally, so this is exactly true rather than approximately true after a
   few thousand partial fills.

Strict ordering means head-of-line blocking is real: a ticket whose cooldown has not
expired holds up everything behind it. That is the honest behaviour. Stepping over it to
reach a smaller ticket would mean the published queue position was not what determined
who got paid.

## Usage

### Build and advance a queue

```ts
import { advance, createQueue, enqueueMany, queueDepth } from "lodz-orecart-queue";

const queue = enqueueMany(createQueue(), [
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
]);

const result = advance(queue, {
  now: "2026-08-15T00:00:00.000Z",
  availableLiquidityBtc: 1.5,
});

result.releasedBtc; // 1.5
result.releases;    // ticket-1 in full, ticket-2 partially
result.blocked;     // { ticketId: "ticket-2", reason: "insufficient-liquidity", shortfallBtc: 0.45 }
result.queue;       // the new queue; the input is untouched
```

Every operation returns a new value. Nothing is mutated in place, so a caller can hold
on to the pre-advance queue and compare.

Partial settlement is on by default, which keeps capital flowing to the front of the
queue instead of stranding it. Pass `allowPartialFill: false` to require whole tickets,
and `maxTickets` to cap how many tickets one pass may touch.

`result.blocked` always names the ticket that stopped the pass and why:
`not-yet-claimable`, `insufficient-liquidity`, or `max-tickets-reached`. It is `null`
only when the queue drained.

### Estimate a wait before joining

```ts
import { estimateWait } from "lodz-orecart-queue";

const estimate = estimateWait({
  queue,
  amountBtc: 1,
  throughputBtcPerDay: 1.5,
  now: "2026-08-15T00:00:00.000Z",
  cooldownDays: 3,
  throughputVolatilityBps: 2_500,
});

estimate.positionInQueue;   // 7
estimate.btcAhead;          // 7
estimate.expectedWaitDays;  // 5.3333
estimate.lowWaitDays;       // same simulation at throughput +25%
estimate.highWaitDays;      // same simulation at throughput -25%
estimate.expectedCompleteAt;
```

The estimate replays the rule `advance` follows: walk the queue in sequence order,
respect each ticket's cooldown, drain at the declared throughput. A ticket ahead whose
cooldown has not expired pushes the estimate out, because that is what will actually
happen.

The range is the same simulation run at throughput plus and minus the declared
volatility. It is not a statistical confidence interval, and it does not account for
tickets that join after the estimate. `estimate.basis` states this in the returned
object so a caller cannot present it as more than it is.

### Price the exit

```ts
import { redemptionFeeBps, redemptionFeeBreakdown } from "lodz-orecart-queue";

const params = {
  baseFeeBps: 10,
  immediateFeeBps: 200,
  standardWaitDays: 7,
  decayCurve: "linear" as const,
  sizeTiers: [
    { minAmountBtc: 0, surchargeBps: 0 },
    { minAmountBtc: 1, surchargeBps: 15 },
    { minAmountBtc: 5, surchargeBps: 40 },
  ],
  minFeeBps: 5,
  maxFeeBps: 300,
};

redemptionFeeBps({ amountBtc: 1, waitDays: 0, params }); // 225
redemptionFeeBps({ amountBtc: 1, waitDays: 7, params }); // 25
```

The exit premium decays to nothing by the standard wait:

```
wait days   fee bps   base   urgency   size
     0.00       225      10       200      15
     1.00       196      10       171      15
     3.50       125      10       100      15
     7.00        25      10         0      15
    14.00        25      10         0      15
```

Someone leaving immediately is asking the queue to prioritise them over depositors who
accepted the published wait, and the premium is what they pay for that. A longer
accepted wait always costs the same or less, never more.

**No policy constant is hard-coded.** `baseFeeBps`, `immediateFeeBps`, the decay curve,
the size bands and both bounds are all supplied by the caller. These have to match the
on-chain vault parameters exactly, and the program is the authority. A default baked
into this package would be a second source of truth waiting to drift.

`redemptionFeeBreakdown` returns the same number with every component shown separately,
including which bound clipped it, so an interface can explain the charge rather than
just present it.

### Inspect depth

```ts
import { queueDepth } from "lodz-orecart-queue";

const depth = queueDepth(queue, "2026-08-15T00:00:00.000Z");

depth.ticketCount;          // outstanding tickets
depth.totalOutstandingBtc;  // BTC still owed
depth.headTicket;           // longest-waiting ticket, which under FIFO is also next
depth.longestWaitDays;      // 5
depth.partiallyFilledCount;
```

Passing `now` is optional; without it the wait figures come back as `null` rather than
being invented from the system clock.

## Risk

A redemption queue can be slow, and this package makes that slowness visible rather than
removing it. Capital in the vault is exposed to bridge risk, custody risk and the
protocol risk of every venue it sits in. Nothing here is free of risk or assured. A wait
estimate is a projection from the queue's current contents and a declared throughput,
not a commitment. Wrapped and bridged representations of BTC are not bitcoin itself and
carry the risk of whatever issues them.

## API

| Export | Purpose |
| --- | --- |
| `createQueue()` | An empty queue |
| `enqueue(queue, ticket)` | Add one ticket to the back; returns a new queue |
| `enqueueMany(queue, tickets)` | Add several in order |
| `advance(queue, options)` | Settle what liquidity and the clock permit |
| `estimateWait(input)` | Position, BTC ahead, expected wait and its range |
| `redemptionFeeBps(input)` | Fee in basis points |
| `redemptionFeeBreakdown(input)` | The same fee with every component itemised |
| `queueDepth(queue, now?)` | Outstanding size, head ticket, longest wait |
| `assertQueue(queue)` | Validate a queue value that came from storage or an RPC boundary |
| `OrecartQueueError` | Thrown for every rejected input, with a `code` |

## Development

```sh
npm run typecheck   # tsc --noEmit
npm run build       # ESM and CommonJS into dist/
npm test            # node --test
npm run demo        # the worked example in examples/scenario.ts
```

## License

MIT
