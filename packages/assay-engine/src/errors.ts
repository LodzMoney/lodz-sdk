/** Machine readable reason an assay input was rejected. */
export type AssayErrorCode =
  | "INVALID_SEAM"
  | "INVALID_ALLOCATION"
  | "INVALID_INPUT"
  | "EMPTY_PORTFOLIO"
  | "STOPE_EXCLUDES_EVERY_SEAM"
  | "ALL_SEAMS_BELOW_LIQUIDITY_FLOOR";

export interface AssayErrorDetail {
  /** Field that failed validation, when the failure is field specific. */
  field?: string;
  /** Seam the failure belongs to, when the failure is seam specific. */
  seamId?: string;
}

/**
 * Thrown for every rejected input. The engine never repairs a malformed
 * portfolio silently: a wrong number that is quietly corrected still reaches
 * the user as a wrong number.
 */
export class AssayError extends Error {
  readonly code: AssayErrorCode;
  readonly field: string | undefined;
  readonly seamId: string | undefined;

  constructor(code: AssayErrorCode, message: string, detail: AssayErrorDetail = {}) {
    super(message);
    this.name = "AssayError";
    this.code = code;
    this.field = detail.field;
    this.seamId = detail.seamId;
    Object.setPrototypeOf(this, AssayError.prototype);
  }
}
