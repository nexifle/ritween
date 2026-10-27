import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(
  new URL("../scripts/skill-cli.mjs", import.meta.url),
);

test("skill CLI rejects missing or unknown modes", () => {
  for (const args of [[], ["production"]]) {
    const result = spawnSync(process.execPath, [runner, ...args], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
});

test("local skill CLI works outside the checkout without a global executable", () => {
  const result = spawnSync(process.execPath, [runner, "local", "--help"], {
    cwd: tmpdir(),
    env: { ...process.env, PATH: "" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ritween/i);
});

test("installed skill CLI never falls back when ritween is missing", () => {
  const result = spawnSync(process.execPath, [runner, "installed", "--help"], {
    env: { ...process.env, PATH: "" },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unable to run installed CLI/);
});

test("installed skill CLI preserves arguments, cwd, and exit status", () => {
  const root = mkdtempSync(join(tmpdir(), "ritween-skill-cli-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "ritween"),
      `#!${process.execPath}\nconsole.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\nprocess.exit(7);\n`,
      { mode: 0o755 },
    );
    const args = [
      "frame",
      "--project",
      "a project/manifest.ts",
      "-o",
      "frame one.png",
    ];
    const result = spawnSync(process.execPath, [runner, "installed", ...args], {
      cwd: root,
      env: { ...process.env, PATH: bin },
      encoding: "utf8",
    });
    assert.equal(result.status, 7, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.args, args);
    assert.equal(output.cwd, realpathSync(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
