import { BPS_DENOMINATOR, roundDivInt } from "./bps.js";
import { decomposeResolved } from "./decompose.js";
import { daysBetween, parseInstant, resolveInstant, toIso } from "./time.js";
import type { Allocation, EvaluationInstant, Seam } from "./types.js";
import { resolvePortfolio } from "./validate.js";

/** One flat segment of the emissions decay curve. */
export interface EmissionStep {
  /** Instant this step begins, ISO-8601. */
  at: string;
  /** Instant this step ends, ISO-8601, or null for the terminal step. */
  endsAt: string | null;
  /** Fractional days from the evaluation instant to the start of this step. */
  dayOffset: number;
  /** Fractional days this step lasts, or null for the terminal step. */
  durationDays: number | null;
  /** Seams whose emissions program ended at the boundary opening this step. */
  endedSeamIds: string[];
  /** Seams still paying emissions during this step. */
  activeEmissionSeamIds: string[];
  /** Portfolio rate in force during this step, in bps. */
  apyBps: number;
  sustainableApyBps: number;
  emissionsApyBps: number;
  counterpartyApyBps: number;
  /** Drop against the previous step, in bps. Zero for the first step. */
  dropBps: number;
}

/** What the portfolio rate looks like once the incentive programs stop. */
export interface PostEmissionsProjection {
  /** Instant the simulation was evaluated at, ISO-8601. */
  at: string;
  /** Portfolio rate right now, in bps. */
  currentApyBps: number;
  currentSustainableApyBps: number;
  currentEmissionsApyBps: number;
  currentCounterpartyApyBps: number;
  /**
   * Capital sitting in emissions funded seams, in bps. Always reported, and 0
   * is a real answer: a market with no live incentive programs is a fact worth
   * stating rather than an empty section.
   */
  emissionExposureBps: number;
  /** Share of the current rate that comes from incentive programs, in bps. */
  emissionsRateShareBps: number;
  /** False when no allocated seam is paying emissions at `at`. */
  hasLiveEmissions: boolean;
  /** Portfolio rate once every emissions program has ended, in bps. */
  postEmissionsApyBps: number;
  /** Rate lost between now and the terminal step, in bps. */
  totalDropBps: number;
  /** Share of the current rate that survives, in bps. */
  retainedRatioBps: number;
  /** Instant the last emissions program ends, ISO-8601, or null when none pends. */
  finalEmissionEndsAt: string | null;
  /** Fractional days until the last emissions program ends, or null. */
  daysUntilFinalEmissionEnd: number | null;
  /**
   * The rate as a step curve. Element 0 is the rate in force now; each later
   * element opens at an emissions end date. The terminal element is the
   * sustainable-only floor.
   */
  steps: EmissionStep[];
}

/**
 * Project the portfolio rate forward across every emissions end date.
 *
 * When programs end on different dates the answer is not one number, it is a
 * staircase: the rate steps down once per end date. Returning only the floor
 * would hide when the drops land, and returning only the current rate would
 * hide that they land at all.
 *
 * @param seams Portfolio seams. Validated on every call.
 * @param at Instant to evaluate from. Defaults to now.
 * @param allocation Optional override; defaults to each seam's `allocationBps`.
 */
export function simulatePostEmissions(
  seams: readonly Seam[],
  at?: EvaluationInstant,
  allocation?: Allocation,
): PostEmissionsProjection {
  const portfolio = resolvePortfolio(seams, allocation);
  const from = resolveInstant(at, "at");
  return simulateResolved(portfolio.seams, portfolio.allocation, from);
}

/** Internal simulation over an already validated portfolio. */
export function simulateResolved(
  seams: readonly Seam[],
  allocation: Allocation,
  from: Date,
): PostEmissionsProjection {
  const fromMs = from.getTime();

  // Only allocated, still running programs can produce a future step.
  const boundaryMs = new Set<number>();
  for (const seam of seams) {
    if (seam.yieldKind !== "emissions" || seam.emissionEndsAt === null) continue;
    if ((allocation[seam.id] ?? 0) === 0) continue;
    const endsAtMs = parseInstant(seam.emissionEndsAt, "emissionEndsAt").getTime();
    if (endsAtMs > fromMs) boundaryMs.add(endsAtMs);
  }
  const boundaries = [...boundaryMs].sort((a, b) => a - b);

  const stepStarts = [fromMs, ...boundaries];
  const steps: EmissionStep[] = [];
  let previousApyBps: number | null = null;

  for (let index = 0; index < stepStarts.length; index += 1) {
    const startMs = stepStarts[index] ?? fromMs;
    const start = new Date(startMs);
    // Evaluating exactly at a boundary already treats that program as ended,
    // so each step carries the rate in force after the drop at its start.
    const snapshot = decomposeResolved(seams, allocation, start);

    const endedSeamIds =
      index === 0
        ? []
        : seams
            .filter(
              (seam) =>
                seam.yieldKind === "emissions" &&
                seam.emissionEndsAt !== null &&
                (allocation[seam.id] ?? 0) > 0 &&
                parseInstant(seam.emissionEndsAt, "emissionEndsAt").getTime() === startMs,
            )
            .map((seam) => seam.id);

    const nextStartMs = stepStarts[index + 1];
    const dropBps = previousApyBps === null ? 0 : previousApyBps - snapshot.apyBps;

    steps.push({
      at: toIso(start),
      endsAt: nextStartMs === undefined ? null : toIso(new Date(nextStartMs)),
      dayOffset: daysBetween(from, start),
      durationDays:
        nextStartMs === undefined ? null : daysBetween(start, new Date(nextStartMs)),
      endedSeamIds,
      activeEmissionSeamIds: snapshot.components
        .filter((component) => component.emissionActive && component.allocationBps > 0)
        .map((component) => component.seamId),
      apyBps: snapshot.apyBps,
      sustainableApyBps: snapshot.sustainableApyBps,
      emissionsApyBps: snapshot.emissionsApyBps,
      counterpartyApyBps: snapshot.counterpartyApyBps,
      dropBps,
    });
    previousApyBps = snapshot.apyBps;
  }

  const first = steps[0];
  const last = steps[steps.length - 1];
  const currentApyBps = first?.apyBps ?? 0;
  // The floor is the terminal step's whole rate, not just its sustainable part:
  // counterparty yield does not end on a date, so it survives the last step.
  const postEmissionsApyBps = last?.apyBps ?? 0;
  const finalBoundaryMs = boundaries[boundaries.length - 1];

  const snapshot = decomposeResolved(seams, allocation, from);
  const emissionExposureBps = snapshot.allocationByYieldKind.emissions;
  const currentEmissionsApyBps = first?.emissionsApyBps ?? 0;

  return {
    at: toIso(from),
    currentApyBps,
    currentSustainableApyBps: first?.sustainableApyBps ?? 0,
    currentEmissionsApyBps,
    currentCounterpartyApyBps: snapshot.counterpartyApyBps,
    emissionExposureBps,
    emissionsRateShareBps:
      currentApyBps > 0 ? roundDivInt(currentEmissionsApyBps * BPS_DENOMINATOR, currentApyBps) : 0,
    hasLiveEmissions: (first?.activeEmissionSeamIds.length ?? 0) > 0,
    postEmissionsApyBps,
    totalDropBps: currentApyBps - postEmissionsApyBps,
    retainedRatioBps:
      currentApyBps > 0 ? roundDivInt(postEmissionsApyBps * BPS_DENOMINATOR, currentApyBps) : 0,
    finalEmissionEndsAt: finalBoundaryMs === undefined ? null : toIso(new Date(finalBoundaryMs)),
    daysUntilFinalEmissionEnd:
      finalBoundaryMs === undefined ? null : daysBetween(from, new Date(finalBoundaryMs)),
    steps,
  };
}
