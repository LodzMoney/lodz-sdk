import { roundDivInt } from "@lodz/assay-engine";
import type { RiskTier, Seam, YieldKind } from "@lodz/assay-engine";
import { validateSeam } from "@lodz/assay-engine";

import {
  createCustodyLedger,
  custodyTouchesProtocolLayer,
  describeCustody,
  getCustodyLedger,
  protocolSeverityFor,
} from "./custody.js";
import type { CustodyLedger, ResolvedCustodyModel } from "./custody.js";
import { HeadlampError } from "./errors.js";
import type { RiskFactor, RiskLayer, Severity } from "./types.js";
import {
  HIGH_SEVERITY,
  RISK_LAYERS,
  UNEVIDENCED_SEVERITY,
  clampSeverity,
  isRiskLayer,
  isSeverity,
} from "./types.js";

/** Weight given to the single worst layer when scoring, in percent. */
export const WORST_LAYER_WEIGHT_PCT = 60;

/** Weight given to the mean across all layers when scoring, in percent. */
export const MEAN_LAYER_WEIGHT_PCT = 40;

/**
 * Tier boundaries on the composite scale, in centi-severity.
 *
 * The scale runs 100..500 because severity runs 1..5. It has no zero.
 */
export const TIER_THRESHOLDS: readonly { tier: RiskTier; maxScore: number }[] = [
  { tier: "low", maxScore: 200 },
  { tier: "medium", maxScore: 320 },
  { tier: "high", maxScore: Number.POSITIVE_INFINITY },
];

export function tierFromScore(score: number): RiskTier {
  for (const threshold of TIER_THRESHOLDS) {
    if (score <= threshold.maxScore) return threshold.tier;
  }
  return "high";
}

/** What is known about one layer of one seam. */
export interface LayerAssessment {
  layer: RiskLayer;
  /** Worst severity observed in this layer, or the unevidenced severity. */
  severity: Severity;
  /** False when no factor was supplied for this layer. */
  evidenced: boolean;
  factorCount: number;
  /** Factor driving `severity`, or null when the layer is unevidenced. */
  worstFactor: RiskFactor | null;
  factors: RiskFactor[];
}

export interface WorstLayerRef {
  layer: RiskLayer;
  severity: Severity;
  label: string;
  evidenced: boolean;
}

/** A severity that was raised because of a measured custody property. */
export interface AppliedFloor {
  layer: RiskLayer;
  /** Severity the supplied evidence produced on its own. */
  evidencedSeverity: Severity;
  /** Severity actually used after the floor was applied. */
  flooredSeverity: Severity;
  reason: string;
}

export interface AssessSeamOptions {
  /**
   * Custody record for this seam's asset. When omitted, it is looked up in
   * `ledger` by mint address first and then by symbol.
   */
  custody?: ResolvedCustodyModel | null;
  /** Ledger for the default lookup. Defaults to the module ledger. */
  ledger?: CustodyLedger;
  /**
   * Set false to score only the factors passed in, ignoring what the custody
   * record implies. The floors still apply: they are the point.
   */
  includeCustodyFactors?: boolean;
  /** Set false to leave out the factors implied by the seam's yield kind. */
  includeYieldKindFactors?: boolean;
}

export interface SeamRiskAssessment {
  seamId: string;
  asset: string;
  venue: string;
  /** All five layers, always, in `RISK_LAYERS` order. */
  layers: LayerAssessment[];
  evidencedLayers: RiskLayer[];
  /** Layers nobody supplied evidence for. Carried, never treated as clear. */
  unevidencedLayers: RiskLayer[];
  /** The single worst layer. Reported alongside the score, never folded into it. */
  worstLayer: WorstLayerRef;
  /** Composite score in centi-severity, 100..500. Never 0. */
  compositeScore: number;
  tier: RiskTier;
  /** The tier the seam catalog claims. */
  declaredTier: RiskTier;
  tierMatchesDeclared: boolean;
  /** True when the measured tier is worse than the catalog claims. */
  measuredWorseThanDeclared: boolean;
  /** Factors carrying no checkable source. */
  factorsWithoutEvidence: number;
  /** Layers sitting at or above `HIGH_SEVERITY`. */
  highSeverityLayers: RiskLayer[];
  /** How this seam's yield source behaves, independent of custody. */
  yieldKindRisk: { yieldKind: YieldKind; summary: string };
  /** The custody record used, when one was found. */
  custody: ResolvedCustodyModel | null;
  /** Severities raised by a measured custody property rather than by evidence. */
  appliedFloors: AppliedFloor[];
}

/** Custody severity floor when the issuer can freeze holder accounts. */
export const FREEZABLE_CUSTODY_FLOOR: Severity = 3;

/**
 * How a seam's yield source changes what can go wrong, independent of custody.
 *
 * A fee stream stops paying. A trading position can invert and take the
 * principal with it. They are not the same exposure and are not described as
 * though they were.
 */
export const YIELD_KIND_RISK: Readonly<
  Record<YieldKind, { summary: string; factors: readonly Omit<RiskFactor, "evidenceUrl">[] }>
> = Object.freeze({
  sustainable: {
    summary:
      "Yield is paid by outside users for a service the venue performs, so it persists as long as the venue is used.",
    factors: [],
  },
  emissions: {
    summary:
      "Yield is paid by an incentive program with an end date, so the rate steps down when the program stops.",
    factors: [
      {
        layer: "protocol",
        label: "payout depends on an incentive program that ends on a date",
        severity: 3,
        rationale:
          "The rate is funded by token issuance rather than by usage, and stops on the declared end date.",
      },
    ],
  },
  counterparty: {
    summary:
      "Yield is paid out of the losses of traders on the other side. It is a trading position, not a fee stream: it shrinks when the market is quiet and inverts when those traders win.",
    factors: [
      {
        layer: "protocol",
        label: "yield source inverts when the counterparty wins",
        severity: 4,
        rationale:
          "The payout is the other side of somebody else's trade, so a directional move against the vault turns the yield negative and can reach the principal.",
      },
      {
        layer: "liquidity",
        label: "yield depends on continued trading volume",
        severity: 3,
        rationale:
          "With no flow there are no counterparty losses to collect, so the rate decays toward zero in a quiet market.",
      },
    ],
  },
});

/**
 * Protocol severity floor implied by a custody record.
 *
 * Applies when issuance sits behind a private key or when the code has never
 * been audited. An issuance authority held by a program is not a clean bill of
 * health if nobody has reviewed the program.
 */
export function protocolFloorFor(custody: ResolvedCustodyModel): Severity | null {
  if (!custodyTouchesProtocolLayer(custody)) return null;
  return protocolSeverityFor(custody);
}

/**
 * Bridge severity floor implied by the number of wrapping hops.
 *
 * Hops do not add, they multiply: each one is a separate set of signers,
 * contracts and reserves that all have to hold. Two hops floors the bridge
 * layer at 4, three at the top of the scale.
 */
export function bridgeFloorForHops(wrapHops: number): Severity {
  return clampSeverity(2 * wrapHops);
}

const TIER_ORDER: Record<RiskTier, number> = { low: 0, medium: 1, high: 2 };

export function validateRiskFactor(factor: RiskFactor, seamId?: string): RiskFactor {
  if (factor === null || typeof factor !== "object") {
    throw new HeadlampError("INVALID_FACTOR", "risk factor must be an object", {
      ...(seamId === undefined ? {} : { seamId }),
    });
  }
  const detail = seamId === undefined ? {} : { seamId };
  if (!isRiskLayer(factor.layer)) {
    throw new HeadlampError(
      "INVALID_FACTOR",
      `layer must be one of ${RISK_LAYERS.join(", ")}, received ${String(factor.layer)}`,
      { field: "layer", ...detail },
    );
  }
  if (!isSeverity(factor.severity)) {
    throw new HeadlampError(
      "INVALID_FACTOR",
      `severity must be an integer from 1 to 5, received ${String(factor.severity)}`,
      { field: "severity", ...detail },
    );
  }
  if (typeof factor.label !== "string" || factor.label.trim().length === 0) {
    throw new HeadlampError("INVALID_FACTOR", "label must be a non-empty string", {
      field: "label",
      ...detail,
    });
  }
  if (typeof factor.rationale !== "string" || factor.rationale.trim().length === 0) {
    throw new HeadlampError("INVALID_FACTOR", "rationale must be a non-empty string", {
      field: "rationale",
      ...detail,
    });
  }
  if (factor.evidenceUrl !== null) {
    if (typeof factor.evidenceUrl !== "string") {
      throw new HeadlampError("INVALID_FACTOR", "evidenceUrl must be a string or null", {
        field: "evidenceUrl",
        ...detail,
      });
    }
    let parsed: URL;
    try {
      parsed = new URL(factor.evidenceUrl);
    } catch {
      throw new HeadlampError(
        "INVALID_FACTOR",
        `evidenceUrl must be an absolute URL, received ${factor.evidenceUrl}`,
        { field: "evidenceUrl", ...detail },
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new HeadlampError(
        "INVALID_FACTOR",
        `evidenceUrl must use http or https, received ${factor.evidenceUrl}`,
        { field: "evidenceUrl", ...detail },
      );
    }
  }
  return factor;
}

/**
 * Composite score from the five layer severities, in centi-severity.
 *
 * The worst layer carries most of the weight on purpose. A position with one
 * severity 5 layer and four severity 1 layers is not a low risk position, and a
 * plain mean would say it was.
 */
export function compositeScore(severities: readonly Severity[]): number {
  if (severities.length === 0) {
    throw new HeadlampError("INVALID_INPUT", "composite score needs at least one layer severity");
  }
  const worst = severities.reduce((max, value) => (value > max ? value : max), 1 as Severity);
  const meanCenti = roundDivInt(
    severities.reduce((sum, value) => sum + value * 100, 0),
    severities.length,
  );
  const score = roundDivInt(
    WORST_LAYER_WEIGHT_PCT * worst * 100 + MEAN_LAYER_WEIGHT_PCT * meanCenti,
    WORST_LAYER_WEIGHT_PCT + MEAN_LAYER_WEIGHT_PCT,
  );
  return Math.min(500, Math.max(100, score));
}

/**
 * Assess one seam across all five layers.
 *
 * Every layer is reported whether or not evidence was supplied. A layer with no
 * factors is marked unevidenced and scored at `UNEVIDENCED_SEVERITY`, so a thin
 * evidence set can never make a seam look safer than a well documented one.
 *
 * @param seam    The seam being assessed. Validated on every call.
 * @param factors Observed risk statements. May be empty.
 */
export function assessSeam(
  seam: Seam,
  factors: readonly RiskFactor[] = [],
  options: AssessSeamOptions = {},
): SeamRiskAssessment {
  validateSeam(seam);
  if (!Array.isArray(factors)) {
    throw new HeadlampError("INVALID_INPUT", "factors must be an array", {
      field: "factors",
      seamId: seam.id,
    });
  }
  for (const factor of factors) validateRiskFactor(factor, seam.id);

  // Resolve the custody record by mint first: tickers are not unique.
  const ledger = options.ledger ?? getCustodyLedger();
  const custody =
    options.custody !== undefined
      ? options.custody
      : (ledger.getByMint(seam.assetMint) ?? ledger.get(seam.asset));

  const custodyFactors =
    custody !== null && options.includeCustodyFactors !== false
      ? describeCustody(custody.assetMint ?? custody.asset, createCustodyLedger([custody]))
          .impliedFactors
      : [];
  const yieldKindProfile = YIELD_KIND_RISK[seam.yieldKind];
  const yieldKindFactors: RiskFactor[] =
    options.includeYieldKindFactors === false
      ? []
      : yieldKindProfile.factors.map((entry) => ({ ...entry, evidenceUrl: seam.sourceUrl }));
  const allFactors = [...factors, ...custodyFactors, ...yieldKindFactors];

  // Measured issuer powers set a floor no supplied evidence can undercut.
  const floors = new Map<RiskLayer, { severity: Severity; reason: string }>();
  if (custody !== null) {
    if (custody.freezable === true) {
      floors.set("custody", {
        severity: FREEZABLE_CUSTODY_FLOOR,
        reason: `${custody.asset} carries a freeze authority, so the issuer can freeze a holder's account`,
      });
    }
    const protocolFloor = protocolFloorFor(custody);
    if (protocolFloor !== null) {
      const reasons: string[] = [];
      if (custody.mintAuthorityIsKeypair === true) {
        reasons.push("its mint authority is a private key rather than a program address");
      }
      if (custody.audits === 0) reasons.push("no third party audit has been published");
      floors.set("protocol", {
        severity: protocolFloor,
        reason: `${custody.asset} ${reasons.join(" and ")}`,
      });
    }
    if (custody.wrapHops !== undefined && custody.wrapHops >= 1) {
      floors.set("bridge", {
        severity: bridgeFloorForHops(custody.wrapHops),
        reason: `${custody.asset} backing passes through ${custody.wrapHops} wrapping hop${custody.wrapHops === 1 ? "" : "s"}`,
      });
    }
  }

  const appliedFloors: AppliedFloor[] = [];

  const layers: LayerAssessment[] = RISK_LAYERS.map((layer) => {
    const layerFactors = allFactors.filter((factor) => factor.layer === layer);
    const floor = floors.get(layer);

    if (layerFactors.length === 0) {
      const evidencedSeverity = UNEVIDENCED_SEVERITY;
      const severity =
        floor !== undefined && floor.severity > evidencedSeverity
          ? floor.severity
          : evidencedSeverity;
      if (severity !== evidencedSeverity && floor !== undefined) {
        appliedFloors.push({ layer, evidencedSeverity, flooredSeverity: severity, reason: floor.reason });
      }
      return {
        layer,
        severity,
        evidenced: false,
        factorCount: 0,
        worstFactor: null,
        factors: [],
      };
    }

    const worstFactor = layerFactors.reduce((worst, factor) =>
      factor.severity > worst.severity ? factor : worst,
    );
    const evidencedSeverity = worstFactor.severity;
    const severity =
      floor !== undefined && floor.severity > evidencedSeverity ? floor.severity : evidencedSeverity;
    if (severity !== evidencedSeverity && floor !== undefined) {
      appliedFloors.push({ layer, evidencedSeverity, flooredSeverity: severity, reason: floor.reason });
    }

    return {
      layer,
      severity,
      evidenced: true,
      factorCount: layerFactors.length,
      worstFactor,
      factors: layerFactors,
    };
  });

  const worstAssessment = layers.reduce((worst, layer) =>
    layer.severity > worst.severity ? layer : worst,
  );
  const score = compositeScore(layers.map((layer) => layer.severity));
  const tier = tierFromScore(score);

  return {
    seamId: seam.id,
    asset: seam.asset,
    venue: seam.venue,
    layers,
    evidencedLayers: layers.filter((layer) => layer.evidenced).map((layer) => layer.layer),
    unevidencedLayers: layers.filter((layer) => !layer.evidenced).map((layer) => layer.layer),
    worstLayer: {
      layer: worstAssessment.layer,
      severity: worstAssessment.severity,
      label: worstAssessment.worstFactor?.label ?? "no evidence supplied for this layer",
      evidenced: worstAssessment.evidenced,
    },
    compositeScore: score,
    tier,
    declaredTier: seam.riskTier,
    tierMatchesDeclared: tier === seam.riskTier,
    measuredWorseThanDeclared: TIER_ORDER[tier] > TIER_ORDER[seam.riskTier],
    factorsWithoutEvidence: allFactors.filter((factor) => factor.evidenceUrl === null).length,
    highSeverityLayers: layers
      .filter((layer) => layer.severity >= HIGH_SEVERITY)
      .map((layer) => layer.layer),
    yieldKindRisk: { yieldKind: seam.yieldKind, summary: yieldKindProfile.summary },
    custody,
    appliedFloors,
  };
}
