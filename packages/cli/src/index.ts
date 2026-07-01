#!/usr/bin/env node
/**
 * lodz -- command line client for the LODZ BTC yield layer.
 *
 * Exit codes carry meaning, because a wrapper script needs to tell a bad
 * request from an unreachable service:
 *
 *   0  success
 *   1  usage error (bad flag, missing argument, denylisted mint)
 *   2  the service answered with an error status
 *   3  the request could not reach the service, or the action is unavailable
 */

import {
  LodzApiError,
  LodzClient,
  LodzDeniedAssetError,
  LodzNetworkError,
  LodzTimeoutError,
  LodzUsageError,
} from "lodz-sdk";
import {
  CliUsageError,
  flagBool,
  flagStope,
  flagString,
  flagYieldType,
  parseArgs,
} from "./args.js";
import {
  cmdAssay,
  cmdBuildOnly,
  cmdQueue,
  cmdSeams,
  optionalOwner,
  parseAmountFor,
  type Ctx,
} from "./commands.js";
import { makeStyle } from "./render.js";

const DEFAULT_API = "https://api.lodz.fi";
const VERSION = "0.1.0";

const HELP = `lodz -- BTC yield attribution on Solana

Usage
  lodz assay   --btc <n> [--stope conservative|balanced|aggressive] [--json]
  lodz seams   [--type sustainable|emissions|counterparty] [--json]
  lodz queue   [--owner <pubkey>] [--json]
  lodz deposit --btc <n> --asset <mint> [--stope <p>] [--json]
  lodz redeem  --amount <n> [--stope <p>] [--json]

Options
  --api <url>     Indexer base URL. Defaults to $LODZ_API_URL, then ${DEFAULT_API}
  --json          Emit raw JSON on stdout. Suitable for a pipe
  --timeout <ms>  Per-request timeout. Default 15000
  --help          This text
  --version       Print the version

Notes
  Yield is reported in three kinds: sustainable, emissions and counterparty.
  They are never summed into a single headline figure.

  Assets are identified by mint, never by symbol. WBTC has two distinct mints
  on Solana and a symbol lookup resolves to the wrong one.

  deposit and redeem build and describe a request. They do not sign or submit.

  Colour is used only on a terminal and is disabled by NO_COLOR.
`;

function fail(message: string, code: number): never {
  process.stderr.write(`lodz: ${message}\n`);
  process.exit(code);
}

async function main(argv: readonly string[]): Promise<number> {
  const { command, flags } = parseArgs(argv);

  // --help / -h / --version / -V are equal to their subcommand forms. Asking
  // for help is never an error, so it exits 0 and prints to stdout.
  if (flags["help"] === true || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (flags["version"] === true || command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  // Invoked with nothing at all: show usage, but exit non-zero so a script
  // that forgot its arguments does not read as success.
  if (command === "" && Object.keys(flags).length === 0) {
    process.stderr.write(HELP);
    return 1;
  }
  if (command === "") {
    throw new CliUsageError(
      `No command given. Run "lodz --help" for the list of commands.`,
    );
  }

  const json = flagBool(flags, "json");
  const apiUrl = flagString(flags, "api") ?? process.env["LODZ_API_URL"] ?? DEFAULT_API;
  const timeoutRaw = flagString(flags, "timeout");
  const timeoutMs = timeoutRaw === undefined ? 15_000 : Number(timeoutRaw);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CliUsageError(`--timeout must be a positive number of milliseconds, got ${timeoutRaw}`);
  }

  const style = makeStyle({
    // JSON output is a data stream. Never paint it, even on a terminal.
    isTty: !json && process.stdout.isTTY === true,
    env: process.env,
  });

  const ctx: Ctx = {
    client: new LodzClient({ apiUrl, timeoutMs }),
    style,
    json,
    out: (line: string) => process.stdout.write(`${line}\n`),
  };

  switch (command) {
    case "assay":
      await cmdAssay(ctx, { btc: parseAmountFor(flags, "btc"), stope: flagStope(flags) });
      return 0;
    case "seams": {
      const type = flagYieldType(flags);
      await cmdSeams(ctx, type ? { type } : {});
      return 0;
    }
    case "queue": {
      const owner = optionalOwner(flags);
      await cmdQueue(ctx, owner ? { owner } : {});
      return 0;
    }
    case "deposit": {
      const assetMint = flagString(flags, "asset");
      return await cmdBuildOnly(ctx, "deposit", {
        amount: parseAmountFor(flags, "btc"),
        stope: flagStope(flags),
        ...(assetMint !== undefined ? { assetMint } : {}),
        send: flagBool(flags, "send"),
      });
    }
    case "redeem":
      return await cmdBuildOnly(ctx, "redeem", {
        amount: parseAmountFor(flags, "amount"),
        stope: flagStope(flags),
        send: flagBool(flags, "send"),
      });
    default:
      throw new CliUsageError(`Unknown command ${JSON.stringify(command)}. Run "lodz --help".`);
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    if (e instanceof CliUsageError || e instanceof LodzUsageError) fail(e.message, 1);
    if (e instanceof LodzDeniedAssetError) fail(e.message, 1);
    if (e instanceof LodzApiError) {
      fail(
        `the service rejected the request (${e.status} ${e.code}): ${e.detail ?? e.message}` +
          (e.requestId ? `\n       request id ${e.requestId}` : ""),
        2,
      );
    }
    if (e instanceof LodzTimeoutError) fail(`${e.message}. Use --timeout to allow longer.`, 3);
    if (e instanceof LodzNetworkError) {
      fail(`${e.message}\n       Check --api or $LODZ_API_URL.`, 3);
    }
    fail(e instanceof Error ? e.message : String(e), 3);
  });
