# lodz-sdk

Typed client for the LODZ BTC yield layer on Solana.

It reads the indexer and returns the yield split into three kinds, so a caller
can tell fee revenue from printed tokens from someone else's losses.

```
npm install lodz-sdk
```

Node 18 or newer. ESM and CommonJS, with type declarations for both.

---

## Use

```ts
import { LodzClient } from "lodz-sdk";

const lodz = new LodzClient({ apiUrl: "https://api.lodz.fi" });

const header = await lodz.metrics.header();
const seams = await lodz.seams.list();
const estimate = await lodz.assay.estimate({ btcAmount: 1.5, stope: "balanced" });
const queue = await lodz.orecart.queue();
const risk = await lodz.headlamp.risk();
const vaults = await lodz.stope.vaults();
```

Options:

```ts
new LodzClient({
  apiUrl: "https://api.lodz.fi",
  fetch: myFetch,      // injected; defaults to the global
  timeoutMs: 15_000,   // per request
  headers: { "x-trace": "..." },
});
```

Per-call `AbortSignal` and timeout override:

```ts
const ac = new AbortController();
const p = lodz.seams.list({ signal: ac.signal, timeoutMs: 3_000 });
ac.abort();
```

---

## Three kinds of yield, not two

```
sustainable    trading fees, borrow interest -- money an outside user actually paid
emissions      protocol token emissions -- money the issuer printed
counterparty   the other side's losses -- money a trader lost
```

Most attribution models have two categories. We measured the Solana BTC
landscape on 2026-08-15 and found a live vault paying 214.828% whose source is
trader losses. On a chart it looks like fee revenue. In character it is the
opposite: it depends on someone else continuing to lose. Merging it into
`sustainable` would make the split misleading in exactly the way this project
exists to correct, so it has its own kind.

The `emissions` figure is currently zero across the board. That is a
measurement, not a gap: all 94 BTC-related pools across 647 days of history show
no reward APY, while the same snapshot finds 15 such pools elsewhere on Solana.

`seams.list({ type })` filters the returned array but leaves `totals` describing
the whole catalogue, deliberately. A filtered view whose totals moved with it
would hide the fact that the emissions count is zero for every seam.

---

## Assets are identified by mint

Never by symbol. WBTC exists on Solana under two distinct mints, and a symbol
lookup resolves to the wrong one without saying so.

```ts
import { assetByMint, BTC_ASSETS, DENIED_MINTS } from "lodz-sdk";

assetByMint("3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh");
// { symbol: "WBTC", trustModel: "bridged", wrapHops: 2, freezable: false, ... }

assetByMint("cbBTC");
// throws LodzUsageError -- a symbol is not an identifier
```

| Asset | Mint | Trust model | Wrap hops | Freezable |
|---|---|---|---|---|
| cbBTC | `cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij` | custodial (Coinbase) | 1 | yes |
| WBTC | `3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh` | bridged (BitGo to Ethereum to Wormhole) | 2 | no |
| zBTC | `zBTCug3er3tLyffELcvDNrKkCymbPWysGcWihESYfLg` | program-controlled (Zeus, PDA) | 1 | no |
| xBTC | `CtzPWv73Sn1dMGVU3ZtLv9yWSyUAanBni19YWDaznnkn` | custodial (OKX) | 1 | yes |

These are wrapped representations of bitcoin. They are not bitcoin, and this
package does not describe them as such. Each carries custody or bridge risk the
underlying chain does not have.

### Denylist

Three mints throw on sight. None of them is a judgement call about risk
appetite; each is a measured failure.

```ts
lodz.assertRoutableMint("9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E");
// throws LodzDeniedAssetError: soBTC (Sollet) -- depegged 99.96 percent, issuer defunct
```

| Mint | Asset | Reason |
|---|---|---|
| `9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E` | soBTC (Sollet) | depegged 99.96 percent, issuer defunct |
| `21BTCo9hWHjGYYUQQLqjLgDBxjcn8vDt4Zic7TB3UbNE` | 21BTC | economically dead |
| `5XZw2LKTyrfvfiskJ78AMpackRjPcyCif1WhUsPDuVqQ` | WBTC (BitGo canonical) | about $46K of liquidity on Solana |

---

## Errors

Every failure path throws. Nothing returns an empty result to stand in for an
error, because a caller receiving `{ seams: [] }` cannot tell an empty catalogue
from an unreachable service, and the second rendered as the first is how a
dashboard ends up quietly showing zero.

| Class | Meaning |
|---|---|
| `LodzApiError` | Non-2xx response. Carries `status`, `code`, `detail` and `requestId` |
| `LodzNetworkError` | No response at all: DNS, connection refused, TLS. Original error on `cause` |
| `LodzTimeoutError` | Exceeded the timeout, or the caller aborted |
| `LodzResponseError` | A response arrived in a shape this client cannot read |
| `LodzDeniedAssetError` | A denylisted mint was supplied |
| `LodzUsageError` | A caller argument is invalid, caught before any request is sent |

All extend `LodzError`.

```ts
import { LodzApiError, LodzNetworkError } from "lodz-sdk";

try {
  await lodz.assay.estimate({ btcAmount: 1.5 });
} catch (e) {
  if (e instanceof LodzApiError) console.error(e.status, e.code, e.requestId);
  else if (e instanceof LodzNetworkError) console.error("service unreachable", e.cause);
  else throw e;
}
```

Argument validation rejects rather than throwing synchronously, so a single
`.catch` covers every failure from a call.

---

## Units

Rates are basis points wherever a calculation may depend on them. The `_pct`
companions are for display only. Anything that reaches a balance should use the
bps field.

`il_unknown: true` means no impermanent loss estimate exists for that seam. It
does not mean zero, and this package never substitutes one.

---

## No credentials

This client carries no API key and holds no RPC endpoint. Every figure comes
from the indexer, which is the only component that talks to a keyed provider.
Embedding a paid RPC URL in a published package would put the key in every
consumer's bundle.

---

## Licence

MIT.
