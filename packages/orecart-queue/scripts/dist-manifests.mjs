// Writes the per-directory module-type markers that let a single "type": "module"
// package ship both an ESM and a CommonJS build from one source tree.
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const manifests = [
  ["dist/esm/package.json", { type: "module" }],
  ["dist/cjs/package.json", { type: "commonjs" }],
];

for (const [relativePath, manifest] of manifests) {
  writeFileSync(resolve(packageRoot, relativePath), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
