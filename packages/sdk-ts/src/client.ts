/**
 * LodzClient -- a typed reader for the LODZ indexer API.
 *
 * The client carries no credentials and holds no RPC endpoint. Every figure it
 * returns comes from the indexer, which is the only component that talks to a
 * keyed provider. Embedding a paid RPC URL in a published package would put the
 * key in every consumer's bundle.
 */

import { assertRoutableMint } from "./assets.js";
import { LodzUsageError } from "./errors.js";
import { request, type FetchLike, type RequestOptions, type TransportConfig } from "./http.js";
import type {
  AssayRequest,
  AssayResponse,
  HeaderMetrics,
  HealthResponse,
  QueueResponse,
  RiskResponse,
  SeamsResponse,
  Stope,
  VaultsResponse,
  YieldType,
} from "./types.js";

const STOPES: readonly Stope[] = ["conservative", "balanced", "aggressive"];
const YIELD_TYPES: readonly YieldType[] = ["sustainable", "emissions", "counterparty"];

export interface LodzClientOptions {
  /** Base URL of the indexer, for example `https://api.lodz.fi`. */
  readonly apiUrl: string;
  /** Injected fetch. Defaults to the global. */
  readonly fetch?: FetchLike;
  /** Per-request timeout in milliseconds. Default 15000. */
  readonly timeoutMs?: number;
  /** Extra headers sent with every request. */
  readonly headers?: Readonly<Record<string, string>>;
}

function normaliseBaseUrl(apiUrl: string): string {
  if (typeof apiUrl !== "string" || apiUrl.trim() === "") {
    throw new LodzUsageError("apiUrl is required, for example https://api.lodz.fi");
  }
  const trimmed = apiUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(trimmed)) {
    throw new LodzUsageError(`apiUrl must start with http:// or https://, got ${apiUrl}`);
  }
  return trimmed;
}

function resolveFetch(injected: FetchLike | undefined): FetchLike {
  if (injected) return injected;
  const g = (globalThis as { fetch?: unknown }).fetch;
  if (typeof g !== "function") {
    throw new LodzUsageError(
      "No fetch available. Use Node 18 or newer, or pass one as options.fetch.",
    );
  }
  return g as FetchLike;
}

export class LodzClient {
  readonly #cfg: TransportConfig;

  constructor(options: LodzClientOptions) {
    this.#cfg = {
      baseUrl: normaliseBaseUrl(options.apiUrl),
      fetch: resolveFetch(options.fetch),
      timeoutMs: options.timeoutMs ?? 15_000,
      headers: { accept: "application/json", ...(options.headers ?? {}) },
    };
  }

  /** The configured base URL, normalised. */
  get apiUrl(): string {
    return this.#cfg.baseUrl;
  }

  health(opts?: RequestOptions): Promise<HealthResponse> {
    return request<HealthResponse>(this.#cfg, "GET", "/health", opts);
  }

  readonly seams = {
    /**
     * The seam catalogue.
     *
     * `type` filters client-side on the response, so the totals block still
     * describes the whole catalogue. That is deliberate: a filtered view whose
     * totals silently changed to match would hide the fact that the emissions
     * count is zero across every seam, which is the finding.
     */
    list: async (
      params: { readonly type?: YieldType; readonly stope?: Stope } & RequestOptions = {},
    ): Promise<SeamsResponse> => {
      const { type, stope, ...opts } = params;
      if (type !== undefined && !YIELD_TYPES.includes(type)) {
        throw new LodzUsageError(
          `Unknown yield type ${JSON.stringify(type)}. Expected one of ${YIELD_TYPES.join(", ")}.`,
        );
      }
      const query = stope ? `?stope=${encodeURIComponent(this.#stope(stope))}` : "";
      const body = await request<SeamsResponse>(this.#cfg, "GET", `/seams${query}`, opts);
      if (!type) return body;
      return { ...body, seams: body.seams.filter((s) => s.yield_type === type) };
    },
  };

  readonly assay = {
    /**
     * Break a deposit down into sustainable, emitted and counterparty yield.
     *
     * Async so that argument validation rejects rather than throwing
     * synchronously. A method returning a promise that sometimes throws before
     * returning one forces every caller to write both a try/catch and a .catch,
     * and whichever they forget is the path that escapes.
     */
    estimate: async (params: AssayRequest & RequestOptions): Promise<AssayResponse> => {
      const { btcAmount, stope, ...opts } = params;
      if (!Number.isFinite(btcAmount) || btcAmount <= 0) {
        throw new LodzUsageError(`btcAmount must be a positive number, got ${String(btcAmount)}`);
      }
      return request<AssayResponse>(this.#cfg, "POST", "/assay", {
        ...opts,
        body: { btc_amount: btcAmount, stope: this.#stope(stope ?? "balanced") },
      });
    },
  };

  readonly orecart = {
    /** Redemption queue state and the wait ladder. */
    queue: async (
      params: { readonly owner?: string; readonly stope?: Stope } & RequestOptions = {},
    ): Promise<QueueResponse> => {
      const { owner, stope, ...opts } = params;
      const q = new URLSearchParams();
      if (owner) q.set("owner", owner);
      if (stope) q.set("stope", this.#stope(stope));
      const query = q.toString() ? `?${q.toString()}` : "";
      return request<QueueResponse>(this.#cfg, "GET", `/orecart/queue${query}`, opts);
    },
  };

  readonly headlamp = {
    /** Bridge, custody and protocol risk layers. */
    risk: (opts?: RequestOptions): Promise<RiskResponse> =>
      request<RiskResponse>(this.#cfg, "GET", "/headlamp/risk", opts),
  };

  readonly stope = {
    /** The three risk-tiered vaults. */
    vaults: (opts?: RequestOptions): Promise<VaultsResponse> =>
      request<VaultsResponse>(this.#cfg, "GET", "/stope/vaults", opts),
  };

  readonly metrics = {
    /** Header trust indicators. Every value is measured, none is hard-coded. */
    header: (opts?: RequestOptions): Promise<HeaderMetrics> =>
      request<HeaderMetrics>(this.#cfg, "GET", "/metrics/header", opts),
  };

  /**
   * Validate a BTC mint before it goes into a request.
   * Throws for a denylisted or unknown mint. Symbols are not accepted.
   */
  assertRoutableMint(mint: string): string {
    return assertRoutableMint(mint);
  }

  #stope(value: Stope): Stope {
    if (!STOPES.includes(value)) {
      throw new LodzUsageError(
        `Unknown stope ${JSON.stringify(value)}. Expected one of ${STOPES.join(", ")}.`,
      );
    }
    return value;
  }
}
