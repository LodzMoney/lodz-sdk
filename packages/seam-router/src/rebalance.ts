import { fail } from "./errors.js";
import {
  BPS_TOTAL,
  MAX_CAPITAL_BTC,
  btcToSats,
  isFiniteNumber,
  isNonNegativeNumber,
  isObject,
  largestRemainder,
  roundTo,
  satsToBtc,
  sum,
} from "./math.js";
import type {
  AllocationSnapshot,
  RebalanceInput,
  RebalanceMove,
  RebalancePlan,
  SkippedMove,
} from "./types.js";

const DAYS_PER_YEAR = 365;

function readSnapshots(
  snapshots: readonly AllocationSnapshot[],
  field: string,
): Map<string, number> {
  if (!Array.isArray(snapshots as unknown)) {
    fail("INVALID_ALLOCATION", `${field} must be an array`);
  }
  const map = new Map<string, number>();
  let total = 0;
  for (let index = 0; index < snapshots.length; index += 1) {
    const snapshot = snapshots[index];
    const at = `${field}[${index}]`;
    if (!isObject(snapshot)) {
      fail("INVALID_ALLOCATION", `${at} must be an object`);
    }
    if (typeof snapshot.seamId !== "string" || snapshot.seamId.length === 0) {
      fail("INVALID_ALLOCATION", `${at}.seamId must be a non-empty string`);
    }
    if (
      !isFiniteNumber(snapshot.allocationBps) ||
      !Number.isInteger(snapshot.allocationBps) ||
      snapshot.allocationBps < 0
    ) {
      fail("INVALID_ALLOCATION", `${at}.allocationBps must be a non-negative integer`, {
        seamId: snapshot.seamId,
        allocationBps: snapshot.allocationBps,
      });
    }
    if (map.has(snapshot.seamId)) {
      fail("INVALID_ALLOCATION", `${at}.seamId "${snapshot.seamId}" appears more than once`, {
        seamId: snapshot.seamId,
      });
    }
    map.set(snapshot.seamId, snapshot.allocationBps);
    total += snapshot.allocationBps;
  }
  if (total > BPS_TOTAL) {
    fail("INVALID_ALLOCATION", `${field} sums to ${total} bps, which exceeds ${BPS_TOTAL}`, {
      total,
    });
  }
  return map;
}

/**
 * Turn a current book into a target book, skipping the trades that are not worth doing.
 *
 * Two filters run before anything is executed. A per-seam threshold drops deltas too
 * small to bother with, and, when APY data and a horizon are supplied, a spread test
 * drops moves whose expected gain over that horizon does not clear the execution cost.
 * Everything filtered out is reported in `skipped` with the reason attached, because a
 * trade that quietly did not happen is worse than one that visibly did not.
 */
export function planRebalance(input: RebalanceInput): RebalancePlan {
  const { minDeltaBps, gasCostBps } = input;

  if (!isFiniteNumber(minDeltaBps) || !Number.isInteger(minDeltaBps) || minDeltaBps < 0) {
    fail("INVALID_ALLOCATION", "minDeltaBps must be a non-negative integer", { minDeltaBps });
  }
  if (!isNonNegativeNumber(gasCostBps)) {
    fail("INVALID_ALLOCATION", "gasCostBps must be a non-negative finite number", { gasCostBps });
  }

  const hasApy = input.apyBpsBySeamId !== undefined;
  const hasHorizon = input.horizonDays !== undefined;
  if (hasApy !== hasHorizon) {
    fail(
      "INVALID_ALLOCATION",
      "apyBpsBySeamId and horizonDays must be supplied together; without both the cost/benefit gate cannot be evaluated",
    );
  }
  if (hasHorizon && (!isFiniteNumber(input.horizonDays) || (input.horizonDays as number) <= 0)) {
    fail("INVALID_ALLOCATION", "horizonDays must be greater than 0", {
      horizonDays: input.horizonDays,
    });
  }

  if (input.forcedExitSeamIds !== undefined) {
    if (!Array.isArray(input.forcedExitSeamIds as unknown)) {
      fail("INVALID_ALLOCATION", "forcedExitSeamIds must be an array of seam ids");
    }
    for (const id of input.forcedExitSeamIds) {
      if (typeof id !== "string" || id.length === 0) {
        fail("INVALID_ALLOCATION", "forcedExitSeamIds entries must be non-empty strings", { id });
      }
    }
  }

  let capitalSats: number | null = null;
  if (input.capitalBtc !== undefined) {
    if (!isNonNegativeNumber(input.capitalBtc) || input.capitalBtc > MAX_CAPITAL_BTC) {
      fail("INVALID_CAPITAL", "capitalBtc must be a non-negative finite number within supply", {
        capitalBtc: input.capitalBtc,
      });
    }
    capitalSats = btcToSats(input.capitalBtc);
  }

  const current = readSnapshots(input.current, "current");
  const target = readSnapshots(input.target, "target");

  const ids = Array.from(new Set([...current.keys(), ...target.keys()])).sort();
  const skipped: SkippedMove[] = [];
  const retained = new Map<string, number>();

  for (const id of ids) {
    const delta = (target.get(id) ?? 0) - (current.get(id) ?? 0);
    if (delta === 0) continue;
    if (Math.abs(delta) < minDeltaBps) {
      skipped.push({
        reason: "below-min-delta",
        bps: Math.abs(delta),
        seamId: id,
        detail: `delta of ${delta} bps is under the ${minDeltaBps} bps threshold; trading it would pay more in fees than it corrects`,
      });
      continue;
    }
    retained.set(id, delta);
  }

  const apyOf = (id: string): number => {
    const map = input.apyBpsBySeamId;
    if (map === undefined) return 0;
    const value = map[id];
    if (!isFiniteNumber(value)) {
      fail("INVALID_ALLOCATION", `apyBpsBySeamId is missing a finite entry for seam "${id}"`, {
        seamId: id,
      });
    }
    return value;
  };

  interface Side {
    id: string;
    requestedBps: number;
    keptBps: number;
  }

  const sources: Side[] = [];
  const sinks: Side[] = [];
  for (const [id, delta] of retained) {
    if (delta < 0) sources.push({ id, requestedBps: -delta, keptBps: -delta });
    else sinks.push({ id, requestedBps: delta, keptBps: delta });
  }

  // Every basis point that leaves one seam has to arrive at another. The two sides can
  // end up unequal for two reasons: the target book is a different size from the
  // current one, or the per-seam threshold dropped a delta from one side only. Either
  // way the larger side is trimmed so the book still adds up, and the trim is reported
  // against the seam that gave it up.
  const outTotal = sum(sources.map((side) => side.requestedBps));
  const inTotal = sum(sinks.map((side) => side.requestedBps));
  const matchedBps = Math.min(outTotal, inTotal);

  const currentTotal = sum(Array.from(current.values()));
  const targetTotal = sum(Array.from(target.values()));
  const sizeGapBps = Math.abs(targetTotal - currentTotal);

  const trim = (sides: Side[], total: number): void => {
    if (total === matchedBps) return;
    const kept = largestRemainder(
      sides.map((side) => side.requestedBps),
      matchedBps,
    );
    for (let index = 0; index < sides.length; index += 1) {
      const side = sides[index];
      side.keptBps = kept[index] ?? 0;
      const trimmed = side.requestedBps - side.keptBps;
      if (trimmed > 0) {
        skipped.push({
          reason: "unmatched",
          bps: trimmed,
          seamId: side.id,
          detail:
            sizeGapBps > 0
              ? `${trimmed} bps had no counterparty: the current book totals ${currentTotal} bps and the target totals ${targetTotal} bps, a gap of ${sizeGapBps} bps that a rebalance cannot close`
              : `${trimmed} bps had no counterparty once below-threshold deltas were dropped`,
        });
      }
    }
  };

  trim(sources, outTotal);
  trim(sinks, inTotal);

  // Cheapest yield out first, richest yield in first. With the sides ordered this way
  // the head pair carries the widest spread available, so if it fails the cost test
  // every remaining pair fails it too.
  if (hasApy) {
    sources.sort((a, b) => apyOf(a.id) - apyOf(b.id) || (a.id < b.id ? -1 : 1));
    sinks.sort((a, b) => apyOf(b.id) - apyOf(a.id) || (a.id < b.id ? -1 : 1));
  } else {
    sources.sort((a, b) => (a.id < b.id ? -1 : 1));
    sinks.sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  const horizonDays = input.horizonDays ?? 0;
  const requiredSpreadBps = hasApy && horizonDays > 0 ? (gasCostBps * DAYS_PER_YEAR) / horizonDays : 0;

  const moves: RebalanceMove[] = [];

  const execute = (source: Side, sink: Side): void => {
    const bps = Math.min(source.keptBps, sink.keptBps);
    const spreadBps = hasApy ? apyOf(sink.id) - apyOf(source.id) : null;
    const share = bps / BPS_TOTAL;

    moves.push({
      fromSeamId: source.id,
      toSeamId: sink.id,
      bps,
      btc: capitalSats === null ? null : satsToBtc(Math.round(capitalSats * share)),
      costBps: roundTo(share * gasCostBps, 6),
      expectedGainBps:
        spreadBps === null ? null : roundTo(share * spreadBps * (horizonDays / DAYS_PER_YEAR), 6),
    });

    source.keptBps -= bps;
    sink.keptBps -= bps;
  };

  // A position that breached a ceiling comes down first, and the cost test does not get
  // a vote. The seam that breached is normally the highest-yielding one in the book, so
  // every exit out of it looks unprofitable on spread alone. Letting the gate veto those
  // exits would leave every risk ceiling advisory.
  const forced = new Set(input.forcedExitSeamIds ?? []);
  for (const source of sources) {
    if (!forced.has(source.id)) continue;
    for (const sink of sinks) {
      if (source.keptBps === 0) break;
      if (sink.keptBps === 0) continue;
      execute(source, sink);
    }
  }

  let sourceIndex = 0;
  let sinkIndex = 0;
  let gateStopped = false;

  while (sourceIndex < sources.length && sinkIndex < sinks.length) {
    const source = sources[sourceIndex];
    const sink = sinks[sinkIndex];
    if (source.keptBps === 0 || forced.has(source.id)) {
      sourceIndex += 1;
      continue;
    }
    if (sink.keptBps === 0) {
      sinkIndex += 1;
      continue;
    }

    if (hasApy) {
      const spreadBps = apyOf(sink.id) - apyOf(source.id);
      if (spreadBps <= requiredSpreadBps) {
        gateStopped = true;
        break;
      }
    }

    execute(source, sink);
  }

  if (gateStopped) {
    const detail = `expected spread does not clear the ${roundTo(requiredSpreadBps, 2)} bps APY spread needed to earn back ${gasCostBps} bps of execution cost over ${horizonDays} days`;
    for (const side of [...sources, ...sinks]) {
      if (side.keptBps > 0) {
        skipped.push({ reason: "cost-exceeds-gain", bps: side.keptBps, seamId: side.id, detail });
      }
    }
  }

  const resultingMap = new Map<string, number>();
  for (const id of ids) resultingMap.set(id, current.get(id) ?? 0);
  for (const move of moves) {
    resultingMap.set(move.fromSeamId, (resultingMap.get(move.fromSeamId) ?? 0) - move.bps);
    resultingMap.set(move.toSeamId, (resultingMap.get(move.toSeamId) ?? 0) + move.bps);
  }

  const resulting: AllocationSnapshot[] = ids
    .map((id) => ({ seamId: id, allocationBps: resultingMap.get(id) ?? 0 }))
    .sort((a, b) => b.allocationBps - a.allocationBps || (a.seamId < b.seamId ? -1 : 1));

  const residualDriftBps = sum(
    ids.map((id) => Math.abs((resultingMap.get(id) ?? 0) - (target.get(id) ?? 0))),
  );
  const turnoverBps = sum(moves.map((move) => move.bps));
  const gains = moves.map((move) => move.expectedGainBps);
  const expectedGainBps = hasApy ? roundTo(sum(gains.map((gain) => gain ?? 0)), 6) : null;

  return {
    moves,
    skipped,
    turnoverBps,
    estimatedCostBps: roundTo((turnoverBps / BPS_TOTAL) * gasCostBps, 6),
    expectedGainBps,
    resulting,
    residualDriftBps,
  };
}
