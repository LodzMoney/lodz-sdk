import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CliUsageError,
  flagAmount,
  flagBool,
  flagStope,
  flagString,
  flagYieldType,
  parseArgs,
} from "../src/args.js";

test("parses a command with space-separated and equals-separated options", () => {
  assert.deepEqual(parseArgs(["assay", "--btc", "1.5"]), {
    command: "assay",
    flags: { btc: "1.5" },
  });
  assert.deepEqual(parseArgs(["assay", "--btc=1.5", "--stope=aggressive"]), {
    command: "assay",
    flags: { btc: "1.5", stope: "aggressive" },
  });
});

test("known boolean options do not swallow the next token", () => {
  const { flags } = parseArgs(["seams", "--json", "--type", "emissions"]);
  assert.equal(flags["json"], true);
  assert.equal(flags["type"], "emissions");
});

test("an option missing its value is an error, not a silent true", () => {
  assert.throws(() => parseArgs(["assay", "--btc"]), CliUsageError);
  assert.throws(() => parseArgs(["assay", "--btc", "--json"]), CliUsageError);
});

test("a bare positional argument is rejected rather than ignored", () => {
  assert.throws(() => parseArgs(["assay", "1.5"]), CliUsageError);
});

test("an unparseable amount is refused rather than coerced to zero", () => {
  // The failure this prevents: --btc abc becoming 0 and the tool then printing
  // a confident 0.00000000 BTC as though it were an answer.
  assert.throws(() => flagAmount({ btc: "abc" }, "btc"), CliUsageError);
  assert.throws(() => flagAmount({ btc: "" }, "btc"), CliUsageError);
  assert.throws(() => flagAmount({ btc: "Infinity" }, "btc"), CliUsageError);
  assert.throws(() => flagAmount({ btc: "0" }, "btc"), CliUsageError);
  assert.throws(() => flagAmount({ btc: "-2" }, "btc"), CliUsageError);
  assert.equal(flagAmount({ btc: "1.5" }, "btc"), 1.5);
  assert.equal(flagAmount({}, "btc"), undefined);
});

test("stope accepts only the three tiers and defaults to balanced", () => {
  assert.equal(flagStope({}), "balanced");
  assert.equal(flagStope({ stope: "conservative" }), "conservative");
  assert.equal(flagStope({ stope: "aggressive" }), "aggressive");
  assert.throws(() => flagStope({ stope: "reckless" }), CliUsageError);
  // A near miss must fail loudly rather than fall back to the default.
  assert.throws(() => flagStope({ stope: "Balanced" }), CliUsageError);
});

test("yield type accepts only the three kinds", () => {
  assert.equal(flagYieldType({}), undefined);
  assert.equal(flagYieldType({ type: "counterparty" }), "counterparty");
  assert.throws(() => flagYieldType({ type: "sustainble" }), CliUsageError);
  // "yield" is not one of the kinds; the split is the product.
  assert.throws(() => flagYieldType({ type: "yield" }), CliUsageError);
});

test("flagString rejects a boolean where a value was required", () => {
  assert.throws(() => flagString({ api: true }, "api"), CliUsageError);
  assert.equal(flagString({ api: "http://x" }, "api"), "http://x");
  assert.equal(flagString({}, "api"), undefined);
});

test("flagBool reads both the presence form and an explicit true", () => {
  assert.equal(flagBool({ json: true }, "json"), true);
  assert.equal(flagBool({ json: "true" }, "json"), true);
  assert.equal(flagBool({}, "json"), false);
  assert.equal(flagBool({ json: "false" }, "json"), false);
});

test("an option in the command position is an option, not a command", () => {
  // The bug this covers: `lodz --help` produced "Unknown command --help. Run
  // lodz --help", which tells the reader to run the thing they just ran.
  assert.deepEqual(parseArgs(["--help"]), { command: "", flags: { help: true } });
  assert.deepEqual(parseArgs(["--version"]), { command: "", flags: { version: true } });
});

test("-h and -V are normalised to their long forms", () => {
  assert.deepEqual(parseArgs(["-h"]), { command: "", flags: { help: true } });
  assert.deepEqual(parseArgs(["-V"]), { command: "", flags: { version: true } });
});

test("a subcommand still parses when help is asked for after it", () => {
  assert.deepEqual(parseArgs(["assay", "--help"]), { command: "assay", flags: { help: true } });
});

test("no arguments at all yields an empty command and no flags", () => {
  assert.deepEqual(parseArgs([]), { command: "", flags: {} });
});
