import { fail } from "./errors.js";

export const MS_PER_DAY = 86_400_000;

/**
 * Parse an ISO-8601 timestamp into epoch milliseconds.
 *
 * Every timestamp this package consumes arrives as an argument. Nothing here reads the
 * system clock, which is what makes the planners reproducible for a given input.
 */
export function parseTimestamp(value: string, field: string): number {
  if (typeof value !== "string" || value.length === 0) {
    fail("INVALID_TIMESTAMP", `${field} must be a non-empty ISO-8601 string`, { field, value });
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    fail("INVALID_TIMESTAMP", `${field} is not a parseable ISO-8601 timestamp`, { field, value });
  }
  return parsed;
}

export function daysBetween(fromMs: number, toMs: number): number {
  return (toMs - fromMs) / MS_PER_DAY;
}
