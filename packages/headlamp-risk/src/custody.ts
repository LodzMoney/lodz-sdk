import { HeadlampError } from "./errors.js";
import type { RiskFactor, RiskLayer, Severity } from "./types.js";
import { clampSeverity, isSeverity } from "./types.js";

/**
 * How the backing BTC is held for a given representation.
 *
 * These describe structures, not brands. The per asset facts are supplied by
 * the caller; nothing about a specific asset is compiled into this package.
 */
export type CustodyType =
  | "centralized-custodian"
  | "threshold-mpc"
  | "federated-multisig"
  | "light-client-bridge"
  | "synthetic-derivative"
  | "unknown";

/** How a holder converts the representation back into BTC. */
export type Redeemability = "direct" | "permissioned" | "market-only" | "unknown";

/** What can be checked about the reserves said to back the representation. */
export type ReserveEvidence =
  | "onchain-verifiable"
  | "proof-of-reserves"
  | "audited-attestation"
  | "none"
  | "unknown";

/**
 * Coarse trust model, matching how the underlying survey classified assets.
 *
 * - `custodial`: a named party holds the backing BTC off-chain.
 * - `bridged`: the token arrived through one or more bridges.
 * - `program-controlled`: an on-chain program holds the issuance authority.
 *
 * `program-controlled` describes where the authority sits, not who moves it.
 * A program can still be driven by a permissioned signer set.
 */
export type TrustModel = "custodial" | "bridged" | "program-controlled";

export const TRUST_MODELS: readonly TrustModel[] = [
  "custodial",
  "bridged",
  "program-controlled",
];

/** Structural custody type implied by each trust model. */
export const CUSTODY_TYPE_BY_TRUST_MODEL: Readonly<Record<TrustModel, CustodyType>> =
  Object.freeze({
    custodial: "centralized-custodian",
    bridged: "federated-multisig",
    "program-controlled": "threshold-mpc",
  });

/** Trust model implied by each structural custody type. */
export const TRUST_MODEL_BY_CUSTODY_TYPE: Readonly<Record<CustodyType, TrustModel>> =
  Object.freeze({
    "centralized-custodian": "custodial",
    "threshold-mpc": "program-controlled",
    "federated-multisig": "bridged",
    "light-client-bridge": "bridged",
    "synthetic-derivative": "bridged",
    unknown: "bridged",
  });

export function custodyTypeFromTrustModel(trustModel: TrustModel): CustodyType {
  const mapped = CUSTODY_TYPE_BY_TRUST_MODEL[trustModel];
  if (mapped === undefined) {
    throw new HeadlampError(
      "INVALID_CUSTODY_MODEL",
      `trustModel must be one of ${TRUST_MODELS.join(", ")}, received ${String(trustModel)}`,
      { field: "trustModel" },
    );
  }
  return mapped;
}

export const CUSTODY_TYPES: readonly CustodyType[] = [
  "centralized-custodian",
  "threshold-mpc",
  "federated-multisig",
  "light-client-bridge",
  "synthetic-derivative",
  "unknown",
];

export const REDEEMABILITY_KINDS: readonly Redeemability[] = [
  "direct",
  "permissioned",
  "market-only",
  "unknown",
];

export const RESERVE_EVIDENCE_KINDS: readonly ReserveEvidence[] = [
  "onchain-verifiable",
  "proof-of-reserves",
  "audited-attestation",
  "none",
  "unknown",
];

/** One BTC representation and the arrangement standing behind it. */
export interface CustodyModel {
  /** Representation symbol, e.g. cbBTC. Symbols are not unique across mints. */
  asset: string;
  /** SPL mint address. The only identifier that is actually unique. */
  assetMint?: string | null;
  /**
   * Structural custody type. Optional when `trustModel` is supplied: the
   * ledger fills it in from `CUSTODY_TYPE_BY_TRUST_MODEL`.
   */
  custodyType?: CustodyType;
  /** Coarse trust model. Derived from `custodyType` when omitted. */
  trustModel?: TrustModel;
  /** Party running the arrangement, or null when it has no single operator. */
  operator: string | null;
  redeemability: Redeemability;
  reserveEvidence: ReserveEvidence;
  /**
   * Wrapping hops the backing BTC passes through before it becomes this token.
   * Each hop is another set of assumptions stacked on the last.
   */
  wrapHops?: number;
  /** True when the issuer can freeze a holder's token account. */
  freezable?: boolean;
  /** True when the mint authority is a private key rather than a program address. */
  mintAuthorityIsKeypair?: boolean;
  /**
   * Count of published third party audits. Zero is a real answer and raises the
   * protocol layer; leaving it out means nobody checked, which is not the same
   * claim and is not scored as one.
   */
  audits?: number;
  /** What a holder is trusting. Supplied per asset; defaults per structure. */
  trustAssumptions?: readonly string[];
  /** Explicit per layer severities. Overrides the default table below. */
  severities?: Partial<Record<RiskLayer, Severity>>;
  sourceUrl?: string | null;
  updatedAt?: string | null;
}

/** A custody record with both classifications filled in. */
export interface ResolvedCustodyModel extends CustodyModel {
  custodyType: CustodyType;
  trustModel: TrustModel;
}

/**
 * An injected set of custody records.
 *
 * Indexed by mint address, which is unique, and by symbol, which is not: more
 * than one mint can carry the same ticker. Symbol lookups that match several
 * mints resolve to nothing rather than to a guess.
 */
export interface CustodyLedger {
  readonly models: readonly ResolvedCustodyModel[];
  /** Look up by mint address first, then by symbol. Null when ambiguous. */
  get(assetOrMint: string): ResolvedCustodyModel | null;
  has(assetOrMint: string): boolean;
  /** Exact mint lookup. Mint addresses are case sensitive. */
  getByMint(mint: string): ResolvedCustodyModel | null;
  /** Every record carrying this symbol. More than one means ambiguous. */
  findBySymbol(symbol: string): ResolvedCustodyModel[];
  readonly size: number;
}

export interface CustodyDescription {
  asset: string;
  /** False when no record was found, including when the symbol was ambiguous. */
  known: boolean;
  /** True when the symbol matched several mints and was not resolved. */
  ambiguous: boolean;
  /** Mints carrying the queried symbol when `ambiguous` is true. */
  candidateMints: string[];
  model: ResolvedCustodyModel | null;
  custodyType: CustodyType;
  trustModel: TrustModel | null;
  /** Wrapping hops on record, or null when the record does not say. */
  wrapHops: number | null;
  /** True when the issuer can freeze holder accounts, per the record. */
  freezable: boolean;
  /** Published audit count on record, or null when the record does not say. */
  audits: number | null;
  operator: string | null;
  redeemability: Redeemability;
  reserveEvidence: ReserveEvidence;
  /** Plain English description of the arrangement. */
  summary: string;
  trustAssumptions: string[];
  /** Bridge, custody and liquidity factors ready to feed into `assessSeam`. */
  impliedFactors: RiskFactor[];
  sourceUrl: string | null;
  updatedAt: string | null;
}

/**
 * Default layer severities per custody structure.
 *
 * Used only when a record does not state its own. An `unknown` structure scores
 * worst on purpose: an arrangement nobody has described is not a mild one.
 */
export const DEFAULT_CUSTODY_SEVERITY: Readonly<
  Record<CustodyType, { bridge: Severity; custody: Severity }>
> = Object.freeze({
  "centralized-custodian": { bridge: 3, custody: 4 },
  "threshold-mpc": { bridge: 3, custody: 3 },
  "federated-multisig": { bridge: 3, custody: 3 },
  "light-client-bridge": { bridge: 3, custody: 2 },
  "synthetic-derivative": { bridge: 4, custody: 3 },
  unknown: { bridge: 4, custody: 4 },
});

/** Default liquidity severity implied by how the position can be exited. */
export const DEFAULT_REDEEMABILITY_SEVERITY: Readonly<Record<Redeemability, Severity>> =
  Object.freeze({
    direct: 2,
    permissioned: 3,
    "market-only": 4,
    unknown: 4,
  });

const STRUCTURE_DESCRIPTION: Readonly<Record<CustodyType, string>> = Object.freeze({
  "centralized-custodian": "a single custodian holding the backing BTC",
  "threshold-mpc": "a threshold signature scheme split across key share operators",
  "federated-multisig": "a federation of signers controlling the backing BTC",
  "light-client-bridge": "an on-chain light client verifying Bitcoin state",
  "synthetic-derivative": "a collateral backed synthetic position rather than a claim on BTC",
  unknown: "an arrangement that has not been described to this system",
});

const REDEMPTION_DESCRIPTION: Readonly<Record<Redeemability, string>> = Object.freeze({
  direct: "Any holder can redeem for BTC directly.",
  permissioned: "Redemption is limited to approved parties.",
  "market-only": "There is no redemption path; exiting means selling on the market.",
  unknown: "The redemption path has not been described to this system.",
});

const RESERVE_DESCRIPTION: Readonly<Record<ReserveEvidence, string>> = Object.freeze({
  "onchain-verifiable": "Reserves can be verified on-chain.",
  "proof-of-reserves": "Reserves are published as a proof-of-reserves report.",
  "audited-attestation": "Reserves are covered by a third party attestation.",
  none: "No reserve evidence is published.",
  unknown: "Reserve evidence has not been described to this system.",
});

const DEFAULT_TRUST_ASSUMPTIONS: Readonly<Record<CustodyType, readonly string[]>> = Object.freeze({
  "centralized-custodian": [
    "The custodian remains solvent and continues to honour redemptions.",
    "The custodian is not compelled to freeze or seize the backing BTC.",
  ],
  "threshold-mpc": [
    "Fewer than the signing threshold of key share operators collude or are compromised.",
    "The key share operators stay reachable enough to process redemptions.",
  ],
  "federated-multisig": [
    "A majority of federation signers neither collude nor are compromised.",
    "The federation continues to process redemptions.",
  ],
  "light-client-bridge": [
    "The light client implementation is correct and its proofs are not forgeable.",
    "Relayers continue to submit Bitcoin headers.",
  ],
  "synthetic-derivative": [
    "The collateral backing the position stays sufficient through market moves.",
    "The position tracks BTC only as long as its incentive mechanism holds.",
  ],
  unknown: ["The backing arrangement has not been supplied to this system."],
});

function validateCustodyModelInternal(model: CustodyModel): CustodyModel {
  if (model === null || typeof model !== "object") {
    throw new HeadlampError("INVALID_CUSTODY_MODEL", "custody record must be an object");
  }
  if (typeof model.asset !== "string" || model.asset.trim().length === 0) {
    throw new HeadlampError("INVALID_CUSTODY_MODEL", "asset must be a non-empty string", {
      field: "asset",
    });
  }
  const detail = { asset: model.asset };
  if (model.custodyType === undefined && model.trustModel === undefined) {
    throw new HeadlampError(
      "INVALID_CUSTODY_MODEL",
      `custody record for ${model.asset} must supply custodyType or trustModel`,
      { field: "custodyType", ...detail },
    );
  }
  if (model.custodyType !== undefined && !CUSTODY_TYPES.includes(model.custodyType)) {
    throw new HeadlampError(
      "INVALID_CUSTODY_MODEL",
      `custodyType must be one of ${CUSTODY_TYPES.join(", ")}, received ${String(model.custodyType)}`,
      { field: "custodyType", ...detail },
    );
  }
  if (model.trustModel !== undefined && !TRUST_MODELS.includes(model.trustModel)) {
    throw new HeadlampError(
      "INVALID_CUSTODY_MODEL",
      `trustModel must be one of ${TRUST_MODELS.join(", ")}, received ${String(model.trustModel)}`,
      { field: "trustModel", ...detail },
    );
  }
  if (!REDEEMABILITY_KINDS.includes(model.redeemability)) {
    throw new HeadlampError(
      "INVALID_CUSTODY_MODEL",
      `redeemability must be one of ${REDEEMABILITY_KINDS.join(", ")}`,
      { field: "redeemability", ...detail },
    );
  }
  if (!RESERVE_EVIDENCE_KINDS.includes(model.reserveEvidence)) {
    throw new HeadlampError(
      "INVALID_CUSTODY_MODEL",
      `reserveEvidence must be one of ${RESERVE_EVIDENCE_KINDS.join(", ")}`,
      { field: "reserveEvidence", ...detail },
    );
  }
  if (model.operator !== null && typeof model.operator !== "string") {
    throw new HeadlampError("INVALID_CUSTODY_MODEL", "operator must be a string or null", {
      field: "operator",
      ...detail,
    });
  }
  if (model.assetMint !== undefined && model.assetMint !== null) {
    if (typeof model.assetMint !== "string" || model.assetMint.trim().length === 0) {
      throw new HeadlampError(
        "INVALID_CUSTODY_MODEL",
        "assetMint must be a non-empty string when supplied",
        { field: "assetMint", ...detail },
      );
    }
  }
  for (const field of ["wrapHops", "audits"] as const) {
    const value = model[field];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 0) {
      throw new HeadlampError(
        "INVALID_CUSTODY_MODEL",
        `${field} must be a non-negative integer, received ${String(value)}`,
        { field, ...detail },
      );
    }
  }
  if (model.freezable !== undefined && typeof model.freezable !== "boolean") {
    throw new HeadlampError("INVALID_CUSTODY_MODEL", "freezable must be a boolean", {
      field: "freezable",
      ...detail,
    });
  }
  if (
    model.mintAuthorityIsKeypair !== undefined &&
    typeof model.mintAuthorityIsKeypair !== "boolean"
  ) {
    throw new HeadlampError(
      "INVALID_CUSTODY_MODEL",
      "mintAuthorityIsKeypair must be a boolean",
      { field: "mintAuthorityIsKeypair", ...detail },
    );
  }
  if (model.severities !== undefined) {
    for (const [layer, severity] of Object.entries(model.severities)) {
      if (severity !== undefined && !isSeverity(severity)) {
        throw new HeadlampError(
          "INVALID_CUSTODY_MODEL",
          `severity for layer ${layer} must be an integer from 1 to 5`,
          { field: "severities", ...detail },
        );
      }
    }
  }
  return model;
}

export function validateCustodyModel(model: CustodyModel): CustodyModel {
  return validateCustodyModelInternal(model);
}

/**
 * Fill in whichever of `custodyType` and `trustModel` the caller left out.
 *
 * The survey this package consumes classifies assets by trust model; the risk
 * tables are keyed on structural custody type. Callers supply either one.
 */
export function normalizeCustodyModel(model: CustodyModel): ResolvedCustodyModel {
  validateCustodyModelInternal(model);
  const custodyType =
    model.custodyType ??
    custodyTypeFromTrustModel(model.trustModel ?? "bridged");
  const trustModel = model.trustModel ?? TRUST_MODEL_BY_CUSTODY_TYPE[custodyType];
  return { ...model, custodyType, trustModel };
}

/**
 * Build a custody ledger from injected records.
 *
 * This package ships no asset data. Feed it the confirmed BTC representation
 * research and it describes what you gave it; feed it nothing and every asset
 * comes back explicitly unknown rather than implicitly fine.
 */
export function createCustodyLedger(models: readonly CustodyModel[] = []): CustodyLedger {
  if (!Array.isArray(models)) {
    throw new HeadlampError("INVALID_CUSTODY_MODEL", "custody records must be an array");
  }
  const byMint = new Map<string, ResolvedCustodyModel>();
  const bySymbol = new Map<string, ResolvedCustodyModel[]>();
  const resolved: ResolvedCustodyModel[] = [];

  for (const supplied of models) {
    const model = normalizeCustodyModel(supplied);
    resolved.push(model);
    const mint = model.assetMint?.trim();
    if (mint !== undefined && mint.length > 0) {
      if (byMint.has(mint)) {
        throw new HeadlampError(
          "INVALID_CUSTODY_MODEL",
          `duplicate custody record for mint ${mint}`,
          { asset: model.asset },
        );
      }
      byMint.set(mint, model);
    }
    const symbol = model.asset.trim().toLowerCase();
    const existing = bySymbol.get(symbol) ?? [];
    // Two records may share a ticker only if they name different mints.
    if (existing.some((entry) => (entry.assetMint ?? null) === (model.assetMint ?? null))) {
      throw new HeadlampError(
        "INVALID_CUSTODY_MODEL",
        `duplicate custody record for asset ${model.asset}`,
        { asset: model.asset },
      );
    }
    bySymbol.set(symbol, [...existing, model]);
  }

  const findBySymbol = (symbol: string): ResolvedCustodyModel[] =>
    typeof symbol === "string" ? [...(bySymbol.get(symbol.trim().toLowerCase()) ?? [])] : [];
  const getByMint = (mint: string): ResolvedCustodyModel | null =>
    typeof mint === "string" ? (byMint.get(mint.trim()) ?? null) : null;
  const get = (assetOrMint: string): ResolvedCustodyModel | null => {
    const byMintHit = getByMint(assetOrMint);
    if (byMintHit !== null) return byMintHit;
    const candidates = findBySymbol(assetOrMint);
    // One ticker, several mints: refuse to guess which one is held.
    return candidates.length === 1 ? (candidates[0] ?? null) : null;
  };

  return {
    models: resolved,
    get,
    has: (assetOrMint: string) => get(assetOrMint) !== null,
    getByMint,
    findBySymbol,
    size: resolved.length,
  };
}

let defaultLedger: CustodyLedger = createCustodyLedger([]);

/** Replace the ledger `describeCustody` uses when none is passed explicitly. */
export function setCustodyLedger(source: CustodyLedger | readonly CustodyModel[]): CustodyLedger {
  defaultLedger = Array.isArray(source)
    ? createCustodyLedger(source)
    : (source as CustodyLedger);
  return defaultLedger;
}

export function getCustodyLedger(): CustodyLedger {
  return defaultLedger;
}

/**
 * Severity for one layer of one record.
 *
 * Starts from the structural default table and adds one step for each measured
 * property that widens the exposure: an extra wrapping hop, an issuer that can
 * freeze holder accounts, a mint authority that is a private key rather than a
 * program address, and reserves nobody can check. Every step is additive and
 * clamped at 5. A record that states its own severity for a layer overrides all
 * of it.
 */
function severityFor(model: ResolvedCustodyModel, layer: RiskLayer): Severity {
  const explicit = model.severities?.[layer];
  if (explicit !== undefined) return explicit;
  const base = DEFAULT_CUSTODY_SEVERITY[model.custodyType];
  if (layer === "bridge") {
    const extraHops = model.wrapHops !== undefined && model.wrapHops >= 2 ? 1 : 0;
    return clampSeverity(base.bridge + extraHops);
  }
  if (layer === "liquidity") return DEFAULT_REDEEMABILITY_SEVERITY[model.redeemability];
  if (layer === "custody") {
    const unproven =
      model.reserveEvidence === "none" || model.reserveEvidence === "unknown" ? 1 : 0;
    const freezable = model.freezable === true ? 1 : 0;
    const keypairAuthority = model.mintAuthorityIsKeypair === true ? 1 : 0;
    return clampSeverity(base.custody + unproven + freezable + keypairAuthority);
  }
  if (layer === "protocol") return protocolSeverityFor(model);
  return DEFAULT_CUSTODY_SEVERITY.unknown.custody;
}

/** Baseline protocol severity once anything is known about the code path. */
export const PROTOCOL_BASE_SEVERITY = 2;

/**
 * Whether a custody record says anything about the protocol layer.
 *
 * It does when issuance sits behind a private key, or when the code has been
 * audited zero times. A structural advantage elsewhere does not cover either:
 * an issuance authority held by a program is worth less if nobody has reviewed
 * the program.
 */
export function custodyTouchesProtocolLayer(model: CustodyModel): boolean {
  return model.mintAuthorityIsKeypair === true || model.audits === 0;
}

/** Protocol severity implied by the issuance authority and the audit count. */
export function protocolSeverityFor(model: CustodyModel): Severity {
  const explicit = model.severities?.protocol;
  if (explicit !== undefined) return explicit;
  const keypairAuthority = model.mintAuthorityIsKeypair === true ? 1 : 0;
  const unaudited = model.audits === 0 ? 1 : 0;
  return clampSeverity(PROTOCOL_BASE_SEVERITY + keypairAuthority + unaudited);
}

function factor(
  layer: RiskLayer,
  label: string,
  severity: Severity,
  rationale: string,
  evidenceUrl: string | null,
): RiskFactor {
  return { layer, label, severity, rationale, evidenceUrl };
}

/**
 * Describe the custody and bridge structure behind a BTC representation.
 *
 * The representation is a token on Solana that tracks BTC held elsewhere. It is
 * not bitcoin on the Bitcoin network, and this description never states or
 * implies otherwise.
 *
 * @param asset  Representation symbol, e.g. cbBTC.
 * @param ledger Optional ledger. Defaults to the one set by `setCustodyLedger`.
 */
export function describeCustody(asset: string, ledger?: CustodyLedger): CustodyDescription {
  if (typeof asset !== "string" || asset.trim().length === 0) {
    throw new HeadlampError("INVALID_INPUT", "asset must be a non-empty string", {
      field: "asset",
    });
  }
  const symbol = asset.trim();
  const source = ledger ?? defaultLedger;
  const model = source.get(symbol);

  if (model === null) {
    // A ticker matching several mints is a different failure from an unknown
    // one, and the difference matters: one of the candidates may be a token
    // that only shares a name with the asset actually held.
    const candidates = source.findBySymbol(symbol);
    const ambiguous = candidates.length > 1;
    const candidateMints = candidates
      .map((candidate) => candidate.assetMint ?? "")
      .filter((mint) => mint.length > 0);
    const severity = DEFAULT_CUSTODY_SEVERITY.unknown;

    const summary = ambiguous
      ? `The symbol ${symbol} matches ${candidates.length} separate BTC representations on ` +
        `record${candidateMints.length > 0 ? ` (mints ${candidateMints.join(", ")})` : ""}. ` +
        `This system will not guess which one is held. Identify the position by mint address.`
      : `No custody record has been supplied for ${symbol}. This system cannot state what backs ` +
        `it, who operates that arrangement, or how it is redeemed. Treat it as carrying the ` +
        `portfolio's heaviest bridge and custody exposure until a record is supplied.`;

    const rationale = ambiguous
      ? `The symbol ${symbol} resolves to more than one mint, so nothing about the position can be verified from the ticker alone.`
      : "No custody record was supplied, so the arrangement behind this token is unverified.";

    return {
      asset: symbol,
      known: false,
      ambiguous,
      candidateMints,
      model: null,
      custodyType: "unknown",
      operator: null,
      redeemability: "unknown",
      reserveEvidence: "unknown",
      summary,
      trustModel: null,
      wrapHops: null,
      freezable: false,
      audits: null,
      trustAssumptions: [...DEFAULT_TRUST_ASSUMPTIONS.unknown],
      impliedFactors: [
        factor(
          "bridge",
          ambiguous
            ? `${symbol} resolves to more than one mint`
            : `${symbol} bridge structure undescribed`,
          severity.bridge,
          rationale,
          null,
        ),
        factor(
          "custody",
          ambiguous
            ? `${symbol} custody arrangement cannot be pinned to one mint`
            : `${symbol} custody arrangement undescribed`,
          severity.custody,
          rationale,
          null,
        ),
        factor(
          "liquidity",
          ambiguous
            ? `${symbol} exit path cannot be pinned to one mint`
            : `${symbol} redemption path undescribed`,
          DEFAULT_REDEEMABILITY_SEVERITY.unknown,
          ambiguous
            ? rationale
            : "No redemption path was supplied, so exiting the position may depend on market depth alone.",
          null,
        ),
      ],
      sourceUrl: null,
      updatedAt: null,
    };
  }

  const operatorClause =
    model.operator === null ? "" : ` operated by ${model.operator}`;
  const trustAssumptions = [
    ...(model.trustAssumptions ?? DEFAULT_TRUST_ASSUMPTIONS[model.custodyType]),
  ];
  // Measured properties are stated outright rather than left in a severity number.
  if (model.freezable === true) {
    trustAssumptions.push("The issuer holds a key that can freeze a holder's token account.");
  }
  if (model.mintAuthorityIsKeypair === true) {
    trustAssumptions.push(
      "The mint authority is a private key rather than a program address, so issuance depends on how that key is held.",
    );
  }
  if (model.wrapHops !== undefined && model.wrapHops >= 2) {
    trustAssumptions.push(
      `The backing BTC passes through ${model.wrapHops} wrapping hops, and every hop must hold for the token to hold.`,
    );
  }
  const evidenceUrl = model.sourceUrl ?? null;

  // A custody record speaks to the protocol layer when it says who can mint or
  // how many times the code has been reviewed.
  const protocolExtras: RiskFactor[] = [];
  const declaredProtocol = model.severities?.protocol;
  if (custodyTouchesProtocolLayer(model) || declaredProtocol !== undefined) {
    const reasons: string[] = [];
    if (model.mintAuthorityIsKeypair === true) {
      reasons.push("the mint authority is a private key rather than a program address");
    }
    if (model.audits === 0) reasons.push("no third party audit has been published");
    const label =
      reasons.length > 0
        ? `${model.asset} issuance path: ${reasons.join(" and ")}`
        : `${model.asset} protocol exposure declared on the custody record`;
    const rationale =
      reasons.length > 0
        ? `${reasons.join("; ")}. A structural advantage in another layer does not cover this.`
        : `Severity supplied with the custody record for ${model.asset}.`;
    protocolExtras.push(
      factor("protocol", label, protocolSeverityFor(model), rationale, evidenceUrl),
    );
  }

  // The oracle layer is only spoken to when the caller states it outright.
  const declaredExtras: RiskFactor[] = (["oracle"] as const)
    .map((layer) => {
      const severity = model.severities?.[layer];
      if (severity === undefined) return null;
      return factor(
        layer,
        `${model.asset} ${layer} exposure declared on the custody record`,
        severity,
        `Severity supplied with the custody record for ${model.asset}.`,
        model.sourceUrl ?? null,
      );
    })
    .filter((entry): entry is RiskFactor => entry !== null);

  const hopClause =
    model.wrapHops !== undefined && model.wrapHops >= 2
      ? ` The backing passes through ${model.wrapHops} wrapping hops.`
      : "";
  const freezeClause =
    model.freezable === true ? " The issuer can freeze holder token accounts." : "";
  const auditClause =
    model.audits === 0
      ? " No third party audit has been published."
      : model.audits !== undefined
        ? ` ${model.audits} third party audit${model.audits === 1 ? " has" : "s have"} been published.`
        : "";
  const mintClause = model.assetMint ? ` Mint ${model.assetMint}.` : "";

  const summary =
    `${model.asset} is a BTC representation on Solana backed by ` +
    `${STRUCTURE_DESCRIPTION[model.custodyType]}${operatorClause}.${mintClause} ` +
    `${REDEMPTION_DESCRIPTION[model.redeemability]} ` +
    `${RESERVE_DESCRIPTION[model.reserveEvidence]}${hopClause}${freezeClause}${auditClause} ` +
    `Holding it is a claim on that arrangement, not on bitcoin held on the Bitcoin network.`;

  return {
    asset: model.asset,
    known: true,
    ambiguous: false,
    candidateMints: [],
    model,
    custodyType: model.custodyType,
    trustModel: model.trustModel,
    wrapHops: model.wrapHops ?? null,
    freezable: model.freezable === true,
    audits: model.audits ?? null,
    operator: model.operator,
    redeemability: model.redeemability,
    reserveEvidence: model.reserveEvidence,
    summary,
    trustAssumptions,
    impliedFactors: [
      factor(
        "bridge",
        `${model.asset} moved to Solana via ${STRUCTURE_DESCRIPTION[model.custodyType]}`,
        severityFor(model, "bridge"),
        `Bridge exposure implied by the ${model.custodyType} structure on record.`,
        evidenceUrl,
      ),
      factor(
        "custody",
        `${model.asset} backing held under a ${model.custodyType} arrangement`,
        severityFor(model, "custody"),
        `${RESERVE_DESCRIPTION[model.reserveEvidence]} Custody exposure follows from that.`,
        evidenceUrl,
      ),
      factor(
        "liquidity",
        `${model.asset} exit path is ${model.redeemability}`,
        severityFor(model, "liquidity"),
        REDEMPTION_DESCRIPTION[model.redeemability],
        evidenceUrl,
      ),
      ...protocolExtras,
      ...declaredExtras,
    ],
    sourceUrl: evidenceUrl,
    updatedAt: model.updatedAt ?? null,
  };
}
