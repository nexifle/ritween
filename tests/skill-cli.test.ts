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
import { nodeCli } from "../scripts/node-cli.mjs";

const withPath = (path: string) => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"),
  ),
  PATH: path,
});

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
    env: withPath(""),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ritween/i);
});

test("installed skill CLI never falls back when ritween is missing", () => {
  const result = spawnSync(process.execPath, [runner, "installed", "--help"], {
    env: withPath(""),
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unable to run installed CLI/);
});

test("installed skill CLI preserves arguments, cwd, and exit status", () => {
  const root = mkdtempSync(join(tmpdir(), "ritween-skill-cli-"));
  try {
    const bin = join(root, "bin with spaces");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "ritween"),
      `#!${process.execPath}\nconsole.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\nprocess.exit(7);\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, "ritween.cmd"),
      '@echo off\r\n"node" "%dp0%\\ritween.js" %*\r\n',
    );
    writeFileSync(
      join(bin, "ritween.js"),
      "console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() })); process.exit(7);",
    );
    const args = [
      "frame",
      "--project",
      "a project/manifest.ts",
      "-o",
      "frame one.png",
      'literal & | < > ^ %PATH% ! " quote',
      "trailing\\",
    ];
    const result = spawnSync(process.execPath, [runner, "installed", ...args], {
      cwd: root,
      env: withPath(bin),
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

test("Windows npm shims resolve without a shell and respect PATH selection", () => {
  const root = mkdtempSync(join(tmpdir(), "ritween shim "));
  try {
    const entry = join(root, "cli.js");
    writeFileSync(entry, "");
    writeFileSync(
      join(root, "ritween.cmd"),
      '@echo off\r\n"%_prog%" "%dp0%\\cli.js" %*\r\n',
    );
    const resolved = nodeCli("ritween", {
      platform: "win32",
      env: { Path: root },
    });
    assert.deepEqual(resolved, { command: process.execPath, args: [entry] });
    assert.deepEqual(
      nodeCli(join(root, "ritween.cmd"), { platform: "win32" }),
      resolved,
    );
    assert.throws(
      () => nodeCli("ritween", { platform: "win32", env: { PATH: "" } }),
      /not found/,
    );
    writeFileSync(join(root, "ritween.cmd"), "echo unsupported");
    assert.throws(
      () => nodeCli("ritween", { platform: "win32", env: { PATH: root } }),
      /Unsupported/,
    );
    assert.deepEqual(nodeCli("custom.exe", { platform: "win32" }), {
      command: "custom.exe",
      args: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
