# lodz-sdk

Tooling for the LODZ BTC yield layer: the attribution engine, the risk model, the
redemption queue calculator, the seam router, the client SDK and the command line
client.

The engine is the point. Everything else is transport.

[lodz.money](https://lodz.money) &middot; [LodzMoney](https://github.com/LodzMoney) &middot;
[lodz](https://github.com/LodzMoney/lodz)

| Repository | Contents |
|---|---|
| [lodz](https://github.com/LodzMoney/lodz) | Anchor vault program, IDL, and the specifications it enforces |
| **lodz-sdk** (this one) | Attribution engine, risk model, redemption queue, seam router, SDK and CLI |

---

## What the engine does

It takes a set of yield seams and a deposit size and returns the return broken into
three kinds, so a reader can see which part survives once the incentives stop.

```
sustainable    trading fees, borrow interest -- money an outside user actually paid
emissions      protocol token emissions -- money the issuer printed
counterparty   the other side's losses -- money a trader lost
```

Two categories is the common model. We measured the Solana BTC landscape on 2026-08-15
and found three kinds in live use, so the type has three variants.

### Why the third one exists

GMTrade's BTC-USDC vault reported 214.828% on $1.71M. Its source is trader losses. On a
chart it looks like fee revenue. In character it is the opposite: it depends on someone
else continuing to lose. Rendering it in the same column as exchange fees misleads the
reader, so it gets its own kind and its own colour.

### Why the emissions column reads zero

Because it is zero. We checked all 94 BTC-related pools on Solana across 647 days of
history and found no pool with a non-zero reward APY. The same snapshot finds 15 such
pools elsewhere on Solana, so the collector is working.

An attribution tool whose emissions column is empty looks broken. This one is reporting
a real measurement, and the projection view exists to make that legible: it answers
"what does this become when the emissions stop" with the same number, because there is
nothing to stop.

---

## Packages

| Package | Purpose |
|---|---|
| `lodz-assay-engine` | Yield attribution. Splits a return into the three kinds, projects a post-emissions rate, and reports data quality |
| `lodz-headlamp-risk` | Risk tiers across bridge, custody and protocol layers |
| `lodz-orecart-queue` | Redemption queue: wait time, delay and fee arithmetic |
| `lodz-seam-router` | Allocation across seams under TVL and concentration constraints |
| `lodz-sdk` | Client SDK for wallets and custodians |
| `lodz-cli` | Command line client: `lodz assay`, `lodz seams`, `lodz queue` |

Package names are unscoped. There is no `@lodz` npm organisation, so a scoped name would
not resolve.

---

## Install

```
npm install
npm run build
npm test
```

Node 22 or newer. This is an npm workspace root because the packages depend on each
other; a standalone clone of a single package fails to install.

---

## Rules the engine enforces

These live in code, not in documentation, because an attribution tool that can be
talked out of its own rules is not an attribution tool.

| Rule | Why |
|---|---|
| Spot APY is rejected. Seven-day or ninety-day median only | An Orca cbBTC-USDC history day reads 74,187% apyBase, an artefact of low TVL |
| A liquidity seam without an impermanent loss estimate is marked `ilUnknown` | DefiLlama `il7d` is null for every relevant pool. The estimate is never fabricated |
| `counterparty` is never merged into `sustainable` | They behave alike on a chart and differ entirely in character |
| Sources disagreeing by more than 20 percent hide the seam and raise a flag | Stale data must not be presented as settled |
| Seams below $100K TVL are excluded | A 104.6% quote on $10,927 of capacity does not survive an allocation |
| Points programmes are never converted into an APY | Pricing unissued points relabels emissions as fee revenue |
| No allocation exceeding 10 percent of a seam's TVL | Our own capital moving the pool means the quoted rate is not the realised rate |

Amounts are integer base units throughout. Rates are basis points. There is no floating
point arithmetic in any calculation that reaches a balance.

---

## Assets

Identified by mint, never by symbol. WBTC has two distinct mints on Solana and a symbol
lookup silently resolves to the wrong one.

| Asset | Mint | Trust model | Wrap hops |
|---|---|---|---|
| cbBTC | `cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij` | custodial (Coinbase) | 1 |
| WBTC | `3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh` | bridged (BitGo to Ethereum to Wormhole) | 2 |
| zBTC | `zBTCug3er3tLyffELcvDNrKkCymbPWysGcWihESYfLg` | program-controlled (Zeus, PDA) | 1 |
| xBTC | `CtzPWv73Sn1dMGVU3ZtLv9yWSyUAanBni19YWDaznnkn` | custodial (OKX) | 1 |

These are wrapped representations of bitcoin. They are not bitcoin, and this codebase
does not describe them as such. Each carries custody or bridge risk the underlying
chain does not have.

---

## Data sources

Confirmed returning 200 at time of measurement:

```
https://yields.llama.fi/pools
https://yields.llama.fi/chart/{poolId}
https://api.kamino.finance/kamino-market/{market}/reserves/metrics
https://api.orca.so/v2/solana/pools
https://api.solend.fi/v1/reserves?scope=all
```

Confirmed failing and therefore not wired in: `data.api.drift.trade` (403),
`api.zeta.markets/markets` (403). Basis seams are unsupported until on-chain parsing is
implemented rather than estimated from an unavailable source.

---

## Status

The packages build and their test suites pass. The on-chain program they describe is
not deployed to mainnet and has not been audited.

Figures produced by this engine are measurements of what a seam did, not a forecast of
what it will do. Nothing here removes custody risk, bridge risk, smart contract risk,
or the impermanent loss that liquidity provision carries.

---

## Licence

MIT. See LICENSE.
