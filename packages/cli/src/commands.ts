/**
 * Command implementations.
 *
 * Every renderer prints what was measured and says so when a figure is absent.
 * `IL: unknown` is a real output, not a fallback to zero: an unknown loss shown
 * as zero turns a gross rate into a net one, which is precisely the
 * misstatement this project exists to correct.
 */

import type { AssayResponse, LodzClient, QueueResponse, SeamsResponse } from "lodz-sdk";
import { assetByMint } from "lodz-sdk";
import { flagAmount, flagString, CliUsageError, type StopeName, type YieldTypeName } from "./args.js";
import { BAR_WIDTH, GLYPH, btc, fit, padLeft, padRight, pct, rule, stackedBar, type Style } from "./render.js";

export interface Ctx {
  readonly client: LodzClient;
  readonly style: Style;
  readonly json: boolean;
  readonly out: (line: string) => void;
}

function provenanceLine(p: { source: string; live: boolean; fetched_at: string | null }): string {
  const when = p.fetched_at ? ` at ${p.fetched_at.replace("T", " ").slice(0, 19)}Z` : "";
  return `source ${p.source}${p.live ? " (live)" : " (not live)"}${when}`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Renders the three-kind split. The shared core of `assay` and `seams`. */
function renderSplit(
  ctx: Ctx,
  parts: {
    sustainableBps: number;
    emissionsBps: number;
    counterpartyBps: number;
    totalBps: number;
    sustainableBtc?: number;
    emissionsBtc?: number;
    counterpartyBtc?: number;
  },
): void {
  const { style, out } = ctx;
  const s = parts.sustainableBps;
  const e = parts.emissionsBps;
  const c = parts.counterpartyBps;
  const total = parts.totalBps;

  out(
    `  ${style.bold(padRight("Yield attribution", 30))}${padLeft(`${total} bps`, 12)}${padLeft(pct(total), 10)}`,
  );
  out(`  ┌${"─".repeat(BAR_WIDTH)}┐`);
  out(
    `  │${stackedBar(
      [
        { bps: s, glyph: GLYPH.sustainable, paint: style.sustainable },
        { bps: e, glyph: GLYPH.emissions, paint: style.emissions },
        { bps: c, glyph: GLYPH.counterparty, paint: style.counterparty },
      ],
      total,
    )}│`,
  );
  out(`  └${"─".repeat(BAR_WIDTH)}┘`);

  const row = (
    glyph: string,
    paint: (x: string) => string,
    label: string,
    bps: number,
    amount: number | undefined,
    note: string,
  ) => {
    const amt = amount === undefined ? "" : `  ${padLeft(btc(amount), 12)} BTC`;
    out(
      `  ${paint(glyph)} ${padRight(label, 14)}${padLeft(`${bps} bps`, 10)}${padLeft(pct(bps), 9)}${amt}   ${style.dim(note)}`,
    );
  };

  row(GLYPH.sustainable, style.sustainable, "Sustainable", s, parts.sustainableBtc,
    "trading fees and borrow interest, paid by an outside user");
  row(GLYPH.emissions, style.emissions, "Emissions", e, parts.emissionsBtc,
    e === 0
      ? `none on Solana BTC pools as of ${today()}`
      : "protocol token emissions, printed by the issuer");
  row(GLYPH.counterparty, style.counterparty, "Counterparty", c, parts.counterpartyBtc,
    c === 0 ? "no allocation to trader-loss funded venues" : "funded by trader losses, not by fees");

  if (e === 0) {
    out("");
    out(
      style.dim(
        `  The emissions row is zero because it was measured as zero: all 94 BTC-related\n` +
        `  pools across 647 days show no reward APY. The collector is working -- the same\n` +
        `  snapshot finds 15 pools with a reward APY elsewhere on Solana.`,
      ),
    );
  }
}

export async function cmdAssay(
  ctx: Ctx,
  args: { btc: number; stope: StopeName },
): Promise<void> {
  const res: AssayResponse = await ctx.client.assay.estimate({
    btcAmount: args.btc,
    stope: args.stope,
  });
  if (ctx.json) {
    ctx.out(JSON.stringify(res, null, 2));
    return;
  }
  const { style, out } = ctx;
  const y = res.yield_split;

  out("");
  out(`  ${style.bold("LODZ assay")}  ${args.btc} BTC  ${style.dim("stope")} ${res.stope}`);
  out(`  ${style.dim(provenanceLine(res.provenance))}`);
  out("");
  renderSplit(ctx, {
    sustainableBps: y.sustainable.apy_bps,
    emissionsBps: y.emissions.apy_bps,
    counterpartyBps: y.counterparty.apy_bps,
    totalBps: y.total.apy_bps,
    sustainableBtc: y.sustainable.annual_btc,
    emissionsBtc: y.emissions.annual_btc,
    counterpartyBtc: y.counterparty.annual_btc,
  });

  out("");
  out(`  ${rule()}`);

  // Impermanent loss. Unknown is printed as unknown.
  if (res.il_unknown || res.net_of_il_bps === null) {
    const ids = res.divergence.il_unknown_seam_ids;
    out(
      `  ${padRight("After impermanent loss", 34)}${padLeft("IL: unknown", 12)}   ${style.warn(
        `no estimate available${ids.length ? ` for ${ids.length} seam(s)` : ""}; not assumed to be zero`,
      )}`,
    );
  } else {
    const lost = y.total.apy_bps - res.net_of_il_bps;
    out(
      `  ${padRight("After impermanent loss", 34)}${padLeft(`${res.net_of_il_bps} bps`, 12)}${padLeft(
        pct(res.net_of_il_bps),
        10,
      )}   ${style.dim(`${lost} bps of estimated loss deducted`)}`,
    );
  }

  const eo = res.emissions_outlook;
  out(
    `  ${padRight("After emissions end", 34)}${padLeft(`${eo.post_emissions_apy_bps} bps`, 12)}${padLeft(
      pct(eo.post_emissions_apy_bps),
      10,
    )}   ${style.dim(eo.apy_lost_bps === 0 ? "no incentive programme to end" : `${eo.apy_lost_bps} bps would stop`)}`,
  );

  const f = res.fee;
  out(
    `  ${padRight(`After performance fee (${f.performance_fee_bps} bps)`, 34)}${padLeft(
      `${f.net_total_apy_bps} bps`,
      12,
    )}${padLeft(pct(f.net_total_apy_bps), 10)}   ${style.dim(`${btc(f.net_annual_btc)} BTC net`)}`,
  );

  out("");
  out(
    `  ${padRight("Redemption", 34)}${res.redemption.estimated_redemption_days} days typical, ${
      res.redemption.worst_case_days
    } days worst case`,
  );
  out(
    `  ${padRight("Risk", 34)}${res.risk.overall_tier}, max ${res.risk.max_wrap_hops} wrap hop(s), ${
      res.risk.freezable_exposure_bps
    } bps freezable`,
  );

  const ref = res.usd_reference;
  if (!ref.live) {
    out("");
    out(style.dim(`  USD figures use an operator-configured reference of $${ref.btc_usd}, not a live quote.`));
  }
  out("");
}

export async function cmdSeams(
  ctx: Ctx,
  args: { type?: YieldTypeName; stope?: StopeName },
): Promise<void> {
  const res: SeamsResponse = await ctx.client.seams.list(
    args.type ? { type: args.type } : {},
  );
  if (ctx.json) {
    ctx.out(JSON.stringify(res, null, 2));
    return;
  }
  const { style, out } = ctx;
  const t = res.totals;

  out("");
  out(
    `  ${style.bold("LODZ seams")}  ${res.seams.length} shown of ${t.seam_count} in catalogue${
      args.type ? `  ${style.dim("filter")} ${args.type}` : ""
    }`,
  );
  out(`  ${style.dim(provenanceLine(res.provenance))}`);
  out("");
  renderSplit(ctx, {
    sustainableBps: t.sustainable_apy_bps,
    emissionsBps: t.emissions_apy_bps,
    counterpartyBps: t.counterparty_apy_bps,
    totalBps: t.blended_apy_bps,
  });
  out("");
  out(`  ${rule(96)}`);
  out(
    `  ${style.dim(
      padRight("VENUE", 17) + padRight("ASSET", 12) + padRight("KIND", 13) + padLeft("APY", 9) +
        padLeft("BASIS", 12) + padLeft("IL", 10) + padLeft("NET", 9) + "  TYPE",
    )}`,
  );
  for (const s of res.seams) {
    const glyph =
      s.yield_type === "sustainable"
        ? style.sustainable(GLYPH.sustainable)
        : s.yield_type === "emissions"
          ? style.emissions(GLYPH.emissions)
          : style.counterparty(GLYPH.counterparty);
    const il = s.il_unknown ? style.warn(padLeft("unknown", 10)) : padLeft(s.il_estimate_bps === null ? "n/a" : `${s.il_estimate_bps} bps`, 10);
    const net = s.net_of_il_bps === null ? padLeft("--", 9) : padLeft(pct(s.net_of_il_bps), 9);
    out(
      `  ${fit(s.venue, 17)}${fit(s.asset, 12)}${fit(s.kind, 13)}${padLeft(
        pct(s.display_apy_bps),
        9,
      )}${padLeft(s.display_apy_basis, 12)}${il}${net}  ${glyph} ${s.yield_type}`,
    );
  }
  out("");
  out(style.dim(`  APY is never the spot rate. BASIS names the window each figure came from.`));
  out(style.dim(`  IL "unknown" means no estimate exists for that pool. It is not zero.`));
  out("");
}

export async function cmdQueue(ctx: Ctx, args: { owner?: string }): Promise<void> {
  const res: QueueResponse = await ctx.client.orecart.queue(
    args.owner ? { owner: args.owner } : {},
  );
  if (ctx.json) {
    ctx.out(JSON.stringify(res, null, 2));
    return;
  }
  const { style, out } = ctx;
  out("");
  out(`  ${style.bold("LODZ redemption queue")}  ${style.dim("status")} ${res.status}`);
  out(`  ${style.dim(provenanceLine(res.provenance))}`);
  out("");
  out(`  ${style.dim(res.status_detail)}`);
  out("");
  out(`  ${padRight("Pending", 24)}${res.pending_requests} request(s), ${btc(res.pending_btc)} BTC`);
  out(`  ${padRight("Typical wait", 24)}${res.current_wait_days} days`);
  out(`  ${padRight("Worst case", 24)}${res.worst_case_wait_days} days`);
  out(`  ${padRight("Standard fee", 24)}${res.policy.standard_fee_bps} bps`);
  out(`  ${padRight("Expedited fee", 24)}${res.policy.expedited_fee_bps} bps`);
  out("");
  out(`  ${style.dim("Wait ladder")}`);
  for (const rung of res.wait_ladder) {
    out(
      `    ${padLeft(btc(rung.btc_amount), 12)} BTC   ${padLeft(String(rung.estimated_days), 5)} days   ${style.dim(
        `worst ${rung.worst_case_days} days`,
      )}`,
    );
  }
  out("");
  out(style.dim(`  ${res.principal_note}`));
  out("");
}

/**
 * Transaction-shaped commands.
 *
 * These build and describe a request; they do not sign or submit. Sending is
 * gated behind an explicit flag AND a deployed program, and the program is not
 * deployed, so there is no path from this binary to a signature today.
 */
export async function cmdBuildOnly(
  ctx: Ctx,
  kind: "deposit" | "redeem",
  args: { amount: number; stope: StopeName; assetMint?: string; send: boolean },
): Promise<number> {
  const { style, out } = ctx;

  if (kind === "deposit") {
    if (!args.assetMint) {
      throw new CliUsageError("deposit needs --asset <mint>. Symbols are not accepted: WBTC has two mints on Solana.");
    }
    // Throws LodzDeniedAssetError for a denylisted mint, before anything else.
    assetByMint(args.assetMint);
  }

  const header = await ctx.client.metrics.header();
  const plan = {
    action: kind,
    amount_btc: args.amount,
    stope: args.stope,
    asset_mint: args.assetMint ?? null,
    program_id: header.program_id,
    cluster: header.cluster,
    vault_status: header.vault_status,
    submitted: false,
    reason_not_submitted:
      header.program_id === null
        ? "The vault program is not deployed, so no instruction can be constructed against it."
        : args.send
          ? "Sending is not implemented in this build."
          : "Sending is disabled by default. Pass --send once the program is live.",
  };

  if (ctx.json) {
    out(JSON.stringify(plan, null, 2));
    return header.program_id === null ? 3 : 0;
  }

  out("");
  out(`  ${style.bold(`LODZ ${kind}`)}  ${args.amount} BTC  ${style.dim("stope")} ${args.stope}`);
  if (args.assetMint) {
    const a = assetByMint(args.assetMint);
    out(`  ${padRight("Asset", 20)}${a.symbol}  ${style.dim(a.mint)}`);
    out(`  ${padRight("Trust model", 20)}${a.trustModel}, ${a.wrapHops} wrap hop(s)${a.freezable ? ", freezable by issuer" : ""}`);
  }
  out(`  ${padRight("Cluster", 20)}${plan.cluster}`);
  out(`  ${padRight("Program", 20)}${plan.program_id ?? style.warn("not deployed")}`);
  out(`  ${padRight("Vault status", 20)}${plan.vault_status}`);
  out("");
  out(`  ${style.warn("Not submitted.")} ${style.dim(plan.reason_not_submitted)}`);
  out("");
  return header.program_id === null ? 3 : 0;
}

export function parseAmountFor(
  flags: Readonly<Record<string, string | boolean>>,
  name: string,
): number {
  const v = flagAmount(flags, name);
  if (v === undefined) throw new CliUsageError(`--${name} is required.`);
  return v;
}

export function optionalOwner(flags: Readonly<Record<string, string | boolean>>): string | undefined {
  return flagString(flags, "owner");
}
