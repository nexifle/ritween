/**
 * Atomic, non-destructive inspection output
 * (docs/plans/declarative-layout-hardening.md §7 CLI contract:
 * "File output is atomic and does not destroy an existing file on failure").
 *
 * Covers the publish mechanics directly: no-replace commit without `--force`, real
 * replacement with it, no temp file or partial target after any failure, and a
 * cancellation check that runs immediately before the commit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAtomic } from "../cli/main.ts";

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), "ritween-atomic-"));
  return {
    directory,
    path: join(directory, "report.json"),
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
    async entries() {
      return (await readdir(directory)).sort();
    },
  };
}

test("writeAtomic publishes a new file and leaves no temp file", async () => {
  const work = await workspace();
  try {
    await writeAtomic(work.path, '{"a":1}\n');
    assert.equal(await readFile(work.path, "utf8"), '{"a":1}\n');
    assert.deepEqual(await work.entries(), ["report.json"]);
  } finally {
    await work.cleanup();
  }
});

test("writeAtomic refuses to replace an existing file without force", async () => {
  const work = await workspace();
  try {
    await writeFile(work.path, "original\n");
    await assert.rejects(
      () => writeAtomic(work.path, "replacement\n"),
      /Output exists: .*Pass --force/,
    );
    assert.equal(
      await readFile(work.path, "utf8"),
      "original\n",
      "the existing file must be byte-identical after a refused write",
    );
    assert.deepEqual(
      await work.entries(),
      ["report.json"],
      "no temp file survives",
    );
  } finally {
    await work.cleanup();
  }
});

test("writeAtomic replaces an existing file only when force is set", async () => {
  const work = await workspace();
  try {
    await writeFile(work.path, "original\n");
    await writeAtomic(work.path, "replacement\n", { force: true });
    assert.equal(await readFile(work.path, "utf8"), "replacement\n");
    assert.deepEqual(await work.entries(), ["report.json"]);
  } finally {
    await work.cleanup();
  }
});

test("a cancellation before the commit leaves no target and no temp file", async () => {
  const work = await workspace();
  try {
    await assert.rejects(
      () =>
        writeAtomic(work.path, '{"a":1}\n', {
          checkCancelled: () => {
            throw Error("Cancelled.");
          },
        }),
      /Cancelled/,
    );
    await assert.rejects(stat(work.path), /ENOENT/, "no output may be created");
    assert.deepEqual(await work.entries(), [], "the temp file is cleaned up");
  } finally {
    await work.cleanup();
  }
});

test("a cancelled force-write preserves the existing file", async () => {
  const work = await workspace();
  try {
    await writeFile(work.path, "original\n");
    await assert.rejects(
      () =>
        writeAtomic(work.path, "replacement\n", {
          force: true,
          checkCancelled: () => {
            throw Error("Cancelled.");
          },
        }),
      /Cancelled/,
    );
    assert.equal(
      await readFile(work.path, "utf8"),
      "original\n",
      "a cancelled replacement must not destroy the previous file",
    );
    assert.deepEqual(await work.entries(), ["report.json"]);
  } finally {
    await work.cleanup();
  }
});

test("writeAtomic creates missing parent directories", async () => {
  const work = await workspace();
  try {
    const nested = join(work.directory, "a/b/report.json");
    await writeAtomic(nested, "x\n");
    assert.equal(await readFile(nested, "utf8"), "x\n");
  } finally {
    await work.cleanup();
  }
});
