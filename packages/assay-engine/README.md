# lodz-assay-engine

Splits a BTC yield number by who actually pays it, and projects what is left
once the incentive programs end and impermanent loss is taken off.

"59% APY" made of 11% swap fees and 48% of trader losses is a different asset
from 59% of swap fees. An incentive-funded 59% is a third thing again. This
package refuses to return the blended number on its own.

It is also the canonical home of the LODZ domain types. Other LODZ packages
import `Seam`, `Allocation`, `RiskTier` and friends from here rather than
redeclaring them.

## Install

```
npm install lodz-assay-engine
```

Node 18 or newer. Ships ESM and CommonJS builds with type declarations for both.

## Design rules

- **Three kinds of yield, never blended.** `sustainable` is paid by an outside
  user for a service. `emissions` is paid by an incentive program until a date.
  `counterparty` is paid out of somebody else's trading losses. Every split in
  the API carries all three.
- **Integer basis points.** Rates are integers in bps, capital shares are
  integers in bps summing to exactly 10000, and BTC amounts are integer
  satoshis carried through `bigint` arithmetic. Splits use the largest remainder
  method, so a decomposition always adds back up to its total.
- **Simple accrual.** Rates annualize linearly on a 365 day basis with no
  compounding. Compounding a quoted APY inflates a projection.
- **Smoothed rates, not spot.** A spot rate on a thin pool can print several
  orders of magnitude off reality. The engine quotes the lower of the 7 day and
  90 day median observations and flags the spot number rather than using it.
- **Expired programs pay nothing.** An emissions seam past its end date
  contributes 0. The catalog rate is still reported as `declaredApyBps` so the
  gap is visible rather than silent.
- **Unknown stays unknown.** A missing impermanent loss estimate is reported as
  `ilUnknown`, never filled in with a guess. There is no path anywhere in this
  package that turns points or airdrop expectations into a rate.
- **Malformed input throws.** An emissions seam with no declared token or end
  date is rejected: downstream it would be indistinguishable from a sustainable
  one.
- **One yield kind per seam.** A venue paying both a service fee and an
  incentive token is modelled as two seams sharing a `venue`.

## Types

```ts
type YieldKind     = "sustainable" | "emissions" | "counterparty";
type SeamVenueKind = "lending" | "lp" | "basis";
type RiskTier      = "low" | "medium" | "high";
type StopeProfile  = "conservative" | "balanced" | "aggressive";
type ApyBasis      = "90d-median" | "7d" | "spot";

interface Seam {
  id: string; name: string; venue: string;
  asset: string;          // BTC representation symbol, e.g. cbBTC / zBTC / tBTC
  assetMint: string;      // SPL mint. The only identifier that is unique.
  kind: SeamVenueKind; yieldKind: YieldKind;
  apyBps: number;                 // spot observation, rarely the quoted rate
  apy7dBps: number | null;        // trailing 7 day
  apy90dMedianBps: number | null; // 90 day median
  tvlUsd: number; allocationBps: number;
  ilEstimateBps: number | null;   // null means unknown, and stays unknown
  pairVolatilityClass: "correlated" | "mixed" | "uncorrelated" | null;
  belowLiquidityFloor: boolean;   // venue cannot absorb capital
  sourceDivergence: boolean;      // two sources disagree past the threshold
  emissionToken: string | null;   // required when yieldKind is "emissions"
  emissionEndsAt: string | null;  // ISO-8601, required for "emissions"
  riskTier: RiskTier; sourceUrl: string; updatedAt: string;
}

type Allocation = Readonly<Record<string, number>>;  // seam id -> bps, totals 10000
```

`asset` names a wrapped or bridged representation of BTC. It is not bitcoin held
on the Bitcoin network, and nothing in this package treats it as such. Identify
seams by `assetMint`: more than one Solana mint ships under the same BTC ticker.

## API

### `decomposeYield(seams, allocation?, at?)`

Splits the portfolio rate by who pays it.

```ts
import { decomposeYield } from "lodz-assay-engine";

const result = decomposeYield(seams);
result.apyBps;               // 5915 -> 59.15%
result.sustainableApyBps;    // 1142 -> 11.42%  swap fees and borrow interest
result.emissionsApyBps;      //    0 -> no incentive programs are running
result.counterpartyApyBps;   // 4773 -> 47.73%  paid out of trader losses
result.counterpartyShareBps; // 8070 -> 80.70% of the headline is trader losses
result.components;           // per seam, contributions summing exactly to apyBps
result.ilUnknown;            // true when an allocated LP seam has no estimate
```

### `simulatePostEmissions(seams, at?, allocation?)`

Projects the rate across every emissions end date. When programs end on
different dates the answer is a staircase, not a number.

```ts
const curve = simulatePostEmissions(seams);
curve.hasLiveEmissions;      // false
curve.emissionExposureBps;   // 0, always reported
curve.postEmissionsApyBps;   // equal to the current rate when nothing expires
curve.steps;                 // one flat step when there is nothing to expire
```

A market with no incentive programs is a supported, first class answer, not an
error and not an empty section.

### `projectYield({ btcAmount, seams, horizonDays, stope?, allocation?, at? })`

```ts
const projection = projectYield({ btcAmount: 1, seams, horizonDays: 365 });

projection.yieldFlat.total.btc;         // today's rate held flat
projection.yieldFlat.counterparty.btc;  // and how much of it is trader losses
projection.yieldScheduled.total.btc;    // programs stopped on their end dates
projection.emissionsShortfall.btc;      // the gap between those two
projection.yieldScheduledNetOfIl.btc;   // known impermanent loss taken off

projection.il.netOfIlBps;   // rate after the known IL drag. May be negative.
projection.il.ilUnknown;    // true -> netOfIlBps is an upper bound, not an answer
projection.il.unknownIlSeamIds;

projection.liquidityFloor.excludedSeamIds;  // venues too small to route into
projection.risk.weightedTier;               // "medium"
projection.risk.worstTier;                  // "high"  (never averaged away)
```

Passing `stope` derives the allocation from a vault profile. Profiles are data:
replace `DEFAULT_STOPE_POLICIES` via `stopePolicies`. Each profile caps emissions
and counterparty exposure separately, because yield paid out of trader losses is
not fee income.

### Display guards

These exist because the underlying market data contains numbers that are true
and useless.

| Guard | What it does |
|---|---|
| `selectQuotedApy(seam)` | Quotes the lower of the 7d and 90d median observations. Falls back to spot only when neither exists, and sets `spotOnly`. |
| `spotRejected` | Set when spot is `SPOT_ARTIFACT_MULTIPLE` (5x) or more above the smoothed rate. One pool printed a 74,187% day from a low-TVL calculation artifact. |
| `isBelowLiquidityFloor(seam)` | True under `LIQUIDITY_FLOOR_USD` (100,000). One reserve quoted 104.62% while holding 10,927 USD. |
| `applyLiquidityFloor(seams, allocation)` | Drops those venues and redistributes their share, still totalling exactly 10000 bps. Applied by `projectYield` unless `enforceLiquidityFloor: false`. |
| `detectSourceDivergence(a, b)` | True past `SOURCE_DIVERGENCE_THRESHOLD_BPS` (20%) relative gap, so a stale source is never shown as settled. |
| `seamDataQuality(seam)` | Bundles every caveat for one seam, including `ilUnknown` and `hasCaveats`. |

There is deliberately **no** function that converts points or airdrop
expectations into a rate. Pricing unissued points disguises an incentive program
as fee income.

### `seamThickness(seam, maxTvlUsd, options?)` and `seamThicknessSet(seams, options?)`

Draw widths for the Seam Map. Thickness tracks realized annual yield rather than
headline rate. `fade` is 0 for sustainable seams and rises from
`MIN_EMISSION_FADE` to 1 as an incentive program runs out.

### Validation

`validateSeam`, `validateSeams`, `validateAllocation` and `resolvePortfolio` are
exported for callers that want to check a catalog before using it. Every public
entry point validates on its own.

Rejections throw `AssayError` with a `code` (`INVALID_SEAM`,
`INVALID_ALLOCATION`, `INVALID_INPUT`, `EMPTY_PORTFOLIO`,
`STOPE_EXCLUDES_EVERY_SEAM`, `ALL_SEAMS_BELOW_LIQUIDITY_FLOOR`) plus the
offending `field` and `seamId`.

Rates are integers in basis points, so anything under 0.005% quotes as 0.00%.
For the lending reserves that currently pay 0.00459%, zero is the honest
display.

## Worked example

`examples/measured-market.mjs` runs 1 BTC across the Solana BTC market as
measured on 2026-08-15:

```
Rate, split by who pays it
  headline      59.15%
  sustainable   11.42% (19.30% of the rate)
  emissions      0.00% (0.00% of the rate)
  counterparty  47.73% (80.70% of the rate)

Emissions
  live programs        no
  capital exposed      0.00%

Impermanent loss
  known?          no, not calculated
  LP capital with no estimate 61.11%

Liquidity floor
  dropped zeus-btc-market-usdc      (104.62% quoted on a 10,927 USD reserve)

The spot rate the engine refused to quote
  spot 74187.00% -> quoted 15.46% (7d), rejected: true
```

## Scripts

```
npm run typecheck   # tsc --noEmit over src and test
npm run build       # ESM into dist/, CommonJS into dist/cjs/
npm test            # node --test over the compiled test build
```

## License

MIT
