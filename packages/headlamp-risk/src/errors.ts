/** Machine readable reason a headlamp input was rejected. */
export type HeadlampErrorCode =
  | "INVALID_FACTOR"
  | "INVALID_INPUT"
  | "INVALID_CUSTODY_MODEL"
  | "EMPTY_PORTFOLIO";

export interface HeadlampErrorDetail {
  field?: string;
  seamId?: string;
  asset?: string;
}

/**
 * Thrown for every rejected input. A malformed risk statement is never dropped
 * silently: a dropped factor reads downstream as an exposure that was measured
 * and found to be nothing.
 */
export class HeadlampError extends Error {
  readonly code: HeadlampErrorCode;
  readonly field: string | undefined;
  readonly seamId: string | undefined;
  readonly asset: string | undefined;

  constructor(code: HeadlampErrorCode, message: string, detail: HeadlampErrorDetail = {}) {
    super(message);
    this.name = "HeadlampError";
    this.code = code;
    this.field = detail.field;
    this.seamId = detail.seamId;
    this.asset = detail.asset;
    Object.setPrototypeOf(this, HeadlampError.prototype);
  }
}
