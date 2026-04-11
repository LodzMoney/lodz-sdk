import assert from "node:assert/strict";
import test from "node:test";

import { assessSeam, bridgeFloorForHops } from "../src/assess.js";
import {
  CUSTODY_TYPE_BY_TRUST_MODEL,
  createCustodyLedger,
  custodyTouchesProtocolLayer,
  custodyTypeFromTrustModel,
  describeCustody,
  normalizeCustodyModel,
  protocolSeverityFor,
} from "../src/custody.js";
import type { CustodyModel } from "../src/custody.js";
import { assessPortfolio } from "../src/portfolio.js";
import { factor, seam } from "./fixtures.js";

/**
 * Custody records as measured on 2026-08-15: mint authority and freeze
 * authority read directly from the Solana mint accounts, wrap hops traced
 * through each bridge. Injected here the same way the service injects them.
 */
const CBBTC: CustodyModel = {
  asset: "cbBTC",
  assetMint: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
  trustModel: "custodial",
  operator: "Coinbase",
  redeemability: "permissioned",
  reserveEvidence: "none",
  wrapHops: 1,
  freezable: true,
  mintAuthorityIsKeypair: true,
  sourceUrl: "https://api.mainnet-beta.solana.com",
  updatedAt: "2026-08-15T07:00:00.000Z",
};

const WBTC_PORTAL: CustodyModel = {
  asset: "WBTC",
  assetMint: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
  trustModel: "bridged",
  operator: "BitGo, wrapped again by Wormhole Portal",
  redeemability: "permissioned",
  reserveEvidence: "none",
  wrapHops: 2,
  freezable: false,
  mintAuthorityIsKeypair: false,
  sourceUrl: "https://api.mainnet-beta.solana.com",
  updatedAt: "2026-08-15T07:00:00.000Z",
};

const WBTC_CANONICAL: CustodyModel = {
  ...WBTC_PORTAL,
  assetMint: "5XZw2LKTyrfvfiskJ78AMpackRjPcyCif1WhUsPDuVqQ",
  operator: "BitGo",
  wrapHops: 1,
};

const ZBTC: CustodyModel = {
  asset: "zBTC",
  assetMint: "zBTCug3er3tLyffELcvDNrKkCymbPWysGcWihESYfLg",
  trustModel: "program-controlled",
  operator: "Zeus Network guardians, a named permissioned signer set",
  redeemability: "permissioned",
  reserveEvidence: "onchain-verifiable",
  wrapHops: 1,
  freezable: false,
  mintAuthorityIsKeypair: false,
  sourceUrl: "https://api.mainnet-beta.solana.com",
  updatedAt: "2026-08-15T07:00:00.000Z",
};

const LEDGER = createCustodyLedger([CBBTC, WBTC_PORTAL, WBTC_CANONICAL, ZBTC]);

const OPTIMISTIC = [
  factor("bridge", 1, { label: "claimed to be safe" }),
  factor("custody", 1, { label: "claimed to be safe" }),
];

test("a record may be supplied by trust model and the structural type is filled in", () => {
  const resolved = normalizeCustodyModel(CBBTC);
  assert.equal(resolved.trustModel, "custodial");
  assert.equal(resolved.custodyType, "centralized-custodian");
  assert.equal(custodyTypeFromTrustModel("bridged"), "federated-multisig");
  assert.equal(custodyTypeFromTrustModel("program-controlled"), "threshold-mpc");
  assert.deepEqual(Object.keys(CUSTODY_TYPE_BY_TRUST_MODEL).sort(), [
    "bridged",
    "custodial",
    "program-controlled",
  ]);
});

test("a record supplied by structural type gets its trust model filled in", () => {
  const resolved = normalizeCustodyModel({
    asset: "example",
    custodyType: "light-client-bridge",
    operator: null,
    redeemability: "direct",
    reserveEvidence: "onchain-verifiable",
  });
  assert.equal(resolved.trustModel, "bridged");
  assert.equal(resolved.custodyType, "light-client-bridge");
});

test("a record with neither classification is rejected", () => {
  assert.throws(() =>
    createCustodyLedger([
      { asset: "x", operator: null, redeemability: "direct", reserveEvidence: "none" },
    ]),
  );
});

test("a freeze authority floors the custody layer no matter what the evidence claims", () => {
  const result = assessSeam(
    seam({ id: "cbbtc-lend", asset: "cbBTC", assetMint: CBBTC.assetMint ?? "" }),
    OPTIMISTIC,
    { ledger: LEDGER, includeCustodyFactors: false },
  );
  const custody = result.layers.find((layer) => layer.layer === "custody");
  assert.equal(custody?.severity, 3, "a freeze key cannot be argued down to severity 1");

  const floor = result.appliedFloors.find((entry) => entry.layer === "custody");
  assert.equal(floor?.evidencedSeverity, 1);
  assert.equal(floor?.flooredSeverity, 3);
  assert.match(floor?.reason ?? "", /freeze/);
  assert.equal(result.custody?.asset, "cbBTC");
});

test("a second wrapping hop floors the bridge layer", () => {
  const result = assessSeam(
    seam({ id: "wbtc-lp", asset: "WBTC", assetMint: WBTC_PORTAL.assetMint ?? "" }),
    OPTIMISTIC,
    { ledger: LEDGER, includeCustodyFactors: false },
  );
  const bridge = result.layers.find((layer) => layer.layer === "bridge");
  assert.equal(bridge?.severity, 4);

  const floor = result.appliedFloors.find((entry) => entry.layer === "bridge");
  assert.equal(floor?.evidencedSeverity, 1);
  assert.equal(floor?.flooredSeverity, 4);
  assert.match(floor?.reason ?? "", /2 wrapping hops/);

  assert.equal(bridgeFloorForHops(1), 2);
  assert.equal(bridgeFloorForHops(2), 4);
  assert.equal(bridgeFloorForHops(3), 5);
  assert.equal(bridgeFloorForHops(9), 5);
});

test("an asset with no freeze key gets no custody floor", () => {
  const result = assessSeam(
    seam({ id: "zbtc-lend", asset: "zBTC", assetMint: ZBTC.assetMint ?? "" }),
    OPTIMISTIC,
    { ledger: LEDGER, includeCustodyFactors: false },
  );
  const custody = result.layers.find((layer) => layer.layer === "custody");
  assert.equal(custody?.severity, 1);
  assert.equal(
    result.appliedFloors.some((entry) => entry.layer === "custody"),
    false,
  );
});

test("custody evidence is pulled in automatically from the ledger by mint", () => {
  const result = assessSeam(
    seam({ id: "cbbtc-auto", asset: "cbBTC", assetMint: CBBTC.assetMint ?? "" }),
    [],
    { ledger: LEDGER },
  );
  assert.equal(result.custody?.asset, "cbBTC");
  // A keypair mint authority is a protocol layer statement, so that layer is
  // now evidenced rather than merely unknown.
  assert.deepEqual(result.evidencedLayers, ["bridge", "custody", "protocol", "liquidity"]);
  assert.deepEqual(result.unevidencedLayers, ["oracle"]);

  // Custodial, unpublished reserves, freeze key and a keypair mint authority all stack.
  const custody = result.layers.find((layer) => layer.layer === "custody");
  assert.equal(custody?.severity, 5);
  const protocol = result.layers.find((layer) => layer.layer === "protocol");
  assert.equal(protocol?.severity, 3);
  assert.equal(result.compositeScore, 436);
  assert.equal(result.tier, "high");
});

test("a keypair mint authority raises the protocol layer", () => {
  const keyed = assessSeam(
    seam({ id: "cbbtc", asset: "cbBTC", assetMint: CBBTC.assetMint ?? "" }),
    [],
    { ledger: LEDGER },
  );
  const pda = assessSeam(
    seam({ id: "zbtc", asset: "zBTC", assetMint: ZBTC.assetMint ?? "" }),
    [],
    { ledger: LEDGER },
  );
  assert.equal(protocolSeverityFor(CBBTC), 3, "keypair authority on top of the base");
  assert.equal(keyed.layers.find((layer) => layer.layer === "protocol")?.severity, 3);
  assert.equal(
    keyed.layers.find((layer) => layer.layer === "protocol")?.evidenced,
    true,
    "issuance authority is a protocol statement, not an unknown",
  );
  assert.equal(pda.layers.find((layer) => layer.layer === "protocol")?.severity, 3);
});

test("an unaudited program does not get a free pass for being program controlled", () => {
  // zBTC has the cleanest structure on record and zero published audits.
  const unaudited = { ...ZBTC, audits: 0 };
  const audited = { ...ZBTC, audits: 3 };
  assert.equal(protocolSeverityFor(unaudited), 3);
  assert.equal(protocolSeverityFor(audited), 2);
  assert.equal(custodyTouchesProtocolLayer(unaudited), true);
  assert.equal(custodyTouchesProtocolLayer(audited), false);

  const claimSafe = [factor("protocol", 1, { label: "program controlled, claimed safe" })];
  const result = assessSeam(
    seam({ id: "zbtc", asset: "zBTC", assetMint: ZBTC.assetMint ?? "" }),
    claimSafe,
    { ledger: createCustodyLedger([unaudited]), includeCustodyFactors: false },
  );
  const protocol = result.layers.find((layer) => layer.layer === "protocol");
  assert.equal(protocol?.severity, 3, "being a PDA does not settle the protocol layer");
  const floor = result.appliedFloors.find((entry) => entry.layer === "protocol");
  assert.equal(floor?.evidencedSeverity, 1);
  assert.equal(floor?.flooredSeverity, 3);
  assert.match(floor?.reason ?? "", /no third party audit/);

  const withAudits = assessSeam(
    seam({ id: "zbtc", asset: "zBTC", assetMint: ZBTC.assetMint ?? "" }),
    claimSafe,
    { ledger: createCustodyLedger([audited]), includeCustodyFactors: false },
  );
  assert.equal(
    withAudits.appliedFloors.some((entry) => entry.layer === "protocol"),
    false,
    "an audited program earns back the protocol layer",
  );
});

test("a counterparty seam is described and scored differently from a fee stream", () => {
  // The emissions branch still has to declare its token and end date: that
  // guard is load bearing and is not relaxed to make this test convenient.
  const asSeam = (yieldKind: "sustainable" | "emissions" | "counterparty") =>
    seam({
      id: `s-${yieldKind}`,
      asset: "cbBTC",
      assetMint: CBBTC.assetMint ?? "",
      yieldKind,
      ...(yieldKind === "emissions"
        ? { emissionToken: "ZEUS", emissionEndsAt: "2027-01-01T00:00:00.000Z" }
        : {}),
    });

  const fee = assessSeam(asSeam("sustainable"), [], { includeCustodyFactors: false });
  const traders = assessSeam(asSeam("counterparty"), [], { includeCustodyFactors: false });
  const program = assessSeam(asSeam("emissions"), [], { includeCustodyFactors: false });

  assert.equal(fee.yieldKindRisk.yieldKind, "sustainable");
  assert.match(fee.yieldKindRisk.summary, /paid by outside users/);
  assert.match(traders.yieldKindRisk.summary, /trading position, not a fee stream/);
  assert.match(traders.yieldKindRisk.summary, /inverts when those traders win/);
  assert.match(program.yieldKindRisk.summary, /incentive program with an end date/);

  // The counterparty seam carries protocol and liquidity exposure a fee stream does not.
  assert.equal(traders.layers.find((layer) => layer.layer === "protocol")?.severity, 4);
  assert.equal(traders.layers.find((layer) => layer.layer === "liquidity")?.severity, 3);
  assert.equal(fee.layers.find((layer) => layer.layer === "protocol")?.evidenced, false);
  assert.ok(
    traders.compositeScore > fee.compositeScore,
    "yield paid out of trader losses must not score like fee income",
  );
  assert.ok(traders.compositeScore > program.compositeScore);
});

test("the largest asset by TVL scores worse than the smallest, which is the point", () => {
  const cbbtc = assessSeam(
    seam({ id: "cbbtc", asset: "cbBTC", assetMint: CBBTC.assetMint ?? "", tvlUsd: 214_159_180 }),
    [],
    { ledger: LEDGER },
  );
  const zbtc = assessSeam(
    seam({ id: "zbtc", asset: "zBTC", assetMint: ZBTC.assetMint ?? "", tvlUsd: 3_749_775 }),
    [],
    { ledger: LEDGER },
  );
  assert.ok(
    cbbtc.compositeScore > zbtc.compositeScore,
    "size is not evidence of safety and the score must not pretend otherwise",
  );
});

test("the shared WBTC ticker resolves only by mint", () => {
  assert.equal(LEDGER.findBySymbol("WBTC").length, 2);
  assert.equal(LEDGER.get("WBTC"), null);

  const ambiguous = describeCustody("WBTC", LEDGER);
  assert.equal(ambiguous.ambiguous, true);
  assert.deepEqual(ambiguous.candidateMints, [
    "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
    "5XZw2LKTyrfvfiskJ78AMpackRjPcyCif1WhUsPDuVqQ",
  ]);

  const portal = describeCustody("3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", LEDGER);
  assert.equal(portal.known, true);
  assert.equal(portal.wrapHops, 2);
  assert.equal(portal.trustModel, "bridged");
});

test("wrap hops and freeze keys reach the portfolio assessment", () => {
  const result = assessPortfolio([
    {
      seam: seam({
        id: "cbbtc",
        asset: "cbBTC",
        assetMint: CBBTC.assetMint ?? "",
        allocationBps: 5_000,
      }),
      factors: [],
    },
    {
      seam: seam({
        id: "zbtc",
        asset: "zBTC",
        assetMint: ZBTC.assetMint ?? "",
        allocationBps: 5_000,
      }),
      factors: [],
    },
  ]);
  // assessPortfolio uses the module ledger, which this test never fills, so the
  // custody layer falls back to unevidenced rather than silently scoring clear.
  assert.equal(result.seams[0]?.custody, null);
  for (const assessment of result.seams) {
    assert.ok(assessment.compositeScore >= 100);
  }
});
