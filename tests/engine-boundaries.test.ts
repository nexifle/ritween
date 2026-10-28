import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const engine = fileURLToPath(new URL("../src/engine/", import.meta.url));

async function checkDirectory(directory: string, forbidden: string[]) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await checkDirectory(filename, forbidden);
    } else if (entry.name.endsWith(".ts")) {
      const source = await readFile(filename, "utf8");
      for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
        const target = path.relative(engine, path.resolve(directory, match[1]));
        assert.ok(
          !forbidden.some((area) => target.startsWith(`${area}${path.sep}`)),
          `${path.relative(engine, filename)} must not import ${target}`,
        );
      }
    }
  }
}

test("codec definitions, decoding and rendering do not depend on export", async () => {
  await checkDirectory(path.join(engine, "codecs"), [
    "decode",
    "render",
    "export",
    "media",
  ]);
  await checkDirectory(path.join(engine, "decode"), ["render", "export"]);
  await checkDirectory(path.join(engine, "render"), ["export"]);
});
