/**
 * Risk layers, ordered from the outside in.
 *
 * A BTC position on Solana fails one layer at a time: the bridge that moved it,
 * the party holding the backing coins, the protocol paying the yield, the price
 * feed that protocol trusts, and the depth available when the position has to
 * be closed.
 */
export type RiskLayer = "bridge" | "custody" | "protocol" | "oracle" | "liquidity";

export const RISK_LAYERS: readonly RiskLayer[] = [
  "bridge",
  "custody",
  "protocol",
  "oracle",
  "liquidity",
];

/**
 * Severity on a fixed 1..5 scale.
 *
 * 1 is the floor. There is no 0: every layer of this system can fail, and a
 * scale with a zero on it invites a total that reads as no exposure.
 */
export type Severity = 1 | 2 | 3 | 4 | 5;

export const MIN_SEVERITY: Severity = 1;
export const MAX_SEVERITY: Severity = 5;

/** Severity at or above which a layer is treated as a headline exposure. */
export const HIGH_SEVERITY: Severity = 4;

/**
 * Severity assigned to a layer nobody supplied evidence for.
 *
 * Deliberately mid scale rather than low: absence of evidence is not evidence
 * of safety, and an unevidenced layer must not pull a composite score down.
 */
export const UNEVIDENCED_SEVERITY: Severity = 3;

/** One observed, sourced risk statement about one layer. */
export interface RiskFactor {
  layer: RiskLayer;
  /** Short description of the exposure, e.g. "single custodian holds reserves". */
  label: string;
  severity: Severity;
  /** Why this severity was assigned. */
  rationale: string;
  /** Where the claim can be checked. Null when no public source exists. */
  evidenceUrl: string | null;
}

export function isRiskLayer(value: unknown): value is RiskLayer {
  return typeof value === "string" && (RISK_LAYERS as readonly string[]).includes(value);
}

export function isSeverity(value: unknown): value is Severity {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

/** Clamp an arbitrary integer onto the severity scale. Never returns 0. */
export function clampSeverity(value: number): Severity {
  const rounded = Math.round(value);
  if (rounded <= MIN_SEVERITY) return MIN_SEVERITY;
  if (rounded >= MAX_SEVERITY) return MAX_SEVERITY;
  return rounded as Severity;
}
