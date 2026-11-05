/**
 * Frozen-snapshot contract for the G0/G7 baseline
 * (docs/plans/declarative-layout-hardening.md §13.1): hashes must describe the
 * snapshot's own bytes, and verification must fail when those bytes change.
 * The npm install is exercised by the driver, not here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  sha256File,
  verifySnapshotBytes,
} from "../scripts/layout-baseline-snapshot.mjs";

async function fixtureSnapshot() {
  const dir = await mkdtemp(join(tmpdir(), "ritween-snapshot-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(dir, "package.json"), "{}\n");
  const files = {
    "src/a.ts": sha256File(join(dir, "src/a.ts")),
    "package.json": sha256File(join(dir, "package.json")),
  };
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ files }));
  return { dir, files };
}

test("verifySnapshotBytes accepts a snapshot that still matches its manifest", async () => {
  const { dir, files } = await fixtureSnapshot();
  const verdict = await verifySnapshotBytes(dir, { files });
  assert.equal(verdict.verified, true);
  assert.equal(verdict.files, 2);
  assert.deepEqual(verdict.mismatches, []);
});

test("verifySnapshotBytes rejects a changed file", async () => {
  const { dir, files } = await fixtureSnapshot();
  await appendFile(join(dir, "src", "a.ts"), "// edited after the manifest\n");
  const changed = await verifySnapshotBytes(dir, { files });
  assert.equal(changed.verified, false);
  assert.deepEqual(changed.mismatches, ["src/a.ts: hash changed"]);
});

test("verifySnapshotBytes rejects a missing file", async () => {
  const { dir, files } = await fixtureSnapshot();
  const missing = await verifySnapshotBytes(dir, {
    files: { ...files, "src/gone.ts": "0".repeat(64) },
  });
  assert.equal(missing.verified, false);
  assert.equal(missing.mismatches.length, 1);
  assert.match(missing.mismatches[0], /^src\/gone\.ts: /);
});

test("sha256File hashes the bytes on disk", async () => {
  const { dir } = await fixtureSnapshot();
  const expected = createHash("sha256").update("{}\n").digest("hex");
  assert.equal(sha256File(join(dir, "package.json")), expected);
});
