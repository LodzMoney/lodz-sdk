import { BPS_DENOMINATOR, roundDivInt } from "@lodz/assay-engine";
import type { Allocation, RiskTier, Seam } from "@lodz/assay-engine";
import { resolvePortfolio } from "@lodz/assay-engine";

import { assessSeam, tierFromScore } from "./assess.js";
import type { AssessSeamOptions, SeamRiskAssessment } from "./assess.js";
import { HeadlampError } from "./errors.js";
import type { RiskFactor, RiskLayer, Severity } from "./types.js";
import { HIGH_SEVERITY, RISK_LAYERS } from "./types.js";

/** A seam paired with the risk statements observed about it. */
export interface SeamRiskEntry {
  seam: Seam;
  factors: readonly RiskFactor[];
}

/** How much capital sits behind one layer across the whole portfolio. */
export interface LayerExposure {
  layer: RiskLayer;
  /** Allocation weighted severity in centi-severity, 100..500. */
  weightedSeverity: number;
  /** Worst severity anywhere in this layer. Not averaged. */
  worstSeverity: Severity;
  /** Seam carrying `worstSeverity`, or null when no capital is allocated. */
  worstSeamId: string | null;
  /** Capital sitting on severity 4 or worse in this layer, in bps. */
  highSeverityAllocationBps: number;
  /** Capital with no evidence supplied for this layer, in bps. */
  unevidencedAllocationBps: number;
}

export interface PortfolioWorstLayer {
  layer: RiskLayer;
  severity: Severity;
  seamId: string;
  label: string;
}

export interface Concentration {
  topSeamId: string;
  topSeamBps: number;
  topAsset: string;
  topAssetBps: number;
  topVenue: string;
  topVenueBps: number;
}

export interface PortfolioRiskAssessment {
  allocation: Allocation;
  seams: SeamRiskAssessment[];
  /** Allocation weighted composite score in centi-severity, 100..500. */
  weightedScore: number;
  weightedTier: RiskTier;
  /**
   * The single worst layer holding capital anywhere in the portfolio.
   * Reported next to the weighted tier, never averaged into it.
   */
  worstLayer: PortfolioWorstLayer;
  /** The worst scoring seam holding capital. */
  worstSeam: { seamId: string; compositeScore: number; tier: RiskTier };
  layers: LayerExposure[];
  /** Capital touching any layer at severity 4 or worse, in bps. */
  highSeverityAllocationBps: number;
  /** Capital touching at least one unevidenced layer, in bps. */
  unevidencedAllocationBps: number;
  concentration: Concentration;
}

function topOf(totals: Map<string, number>): { key: string; bps: number } {
  let key = "";
  let bps = -1;
  for (const [candidate, value] of totals) {
    if (value > bps || (value === bps && candidate < key)) {
      key = candidate;
      bps = value;
    }
  }
  return { key, bps: bps < 0 ? 0 : bps };
}

/**
 * Assess a whole portfolio, weighted by allocation.
 *
 * The weighted score answers "what is the average exposure of this capital".
 * It is not allowed to answer "how bad can this get": a severity 5 bridge on 5%
 * of capital barely moves the average, so `worstLayer`, `worstSeam` and the per
 * layer `worstSeverity` are reported undiluted alongside it.
 *
 * @param seams      Seams paired with their observed risk factors.
 * @param allocation Optional override; defaults to each seam's `allocationBps`.
 * @param options    Forwarded to `assessSeam`, so a custody ledger passed here
 *                   reaches every seam and its floors apply portfolio wide.
 */
export function assessPortfolio(
  seams: readonly SeamRiskEntry[],
  allocation?: Allocation,
  options: AssessSeamOptions = {},
): PortfolioRiskAssessment {
  if (!Array.isArray(seams)) {
    throw new HeadlampError("INVALID_INPUT", "seams must be an array of seam and factor pairs", {
      field: "seams",
    });
  }
  if (seams.length === 0) {
    throw new HeadlampError("EMPTY_PORTFOLIO", "at least one seam is required", {
      field: "seams",
    });
  }
  for (const entry of seams) {
    if (entry === null || typeof entry !== "object" || entry.seam === undefined) {
      throw new HeadlampError(
        "INVALID_INPUT",
        "each entry must be an object shaped { seam, factors }",
        { field: "seams" },
      );
    }
  }

  const portfolio = resolvePortfolio(
    seams.map((entry) => entry.seam),
    allocation,
  );
  const effectiveAllocation = portfolio.allocation;

  const assessments = seams.map((entry) => assessSeam(entry.seam, entry.factors ?? [], options));
  const allocationFor = (seamId: string): number => effectiveAllocation[seamId] ?? 0;

  let weightedNumerator = 0;
  let highSeverityAllocationBps = 0;
  let unevidencedAllocationBps = 0;

  const seamTotals = new Map<string, number>();
  const assetTotals = new Map<string, number>();
  const venueTotals = new Map<string, number>();

  assessments.forEach((assessment, index) => {
    const entry = seams[index];
    const bps = allocationFor(assessment.seamId);
    weightedNumerator += bps * assessment.compositeScore;
    if (assessment.highSeverityLayers.length > 0) highSeverityAllocationBps += bps;
    if (assessment.unevidencedLayers.length > 0) unevidencedAllocationBps += bps;

    seamTotals.set(assessment.seamId, bps);
    assetTotals.set(assessment.asset, (assetTotals.get(assessment.asset) ?? 0) + bps);
    const venue = entry?.seam.venue ?? assessment.venue;
    venueTotals.set(venue, (venueTotals.get(venue) ?? 0) + bps);
  });

  const weightedScore = Math.max(100, roundDivInt(weightedNumerator, BPS_DENOMINATOR));

  const layers: LayerExposure[] = RISK_LAYERS.map((layer) => {
    let weightedNumeratorForLayer = 0;
    let worstSeverity = 1 as Severity;
    let worstSeamId: string | null = null;
    let layerHighSeverityBps = 0;
    let layerUnevidencedBps = 0;

    for (const assessment of assessments) {
      const bps = allocationFor(assessment.seamId);
      const layerAssessment = assessment.layers.find((candidate) => candidate.layer === layer);
      if (layerAssessment === undefined) continue;
      weightedNumeratorForLayer += bps * layerAssessment.severity * 100;
      if (bps > 0 && (worstSeamId === null || layerAssessment.severity > worstSeverity)) {
        worstSeverity = layerAssessment.severity;
        worstSeamId = assessment.seamId;
      }
      if (layerAssessment.severity >= HIGH_SEVERITY) layerHighSeverityBps += bps;
      if (!layerAssessment.evidenced) layerUnevidencedBps += bps;
    }

    return {
      layer,
      weightedSeverity: roundDivInt(weightedNumeratorForLayer, BPS_DENOMINATOR),
      worstSeverity,
      worstSeamId,
      highSeverityAllocationBps: layerHighSeverityBps,
      unevidencedAllocationBps: layerUnevidencedBps,
    };
  });

  // The undiluted worst: the highest severity layer on any seam holding capital.
  let worstLayer: PortfolioWorstLayer | null = null;
  for (const assessment of assessments) {
    if (allocationFor(assessment.seamId) === 0) continue;
    for (const layerAssessment of assessment.layers) {
      if (worstLayer === null || layerAssessment.severity > worstLayer.severity) {
        worstLayer = {
          layer: layerAssessment.layer,
          severity: layerAssessment.severity,
          seamId: assessment.seamId,
          label:
            layerAssessment.worstFactor?.label ?? "no evidence supplied for this layer",
        };
      }
    }
  }
  if (worstLayer === null) {
    throw new HeadlampError("EMPTY_PORTFOLIO", "no seam in this portfolio holds any capital");
  }

  const allocatedAssessments = assessments.filter(
    (assessment) => allocationFor(assessment.seamId) > 0,
  );
  const worstSeamAssessment = allocatedAssessments.reduce((worst, assessment) =>
    assessment.compositeScore > worst.compositeScore ? assessment : worst,
  );

  const topSeam = topOf(seamTotals);
  const topAsset = topOf(assetTotals);
  const topVenue = topOf(venueTotals);

  return {
    allocation: effectiveAllocation,
    seams: assessments,
    weightedScore,
    weightedTier: tierFromScore(weightedScore),
    worstLayer,
    worstSeam: {
      seamId: worstSeamAssessment.seamId,
      compositeScore: worstSeamAssessment.compositeScore,
      tier: worstSeamAssessment.tier,
    },
    layers,
    highSeverityAllocationBps,
    unevidencedAllocationBps,
    concentration: {
      topSeamId: topSeam.key,
      topSeamBps: topSeam.bps,
      topAsset: topAsset.key,
      topAssetBps: topAsset.bps,
      topVenue: topVenue.key,
      topVenueBps: topVenue.bps,
    },
  };
}
