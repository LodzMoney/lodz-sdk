/** Machine-readable failure codes raised by this package. */
export type SeamRouterErrorCode =
  | "INVALID_SEAM"
  | "DUPLICATE_SEAM"
  | "INVALID_CAPITAL"
  | "INVALID_PROFILE"
  | "INVALID_CONSTRAINT"
  | "INVALID_TIMESTAMP"
  | "INVALID_ALLOCATION"
  | "INVALID_ENTRY"
  | "INVALID_BOND_PARAMS";

/** Thrown for every rejected input. Never used for control flow inside the package. */
export class SeamRouterError extends Error {
  public readonly code: SeamRouterErrorCode;
  public readonly details: Record<string, unknown> | undefined;

  public constructor(
    code: SeamRouterErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SeamRouterError";
    this.code = code;
    this.details = details;
  }
}

export function fail(
  code: SeamRouterErrorCode,
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new SeamRouterError(code, message, details);
}
