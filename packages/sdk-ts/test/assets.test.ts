import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BTC_ASSETS,
  DENIED_MINTS,
  LodzDeniedAssetError,
  LodzUsageError,
  assertRoutableMint,
  assetByMint,
  deniedEntry,
  isDeniedMint,
} from "../src/index.js";

const SO_BTC = "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E";
const TWENTYONE = "21BTCo9hWHjGYYUQQLqjLgDBxjcn8vDt4Zic7TB3UbNE";
const WBTC_BITGO = "5XZw2LKTyrfvfiskJ78AMpackRjPcyCif1WhUsPDuVqQ";
const WBTC_WORMHOLE = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh";
const CBBTC = "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij";

test("every denylisted mint throws rather than resolving", () => {
  for (const mint of [SO_BTC, TWENTYONE, WBTC_BITGO]) {
    assert.equal(isDeniedMint(mint), true, `${mint} should be denied`);
    assert.throws(() => assetByMint(mint), LodzDeniedAssetError);
    assert.throws(() => assertRoutableMint(mint), LodzDeniedAssetError);
  }
  assert.equal(DENIED_MINTS.length, 3);
});

test("the denial message names the asset and the measured reason", () => {
  const e = deniedEntry(SO_BTC);
  assert.ok(e);
  assert.match(e.label, /soBTC/);
  assert.match(e.reason, /depegged/);
  try {
    assetByMint(SO_BTC);
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof LodzDeniedAssetError);
    assert.equal(err.mint, SO_BTC);
    assert.match(err.message, /denylist/);
  }
});

test("the two WBTC mints resolve differently, which is why symbols are not accepted", () => {
  // Both are called WBTC. One carries the liquidity, the other holds about $46K.
  // A symbol lookup would pick one of them silently.
  const routable = assetByMint(WBTC_WORMHOLE);
  assert.equal(routable.symbol, "WBTC");
  assert.equal(routable.trustModel, "bridged");
  assert.equal(routable.wrapHops, 2);
  assert.throws(() => assetByMint(WBTC_BITGO), LodzDeniedAssetError);
});

test("an unknown or empty mint is a usage error, never a silent default", () => {
  assert.throws(() => assetByMint("not-a-mint"), LodzUsageError);
  assert.throws(() => assetByMint(""), LodzUsageError);
  // A symbol is not an identifier here.
  assert.throws(() => assetByMint("cbBTC"), LodzUsageError);
});

test("routable assets span the three trust models", () => {
  const models = new Set(BTC_ASSETS.map((a) => a.trustModel));
  assert.ok(models.has("custodial"));
  assert.ok(models.has("bridged"));
  assert.ok(models.has("program-controlled"));
});

test("asset metadata matches the on-chain measurement", () => {
  const cb = assetByMint(CBBTC);
  assert.equal(cb.issuer, "Coinbase");
  assert.equal(cb.trustModel, "custodial");
  assert.equal(cb.wrapHops, 1);
  assert.equal(cb.freezable, true);

  const z = assetByMint("zBTCug3er3tLyffELcvDNrKkCymbPWysGcWihESYfLg");
  assert.equal(z.trustModel, "program-controlled");
  assert.equal(z.freezable, false);
});

test("no routable mint is also on the denylist", () => {
  for (const a of BTC_ASSETS) {
    assert.equal(isDeniedMint(a.mint), false, `${a.symbol} must not be denied`);
  }
});

test("the asset tables are frozen so a consumer cannot widen the denylist away", () => {
  assert.throws(() => {
    (DENIED_MINTS as unknown as unknown[]).push({});
  });
});
