# @lodz/seam-router

Deterministic capital routing across BTC yield seams on Solana.

A seam is one place yield comes from: a lending market, an LP position, a market-making
vault. This package decides how much capital belongs in each of them, when it is worth
trading to correct a drifted book, and how much realized yield came from fees, from
token emissions, or from the losing side of somebody else's trade.

Every function is pure. No network, no filesystem, no clock, no random source.
Timestamps arrive as arguments, so the same input always produces the same plan. That is
what lets an off-chain planner and an on-chain program reach the same answer.

## Install

```sh
npm install @lodz/seam-router
```

Node 18 or newer. Ships ESM and CommonJS builds with type declarations for both.

## What the measured market looks like

The ceilings and gates below are not generic risk hygiene. Each one exists because a
survey of every BTC-related pool on Solana turned up a specific case that would otherwise
produce a dishonest plan:

| Measured fact | What the router does about it |
| --- | --- |
| A vault advertising 104 percent has 10,927 USD of capacity | Hard liquidity floor, default 100,000 USD |
| One pool's history contains a day reading 74,187 percent | Spot rates are never routed on; only trailing windows are |
| The only real yield is LP fees, and nobody has measured the impermanent loss against them | Unmeasured loss is disclosed, never assumed to be zero |
| The highest rate on the market, 214 percent, is funded by trader losses | Third yield source, `counterparty`, with its own ceiling |
| Lending rates are effectively zero because nothing is being borrowed | Zero-rate seams are excluded regardless of TVL |
| The largest BTC representation is bridged through a bridge that was exploited | Custody hop limit per posture |
| One data source can be stale while another is current | A seam two sources disagree about is withheld, not published |

## Why a router rather than a sort

Ranking seams by headline rate produces a book that fills up with whatever is currently
printing the largest number, and on this market that number is funded by other traders
losing money. So the ceilings are hard limits, expressed in basis points of total capital
and varying by posture:

| Ceiling | `conservative` | `balanced` | `aggressive` |
| --- | --- | --- | --- |
| Counterparty-funded yield | 0 | 1000 | 3000 |
| Uncorrelated LP exposure | 1000 | 3500 | 6000 |
| Emission-funded yield | 1500 | 3500 | 6000 |
| Single venue | 3000 | 4000 | 5000 |
| Single asset | 4000 | 6000 | 7000 |
| Custody hops | 1 | 2 | 3 |
| Risk tier low / medium / high | 10000 / 3500 / 0 | 10000 / 7000 / 2000 | 10000 / 10000 / 5000 |
| Holds unmeasured impermanent loss | no | yes | yes |
| Liquidity buffer | 500 | 250 | 0 |

The emissions ceiling is kept even though the measured market currently has zero emission
programmes. It has had them before and will again, and a ceiling that only appears once
the exposure exists is a ceiling nobody reviewed.

Every one of these is an argument, not a constant. Once the vault program is live, its
on-chain parameters are the authority and should be passed in.

## Usage

### Plan an allocation

```ts
import { planAllocation } from "@lodz/seam-router";
import type { Seam } from "@lodz/seam-router";

// The catalogue is injected. This package does not ship one: it comes from the indexer.
const seams: Seam[] = [
  {
    id: "S2",
    name: "Orca cbBTC-USDC",
    venue: "Orca",
    asset: "cbBTC",
    assetMint: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
    kind: "lp",
    yieldKind: "sustainable",
    apyBps: 1_500,          // spot, never routed on
    apy7dBps: 1_546,
    apy30dBps: 2_201,
    apy90dMedianBps: 2_850,
    tvlUsd: 6_319_470,
    allocationBps: 0,
    emissionToken: null,
    emissionEndsAt: null,
    riskTier: "medium",
    belowLiquidityFloor: false,
    sourceDivergence: false,
    ilEstimateBps: null,    // unmeasured, which is not the same as zero
    pairVolatilityClass: "uncorrelated",
    wrapHops: 1,
    sourceUrl: "https://yields.llama.fi/chart/2651188f-6b05-473e-9cfb-977a4ad094ba",
    updatedAt: "2026-08-15T00:00:00.000Z",
  },
  // ...more seams
];

const plan = planAllocation({
  seams,
  stope: "balanced",
  capitalBtc: 12.5,
  btcPriceUsd: 100_000,
  now: "2026-08-15T00:00:00.000Z",
});
```

`btcPriceUsd` is required. The liquidity floor and the share-of-pool ceiling are
denominated in USD and cannot be enforced without it.

`sum(plan.allocations[].allocationBps) + plan.idleBps` is exactly 10000 for every input.
When the ceilings make full deployment impossible, the surplus stays in `idleBps` rather
than being forced into a seam already at its limit. `idleBps` is never smaller than the
posture's liquidity buffer. Satoshis are split exactly too: the per-seam `capitalSats`
values plus `idleSats` add up to `capitalSats` with no remainder lost.

Routing the measured catalogue for three postures produces three genuinely different
books:

```
profile        counterparty  ceiling   status
conservative       0 bps        0   refused outright
balanced        1000 bps     1000   ceiling is binding
aggressive      1367 bps     3000   under ceiling
```

Each allocation carries a `bindingCap` naming the ceiling that stopped it from growing,
and every seam that received nothing appears in `plan.excluded` with a reason.

### Rates: trailing windows only

`planAllocation` never routes on `apyBps`. It picks the **lowest** available trailing
window and reports which one in `apySource`.

Windows disagree by a lot here. One pool reads 15.46 percent over seven days, 22.01 over
thirty and 28.50 as a ninety day median. Picking the highest would let the planner
justify a position with a rate the pool is no longer paying, so the lowest is used: it
cannot overstate, and no single inflated window can carry a seam into the book alone.

A seam with no trailing figure at all is excluded (`no-durable-apy`) rather than routed
on its spot rate. A seam carrying `sourceDivergence` is excluded too: when two
independent feeds disagree about a rate, at least one of them is stale, and publishing
the disputed number as settled is how a stale feed becomes a promise. `belowLiquidityFloor`
excludes a seam on the indexer's own judgement even when its reported TVL clears the
numeric floor. When the spot reading exceeds the trailing week by more than
`spotRejectMultiple` (default 5), `spotRejected` is set on the allocation for disclosure.
Feeding a seam the documented 74,187 percent artifact day moves its allocation by exactly
zero basis points.

### Impermanent loss: disclosed, never invented

For an LP seam, `ilEstimateBps` of `null` means nobody has measured the loss. It does not
mean zero, and this package will not pretend otherwise:

- `netApyBps` is `grossApyBps - ilEstimateBps` when the loss is measured, and `null` when
  it is not;
- `plan.blendedNetApyBps` is `null` if any held seam has an unmeasured loss, because a
  net figure that silently treats an unmeasured cost as zero is the overstatement this
  package exists to prevent;
- `plan.ilUnknownBps` reports how much capital sits in such seams;
- ranking applies a discount for unmeasured loss, which is a scoring penalty and not a
  substitute figure.

`conservative` refuses these seams outright. On the measured market that removes every LP
position, which is the honest answer: the only real yield available is LP fees, and the
cost that offsets them has not been measured.

### Plan a rebalance

```ts
import { planRebalance } from "@lodz/seam-router";

const rebalance = planRebalance({
  current,
  target,
  minDeltaBps: 250,
  gasCostBps: 6,
  apyBpsBySeamId,
  horizonDays: 90,
  forcedExitSeamIds: ["X1"],
});
```

Two filters run before anything executes. A per-seam threshold drops deltas too small to
bother with. Then, when APY data and a horizon are supplied, a spread test drops moves
whose expected gain does not clear the execution cost over that horizon:

```
required spread (bps) = gasCostBps * 365 / horizonDays
```

`forcedExitSeamIds` overrides that test. A position that breached a ceiling has to come
down whether or not the move is accretive, and it almost never is: the seam that breached
is usually the highest-yielding one in the book. Without the override, the cost test
would quietly make every risk ceiling advisory. The move is still reported with its real,
negative `expectedGainBps` rather than dressed up.

Everything filtered out appears in `skipped` with a reason: `below-min-delta`,
`cost-exceeds-gain`, or `unmatched`. `sum(resulting)` always equals `sum(current)`; a
rebalance moves capital, it never creates or destroys it.

### Aggregate realized yield

```ts
import { aggregateRealizedYield } from "@lodz/seam-router";

const report = aggregateRealizedYield(entries, { from, to });

report.sustainableShareBps;   // 4906
report.emissionsShareBps;     // 412
report.counterpartyShareBps;  // 4682
```

The report never collapses the three sources into one headline number. `bySeam` and
`byVenue` carry all three at every level, and the shares always close to exactly 10000.
A combined total says nothing about whether the yield survives the end of an emission
schedule or the month the traders on the other side stop losing.

### Size a keeper bond

```ts
import { keeperBondRequirement } from "@lodz/seam-router";

const bond = keeperBondRequirement(12.5, {
  btcPriceUsd: 100_000,
  lodzPriceUsd: 0.25,
  bondRateBps: 200,
  minBondUsd: 5_000,
  maxBondUsd: 2_000_000,
  stope: "balanced",
  profileMultiplierBps: { conservative: 8_000, balanced: 10_000, aggressive: 15_000 },
  slashConditions: [
    { code: "allocation-cap-breach", description: "Submitted an allocation that breaches a vault ceiling", slashBps: 2_500 },
    { code: "spot-rate-routing", description: "Routed capital on a spot rate the planner had rejected", slashBps: 2_000 },
  ],
});
```

Slash conditions are supplied rather than defined here. They have to match the on-chain
program exactly, and the program is the authority.

## Risk

Capital routed through this package is exposed to bridge risk, custody risk and the
protocol risk of every venue it touches. Emission-funded yield ends on a schedule.
Counterparty-funded yield is paid by somebody else's losses and stops when they stop
losing. Impermanent loss on an LP position can exceed the fees it collects, and on this
market it is largely unmeasured. Nothing here is free of risk or assured, and no
computation in this package should be read as a promise about future returns. Wrapped and
bridged representations of BTC are not bitcoin itself and carry the risk of whatever
issues them.

## API

| Export | Purpose |
| --- | --- |
| `planAllocation(input)` | Target allocation per seam under the posture's ceilings |
| `planRebalance(input)` | Moves to execute, plus the ones deliberately skipped |
| `aggregateRealizedYield(entries, window?)` | Realized yield split by source, seam, venue and token |
| `keeperBondRequirement(capitalBtc, params)` | Bond size in USD and LODZ, with priced slash conditions |
| `resolveConstraints(input?)` | Merge overrides onto the defaults and validate |
| `DEFAULT_CONSTRAINTS` | The default ceiling set |
| `SeamRouterError` | Thrown for every rejected input, with a `code` |

Domain types (`Seam`, `YieldKind`, `RiskTier`, `StopeProfile`, `PairVolatilityClass`) are
declared here and kept shape-identical to `@lodz/assay-engine`, which owns the canonical
declarations.

## Development

```sh
npm run typecheck   # tsc --noEmit
npm run build       # ESM and CommonJS into dist/
npm test            # node --test
npm run demo        # the worked example in examples/scenario.ts
```

## License

MIT
