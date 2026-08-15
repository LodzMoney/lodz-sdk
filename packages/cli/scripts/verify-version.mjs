// The last step of the build: run what was just built and read back what it
// says about itself.
//
// Every other check in this build inspects files. This one checks behaviour --
// it executes dist/index.js (the ESM build, which is the `lodz` bin) and
// dist/cjs/index.js (the CommonJS build) with --version and compares stdout,
// byte for byte, against package.json. It runs after vendor-sdk.mjs, so what it
// executes is the finished self-contained artifact: the same bytes `npm pack`
// puts in the tarball.
//
// Why it exists: `lodz --version` answered 0.1.0 for a package published as
// 0.1.1, and every file-level check of the day passed. Only running the binary
// disagreed. So now the build runs the binary.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rel = (p) => relative(packageRoot, p) || p;

function fail(message) {
  process.stderr.write(`verify-version: ${message}\n`);
  process.exit(1);
}

const version = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;

// The bin is ESM; dist/cjs/package.json marks the other tree as CommonJS, so
// Node loads each one exactly as an installing user's `lodz` or `require()`
// would.
const entries = [
  { label: "esm", file: join(packageRoot, "dist", "index.js") },
  { label: "cjs", file: join(packageRoot, "dist", "cjs", "index.js") },
];

for (const entry of entries) {
  if (!existsSync(entry.file)) fail(`${rel(entry.file)} is missing. The build did not finish.`);

  const run = spawnSync(process.execPath, [entry.file, "--version"], { encoding: "utf8" });
  if (run.error) fail(`could not run ${rel(entry.file)}: ${run.error.message}`);
  if (run.status !== 0) {
    fail(
      `${rel(entry.file)} --version exited ${run.status}` +
        (run.stderr ? `\n       ${run.stderr.trim()}` : ""),
    );
  }
  // Exact match, including the trailing newline and nothing before it: the
  // output is parsed by scripts, so a prefix is a break.
  if (run.stdout !== `${version}\n`) {
    fail(
      `${entry.label} build reports the wrong version.\n` +
        `       package.json: ${JSON.stringify(version)}\n` +
        `       ${rel(entry.file)} --version: ${JSON.stringify(run.stdout)}\n` +
        `       Rebuild; if it persists, the version stamp in scripts/stamp-dist.mjs is broken.`,
    );
  }
  process.stdout.write(`verified: ${rel(entry.file)} --version prints ${version}\n`);
}
