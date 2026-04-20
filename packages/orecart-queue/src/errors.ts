/** Machine-readable failure codes raised by this package. */
export type OrecartQueueErrorCode =
  | "INVALID_QUEUE"
  | "INVALID_TICKET"
  | "DUPLICATE_TICKET"
  | "ORDER_VIOLATION"
  | "INVALID_AMOUNT"
  | "INVALID_TIMESTAMP"
  | "INVALID_THROUGHPUT"
  | "INVALID_FEE_PARAMS";

/** Thrown for every rejected input. Never used for control flow inside the package. */
export class OrecartQueueError extends Error {
  public readonly code: OrecartQueueErrorCode;
  public readonly details: Record<string, unknown> | undefined;

  public constructor(
    code: OrecartQueueErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "OrecartQueueError";
    this.code = code;
    this.details = details;
  }
}

export function fail(
  code: OrecartQueueErrorCode,
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new OrecartQueueError(code, message, details);
}
