// Post-build stamping of dist/. Two jobs, both about making the shipped
// artifact agree with its own package.json:
//
//   1. Mark the CommonJS output directory so Node reads dist/cjs/*.js as
//      CommonJS while the package itself stays ESM.
//   2. Write the package.json "version" into the placeholder that
//      src/version.ts carries, in both the ESM and the CommonJS output.
//
// (2) exists because the version used to be a constant typed by hand into
// src/index.ts. 0.1.1 was published while `lodz --version` still answered
// 0.1.0, and nothing objected: the build passed, the tests passed, and only
// running the installed binary revealed it. The stamp deletes the second copy
// of the number outright -- package.json is now the only place a version is
// written -- and every failure mode below exits non-zero instead of shipping a
// version string that lies. Silence is what let the last one through, so this
// script prefers a dead build to a quiet one.
//
// No bundler and no dependency: this is the same fail-loud rewrite that the
// sibling scripts/vendor-sdk.mjs performs on the vendored SDK specifier.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rel = (p) => relative(packageRoot, p) || p;

function fail(message) {
  process.stderr.write(`stamp-dist: ${message}\n`);
  process.exit(1);
}

/** Every file under `dir`, recursively. */
function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// ------------------------------------------------------------ commonjs marker

writeFileSync(
  join(packageRoot, "dist", "cjs", "package.json"),
  `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`,
);
process.stdout.write("stamped dist/cjs/package.json as commonjs\n");

// ----------------------------------------------------------- version stamping

const PLACEHOLDER = "0.0.0-unstamped";
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;

const manifestPath = join(packageRoot, "package.json");
let version;
try {
  version = JSON.parse(readFileSync(manifestPath, "utf8")).version;
} catch (e) {
  fail(`could not read ${rel(manifestPath)}: ${e instanceof Error ? e.message : String(e)}`);
}
if (typeof version !== "string" || !SEMVER.test(version)) {
  fail(`package.json "version" is not a version string: ${JSON.stringify(version)}`);
}
if (version === PLACEHOLDER) {
  fail(`package.json "version" is the build placeholder. Set a real version.`);
}

// A version typed into the source by hand is the exact defect this script
// exists to prevent, so refuse to build one. The placeholder itself is the
// only version-shaped literal src/ is allowed to contain.
const LITERAL = /(["'])(\d+\.\d+\.\d+[^"']*)\1/g;
const handWritten = [];
for (const file of walk(join(packageRoot, "src"))) {
  if (!file.endsWith(".ts")) continue;
  for (const [, , literal] of readFileSync(file, "utf8").matchAll(LITERAL)) {
    if (literal !== PLACEHOLDER) handWritten.push(`${rel(file)}: "${literal}"`);
  }
}
if (handWritten.length > 0) {
  fail(
    `a version literal is written by hand in the source:\n` +
      handWritten.map((h) => `         ${h}\n`).join("") +
      `       package.json is the only source of truth for the version.\n` +
      `       Import VERSION from ./version.js instead, and let this script stamp it.`,
  );
}

const targets = [
  { label: "esm", file: join(packageRoot, "dist", "version.js") },
  { label: "cjs", file: join(packageRoot, "dist", "cjs", "version.js") },
];

for (const t of targets) {
  let body;
  try {
    body = readFileSync(t.file, "utf8");
  } catch {
    fail(`${rel(t.file)} is missing. Run the TypeScript build first.`);
  }

  const quoted = [`"${PLACEHOLDER}"`, `'${PLACEHOLDER}'`];
  const hits = quoted.reduce((n, q) => n + body.split(q).length - 1, 0);
  if (hits === 0) {
    fail(
      `${rel(t.file)} carries no ${JSON.stringify(PLACEHOLDER)} placeholder, so the ` +
        `${t.label} build would ship whatever version string is in it.\n` +
        `       src/version.ts must declare exactly: export const VERSION: string = "${PLACEHOLDER}";`,
    );
  }
  if (hits > 1) {
    fail(`${rel(t.file)} carries ${hits} placeholders. Exactly one version literal is allowed.`);
  }

  let stamped = body;
  for (const q of quoted) stamped = stamped.replaceAll(q, `"${version}"`);
  writeFileSync(t.file, stamped);

  // Read back rather than trust the write: this file is the only thing standing
  // between package.json and what the published binary prints.
  const after = readFileSync(t.file, "utf8");
  if (!after.includes(`"${version}"`)) fail(`${rel(t.file)} does not contain ${version} after stamping.`);
  process.stdout.write(`stamped version ${version} into ${rel(t.file)} (${t.label})\n`);
}

// A missed copy would install fine and only lie when the command is run, which
// is precisely how the last one escaped. Sweep the whole build output.
const leftover = walk(join(packageRoot, "dist"))
  .filter((f) => /\.(js|cjs|mjs|d\.ts|json)$/.test(f))
  .filter((f) => readFileSync(f, "utf8").includes(PLACEHOLDER));
if (leftover.length > 0) {
  fail(`unstamped placeholder left in: ${leftover.map(rel).join(", ")}`);
}
process.stdout.write(`verified: dist reports version ${version}, no unstamped placeholder remains\n`);
