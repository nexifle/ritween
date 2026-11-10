/**
 * Frozen executable snapshot for the G0/G7 baseline
 * (docs/plans/declarative-layout-hardening.md §13.1: "preserve the baseline
 * artifact so it remains executable").
 *
 * Two properties the review requires:
 * - Hashes are taken from the DESTINATION bytes after copying, never from the
 *   live checkout file, so a concurrent edit cannot produce a manifest that
 *   disagrees with what the snapshot actually contains.
 * - Dependencies are installed inside the snapshot from the copied lockfile
 *   (`npm ci`), never linked from the checkout's node_modules, so replay proves
 *   the recorded dependency set rather than whatever happens to be installed.
 */
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

const SNAPSHOT_EXCLUDE = new Set([
  ".git",
  "node_modules",
  "artifacts",
  "dist",
  "release",
  ".pi",
  "types",
  "benchmarks",
  ".DS_Store",
]);

export function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(filePath) {
  return sha256Bytes(readFileSync(filePath));
}

function walkFiles(dir, base, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SNAPSHOT_EXCLUDE.has(entry.name) || entry.name.endsWith(".env"))
      continue;
    const full = join(dir, entry.name);
    const relative = join(base, entry.name);
    if (entry.isDirectory()) walkFiles(full, relative, files);
    else files.push({ absolute: full, relative });
  }
  return files;
}

/**
 * Copies `checkoutRoot` into `snapshotDir`, hashes the copied files, installs
 * dependencies from the snapshot's own lockfile, and writes manifest.json.
 * Only `snapshotDir` is ever written or removed; the checkout tree is read-only.
 */
export async function createFrozenSnapshot({ checkoutRoot, snapshotDir }) {
  await rm(snapshotDir, { recursive: true, force: true });
  await mkdir(snapshotDir, { recursive: true });
  const files = {};
  for (const file of walkFiles(checkoutRoot, "")) {
    const destination = join(snapshotDir, file.relative);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(file.absolute, destination);
    // Hash what the snapshot now holds, not the mutable source path.
    files[file.relative] = sha256File(destination);
  }
  execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: snapshotDir,
    stdio: "inherit",
    env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
  });
  const manifest = {
    createdAt: new Date().toISOString(),
    files,
    dependencies: {
      source: "isolated npm ci from the snapshot lockfile",
      packageLockSha256: sha256File(join(snapshotDir, "package-lock.json")),
      installedPackages: readdirSync(join(snapshotDir, "node_modules")).length,
    },
  };
  await writeFile(
    join(snapshotDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return manifest;
}

/** Re-hashes every manifest entry; a mismatch means the frozen bytes changed. */
export async function verifySnapshotBytes(snapshotDir, manifest) {
  const entries = Object.entries(manifest.files);
  const mismatches = [];
  for (const [relative, expected] of entries) {
    let actual;
    try {
      actual = sha256Bytes(await readFile(join(snapshotDir, relative)));
    } catch (error) {
      mismatches.push(`${relative}: ${String(error.message ?? error)}`);
      continue;
    }
    if (actual !== expected) mismatches.push(`${relative}: hash changed`);
  }
  return {
    verified: mismatches.length === 0,
    files: entries.length,
    mismatches,
  };
}
