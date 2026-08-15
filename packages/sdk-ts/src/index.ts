/**
 * @lodz/sdk -- typed client for the LODZ BTC yield layer.
 *
 * Yield is reported in three kinds, not two. See {@link YieldType}.
 * BTC assets are identified by mint, never by symbol: WBTC has two distinct
 * mints on Solana and a symbol lookup resolves to the wrong one silently.
 */

export { LodzClient } from "./client.js";
export type { LodzClientOptions } from "./client.js";
export type { FetchLike, RequestOptions } from "./http.js";

export {
  LodzError,
  LodzApiError,
  LodzNetworkError,
  LodzTimeoutError,
  LodzResponseError,
  LodzDeniedAssetError,
  LodzUsageError,
} from "./errors.js";
export type { LodzErrorBody } from "./errors.js";

export {
  BTC_ASSETS,
  DENIED_MINTS,
  assetByMint,
  assertRoutableMint,
  isDeniedMint,
  deniedEntry,
} from "./assets.js";
export type { BtcAsset, DeniedAsset, TrustModel } from "./assets.js";

export type * from "./types.js";
