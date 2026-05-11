import { YIELD_KINDS } from "./constraints.js";
import { fail } from "./errors.js";
import {
  BPS_TOTAL,
  btcToSats,
  isNonNegativeNumber,
  isObject,
  largestRemainder,
  satsToBtc,
} from "./math.js";
import { parseTimestamp } from "./time.js";
import type {
  AggregateWindow,
  RealizedYieldEntry,
  RealizedYieldReport,
  SplitBucket,
  YieldBucket,
  YieldKind,
} from "./types.js";

interface Accumulator {
  sats: number;
  entries: number;
  byKind: Record<YieldKind, number>;
  countByKind: Record<YieldKind, number>;
}

function emptyAccumulator(): Accumulator {
  return {
    sats: 0,
    entries: 0,
    byKind: { sustainable: 0, emissions: 0, counterparty: 0 },
    countByKind: { sustainable: 0, emissions: 0, counterparty: 0 },
  };
}

function add(map: Map<string, Accumulator>, key: string, entry: RealizedYieldEntry, sats: number): void {
  let bucket = map.get(key);
  if (bucket === undefined) {
    bucket = emptyAccumulator();
    map.set(key, bucket);
  }
  bucket.sats += sats;
  bucket.entries += 1;
  bucket.byKind[entry.yieldKind] += sats;
  bucket.countByKind[entry.yieldKind] += 1;
}

/**
 * Distribute exact basis-point shares over a set of buckets so the shares add to 10000.
 * Reporting a split that does not add up invites the reader to assume rounding hides
 * something, so the rounding is made to close instead.
 */
function exactShares(values: readonly number[], totalSats: number): number[] {
  if (totalSats <= 0) return values.map(() => 0);
  return largestRemainder(values, BPS_TOTAL);
}

function splitShares(bucket: Accumulator): Record<YieldKind, number> {
  if (bucket.sats <= 0) return { sustainable: 0, emissions: 0, counterparty: 0 };
  const parts = largestRemainder(
    YIELD_KINDS.map((kind) => bucket.byKind[kind]),
    BPS_TOTAL,
  );
  return {
    sustainable: parts[0] ?? 0,
    emissions: parts[1] ?? 0,
    counterparty: parts[2] ?? 0,
  };
}

/**
 * Aggregate realized yield, split by where it actually came from.
 *
 * The report never collapses the three sources into a single headline number. Every
 * level of the breakdown carries all of them, because the combined total on its own
 * tells a depositor nothing about whether the yield survives the end of an emission
 * schedule or the month the traders on the other side stop losing.
 */
export function aggregateRealizedYield(
  entries: readonly RealizedYieldEntry[],
  window?: AggregateWindow,
): RealizedYieldReport {
  if (!Array.isArray(entries as unknown)) {
    fail("INVALID_ENTRY", "entries must be an array");
  }

  const fromMs = window?.from === undefined ? null : parseTimestamp(window.from, "window.from");
  const toMs = window?.to === undefined ? null : parseTimestamp(window.to, "window.to");
  if (fromMs !== null && toMs !== null && toMs < fromMs) {
    fail("INVALID_TIMESTAMP", "window.to must not precede window.from", { window });
  }

  const bySeamMap = new Map<string, Accumulator>();
  const byVenueMap = new Map<string, Accumulator>();
  const byTokenMap = new Map<string, Accumulator>();
  const total = emptyAccumulator();

  let skippedOutOfWindow = 0;
  let firstMs: number | null = null;
  let lastMs: number | null = null;
  let firstAt: string | null = null;
  let lastAt: string | null = null;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const at = `entries[${index}]`;
    if (!isObject(entry)) {
      fail("INVALID_ENTRY", `${at} must be an object`);
    }
    if (typeof entry.seamId !== "string" || entry.seamId.length === 0) {
      fail("INVALID_ENTRY", `${at}.seamId must be a non-empty string`);
    }
    if (typeof entry.venue !== "string" || entry.venue.length === 0) {
      fail("INVALID_ENTRY", `${at}.venue must be a non-empty string`);
    }
    if (typeof entry.token !== "string" || entry.token.length === 0) {
      fail("INVALID_ENTRY", `${at}.token must be a non-empty string`);
    }
    if (!YIELD_KINDS.includes(entry.yieldKind)) {
      fail("INVALID_ENTRY", `${at}.yieldKind must be one of ${YIELD_KINDS.join(", ")}`);
    }
    if (!isNonNegativeNumber(entry.amountBtc)) {
      fail("INVALID_ENTRY", `${at}.amountBtc must be a non-negative finite number`, {
        seamId: entry.seamId,
        amountBtc: entry.amountBtc,
      });
    }

    const atMs = parseTimestamp(entry.at, `${at}.at`);
    if (fromMs !== null && atMs < fromMs) {
      skippedOutOfWindow += 1;
      continue;
    }
    if (toMs !== null && atMs >= toMs) {
      skippedOutOfWindow += 1;
      continue;
    }

    const sats = btcToSats(entry.amountBtc);
    total.sats += sats;
    total.entries += 1;
    total.byKind[entry.yieldKind] += sats;
    total.countByKind[entry.yieldKind] += 1;

    if (firstMs === null || atMs < firstMs) {
      firstMs = atMs;
      firstAt = entry.at;
    }
    if (lastMs === null || atMs > lastMs) {
      lastMs = atMs;
      lastAt = entry.at;
    }

    add(bySeamMap, entry.seamId, entry, sats);
    add(byVenueMap, entry.venue, entry, sats);
    add(byTokenMap, entry.token, entry, sats);
  }

  const totalSats = total.sats;

  const buildSplit = (map: Map<string, Accumulator>): Record<string, SplitBucket> => {
    const keys = Array.from(map.keys()).sort();
    const shares = exactShares(
      keys.map((key) => map.get(key)?.sats ?? 0),
      totalSats,
    );
    const result: Record<string, SplitBucket> = {};
    keys.forEach((key, position) => {
      const bucket = map.get(key) ?? emptyAccumulator();
      const kindShares = splitShares(bucket);
      result[key] = {
        btc: satsToBtc(bucket.sats),
        sats: bucket.sats,
        entries: bucket.entries,
        shareBps: shares[position] ?? 0,
        sustainableBtc: satsToBtc(bucket.byKind.sustainable),
        emissionsBtc: satsToBtc(bucket.byKind.emissions),
        counterpartyBtc: satsToBtc(bucket.byKind.counterparty),
        sustainableShareBps: kindShares.sustainable,
        emissionsShareBps: kindShares.emissions,
        counterpartyShareBps: kindShares.counterparty,
      };
    });
    return result;
  };

  const buildFlat = (map: Map<string, Accumulator>): Record<string, YieldBucket> => {
    const keys = Array.from(map.keys()).sort();
    const shares = exactShares(
      keys.map((key) => map.get(key)?.sats ?? 0),
      totalSats,
    );
    const result: Record<string, YieldBucket> = {};
    keys.forEach((key, position) => {
      const bucket = map.get(key) ?? emptyAccumulator();
      result[key] = {
        btc: satsToBtc(bucket.sats),
        sats: bucket.sats,
        entries: bucket.entries,
        shareBps: shares[position] ?? 0,
      };
    });
    return result;
  };

  const kindShares = splitShares(total);
  const byYieldKind = {} as Record<YieldKind, YieldBucket>;
  for (const kind of YIELD_KINDS) {
    byYieldKind[kind] = {
      btc: satsToBtc(total.byKind[kind]),
      sats: total.byKind[kind],
      entries: total.countByKind[kind],
      shareBps: kindShares[kind],
    };
  }

  return {
    totalBtc: satsToBtc(totalSats),
    totalSats,
    entryCount: total.entries,
    byYieldKind,
    bySeam: buildSplit(bySeamMap),
    byVenue: buildSplit(byVenueMap),
    byToken: buildFlat(byTokenMap),
    sustainableShareBps: kindShares.sustainable,
    emissionsShareBps: kindShares.emissions,
    counterpartyShareBps: kindShares.counterparty,
    window: { from: window?.from ?? null, to: window?.to ?? null },
    observed: { first: firstAt, last: lastAt },
    skippedOutOfWindow,
  };
}
