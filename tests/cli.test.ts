import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOptions } from "../cli/options.mjs";
import { resolveProject } from "../cli/project.mjs";
import { fileURLToPath } from "node:url";
test("CLI resolves web preview, PNG preview alias, frame indices and export presets", () => {
  assert.equal(parseOptions(["preview"]).command, "preview");
  const frame = parseOptions([
    "preview",
    "--frame",
    "156",
    "--fps",
    "30",
    "-o",
    "frame.png",
  ]);
  assert.equal(frame.command, "frame");
  assert.equal(frame.time, 5.2);
  const video = parseOptions([
    "export",
    "/tmp/video",
    "--resolution",
    "1080p",
    "--fps",
    "60",
  ]);
  assert.equal(video.project, "/tmp/video");
  assert.equal(video.width, 1920);
  assert.equal(video.height, 1080);
  assert.equal(video.fps, 60);
  assert.equal(parseOptions(["frame", "--resolution", "256x144"]).width, 256);
});
test("CLI rejects ambiguous and unsupported options before browser startup", () => {
  for (const args of [
    ["unknown"],
    ["frame", "--time", "NaN"],
    ["frame", "--frame", "1.5"],
    ["frame", "--time", "1", "--frame", "30"],
    ["export", "--resolution", "800x600"],
    ["frame", "-o", "video.mp4"],
    ["export", "--fps", "25"],
    ["preview", "--port", "-1"],
    ["frame", "--timeout", "0"],
    ["frame", "--demo", "--project", "."],
    ["export", "--time", "2"],
  ])
    assert.throws(() => parseOptions(args), args.join(" "));
});
test("CLI discovers a project and reports absent manifests", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const found = await resolveProject(root, false, root);
  assert.ok(found.manifest.endsWith("src/project/manifest.ts"));
  await assert.rejects(
    resolveProject("/nonexistent/rimotion-project", false, root),
  );
});
