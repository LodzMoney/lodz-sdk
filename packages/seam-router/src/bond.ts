import { STOPE_PROFILES, assertStopeProfile } from "./constraints.js";
import { fail } from "./errors.js";
import {
  BPS_TOTAL,
  MAX_CAPITAL_BTC,
  clamp,
  isBps,
  isFiniteNumber,
  isNonNegativeNumber,
  isObject,
  roundTo,
} from "./math.js";
import type { KeeperBondParams, KeeperBondRequirement, ResolvedSlashCondition } from "./types.js";

/**
 * Size the bond a keeper must post before it is allowed to move depositor capital, and
 * price every slash condition against that bond.
 *
 * The bond scales with the notional the keeper can touch, so a keeper routing a larger
 * book has proportionally more of its own capital at stake. Slash conditions are passed
 * in rather than defined here: they have to match the on-chain program byte for byte,
 * and the program is the authority.
 */
export function keeperBondRequirement(
  capitalBtc: number,
  params: KeeperBondParams,
): KeeperBondRequirement {
  if (!isNonNegativeNumber(capitalBtc) || capitalBtc > MAX_CAPITAL_BTC) {
    fail("INVALID_CAPITAL", "capitalBtc must be a non-negative finite number within supply", {
      capitalBtc,
    });
  }
  if (!isObject(params)) {
    fail("INVALID_BOND_PARAMS", "params must be an object");
  }
  if (!isFiniteNumber(params.btcPriceUsd) || params.btcPriceUsd <= 0) {
    fail("INVALID_BOND_PARAMS", "params.btcPriceUsd must be greater than 0", {
      btcPriceUsd: params.btcPriceUsd,
    });
  }
  if (!isFiniteNumber(params.lodzPriceUsd) || params.lodzPriceUsd <= 0) {
    fail("INVALID_BOND_PARAMS", "params.lodzPriceUsd must be greater than 0", {
      lodzPriceUsd: params.lodzPriceUsd,
    });
  }
  if (!isBps(params.bondRateBps)) {
    fail("INVALID_BOND_PARAMS", `params.bondRateBps must be an integer between 0 and ${BPS_TOTAL}`, {
      bondRateBps: params.bondRateBps,
    });
  }
  if (!isNonNegativeNumber(params.minBondUsd)) {
    fail("INVALID_BOND_PARAMS", "params.minBondUsd must be a non-negative finite number", {
      minBondUsd: params.minBondUsd,
    });
  }
  if (!isNonNegativeNumber(params.maxBondUsd) || params.maxBondUsd < params.minBondUsd) {
    fail("INVALID_BOND_PARAMS", "params.maxBondUsd must be at least params.minBondUsd", {
      minBondUsd: params.minBondUsd,
      maxBondUsd: params.maxBondUsd,
    });
  }
  if (!Array.isArray(params.slashConditions as unknown) || params.slashConditions.length === 0) {
    fail(
      "INVALID_BOND_PARAMS",
      "params.slashConditions must list at least one condition; a bond nobody can slash is not collateral",
    );
  }
  if (params.utilizationSurchargeBps !== undefined && !isBps(params.utilizationSurchargeBps)) {
    fail(
      "INVALID_BOND_PARAMS",
      `params.utilizationSurchargeBps must be an integer between 0 and ${BPS_TOTAL}`,
      { utilizationSurchargeBps: params.utilizationSurchargeBps },
    );
  }
  if (params.profileMultiplierBps !== undefined) {
    if (params.stope === undefined) {
      fail(
        "INVALID_BOND_PARAMS",
        "params.stope is required whenever params.profileMultiplierBps is supplied",
      );
    }
    assertStopeProfile(params.stope);
    for (const profile of STOPE_PROFILES) {
      const multiplier = params.profileMultiplierBps[profile];
      if (!isFiniteNumber(multiplier) || multiplier < 0) {
        fail(
          "INVALID_BOND_PARAMS",
          `params.profileMultiplierBps.${profile} must be a non-negative finite number`,
          { profile, multiplier },
        );
      }
    }
  } else if (params.stope !== undefined) {
    assertStopeProfile(params.stope);
  }

  const seenCodes = new Set<string>();
  for (let index = 0; index < params.slashConditions.length; index += 1) {
    const condition = params.slashConditions[index];
    const at = `params.slashConditions[${index}]`;
    if (!isObject(condition)) {
      fail("INVALID_BOND_PARAMS", `${at} must be an object`);
    }
    if (typeof condition.code !== "string" || condition.code.length === 0) {
      fail("INVALID_BOND_PARAMS", `${at}.code must be a non-empty string`);
    }
    if (seenCodes.has(condition.code)) {
      fail("INVALID_BOND_PARAMS", `${at}.code "${condition.code}" appears more than once`);
    }
    seenCodes.add(condition.code);
    if (typeof condition.description !== "string" || condition.description.length === 0) {
      fail("INVALID_BOND_PARAMS", `${at}.description must be a non-empty string`, {
        code: condition.code,
      });
    }
    if (!isBps(condition.slashBps)) {
      fail("INVALID_BOND_PARAMS", `${at}.slashBps must be an integer between 0 and ${BPS_TOTAL}`, {
        code: condition.code,
        slashBps: condition.slashBps,
      });
    }
    if (
      condition.graceSeconds !== undefined &&
      (!isNonNegativeNumber(condition.graceSeconds) || !Number.isInteger(condition.graceSeconds))
    ) {
      fail("INVALID_BOND_PARAMS", `${at}.graceSeconds must be a non-negative integer`, {
        code: condition.code,
      });
    }
  }

  const multiplierBps =
    params.profileMultiplierBps !== undefined && params.stope !== undefined
      ? params.profileMultiplierBps[params.stope]
      : BPS_TOTAL;
  const surchargeBps = params.utilizationSurchargeBps ?? 0;

  const effectiveRate =
    params.bondRateBps * (multiplierBps / BPS_TOTAL) * (1 + surchargeBps / BPS_TOTAL);
  const effectiveRateBps = Math.round(effectiveRate);

  const managedNotionalUsd = roundTo(capitalBtc * params.btcPriceUsd, 2);
  const rawBondUsd = managedNotionalUsd * (effectiveRate / BPS_TOTAL);
  const bondUsd = roundTo(clamp(rawBondUsd, params.minBondUsd, params.maxBondUsd), 2);

  let binding: KeeperBondRequirement["binding"] = "rate";
  if (rawBondUsd < params.minBondUsd) binding = "min";
  else if (rawBondUsd > params.maxBondUsd) binding = "max";

  const bondLodz = roundTo(bondUsd / params.lodzPriceUsd, 6);

  let stackedSlashBps = 0;
  for (const condition of params.slashConditions) stackedSlashBps += condition.slashBps;
  const maxSlashBps = Math.min(BPS_TOTAL, stackedSlashBps);

  const slashConditions: ResolvedSlashCondition[] = params.slashConditions.map((condition) => {
    const slashUsd = roundTo(bondUsd * (condition.slashBps / BPS_TOTAL), 2);
    return {
      ...condition,
      slashUsd,
      slashLodz: roundTo(slashUsd / params.lodzPriceUsd, 6),
    };
  });

  const maxSlashUsd = roundTo(bondUsd * (maxSlashBps / BPS_TOTAL), 2);

  return {
    capitalBtc,
    managedNotionalUsd,
    effectiveRateBps,
    bondUsd,
    bondLodz,
    coverageBps:
      managedNotionalUsd > 0 ? Math.round((bondUsd / managedNotionalUsd) * BPS_TOTAL) : 0,
    maxSlashBps,
    maxSlashUsd,
    maxSlashLodz: roundTo(maxSlashUsd / params.lodzPriceUsd, 6),
    slashConditions,
    binding,
  };
}
