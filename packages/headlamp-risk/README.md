# @lodz/headlamp-risk

Measures the exposure behind a BTC position on Solana as five layers, and keeps
the worst layer visible instead of averaging it away.

A BTC position on Solana fails one layer at a time: the bridge that moved it,
the party holding the backing coins, the protocol paying the yield, the price
feed that protocol trusts, and the depth available when the position has to be
closed. A single number that blends all five hides which one is about to give.

Domain types (`Seam`, `Allocation`, `RiskTier`) come from
[`@lodz/assay-engine`](https://www.npmjs.com/package/@lodz/assay-engine).

## Install

```
npm install @lodz/headlamp-risk
```

Node 18 or newer. Ships ESM and CommonJS builds with type declarations for both.

## Design rules

- **The scale has no zero.** Severity runs 1 to 5 and composite scores run 100
  to 500 centi-severity. Nothing in this package returns an assessment that
  reads as no exposure.
- **Absence of evidence is not evidence of safety.** A layer nobody supplied a
  factor for is scored at `UNEVIDENCED_SEVERITY` (3), marked `evidenced: false`
  and listed in `unevidencedLayers`. A thin evidence set scores worse than a
  well documented calm one, never better.
- **The worst layer is never diluted.** Weighted averages answer "what is the
  average exposure of this capital". They are not allowed to answer "how bad can
  this get", so `worstLayer`, `worstSeam` and each layer's `worstSeverity` are
  reported undiluted alongside the average.
- **No asset data is compiled in.** Custody facts are injected. An asset with no
  record comes back explicitly unknown, carrying the heaviest implied exposure.
- **Mint addresses identify assets, tickers do not.** More than one Solana mint
  can ship under the same BTC ticker. A symbol matching several records resolves
  to nothing and says so, rather than picking one.

## Types

```ts
type RiskLayer = "bridge" | "custody" | "protocol" | "oracle" | "liquidity";
type Severity  = 1 | 2 | 3 | 4 | 5;

interface RiskFactor {
  layer: RiskLayer;
  label: string;
  severity: Severity;
  rationale: string;
  evidenceUrl: string | null;
}
```

## API

### `assessSeam(seam, factors, options?)`

Scores one seam across all five layers. Every layer is reported whether or not
evidence exists for it.

When a custody record exists for the seam's asset, its implied factors are
folded in automatically (looked up by `assetMint` first, then by symbol), and
two measured properties set floors that supplied evidence cannot undercut:

| Measured property | Floor |
|---|---|
| `freezable: true` | custody layer at severity 3 or worse. The issuer can freeze a holder's account. |
| `wrapHops: n` | bridge layer at `min(2n, 5)`. Hops multiply: two hops floors the bridge at 4. |

`appliedFloors` reports every floor that actually raised a severity, with the
severity the evidence produced on its own.

```ts
const result = assessSeam(cbBtcSeam, optimisticFactors, { ledger });
result.layers.find((l) => l.layer === "custody")?.severity;  // 3, not the 1 claimed
result.appliedFloors[0];  // { layer: "custody", evidencedSeverity: 1, flooredSeverity: 3, reason: ... }
```

```ts
import { assessSeam } from "@lodz/headlamp-risk";

const result = assessSeam(seam, [
  { layer: "bridge", label: "bridge signer set is unaudited", severity: 5,
    rationale: "No published audit of the signer set.", evidenceUrl: null },
  { layer: "custody", label: "reserves attested quarterly", severity: 2,
    rationale: "Third party attestation published on a quarterly cadence.",
    evidenceUrl: "https://example.org/attestation" },
]);

result.compositeScore;            // 372 on a 100..500 scale
result.tier;                      // "high"
result.worstLayer;                // { layer: "bridge", severity: 5, ... }
result.unevidencedLayers;         // ["protocol", "oracle", "liquidity"]
result.declaredTier;              // what the seam catalog claims
result.measuredWorseThanDeclared; // true when the catalog is optimistic
```

The composite score weights the worst layer at 60% and the mean across layers at
40%. A position with one severity 5 layer and four severity 1 layers scores 372
and lands in `high`; a plain mean would have scored it 180 and called it low.

### `assessPortfolio(seams, allocation?)`

Takes `{ seam, factors }` pairs and weights by allocation. `allocation` defaults
to each seam's `allocationBps` and must total exactly 10000 bps.

```ts
const portfolio = assessPortfolio([
  { seam: calmSeam,    factors: calmFactors },     // 95% of capital
  { seam: fragileSeam, factors: fragileFactors },  // 5% behind a severity 5 bridge
]);

portfolio.weightedScore;   // 114 -> the average barely moved
portfolio.weightedTier;    // "low"
portfolio.worstLayer;      // { layer: "bridge", severity: 5, seamId: "fragile", ... }
portfolio.worstSeam;       // { seamId: "fragile", compositeScore: 372, tier: "high" }
portfolio.layers;          // per layer: weighted severity AND worst severity
portfolio.highSeverityAllocationBps;  // capital touching severity 4 or worse
portfolio.unevidencedAllocationBps;   // capital with an undocumented layer
portfolio.concentration;   // top seam, top asset and top venue by allocation
```

Reporting `weightedTier` without `worstLayer` would be the exact failure this
package exists to prevent.

### `describeCustody(asset, ledger?)`

Describes the arrangement standing behind a BTC representation. This package
ships no asset data: build a ledger from your own confirmed research and inject
it, either per call or once via `setCustodyLedger`.

```ts
import { createCustodyLedger, describeCustody, setCustodyLedger } from "@lodz/headlamp-risk";

setCustodyLedger([
  {
    asset: "cbBTC",
    assetMint: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
    trustModel: "custodial",       // custodial | bridged | program-controlled
    operator: "Coinbase",
    redeemability: "permissioned", // direct | permissioned | market-only | unknown
    reserveEvidence: "none",
    wrapHops: 1,                   // hops the backing BTC passes through
    freezable: true,               // issuer can freeze holder accounts
    mintAuthorityIsKeypair: true,  // mint authority is a key, not a program
    sourceUrl: "https://api.mainnet-beta.solana.com",
    updatedAt: "2026-08-15T07:00:00.000Z",
  },
]);

const custody = describeCustody("cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij");
custody.known;            // true
custody.trustModel;       // "custodial"
custody.custodyType;      // "centralized-custodian", derived from the trust model
custody.summary;          // structural description in plain English
custody.trustAssumptions; // what a holder is actually trusting, stated outright
custody.impliedFactors;   // bridge, custody and liquidity factors for assessSeam
```

Supply `trustModel` or `custodyType`; the ledger fills in whichever is missing
(`custodyTypeFromTrustModel` and `normalizeCustodyModel` are exported for
callers that want the mapping directly).

`describeCustody` accepts a mint address or a symbol, and tries the mint first.
Implied severities start from a documented default table keyed on the structure
and take one step up for each measured property that widens the exposure: an
extra wrapping hop, a freeze key, a keypair mint authority, unpublished
reserves. Steps are additive and clamp at 5. A record stating its own
`severities` per layer overrides all of it.

Because size is not evidence of safety, this ordering falls out of the data
rather than being asserted: an asset holding 214m USD behind a custodian with a
freeze key, a keypair mint authority and no published reserves scores 436 and
lands in `high`, while a 3.7m USD asset whose issuance authority is a program
with no freeze authority scores lower.

An asset with no record is not treated as fine:

```ts
describeCustody("unlisted").known;                      // false
describeCustody("unlisted").ambiguous;                  // false
describeCustody("unlisted").impliedFactors[0].severity; // 4, the heaviest bridge default
```

Neither is a ticker that matches more than one mint:

```ts
const shared = describeCustody("WBTC");   // two mints ship under this ticker
shared.known;          // false
shared.ambiguous;      // true
shared.candidateMints; // ["3NZ9JMV...", "5XZw2LK..."]
```

The descriptions state that a representation is a claim on an arrangement, not
bitcoin held on the Bitcoin network.

### Errors

Every rejection throws `HeadlampError` with a `code` (`INVALID_FACTOR`,
`INVALID_INPUT`, `INVALID_CUSTODY_MODEL`, `EMPTY_PORTFOLIO`) plus the offending
`field`, `seamId` or `asset`. Allocation and seam shape rejections surface as
`AssayError` from `@lodz/assay-engine`, which owns that validation.

## Scripts

```
npm run typecheck   # tsc --noEmit over src and test
npm run build       # ESM into dist/, CommonJS into dist/cjs/
npm test            # node --test over the compiled test build
```

## License

MIT
