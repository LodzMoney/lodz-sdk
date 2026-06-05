/**
 * Transport. One place where a request turns into either a parsed body or a
 * thrown error, so no caller has to remember to check a status code.
 */

import {
  LodzApiError,
  LodzNetworkError,
  LodzResponseError,
  LodzTimeoutError,
  type LodzErrorBody,
} from "./errors.js";

/** Minimal shape this client needs from fetch, so a stub is easy to supply. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface RequestOptions {
  /** Aborts the request when it fires. Combined with the configured timeout. */
  readonly signal?: AbortSignal;
  /** Overrides the client timeout for this call. */
  readonly timeoutMs?: number;
}

export interface TransportConfig {
  readonly baseUrl: string;
  readonly fetch: FetchLike;
  readonly timeoutMs: number;
  readonly headers: Readonly<Record<string, string>>;
}

function isAbortError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "name" in e &&
    (e as { name?: unknown }).name === "AbortError"
  );
}

/** Parse the service error envelope. Falls back to the raw text. */
function toApiError(url: string, status: number, text: string): LodzApiError {
  let body: LodzErrorBody | undefined;
  let requestId: string | null = null;
  let path: string | null = null;
  try {
    const parsed = JSON.parse(text) as {
      error?: LodzErrorBody;
      request_id?: string;
      path?: string;
    };
    body = parsed.error;
    requestId = parsed.request_id ?? null;
    path = parsed.path ?? null;
  } catch {
    // Not JSON. Handled below by the fallback.
  }
  return new LodzApiError({
    status,
    code: body?.code ?? "http_error",
    message: body?.message ?? (text.trim() === "" ? url : text.slice(0, 200)),
    detail: body?.detail ?? null,
    requestId,
    path,
  });
}

export async function request<T>(
  cfg: TransportConfig,
  method: "GET" | "POST",
  path: string,
  opts: RequestOptions & { body?: unknown } = {},
): Promise<T> {
  const url = `${cfg.baseUrl}${path}`;
  const timeoutMs = opts.timeoutMs ?? cfg.timeoutMs;

  // Own controller so the timeout can abort, chained to the caller's signal so
  // their abort still works.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onCallerAbort, { once: true });
  }

  let status: number;
  let text: string;
  let ok: boolean;
  try {
    const headers: Record<string, string> = { ...cfg.headers };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await cfg.fetch(url, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: controller.signal,
    });
    ok = res.ok;
    status = res.status;
    text = await res.text();
  } catch (e) {
    if (timedOut) throw new LodzTimeoutError(url, timeoutMs);
    if (isAbortError(e)) throw new LodzTimeoutError(url, timeoutMs);
    throw new LodzNetworkError(url, e);
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onCallerAbort);
  }

  if (!ok) throw toApiError(url, status, text);

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new LodzResponseError(
      url,
      status,
      `expected JSON, got ${text.length} characters starting ${JSON.stringify(text.slice(0, 60))}`,
    );
  }
}
