import assert from "node:assert/strict";
import test from "node:test";

import { BPS_TOTAL, SeamRouterError, aggregateRealizedYield } from "../src/index.js";
import { REALIZED_ENTRIES } from "./fixtures.js";

test("realized yield is reported by source, never as a single blended number", () => {
  const report = aggregateRealizedYield(REALIZED_ENTRIES);

  assert.equal(report.entryCount, 6);
  assert.equal(report.totalBtc, 0.267);
  assert.equal(report.byYieldKind.sustainable.btc, 0.131);
  assert.equal(report.byYieldKind.emissions.btc, 0.011);
  assert.equal(report.byYieldKind.counterparty.btc, 0.125);
  assert.equal(
    report.byYieldKind.sustainable.btc +
      report.byYieldKind.emissions.btc +
      report.byYieldKind.counterparty.btc,
    report.totalBtc,
  );
});

test("the three source shares close to exactly 10000 bps", () => {
  const report = aggregateRealizedYield(REALIZED_ENTRIES);
  assert.equal(
    report.sustainableShareBps + report.emissionsShareBps + report.counterpartyShareBps,
    BPS_TOTAL,
  );
  assert.equal(report.sustainableShareBps, 4_906);
  assert.equal(report.emissionsShareBps, 412);
  assert.equal(report.counterpartyShareBps, 4_682);
});

test("counterparty yield is never folded into the sustainable figure", () => {
  const report = aggregateRealizedYield(REALIZED_ENTRIES);
  const gmtrade = report.byVenue["GMTrade"];

  assert.ok(gmtrade);
  assert.equal(gmtrade.counterpartyBtc, 0.125);
  assert.equal(gmtrade.sustainableBtc, 0);
  assert.equal(gmtrade.counterpartyShareBps, BPS_TOTAL);
  assert.ok(
    report.byYieldKind.counterparty.btc > report.byYieldKind.emissions.btc,
    "on this ledger the trader-funded share is the larger one, and it must be visible as such",
  );
});

test("a seam paying from two sources at once is split, not lumped", () => {
  const report = aggregateRealizedYield(REALIZED_ENTRIES);
  const bucket = report.bySeam["S1"];

  assert.ok(bucket);
  assert.equal(bucket.entries, 2);
  assert.equal(bucket.sustainableBtc, 0.031);
  assert.equal(bucket.emissionsBtc, 0.011);
  assert.equal(bucket.counterpartyBtc, 0);
  assert.equal(bucket.btc, 0.042);
  assert.equal(
    bucket.sustainableShareBps + bucket.emissionsShareBps + bucket.counterpartyShareBps,
    BPS_TOTAL,
  );
});

test("every breakdown closes to 10000 bps", () => {
  const report = aggregateRealizedYield(REALIZED_ENTRIES);
  const closes = (buckets: Record<string, { shareBps: number }>): number =>
    Object.values(buckets).reduce((acc, bucket) => acc + bucket.shareBps, 0);

  assert.equal(closes(report.bySeam), BPS_TOTAL);
  assert.equal(closes(report.byVenue), BPS_TOTAL);
  assert.equal(closes(report.byToken), BPS_TOTAL);
});

test("venue and token breakdowns account for every satoshi", () => {
  const report = aggregateRealizedYield(REALIZED_ENTRIES);
  const satsIn = (buckets: Record<string, { sats: number }>): number =>
    Object.values(buckets).reduce((acc, bucket) => acc + bucket.sats, 0);

  assert.equal(satsIn(report.bySeam), report.totalSats);
  assert.equal(satsIn(report.byVenue), report.totalSats);
  assert.equal(satsIn(report.byToken), report.totalSats);
});

test("per-source entry counts add up to the total", () => {
  const report = aggregateRealizedYield(REALIZED_ENTRIES);
  assert.equal(
    report.byYieldKind.sustainable.entries +
      report.byYieldKind.emissions.entries +
      report.byYieldKind.counterparty.entries,
    report.entryCount,
  );
  assert.equal(report.byYieldKind.counterparty.entries, 2);
});

test("a window filters entries and reports how many fell outside it", () => {
  const report = aggregateRealizedYield(REALIZED_ENTRIES, {
    from: "2026-07-15T00:00:00.000Z",
    to: "2026-08-03T00:00:00.000Z",
  });

  assert.equal(report.entryCount, 3);
  assert.equal(report.skippedOutOfWindow, 3);
  assert.equal(report.observed.first, "2026-07-19T00:00:00.000Z");
  assert.equal(report.observed.last, "2026-08-02T00:00:00.000Z");
  assert.equal(report.totalBtc, 0.183);
  assert.equal(report.byYieldKind.counterparty.btc, 0.125);
  assert.equal(report.byYieldKind.emissions.btc, 0);
});

test("an empty ledger reports zeroes rather than dividing by zero", () => {
  const report = aggregateRealizedYield([]);
  assert.equal(report.totalBtc, 0);
  assert.equal(report.entryCount, 0);
  assert.equal(report.sustainableShareBps, 0);
  assert.equal(report.emissionsShareBps, 0);
  assert.equal(report.counterpartyShareBps, 0);
  assert.deepEqual(report.bySeam, {});
});

test("invalid entries are rejected", () => {
  assert.throws(
    () => aggregateRealizedYield([{ ...REALIZED_ENTRIES[0], amountBtc: -0.01 }]),
    (error: unknown) => error instanceof SeamRouterError && error.code === "INVALID_ENTRY",
  );
  assert.throws(
    () => aggregateRealizedYield([{ ...REALIZED_ENTRIES[0], at: "not-a-timestamp" }]),
    (error: unknown) => error instanceof SeamRouterError && error.code === "INVALID_TIMESTAMP",
  );
  assert.throws(
    () =>
      aggregateRealizedYield(REALIZED_ENTRIES, {
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-07-01T00:00:00.000Z",
      }),
    (error: unknown) => error instanceof SeamRouterError && error.code === "INVALID_TIMESTAMP",
  );
});
