# @lodz/cli

Command line client for the LODZ BTC yield layer on Solana.

It answers one question in the terminal: of the yield being quoted, how much is
someone actually paying, how much is being printed, and how much is somebody
else losing.

```
npm install -g @lodz/cli
lodz assay --btc 1.5
```

Node 18 or newer. No runtime dependencies: the client library is compiled into
the published output, so the install cannot fail on a package that is not on the
registry yet, and there is no publish order to get right.

---

## Output

```
  LODZ assay  1.5 BTC  stope balanced
  source defillama (live) at 2026-08-15 07:53:59Z

  Yield attribution                  807 bps     8.07%
  ┌────────────────────────────────────────────────────────┐
  │████████████████████████████████████████████████████████│
  └────────────────────────────────────────────────────────┘
  █ Sustainable      807 bps    8.07%    0.12108313 BTC   trading fees and borrow interest, paid by an outside user
  ▒ Emissions          0 bps    0.00%    0.00000000 BTC   none on Solana BTC pools as of 2026-08-15
  ▓ Counterparty       0 bps    0.00%    0.00000000 BTC   no allocation to trader-loss funded venues

  After impermanent loss                 776 bps     7.76%   31 bps of estimated loss deducted
  After emissions end                    807 bps     8.07%   no incentive programme to end
  Redemption fee (10 bps of yield)       806 bps     8.06%   0.12096205 BTC net
```

The shape above is what the client prints. The figures are a snapshot taken when
this README was written, not a promise: rates are read from the venues at each
run, so your own output will carry different numbers and its own `source ... at`
line. That header exists so a printed example and a live run can be told apart
rather than reconciled.

The three kinds are never summed into one headline number. Each has its own
glyph as well as its own colour, so the split survives a pipe, a `NO_COLOR`
terminal and a reader who cannot distinguish the hues.

---

## Commands

```
lodz assay   --btc <n> [--stope conservative|balanced|aggressive] [--json]
lodz seams   [--type sustainable|emissions|counterparty] [--json]
lodz queue   [--owner <pubkey>] [--json]
lodz deposit --btc <n> --asset <mint> [--stope <p>] [--json]
lodz redeem  --amount <n> [--stope <p>] [--json]
```

| Option | Meaning |
|---|---|
| `--api <url>` | Indexer base URL. Defaults to `$LODZ_API_URL`, then `https://api.lodz.money` |
| `--json` | Raw JSON on stdout, never coloured. Suitable for a pipe |
| `--timeout <ms>` | Per-request timeout. Default 15000 |
| `--help`, `-h` | Usage. Exits 0 |
| `--version`, `-V` | Version. Exits 0 |

---

## What the numbers mean

**The emissions row is usually zero, and that is the finding.** All 94
BTC-related pools on Solana across 647 days of history show no reward APY. The
collector works: the same snapshot finds 15 pools with a reward APY elsewhere on
Solana. When a competitor advertises a double-digit BTC yield, one of three
things is true -- fee revenue is shown without impermanent loss deducted, a
points programme has been converted into an APY, or leverage is folded into the
headline. This tool separates the three.

**`IL: unknown` is a real answer.** DefiLlama reports `il7d` as null for the
relevant pools. Where an impermanent loss estimate cannot be computed the seam
says so, and the net column shows `--`. An unknown loss printed as zero turns a
gross rate into a net one, which is the misstatement the tool exists to catch.

**APY is never the spot rate.** The `BASIS` column names the window each figure
came from. One day in the Orca cbBTC-USDC history reads 74,187% apyBase, an
artefact of low TVL, which is what a spot quote would happily print.

**`counterparty` is not `sustainable`.** GMTrade's BTC-USDC vault pays out of
trader losses. It gets its own row, its own glyph and its own colour.

---

## Assets are identified by mint

`deposit` takes `--asset <mint>`. Symbols are rejected: WBTC exists on Solana
under two distinct mints and a symbol lookup resolves to the wrong one silently.

```
lodz deposit --btc 0.5 --asset cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij
```

Three mints are refused outright, each for a measured reason: soBTC (depegged
99.96 percent), 21BTC (economically dead) and the BitGo canonical WBTC mint
(about $46K of liquidity on Solana).

---

## deposit and redeem do not send anything

They build and describe a request, print the asset's trust model and the target
program, and stop. There is no signing path in this binary. While the vault
program is undeployed they exit `3` and say why.

---

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | usage error: bad flag, missing argument, denylisted mint |
| 2 | the service answered with an error status |
| 3 | the service could not be reached, or the action is unavailable |

A network failure prints a diagnosis rather than an empty result:

```
lodz: LODZ request to http://127.0.0.1:9/assay failed before a response: fetch failed
       Check --api or $LODZ_API_URL.
```

---

## Colour

On a terminal only. `NO_COLOR` disables it, with any value including an empty
one, and outranks `FORCE_COLOR`. `--json` output is never coloured.

---

## Licence

MIT.
