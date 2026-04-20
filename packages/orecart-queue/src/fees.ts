import { fail } from "./errors.js";
import {
  BPS_TOTAL,
  MAX_AMOUNT_BTC,
  btcToSats,
  clamp,
  isBps,
  isNonNegativeNumber,
  isObject,
  isPositiveNumber,
  satsToBtc,
} from "./math.js";
import type { RedemptionFeeBreakdown, RedemptionFeeInput, RedemptionFeeParams } from "./types.js";

function assertParams(params: RedemptionFeeParams): void {
  if (!isObject(params)) {
    fail("INVALID_FEE_PARAMS", "params must be an object");
  }
  for (const field of ["baseFeeBps", "immediateFeeBps", "minFeeBps", "maxFeeBps"] as const) {
    if (!isBps(params[field])) {
      fail("INVALID_FEE_PARAMS", `params.${field} must be an integer between 0 and ${BPS_TOTAL}`, {
        field,
        value: params[field],
      });
    }
  }
  if (params.maxFeeBps < params.minFeeBps) {
    fail("INVALID_FEE_PARAMS", "params.maxFeeBps must be at least params.minFeeBps", {
      minFeeBps: params.minFeeBps,
      maxFeeBps: params.maxFeeBps,
    });
  }
  if (!isNonNegativeNumber(params.standardWaitDays)) {
    fail("INVALID_FEE_PARAMS", "params.standardWaitDays must be a non-negative finite number");
  }
  if (params.decayCurve !== "linear" && params.decayCurve !== "exponential") {
    fail("INVALID_FEE_PARAMS", 'params.decayCurve must be "linear" or "exponential"', {
      decayCurve: params.decayCurve,
    });
  }
  if (params.decayCurve === "exponential" && !isPositiveNumber(params.decayHalfLifeDays)) {
    fail(
      "INVALID_FEE_PARAMS",
      "params.decayHalfLifeDays must be greater than 0 when decayCurve is exponential",
      { decayHalfLifeDays: params.decayHalfLifeDays },
    );
  }
  if (params.utilizationSurchargeBps !== undefined && !isBps(params.utilizationSurchargeBps)) {
    fail(
      "INVALID_FEE_PARAMS",
      `params.utilizationSurchargeBps must be an integer between 0 and ${BPS_TOTAL}`,
    );
  }
  if (params.sizeTiers !== undefined) {
    if (!Array.isArray(params.sizeTiers)) {
      fail("INVALID_FEE_PARAMS", "params.sizeTiers must be an array");
    }
    for (let index = 0; index < params.sizeTiers.length; index += 1) {
      const tier = params.sizeTiers[index];
      const at = `params.sizeTiers[${index}]`;
      if (!isObject(tier)) {
        fail("INVALID_FEE_PARAMS", `${at} must be an object`);
      }
      if (!isNonNegativeNumber(tier.minAmountBtc)) {
        fail("INVALID_FEE_PARAMS", `${at}.minAmountBtc must be a non-negative finite number`);
      }
      if (!isBps(tier.surchargeBps)) {
        fail("INVALID_FEE_PARAMS", `${at}.surchargeBps must be an integer between 0 and ${BPS_TOTAL}`);
      }
    }
  }
}

/**
 * Full fee calculation with every component shown separately.
 *
 * Not one constant in this function is hard-coded. The policy has to match the on-chain
 * vault parameters exactly, and the program is the authority, so every number is
 * supplied by the caller.
 *
 * The shape of the policy is deliberate: an immediate exit pays a premium that decays
 * to nothing by the standard wait. Someone leaving in a hurry is asking the queue to
 * prioritise them over depositors who accepted the published wait, and the premium is
 * what they pay for that.
 */
export function redemptionFeeBreakdown(input: RedemptionFeeInput): RedemptionFeeBreakdown {
  if (!isObject(input)) {
    fail("INVALID_FEE_PARAMS", "input must be an object");
  }
  const { amountBtc, waitDays, params } = input;
  assertParams(params);

  if (!isNonNegativeNumber(amountBtc) || amountBtc > MAX_AMOUNT_BTC) {
    fail("INVALID_AMOUNT", "amountBtc must be a non-negative finite number within supply", {
      amountBtc,
    });
  }
  if (!isNonNegativeNumber(waitDays)) {
    fail("INVALID_AMOUNT", "waitDays must be a non-negative finite number", { waitDays });
  }

  let urgency: number;
  if (params.decayCurve === "exponential") {
    const halfLife = params.decayHalfLifeDays ?? 1;
    urgency = 2 ** (-waitDays / halfLife);
  } else if (params.standardWaitDays <= 0) {
    urgency = 0;
  } else {
    urgency = clamp((params.standardWaitDays - waitDays) / params.standardWaitDays, 0, 1);
  }

  let sizeSurchargeBps = 0;
  if (params.sizeTiers !== undefined) {
    const sorted = [...params.sizeTiers].sort((a, b) => a.minAmountBtc - b.minAmountBtc);
    for (const tier of sorted) {
      if (amountBtc >= tier.minAmountBtc) sizeSurchargeBps = tier.surchargeBps;
    }
  }

  const urgencyFeeBps = Math.round(params.immediateFeeBps * urgency);
  const utilizationSurchargeBps = params.utilizationSurchargeBps ?? 0;
  const rawFeeBps =
    params.baseFeeBps + urgencyFeeBps + sizeSurchargeBps + utilizationSurchargeBps;

  const feeBps = Math.round(clamp(rawFeeBps, params.minFeeBps, params.maxFeeBps));
  let clampedBy: RedemptionFeeBreakdown["clampedBy"] = null;
  if (rawFeeBps < params.minFeeBps) clampedBy = "min";
  else if (rawFeeBps > params.maxFeeBps) clampedBy = "max";

  const amountSats = btcToSats(amountBtc);
  const feeSats = Math.round(amountSats * (feeBps / BPS_TOTAL));
  const netSats = amountSats - feeSats;

  return {
    feeBps,
    feeBtc: satsToBtc(feeSats),
    feeSats,
    netBtc: satsToBtc(netSats),
    netSats,
    baseFeeBps: params.baseFeeBps,
    urgencyFeeBps,
    sizeSurchargeBps,
    utilizationSurchargeBps,
    urgency,
    clampedBy,
  };
}

/**
 * Redemption fee in basis points.
 *
 * A longer accepted wait always costs the same or less, never more. Use
 * {@link redemptionFeeBreakdown} when the caller needs to show why.
 */
export function redemptionFeeBps(input: RedemptionFeeInput): number {
  return redemptionFeeBreakdown(input).feeBps;
}
