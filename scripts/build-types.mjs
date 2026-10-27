import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);
rmSync(new URL("types/", root), { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  [
    require.resolve("typescript/bin/tsc"),
    "-p",
    fileURLToPath(new URL("tsconfig.types.json", root)),
  ],
  { cwd: fileURLToPath(root), stdio: "inherit" },
);
if (result.error) {
  console.error(result.error.message);
}
process.exit(result.status ?? 1);
