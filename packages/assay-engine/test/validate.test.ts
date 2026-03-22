import assert from "node:assert/strict";
import test from "node:test";

import { decomposeYield } from "../src/decompose.js";
import { AssayError } from "../src/errors.js";
import { simulatePostEmissions } from "../src/emissions.js";
import { validateAllocation, validateSeam, validateSeams } from "../src/validate.js";
import { AT, MIXED_SEAMS, emissionSeam, seam } from "./fixtures.js";

function expectCode(code: string, run: () => unknown): AssayError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof AssayError, `expected AssayError, received ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  throw new Error(`expected the call to throw ${code}`);
}

test("an emissions seam without emissionEndsAt is rejected", () => {
  const broken = { ...emissionSeam({ id: "e", emissionEndsAt: "2027-01-01T00:00:00.000Z" }) };
  broken.emissionEndsAt = null;
  const error = expectCode("INVALID_SEAM", () => validateSeam(broken));
  assert.equal(error.field, "emissionEndsAt");
  assert.equal(error.seamId, "e");
});

test("an emissions seam without emissionToken is rejected", () => {
  const broken = { ...emissionSeam({ id: "e", emissionEndsAt: "2027-01-01T00:00:00.000Z" }) };
  broken.emissionToken = null;
  const error = expectCode("INVALID_SEAM", () => validateSeam(broken));
  assert.equal(error.field, "emissionToken");
});

test("an emissions seam with a non ISO end date is rejected", () => {
  const broken = { ...emissionSeam({ id: "e", emissionEndsAt: "2027-01-01T00:00:00.000Z" }) };
  broken.emissionEndsAt = "next spring";
  expectCode("INVALID_SEAM", () => validateSeam(broken));
});

test("a sustainable seam may not carry emissions metadata", () => {
  const mislabelled = { ...seam({ id: "s" }) };
  mislabelled.emissionToken = "INCENTIVE";
  expectCode("INVALID_SEAM", () => validateSeam(mislabelled));
});

test("negative rates and negative TVL are rejected", () => {
  expectCode("INVALID_SEAM", () => validateSeam(seam({ id: "s", apyBps: -1 })));
  expectCode("INVALID_SEAM", () => validateSeam(seam({ id: "s", tvlUsd: -1 })));
  expectCode("INVALID_SEAM", () => validateSeam(seam({ id: "s", apyBps: 12.5 })));
});

test("allocations that do not total 10000 bps are rejected", () => {
  const seams = [
    seam({ id: "a", allocationBps: 6_000 }),
    seam({ id: "b", allocationBps: 3_000 }),
  ];
  const error = expectCode("INVALID_ALLOCATION", () => decomposeYield(seams, undefined, AT));
  assert.match(error.message, /9000/);

  expectCode("INVALID_ALLOCATION", () =>
    validateAllocation(seams, { a: 5_000, b: 4_999 }),
  );
  expectCode("INVALID_ALLOCATION", () => validateAllocation(seams, { a: 5_000, b: 5_001 }));
  expectCode("INVALID_ALLOCATION", () => simulatePostEmissions(seams, AT));
});

test("an allocation naming an unknown seam is rejected", () => {
  expectCode("INVALID_ALLOCATION", () =>
    validateAllocation(MIXED_SEAMS, { "does-not-exist": 10_000 }),
  );
});

test("non integer allocation shares are rejected", () => {
  expectCode("INVALID_ALLOCATION", () =>
    validateAllocation(MIXED_SEAMS, {
      "kamino-cbbtc-lend": 3_333.5,
      "orca-cbbtc-lp": 2_500,
      "zbtc-lend-incentive": 2_666.5,
      "tbtc-basis-incentive": 1_500,
    }),
  );
});

test("duplicate seam ids and empty portfolios are rejected", () => {
  expectCode("INVALID_SEAM", () =>
    validateSeams([seam({ id: "dup", allocationBps: 5_000 }), seam({ id: "dup", allocationBps: 5_000 })]),
  );
  expectCode("EMPTY_PORTFOLIO", () => validateSeams([]));
});

test("a non http sourceUrl is rejected", () => {
  expectCode("INVALID_SEAM", () => validateSeam(seam({ id: "s", sourceUrl: "not a url" })));
  expectCode("INVALID_SEAM", () =>
    validateSeam(seam({ id: "s", sourceUrl: "ftp://example.org/data" })),
  );
});
