import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The bug this file covers: the version was a constant typed into
// src/index.ts. The package was published as 0.1.1 while `lodz --version`
// answered 0.1.0. The build passed and the tests passed, because nothing
// compared the two numbers. This does.
//
// Compiled to .tmp-test/test/version.test.js, so the package root is two up.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Deliberately not a literal. A version written down here would drift in step
// with the one it is supposed to catch, and the test would keep passing.
const expected: string = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf8"),
).version;

/** Run a built entry point with --version, the way an installed user would. */
function reportedVersion(entry: string): string {
  const file = join(packageRoot, entry);
  assert.ok(
    existsSync(file),
    `${entry} is missing. Run "npm run build -w @lodz/cli" before the tests.`,
  );
  const run = spawnSync(process.execPath, [file, "--version"], { encoding: "utf8" });
  assert.equal(run.status, 0, `${entry} --version exited ${run.status}: ${run.stderr}`);
  return run.stdout;
}

test("the ESM build prints the version in package.json, and nothing else", () => {
  // Byte for byte: the trailing newline is part of the contract and a prefix
  // would break every script that reads this output.
  assert.equal(reportedVersion("dist/index.js"), `${expected}\n`);
});

test("the CommonJS build prints the same version as the ESM build", () => {
  // dist/cjs/index.js is what `require("@lodz/cli")` loads. It is a separate
  // tsc emit, so it is a separate chance to disagree.
  assert.equal(reportedVersion("dist/cjs/index.js"), `${expected}\n`);
});

test("the source declares no version of its own", () => {
  // The regression guard proper. scripts/stamp-dist.mjs refuses to build a
  // hand written version literal; this catches one even when nobody rebuilt,
  // and names the file so the fix is obvious.
  const literal = /(["'])(\d+\.\d+\.\d+[^"']*)\1/g;
  const placeholder = "0.0.0-unstamped";
  const offenders: string[] = [];

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });

  for (const file of walk(join(packageRoot, "src"))) {
    if (!file.endsWith(".ts")) continue;
    for (const [, , found] of readFileSync(file, "utf8").matchAll(literal)) {
      if (found !== placeholder) offenders.push(`${file}: "${found}"`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `a version is written by hand in the source. Import VERSION from ./version.js instead.`,
  );
});
