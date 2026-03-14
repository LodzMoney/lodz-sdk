import { MS_PER_DAY, roundTo } from "./bps.js";
import { AssayError } from "./errors.js";
import type { EvaluationInstant } from "./types.js";

const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** True when the string parses as an ISO-8601 date or date-time. */
export function isIso8601(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_8601.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

/** Parse an evaluation instant, or throw with the offending field named. */
export function parseInstant(value: EvaluationInstant, field: string): Date {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new AssayError("INVALID_INPUT", `${field} is an invalid Date`, { field });
    }
    return new Date(value.getTime());
  }
  if (!isIso8601(value)) {
    throw new AssayError(
      "INVALID_INPUT",
      `${field} must be an ISO-8601 instant, received ${JSON.stringify(value)}`,
      { field },
    );
  }
  return new Date(Date.parse(value));
}

/** Resolve an optional instant, defaulting to now. */
export function resolveInstant(value: EvaluationInstant | undefined, field: string): Date {
  return value === undefined ? new Date() : parseInstant(value, field);
}

export function toIso(value: Date): string {
  return value.toISOString();
}

/** Fractional days from `from` to `to`. Negative when `to` precedes `from`. */
export function daysBetween(from: Date, to: Date): number {
  return roundTo((to.getTime() - from.getTime()) / MS_PER_DAY, 6);
}

/** Add fractional days to an instant, rounded to whole milliseconds. */
export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + Math.round(days * MS_PER_DAY));
}
