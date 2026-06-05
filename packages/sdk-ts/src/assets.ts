/**
 * BTC representations on Solana, identified by mint.
 *
 * Symbols are not identifiers here and no lookup in this file accepts one.
 * WBTC exists on Solana under two distinct mints -- a Wormhole-wrapped route
 * that carries the liquidity, and the BitGo canonical mint that holds about
 * $46K -- so "WBTC" resolves to two different assets with different risk and
 * different depth. A symbol lookup picks one of them silently. Mints do not
 * have that failure mode.
 */

import { LodzDeniedAssetError, LodzUsageError } from "./errors.js";

/** How the claim on bitcoin is held. */
export type TrustModel = "custodial" | "bridged" | "program-controlled";

export interface BtcAsset {
  /** Display symbol. Never used for lookup. */
  readonly symbol: string;
  readonly mint: string;
  readonly issuer: string;
  readonly trustModel: TrustModel;
  /**
   * Number of wrapping steps between bitcoin and this token. Each hop is a
   * separate party that can fail independently.
   */
  readonly wrapHops: number;
  /** Whether the issuer can freeze a holder's account. */
  readonly freezable: boolean;
}

/**
 * Routable assets. cbBTC, WBTC and zBTC deliberately span the three trust
 * models: a custodian holds it, a bridge holds it, or a program holds it.
 */
export const BTC_ASSETS: readonly BtcAsset[] = Object.freeze([
  Object.freeze({
    symbol: "cbBTC",
    mint: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
    issuer: "Coinbase",
    trustModel: "custodial",
    wrapHops: 1,
    freezable: true,
  }),
  Object.freeze({
    symbol: "WBTC",
    mint: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
    issuer: "BitGo via Wormhole",
    trustModel: "bridged",
    wrapHops: 2,
    freezable: false,
  }),
  Object.freeze({
    symbol: "zBTC",
    mint: "zBTCug3er3tLyffELcvDNrKkCymbPWysGcWihESYfLg",
    issuer: "Zeus Network",
    trustModel: "program-controlled",
    wrapHops: 1,
    freezable: false,
  }),
  Object.freeze({
    symbol: "xBTC",
    mint: "CtzPWv73Sn1dMGVU3ZtLv9yWSyUAanBni19YWDaznnkn",
    issuer: "OKX",
    trustModel: "custodial",
    wrapHops: 1,
    freezable: true,
  }),
]);

export interface DeniedAsset {
  readonly mint: string;
  readonly label: string;
  readonly reason: string;
}

/**
 * Mints that must never be routed into. These are not judgement calls about
 * risk appetite; each one is a measured failure.
 */
export const DENIED_MINTS: readonly DeniedAsset[] = Object.freeze([
  Object.freeze({
    mint: "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E",
    label: "soBTC (Sollet)",
    reason: "depegged 99.96 percent, issuer defunct",
  }),
  Object.freeze({
    mint: "21BTCo9hWHjGYYUQQLqjLgDBxjcn8vDt4Zic7TB3UbNE",
    label: "21BTC",
    reason: "economically dead",
  }),
  Object.freeze({
    mint: "5XZw2LKTyrfvfiskJ78AMpackRjPcyCif1WhUsPDuVqQ",
    label: "WBTC (BitGo canonical)",
    reason:
      "about $46K of liquidity on Solana; the routable WBTC is the Wormhole mint 3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
  }),
]);

const BY_MINT = new Map(BTC_ASSETS.map((a) => [a.mint, a]));
const DENIED_BY_MINT = new Map(DENIED_MINTS.map((d) => [d.mint, d]));

/** True when the mint is on the denylist. */
export function isDeniedMint(mint: string): boolean {
  return DENIED_BY_MINT.has(mint);
}

/** The denylist entry for a mint, or undefined. */
export function deniedEntry(mint: string): DeniedAsset | undefined {
  return DENIED_BY_MINT.get(mint);
}

/**
 * Resolve a mint to a routable asset.
 *
 * Throws {@link LodzDeniedAssetError} for a denylisted mint and
 * {@link LodzUsageError} for anything else unrecognised. It never falls back to
 * a symbol and never returns a partially populated asset.
 */
export function assetByMint(mint: string): BtcAsset {
  if (typeof mint !== "string" || mint.length === 0) {
    throw new LodzUsageError("A mint address is required; symbols are not accepted.");
  }
  const denied = DENIED_BY_MINT.get(mint);
  if (denied) {
    throw new LodzDeniedAssetError(denied.mint, denied.label, denied.reason);
  }
  const asset = BY_MINT.get(mint);
  if (!asset) {
    throw new LodzUsageError(
      `Unknown mint ${mint}. Routable mints: ${BTC_ASSETS.map((a) => a.mint).join(", ")}`,
    );
  }
  return asset;
}

/**
 * Throw if the mint is denylisted, otherwise return it unchanged. Use before
 * putting a caller-supplied mint into a request.
 */
export function assertRoutableMint(mint: string): string {
  assetByMint(mint);
  return mint;
}
