// Marks the CommonJS output directory so Node reads dist/cjs/*.js as CommonJS
// while the package itself stays ESM. No bundler and no extra dependency.
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
writeFileSync(
  join(packageRoot, "dist", "cjs", "package.json"),
  `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`,
);
process.stdout.write("stamped dist/cjs/package.json as commonjs\n");
