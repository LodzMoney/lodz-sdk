import assert from "node:assert/strict";
import test from "node:test";

import { assessSeam } from "../src/assess.js";
import {
  CUSTODY_TYPES,
  REDEEMABILITY_KINDS,
  RESERVE_EVIDENCE_KINDS,
  createCustodyLedger,
  describeCustody,
  getCustodyLedger,
  setCustodyLedger,
  validateCustodyModel,
} from "../src/custody.js";
import type { CustodyModel } from "../src/custody.js";
import { HeadlampError } from "../src/errors.js";
import { seam } from "./fixtures.js";

/** Injected example record. This package ships no asset data of its own. */
const EXAMPLE: CustodyModel = {
  asset: "xBTC",
  assetMint: "xbtc11111111111111111111111111111111111111111",
  custodyType: "centralized-custodian",
  operator: "Example Custodian",
  redeemability: "permissioned",
  reserveEvidence: "proof-of-reserves",
  trustAssumptions: ["The custodian keeps honouring redemptions."],
  sourceUrl: "https://example.org/custody-record",
  updatedAt: "2026-08-15T00:00:00.000Z",
};

test("the package ships no asset data, so an asset with no record is explicitly unknown", () => {
  const ledger = createCustodyLedger([]);
  assert.equal(ledger.size, 0);

  const description = describeCustody("yBTC", ledger);
  assert.equal(description.known, false);
  assert.equal(description.model, null);
  assert.equal(description.custodyType, "unknown");
  assert.equal(description.operator, null);
  assert.equal(description.redeemability, "unknown");
  assert.match(description.summary, /No custody record has been supplied for yBTC/);
  assert.equal(description.sourceUrl, null);
});

test("an undescribed asset carries the heaviest implied exposure, not the lightest", () => {
  const unknown = describeCustody("yBTC", createCustodyLedger([]));
  const known = describeCustody("xBTC", createCustodyLedger([EXAMPLE]));

  const severityOf = (factors: readonly { layer: string; severity: number }[], layer: string) =>
    factors.find((entry) => entry.layer === layer)?.severity ?? 0;

  assert.equal(severityOf(unknown.impliedFactors, "bridge"), 4);
  assert.equal(severityOf(unknown.impliedFactors, "custody"), 4);
  assert.equal(severityOf(unknown.impliedFactors, "liquidity"), 4);
  assert.ok(
    severityOf(unknown.impliedFactors, "bridge") > severityOf(known.impliedFactors, "bridge"),
    "an undescribed bridge must not score better than a described one",
  );
  for (const implied of unknown.impliedFactors) {
    assert.ok(implied.severity >= 1, "no implied factor may score below severity 1");
  }
});

test("a described asset produces a structural summary and implied factors", () => {
  const description = describeCustody("xBTC", createCustodyLedger([EXAMPLE]));
  assert.equal(description.known, true);
  assert.equal(description.custodyType, "centralized-custodian");
  assert.equal(description.operator, "Example Custodian");
  assert.match(description.summary, /single custodian holding the backing BTC/);
  assert.match(description.summary, /operated by Example Custodian/);
  assert.match(description.summary, /Redemption is limited to approved parties/);
  assert.match(description.summary, /proof-of-reserves/);
  assert.deepEqual(description.trustAssumptions, ["The custodian keeps honouring redemptions."]);
  assert.equal(description.sourceUrl, "https://example.org/custody-record");

  const bridge = description.impliedFactors.find((entry) => entry.layer === "bridge");
  const custody = description.impliedFactors.find((entry) => entry.layer === "custody");
  const liquidity = description.impliedFactors.find((entry) => entry.layer === "liquidity");
  assert.equal(bridge?.severity, 3);
  assert.equal(custody?.severity, 4);
  assert.equal(liquidity?.severity, 3);
  assert.equal(bridge?.evidenceUrl, "https://example.org/custody-record");
});

test("unpublished reserves raise the custody severity", () => {
  const noEvidence = describeCustody(
    "xBTC",
    createCustodyLedger([{ ...EXAMPLE, reserveEvidence: "none" }]),
  );
  const custody = noEvidence.impliedFactors.find((entry) => entry.layer === "custody");
  assert.equal(custody?.severity, 5);
  assert.match(noEvidence.summary, /No reserve evidence is published/);
});

test("a record may state its own severities and they win", () => {
  const description = describeCustody(
    "xBTC",
    createCustodyLedger([
      { ...EXAMPLE, severities: { bridge: 1, custody: 2, liquidity: 1, protocol: 5 } },
    ]),
  );
  assert.equal(description.impliedFactors.find((entry) => entry.layer === "bridge")?.severity, 1);
  assert.equal(description.impliedFactors.find((entry) => entry.layer === "custody")?.severity, 2);
  assert.equal(description.impliedFactors.find((entry) => entry.layer === "protocol")?.severity, 5);
});

test("implied factors feed straight into a seam assessment", () => {
  const description = describeCustody("xBTC", createCustodyLedger([EXAMPLE]));
  const result = assessSeam(seam({ id: "with-custody", asset: "xBTC" }), description.impliedFactors);
  assert.deepEqual(result.evidencedLayers, ["bridge", "custody", "liquidity"]);
  assert.deepEqual(result.unevidencedLayers, ["protocol", "oracle"]);
  assert.equal(result.worstLayer.layer, "custody");
  assert.equal(result.worstLayer.severity, 4);
  assert.ok(result.compositeScore >= 100);
});

test("the module level ledger is an injection point, empty until filled", () => {
  assert.equal(getCustodyLedger().size, 0);
  setCustodyLedger([EXAMPLE]);
  assert.equal(getCustodyLedger().size, 1);
  assert.equal(describeCustody("xBTC").known, true);
  assert.equal(describeCustody("XBTC").known, true, "lookups are case insensitive");
  setCustodyLedger([]);
  assert.equal(describeCustody("xBTC").known, false);
});

test("a record is found by mint address, which is the only unique identifier", () => {
  const ledger = createCustodyLedger([EXAMPLE]);
  const byMint = describeCustody("xbtc11111111111111111111111111111111111111111", ledger);
  assert.equal(byMint.known, true);
  assert.equal(byMint.asset, "xBTC");
  assert.equal(ledger.getByMint("xbtc11111111111111111111111111111111111111111")?.asset, "xBTC");
  assert.equal(ledger.getByMint("nope"), null);
  assert.match(byMint.summary, /Mint xbtc111/);
});

test("one ticker across two mints resolves to nothing, not to a guess", () => {
  // Observed on Solana: two distinct mints ship under the same BTC ticker.
  const ledger = createCustodyLedger([
    { ...EXAMPLE, asset: "yBTC", assetMint: "mintAAA", operator: "First Issuer" },
    {
      ...EXAMPLE,
      asset: "yBTC",
      assetMint: "mintBBB",
      operator: "Second Issuer",
      custodyType: "federated-multisig",
    },
  ]);
  assert.equal(ledger.size, 2);
  assert.equal(ledger.findBySymbol("yBTC").length, 2);
  assert.equal(ledger.get("yBTC"), null);

  const description = describeCustody("yBTC", ledger);
  assert.equal(description.known, false);
  assert.equal(description.ambiguous, true);
  assert.deepEqual(description.candidateMints, ["mintAAA", "mintBBB"]);
  assert.match(description.summary, /will not guess which one is held/);
  assert.match(description.summary, /Identify the position by mint address/);
  for (const implied of description.impliedFactors) {
    assert.equal(implied.severity, 4, "an unresolvable ticker keeps the heaviest defaults");
  }

  // The same ledger still resolves each mint precisely.
  assert.equal(describeCustody("mintAAA", ledger).operator, "First Issuer");
  assert.equal(describeCustody("mintBBB", ledger).operator, "Second Issuer");
});

test("a plain unknown asset is not reported as ambiguous", () => {
  const description = describeCustody("neverHeardOf", createCustodyLedger([EXAMPLE]));
  assert.equal(description.known, false);
  assert.equal(description.ambiguous, false);
  assert.deepEqual(description.candidateMints, []);
});

test("measured issuer powers raise custody severity one step at a time", () => {
  const plain = describeCustody("xBTC", createCustodyLedger([EXAMPLE]));
  const freezable = describeCustody(
    "xBTC",
    createCustodyLedger([{ ...EXAMPLE, freezable: true }]),
  );
  const alsoKeypair = describeCustody(
    "xBTC",
    createCustodyLedger([{ ...EXAMPLE, freezable: true, mintAuthorityIsKeypair: true }]),
  );
  const custodyOf = (description: { impliedFactors: readonly { layer: string; severity: number }[] }) =>
    description.impliedFactors.find((entry) => entry.layer === "custody")?.severity ?? 0;

  assert.equal(custodyOf(plain), 4);
  assert.equal(custodyOf(freezable), 5);
  assert.equal(custodyOf(alsoKeypair), 5, "severity is clamped at the top of the scale");
  assert.ok(
    freezable.trustAssumptions.some((entry) => entry.includes("freeze")),
    "a freeze key must be stated outright, not buried in a number",
  );
  assert.match(freezable.summary, /can freeze holder token accounts/);
});

test("extra wrapping hops raise bridge severity and are stated in the summary", () => {
  const single = describeCustody("xBTC", createCustodyLedger([{ ...EXAMPLE, wrapHops: 1 }]));
  const double = describeCustody("xBTC", createCustodyLedger([{ ...EXAMPLE, wrapHops: 2 }]));
  const bridgeOf = (description: { impliedFactors: readonly { layer: string; severity: number }[] }) =>
    description.impliedFactors.find((entry) => entry.layer === "bridge")?.severity ?? 0;

  assert.equal(bridgeOf(single), 3);
  assert.equal(bridgeOf(double), 4);
  assert.match(double.summary, /passes through 2 wrapping hops/);
  assert.ok(double.trustAssumptions.some((entry) => entry.includes("2 wrapping hops")));
});

test("malformed custody records are rejected", () => {
  assert.throws(
    () => createCustodyLedger([{ ...EXAMPLE, custodyType: "vibes" as never }]),
    (error: unknown) => {
      assert.ok(error instanceof HeadlampError);
      assert.equal(error.code, "INVALID_CUSTODY_MODEL");
      return true;
    },
  );
  assert.throws(() => createCustodyLedger([{ ...EXAMPLE, asset: "" }]), HeadlampError);
  assert.throws(
    () => createCustodyLedger([{ ...EXAMPLE, redeemability: "someday" as never }]),
    HeadlampError,
  );
  assert.throws(
    () => createCustodyLedger([{ ...EXAMPLE, severities: { bridge: 9 as never } }]),
    HeadlampError,
  );
  assert.throws(() => createCustodyLedger([EXAMPLE, { ...EXAMPLE }]), HeadlampError);
  assert.throws(() => createCustodyLedger([{ ...EXAMPLE, wrapHops: -1 }]), HeadlampError);
  assert.throws(
    () => createCustodyLedger([{ ...EXAMPLE, freezable: "yes" as never }]),
    HeadlampError,
  );
  assert.throws(() => createCustodyLedger([{ ...EXAMPLE, assetMint: "  " }]), HeadlampError);
  assert.throws(() => describeCustody(""), HeadlampError);
  assert.equal(validateCustodyModel(EXAMPLE), EXAMPLE);
});

test("no generated description claims safety or calls a representation bitcoin itself", () => {
  // Assembled from fragments so this guard never plants the phrases it bans.
  const banned = new RegExp(
    [
      ["risk", "free"].join("[- ]"),
      "guarantee",
      ["native", "bitcoin"].join(" "),
      ["native", "BTC"].join(" "),
      ["fully", "backed"].join(" "),
      "no risk",
    ].join("|"),
    "i",
  );

  const summaries: string[] = [describeCustody("nothing-on-file", createCustodyLedger([])).summary];
  for (const custodyType of CUSTODY_TYPES) {
    for (const redeemability of REDEEMABILITY_KINDS) {
      for (const reserveEvidence of RESERVE_EVIDENCE_KINDS) {
        const description = describeCustody(
          "xBTC",
          createCustodyLedger([{ ...EXAMPLE, custodyType, redeemability, reserveEvidence }]),
        );
        summaries.push(description.summary);
        summaries.push(...description.trustAssumptions);
        summaries.push(...description.impliedFactors.map((entry) => entry.rationale));
        summaries.push(...description.impliedFactors.map((entry) => entry.label));
      }
    }
  }

  assert.ok(summaries.length > 100, "the sweep must cover every structural combination");
  for (const text of summaries) {
    assert.doesNotMatch(text, banned, `generated copy made a safety claim: ${text}`);
  }
});

test("every description states the representation is a claim, not bitcoin on Bitcoin", () => {
  const described = describeCustody("xBTC", createCustodyLedger([EXAMPLE]));
  assert.match(described.summary, /not on bitcoin held on the Bitcoin network|not a claim|claim on that arrangement/);
  assert.match(described.summary, /BTC representation on Solana/);
});
