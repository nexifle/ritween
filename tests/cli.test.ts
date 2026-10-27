import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOptions } from "../cli/options.mjs";
import {
  resolveProject,
  resolveSceneSource,
  sceneSources,
} from "../cli/project.mjs";
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
  assert.equal(parseOptions(["export"]).width, undefined);
  assert.equal(
    parseOptions(["export", "--resolution", "1080x1920"]).height,
    1920,
  );
  assert.equal(parseOptions(["export", "--resolution", "800x600"]).width, 800);
  assert.equal(parseOptions(["frame", "--resolution", "256x144"]).width, 256);
  const demo = parseOptions(["--demo", "--open"]);
  assert.equal(demo.command, "preview");
  assert.equal(demo.demo, true);
  assert.equal(demo.open, true);
  assert.equal(parseOptions([]).help, true);
});
test("CLI rejects ambiguous and unsupported options before browser startup", () => {
  for (const args of [
    ["unknown"],
    ["frame", "--time", "NaN"],
    ["frame", "--frame", "1.5"],
    ["frame", "--time", "1", "--frame", "30"],
    ["export", "--resolution", "721x1280"],
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
test("scene source reads files next to the manifest and rejects paths that leave it", () => {
  const manifest = fileURLToPath(
    new URL("../src/project/manifest.ts", import.meta.url),
  );
  const { sources } = sceneSources(manifest);
  assert.match(sources["scenes/intro.ts"], /createIntro/);
  assert.match(sources["scenes/main.tsx"], /createMain/);
  assert.match(sources["scenes/outro.js"], /createOutro/);
  assert.equal(resolveSceneSource(manifest, "../engine/types.ts"), null);
  assert.equal(resolveSceneSource(manifest, "/etc/passwd"), null);
  assert.equal(resolveSceneSource(manifest, "scenes/missing.ts"), null);
  assert.equal(resolveSceneSource(manifest, "scenes/intro.ts?raw"), null);
});

test("CLI exposes encoding controls and rejects invalid or misplaced export settings", () => {
  const defaults = parseOptions(["export"]);
  assert.equal(defaults.bitrate, undefined);
  assert.equal(defaults.latencyMode, "quality");
  assert.equal(defaults.keyFrameInterval, 2);
  const custom = parseOptions([
    "export",
    "--bitrate",
    "8000000",
    "--latency-mode",
    "realtime",
    "--keyframe-interval",
    ".5",
  ]);
  assert.equal(custom.bitrate, 8_000_000);
  assert.equal(custom.latencyMode, "realtime");
  assert.equal(custom.keyFrameInterval, 0.5);
  for (const args of [
    ["export", "--bitrate", "0"],
    ["export", "--bitrate", "6M"],
    ["export", "--bitrate", "Infinity"],
    ["export", "--bitrate", "1.5"],
    ["export", "--latency-mode", "fast"],
    ["export", "--keyframe-interval", "0"],
    ["export", "--keyframe-interval", "61"],
    ["frame", "--bitrate", "1000000"],
  ])
    assert.throws(() => parseOptions(args));
});
