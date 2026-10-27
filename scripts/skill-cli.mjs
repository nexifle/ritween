import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nodeCli } from "./node-cli.mjs";

const [mode, ...args] = process.argv.slice(2);
if (mode !== "local" && mode !== "installed") {
  console.error(
    "Usage: node scripts/skill-cli.mjs <local|installed> <CLI arguments>",
  );
  process.exit(1);
}

let installed;
try {
  installed = mode === "installed" ? nodeCli("ritween") : null;
} catch (error) {
  console.error(`Unable to run installed CLI: ${error.message}`);
  process.exit(1);
}
const executable = installed?.command ?? process.execPath;
const cliArgs =
  mode === "local"
    ? [fileURLToPath(new URL("../bin/ritween.mjs", import.meta.url)), ...args]
    : [...installed.args, ...args];
const result = spawnSync(executable, cliArgs, { stdio: "inherit" });
if (result.error) {
  console.error(`Unable to run ${mode} CLI: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exit(result.status ?? 1);
}
