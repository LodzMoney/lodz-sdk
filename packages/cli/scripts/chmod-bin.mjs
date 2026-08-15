// The bin entry must be executable once npm links it. tsc does not preserve
// the mode, so it is set here after the build.
import { chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
chmodSync(join(root, "dist", "index.js"), 0o755);
process.stdout.write("marked dist/index.js executable\n");
