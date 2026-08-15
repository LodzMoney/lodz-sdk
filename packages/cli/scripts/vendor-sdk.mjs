// Vendor lodz-sdk into this package's build output.
//
// Why this exists rather than a plain dependency:
//
// lodz-sdk is not on the registry, so `npm install lodz-cli` cannot resolve it.
// The first attempt used bundleDependencies, which does produce a working
// tarball -- until anyone runs `npm install` at the workspace root. That prunes
// the physical copy npm needs to bundle and replaces it with a hoisted symlink,
// which bundleDependencies does not follow. `npm pack` then succeeds and emits
// a tarball that installs cleanly and dies at first import. A packaging step
// whose correctness depends on what someone else ran last is not a packaging
// step, so the runtime dependency is removed entirely instead.
//
// The SDK has no dependencies of its own and imports nothing outside itself,
// so copying its compiled output and rewriting one specifier is the whole job.
// No bundler is involved and nothing is minified: the shipped code is the same
// code tsc emitted, and it stays readable in a stack trace.
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..");
const sdkRoot = resolve(cliRoot, "..", "sdk-ts");

const SPECIFIER = "lodz-sdk";
const REPLACEMENT = "./vendor/lodz-sdk/index.js";

function fail(message) {
  process.stderr.write(`vendor-sdk: ${message}\n`);
  process.exit(1);
}

if (!existsSync(join(sdkRoot, "dist", "index.js"))) {
  fail("lodz-sdk is not built. Run `npm run build` in packages/sdk-ts first.");
}

/** Rewrite the bare specifier to the vendored path in every emitted file. */
function rewriteDir(dir) {
  let touched = 0;
  for (const name of readdirSync(dir)) {
    if (!/\.(js|d\.ts|js\.map|d\.ts\.map)$/.test(name)) continue;
    const p = join(dir, name);
    const before = readFileSync(p, "utf8");
    // Match the specifier only when it is a complete module string, so a
    // mention inside a comment or a URL is left alone.
    const after = before
      .replaceAll(`from "${SPECIFIER}"`, `from "${REPLACEMENT}"`)
      .replaceAll(`from '${SPECIFIER}'`, `from '${REPLACEMENT}'`)
      .replaceAll(`require("${SPECIFIER}")`, `require("${REPLACEMENT}")`)
      .replaceAll(`import("${SPECIFIER}")`, `import("${REPLACEMENT}")`);
    if (after !== before) {
      writeFileSync(p, after);
      touched += 1;
    }
  }
  return touched;
}

const targets = [
  { out: join(cliRoot, "dist"), src: join(sdkRoot, "dist"), label: "esm" },
  { out: join(cliRoot, "dist", "cjs"), src: join(sdkRoot, "dist", "cjs"), label: "cjs" },
];

for (const t of targets) {
  if (!existsSync(t.out)) fail(`${t.out} is missing. Run the TypeScript build first.`);
  if (!existsSync(t.src)) fail(`${t.src} is missing. The SDK build is incomplete.`);

  const vendorDir = join(t.out, "vendor", "lodz-sdk");
  cpSync(t.src, vendorDir, { recursive: true });

  // dist/cjs/vendor would otherwise inherit the ESM copy nested under dist/cjs.
  const strayNested = join(vendorDir, "cjs");
  if (t.label === "cjs" && existsSync(strayNested)) {
    cpSync(strayNested, vendorDir, { recursive: true });
  }

  const n = rewriteDir(t.out);
  process.stdout.write(`vendored lodz-sdk into ${t.label}, rewrote ${n} file(s)\n`);
}

// Fail loudly if any bare specifier survived. A missed rewrite would install
// fine and only break when the command is actually run.
let leftover = [];
for (const t of targets) {
  for (const name of readdirSync(t.out)) {
    if (!/\.(js|d\.ts)$/.test(name)) continue;
    const body = readFileSync(join(t.out, name), "utf8");
    if (
      body.includes(`from "${SPECIFIER}"`) ||
      body.includes(`require("${SPECIFIER}")`)
    ) {
      leftover.push(join(t.out, name));
    }
  }
}
if (leftover.length > 0) fail(`bare "${SPECIFIER}" specifier left in: ${leftover.join(", ")}`);
process.stdout.write("verified: no bare lodz-sdk specifier remains in the build output\n");
