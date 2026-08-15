import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const target of ["dist", ".dev"]) {
  rmSync(resolve(packageRoot, target), { recursive: true, force: true });
}
