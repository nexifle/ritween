import assert from "node:assert/strict";
import test from "node:test";
import { exportFilename } from "../src/engine/export/filename";

test("MP4 filenames follow the manifest project name", () => {
  assert.equal(exportFilename("Source to motion"), "source-to-motion.mp4");
  assert.equal(exportFilename("My New Composition"), "my-new-composition.mp4");
  assert.equal(exportFilename("  Motion   Study  "), "motion-study.mp4");
});

test("MP4 filenames remove path separators and unsafe filename characters", () => {
  assert.equal(
    exportFilename('../Demo\\Cut: "Final"?*<>|'),
    "demo-cut-final.mp4",
  );
  assert.equal(
    exportFilename("First\nSecond\u0000Third"),
    "first-second-third.mp4",
  );
});

test("MP4 filenames preserve Unicode names and normalize combining characters", () => {
  assert.equal(exportFilename("Café 東京"), "café-東京.mp4");
  assert.equal(exportFilename("Café"), "café.mp4");
});

test("MP4 filenames fall back when the project name has no usable characters", () => {
  for (const name of ["", "   ", "../", "🎬"]) {
    assert.equal(exportFilename(name), "video.mp4");
  }
});
