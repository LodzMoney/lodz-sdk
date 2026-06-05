/**
 * Error classes.
 *
 * Every failure path throws. Nothing here returns an empty result to stand in
 * for an error, because a caller that receives `{ seams: [] }` cannot tell a
 * genuinely empty catalogue from an unreachable service, and the second one
 * rendered as the first is how a dashboard ends up quietly showing zero.
 */

/** Shape the service returns on a non-2xx response. */
export interface LodzErrorBody {
  readonly code: string;
  readonly message: string;
  readonly detail: string | null;
}

/** Base class. Catch this to catch anything the client throws. */
export class LodzError extends Error {
  override readonly name: string = "LodzError";
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The service answered with a non-2xx status and a parseable error body.
 * `code`, `detail` and `requestId` come straight from the service so a report
 * can quote the request the operator needs to look up.
 */
export class LodzApiError extends LodzError {
  override readonly name = "LodzApiError";
  readonly status: number;
  readonly code: string;
  readonly detail: string | null;
  readonly requestId: string | null;
  readonly path: string | null;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    detail?: string | null;
    requestId?: string | null;
    path?: string | null;
  }) {
    const suffix = init.detail ? ` (${init.detail})` : "";
    const rid = init.requestId ? ` [request ${init.requestId}]` : "";
    super(`LODZ API ${init.status} ${init.code}: ${init.message}${suffix}${rid}`);
    this.status = init.status;
    this.code = init.code;
    this.detail = init.detail ?? null;
    this.requestId = init.requestId ?? null;
    this.path = init.path ?? null;
  }
}

/** The request never produced an HTTP response: DNS, connection refused, TLS. */
export class LodzNetworkError extends LodzError {
  override readonly name = "LodzNetworkError";
  override readonly cause: unknown;
  constructor(url: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`LODZ request to ${url} failed before a response: ${reason}`);
    this.cause = cause;
  }
}

/** The request exceeded the configured timeout, or the caller aborted it. */
export class LodzTimeoutError extends LodzError {
  override readonly name = "LodzTimeoutError";
  readonly timeoutMs: number;
  constructor(url: string, timeoutMs: number) {
    super(`LODZ request to ${url} timed out after ${timeoutMs} ms`);
    this.timeoutMs = timeoutMs;
  }
}

/**
 * A response arrived but was not the shape this client understands: not JSON,
 * or missing a field the caller is about to read. Surfaced rather than coerced,
 * so a service change is a loud failure instead of silent undefined.
 */
export class LodzResponseError extends LodzError {
  override readonly name = "LodzResponseError";
  readonly status: number;
  constructor(url: string, status: number, reason: string) {
    super(`LODZ response from ${url} (${status}) was unusable: ${reason}`);
    this.status = status;
  }
}

/**
 * A mint on the denylist was supplied. These are not "risky" assets, they are
 * assets that already failed, and routing into one is a loss, not a trade-off.
 */
export class LodzDeniedAssetError extends LodzError {
  override readonly name = "LodzDeniedAssetError";
  readonly mint: string;
  readonly label: string;
  readonly reason: string;
  constructor(mint: string, label: string, reason: string) {
    super(`Mint ${mint} (${label}) is on the LODZ denylist: ${reason}`);
    this.mint = mint;
    this.label = label;
    this.reason = reason;
  }
}

/** A caller argument is invalid, detected before any request is sent. */
export class LodzUsageError extends LodzError {
  override readonly name = "LodzUsageError";
  constructor(message: string) {
    super(message);
  }
}
