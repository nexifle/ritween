import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [mode, ...args] = process.argv.slice(2);
if (mode !== "local" && mode !== "installed") {
  console.error(
    "Usage: node scripts/skill-cli.mjs <local|installed> <CLI arguments>",
  );
  process.exit(1);
}

const executable = mode === "local" ? process.execPath : "ritween";
const cliArgs =
  mode === "local"
    ? [fileURLToPath(new URL("../bin/ritween.mjs", import.meta.url)), ...args]
    : args;
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
