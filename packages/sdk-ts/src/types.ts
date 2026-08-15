/**
 * Response types, mirroring the LODZ indexer API.
 *
 * Rates are basis points wherever a calculation may depend on them. The `_pct`
 * companions the service also sends are kept for display only; anything that
 * reaches a balance should use the bps field.
 */

/**
 * Where a yield actually comes from.
 *
 * Three variants, not two. Measurement on 2026-08-15 found a live vault paying
 * 214.828% whose source is trader losses, which behaves like fee revenue on a
 * chart and is nothing like it in character. Merging it into `sustainable`
 * would make the split misleading in exactly the way this project exists to fix.
 */
export type YieldType = "sustainable" | "emissions" | "counterparty";

/** Risk appetite tier. */
export type Stope = "conservative" | "balanced" | "aggressive";

export type RiskTier = "low" | "medium" | "high";

/** How an APY figure was derived. Spot values are never used. */
export type ApyBasis = "apy_7d" | "apy_30d_mean" | "apy_90d_median" | string;

export interface Provenance {
  readonly source: string;
  readonly mode: string;
  readonly live: boolean;
  readonly description: string;
  readonly catalog_compiled_at: string | null;
  readonly fetched_at: string | null;
  readonly upstreams: readonly string[];
  readonly degraded_reason: string | null;
  readonly generated_at: string;
}

export interface UsdReference {
  readonly btc_usd: number;
  readonly source: string;
  /** False when the figure is an operator-configured constant, not a quote. */
  readonly live: boolean;
}

export interface Seam {
  readonly id: string;
  readonly name: string;
  readonly venue: string;
  readonly asset: string;
  readonly asset_mint: string;
  readonly kind: string;
  readonly yield_type: YieldType;
  readonly apy_bps: number;
  readonly apy_pct: number;
  readonly apy_7d_bps: number | null;
  readonly apy_30d_mean_bps: number | null;
  readonly apy_90d_median_bps: number | null;
  /** The figure that may be shown. Never the spot rate. */
  readonly display_apy_bps: number;
  readonly display_apy_pct: number;
  readonly display_apy_basis: ApyBasis;
  readonly tvl_usd: number;
  readonly allocation_bps: number;
  readonly emission_token: string | null;
  readonly emission_ends_at: string | null;
  readonly risk_tier: RiskTier;
  readonly source_url: string | null;
  readonly updated_at: string;
  /**
   * Impermanent loss estimate. Meaningful only when `il_unknown` is false.
   * When it is true the estimate does not exist and must not be invented.
   */
  readonly il_estimate_bps: number | null;
  readonly il_unknown: boolean;
  readonly il_model: string | null;
  readonly net_of_il_bps: number | null;
  readonly below_liquidity_floor: boolean;
  readonly source_divergence: boolean;
  readonly divergence_detail: string | null;
  readonly routable: boolean;
  readonly exclusion_reason: string | null;
  readonly pool_address: string | null;
}

export interface SeamTotals {
  readonly seam_count: number;
  readonly routable_count: number;
  readonly sustainable_count: number;
  readonly emissions_count: number;
  readonly counterparty_count: number;
  readonly sustainable_apy_bps: number;
  readonly emissions_apy_bps: number;
  readonly counterparty_apy_bps: number;
  readonly blended_apy_bps: number;
  readonly sustainable_share_bps: number;
  readonly [key: string]: unknown;
}

export interface SeamsResponse {
  readonly seams: readonly Seam[];
  readonly stope: Stope;
  readonly totals: SeamTotals;
  readonly allocation_notes: readonly string[];
  readonly excluded_candidates: readonly unknown[];
  readonly usd_reference: UsdReference;
  readonly provenance: Provenance;
}

export interface YieldLeg {
  readonly apy_bps: number;
  readonly apy_pct: number;
  readonly annual_btc: number;
  readonly annual_usd: number;
}

export interface YieldSplit {
  readonly sustainable: YieldLeg;
  readonly emissions: YieldLeg;
  readonly counterparty: YieldLeg;
  readonly total: YieldLeg;
}

export interface EmissionsOutlook {
  readonly post_emissions_apy_bps: number;
  readonly apy_lost_bps: number;
  readonly emission_exposure_bps: number;
  readonly emissions_share_bps: number;
  readonly sustainable_share_bps: number;
  readonly counterparty_share_bps: number;
  readonly programmes: readonly unknown[];
  readonly earliest_published_end: string | null;
  readonly note: string;
}

export interface DivergenceReport {
  readonly il_estimate_bps: number | null;
  readonly il_unknown: boolean;
  readonly il_unknown_seam_ids: readonly string[];
  readonly covered_allocation_bps: number;
  readonly model: string | null;
  readonly note: string;
}

export interface RedemptionEstimate {
  readonly estimated_redemption_days: number;
  readonly unwind_days: number;
  readonly settlement_days: number;
  readonly queue_days: number;
  readonly worst_case_days: number;
  readonly standard_fee_bps: number;
  readonly expedited_fee_bps: number;
  readonly note: string;
}

/**
 * What the projection subtracts before it reports a net rate.
 *
 * There is one fee, and it is a redemption fee. It is charged when a position is
 * redeemed, and its basis is the realised yield attached to the shares being
 * redeemed. Principal is not in the basis, so a redemption that accrued no yield
 * is charged nothing. No performance fee and no management fee exist.
 */
export interface FeeBreakdown {
  /** Redemption fee rate, in basis points of realised yield. */
  readonly redemption_fee_bps: number;
  /**
   * The same fee in BTC, over the projected year this response describes.
   * It is taken out of projected yield, never out of the deposit.
   */
  readonly redemption_fee_btc: number;
  /**
   * @deprecated Alias of `redemption_fee_bps` and carries the same corrected
   * value. It stays because the published `@lodz/cli` 0.1.2 reads this key and
   * would lose the figure if it disappeared. New code should read
   * `redemption_fee_bps`.
   */
  readonly performance_fee_bps: number;
  /**
   * @deprecated Alias of `redemption_fee_btc` and carries the same corrected
   * value. It stays because the published `@lodz/cli` 0.1.2 reads this key.
   * New code should read `redemption_fee_btc`.
   */
  readonly performance_fee_btc: number;
  readonly net_annual_btc: number;
  readonly net_annual_usd: number;
  readonly net_total_apy_bps: number;
  readonly net_post_emissions_apy_bps: number;
}

export interface SeamContribution {
  readonly seam_id: string;
  readonly name: string;
  readonly venue: string;
  readonly asset: string;
  readonly asset_mint: string;
  readonly kind: string;
  readonly yield_type: YieldType;
  readonly risk_tier: RiskTier;
  readonly allocation_bps: number;
  readonly btc_allocated: number;
  readonly apy_bps: number;
  readonly apy_basis: ApyBasis;
  readonly annual_btc: number;
  readonly il_estimate_bps: number | null;
  readonly il_unknown: boolean;
  readonly net_of_il_bps: number | null;
  readonly contribution_bps: number;
  readonly share_of_yield_bps: number;
  readonly emission_token: string | null;
}

export interface RiskLayer {
  readonly id: string;
  readonly name: string;
  readonly tier: RiskTier;
  readonly summary: string;
  readonly factors: readonly unknown[];
}

export interface RiskSummary {
  readonly overall_tier: RiskTier;
  readonly exposure_by_tier_bps: Readonly<Record<string, number>>;
  readonly exposure_by_trust_model_bps: Readonly<Record<string, number>>;
  readonly max_wrap_hops: number;
  readonly freezable_exposure_bps: number;
  readonly layers: readonly RiskLayer[];
  readonly disclosures: readonly string[];
}

export interface AssayRequest {
  readonly btcAmount: number;
  readonly stope?: Stope;
}

export interface AssayResponse {
  readonly btc_amount: number;
  readonly stope: Stope;
  readonly yield_split: YieldSplit;
  readonly post_emissions_apy_bps: number;
  readonly net_of_il_bps: number | null;
  readonly il_unknown: boolean;
  readonly emission_exposure_bps: number;
  readonly emissions_outlook: EmissionsOutlook;
  readonly divergence: DivergenceReport;
  readonly redemption: RedemptionEstimate;
  readonly estimated_redemption_days: number;
  readonly fee: FeeBreakdown;
  readonly risk: RiskSummary;
  readonly contributions: readonly SeamContribution[];
  readonly allocation_notes: readonly string[];
  readonly usd_reference: UsdReference;
  readonly provenance: Provenance;
}

export interface QueuePolicy {
  readonly unwind_days: number;
  readonly settlement_days: number;
  readonly throughput_btc_per_day: number;
  readonly max_wait_days: number;
  readonly standard_fee_bps: number;
  readonly expedited_fee_bps: number;
  readonly minimum_redemption_btc: number;
  readonly buffer_target_bps: number;
  readonly [key: string]: unknown;
}

export interface QueueResponse {
  readonly status: string;
  readonly status_detail: string;
  readonly stope: Stope;
  readonly pending_requests: number;
  readonly pending_btc: number;
  readonly ready_btc: number;
  readonly deployed_btc: number;
  readonly buffer_btc: number;
  readonly current_wait_days: number;
  readonly worst_case_wait_days: number;
  readonly policy: QueuePolicy;
  readonly entries: readonly unknown[];
  readonly wait_ladder: readonly {
    readonly btc_amount: number;
    readonly estimated_days: number;
    readonly worst_case_days: number;
  }[];
  readonly principal_note: string;
  readonly updated_at: string;
  readonly provenance: Provenance;
}

export interface RiskAsset {
  readonly asset: string;
  readonly mint: string;
  readonly issuer: string;
  readonly trust_model: string;
  readonly wrap_hops: number;
  readonly mint_authority_is_keypair: boolean;
  readonly freezable: boolean;
  readonly tier: RiskTier;
  readonly detail: string;
  readonly routed: boolean;
}

export interface RiskResponse {
  readonly overall_tier: RiskTier;
  readonly layers: readonly RiskLayer[];
  readonly assets: readonly RiskAsset[];
  readonly excluded_assets: readonly {
    readonly mint: string;
    readonly label: string;
    readonly reason: string;
    readonly category: string;
  }[];
  readonly excluded_venues: Readonly<Record<string, string>>;
  readonly incidents: readonly unknown[];
  readonly disclosures: readonly string[];
  readonly reviewed_at: string;
  readonly provenance: Provenance;
}

export interface Vault {
  readonly id: Stope;
  readonly name: string;
  readonly subtitle: string;
  readonly thesis: string;
  readonly risk_tier: RiskTier;
  readonly sustainable_apy_bps: number;
  readonly emissions_apy_bps: number;
  readonly counterparty_apy_bps: number;
  readonly total_apy_bps: number;
  readonly post_emissions_apy_bps: number;
  readonly net_of_il_bps: number | null;
  readonly il_estimate_bps: number | null;
  readonly il_unknown: boolean;
  readonly emissions_share_bps: number;
  readonly exposure_by_tier_bps: Readonly<Record<string, number>>;
  readonly exposure_by_trust_model_bps: Readonly<Record<string, number>>;
  readonly max_wrap_hops: number;
  readonly estimated_redemption_days: number;
}

export interface VaultsResponse {
  readonly vaults: readonly Vault[];
  readonly default_stope: Stope;
  readonly vault_status: string;
  readonly updated_at: string;
  readonly provenance: Provenance;
}

export interface HeaderMetrics {
  readonly btc_in_seams: number;
  readonly sustainable_pct_bps: number;
  readonly emissions_pct_bps: number;
  readonly counterparty_pct_bps: number;
  readonly redemption_days: number;
  readonly anchor_version: string;
  readonly cluster: string;
  readonly vault_status: string;
  readonly program_id: string | null;
  readonly blended_apy_bps: number;
  readonly post_emissions_apy_bps: number;
  readonly net_of_il_bps: number | null;
  readonly il_unknown: boolean;
  readonly catalog_tvl_usd: number;
  readonly routable_tvl_usd: number;
  readonly seam_count: number;
  readonly routable_seam_count: number;
}

export interface HealthResponse {
  readonly status: string;
  readonly service: string;
  readonly version: string;
  readonly environment: string;
  readonly cluster: string;
  readonly seam_source: string;
  readonly uptime_seconds: number;
  readonly timestamp: string;
}
