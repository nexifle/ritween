import test from "node:test";
import assert from "node:assert/strict";
import { StageEntry, Shot, World, Video } from "../src/authoring/index";
import { resolveMediaProject } from "../src/engine/media/project";
import { validateProject } from "../src/engine/timeline";

const clip = () => ({
  id: "footage",
  name: "Footage",
  url: "/video.mp4",
  start: 0,
  duration: 2,
  offset: 1,
});

test("StageEntry snapshots one footage declaration and creates independent Stages", () => {
  const footage = clip();
  const clips = [footage];
  const entry = StageEntry({
    id: "intro",
    source: "manifest.ts",
    start: 0,
    duration: 2,
    mediaClips: clips,
    view: () => Video(footage, { width: 100, height: 100 }),
  });
  assert.equal(entry.name, "intro");
  assert.deepEqual(entry.mediaClips, [footage]);
  footage.offset = 99;
  clips.length = 0;
  assert.equal(entry.mediaClips![0].offset, 1);
  assert.ok(Object.isFrozen(entry.mediaClips));
  assert.ok(Object.isFrozen(entry.mediaClips![0]));
  const a = entry.create(),
    b = entry.create();
  assert.notEqual(a, b);
  assert.equal(typeof a.prepareFrame, "function");
  a.dispose();
  b.dispose();
  const project = {
    name: "Entry",
    resolution: [100, 100] as const,
    aspectRatio: [1, 1] as const,
    duration: 2,
    scenes: [entry],
  };
  validateProject(project);
  const resolved = resolveMediaProject(project);
  const audio = resolved.audioTracks![0].clips[0];
  assert.equal(audio.id, "footage");
  assert.equal(audio.sceneId, "intro");
  assert.equal(audio.duration, 2);
});

test("StageEntry and Shot share timing validation and clip snapshots", () => {
  const footage = clip();
  const world = World(() => Video(footage, { width: 100, height: 100 }), {
    size: [100, 100],
  });
  for (const start of [-1, NaN, Infinity]) {
    assert.throws(
      () =>
        StageEntry({
          id: "bad",
          source: "fixture",
          start,
          duration: 2,
          view: world.view,
        }),
      /valid timing/,
    );
    assert.throws(
      () => Shot({ id: "bad", source: "fixture", start, duration: 2, world }),
      /valid timing/,
    );
  }
  for (const duration of [0, -1, NaN, Infinity])
    assert.throws(
      () =>
        StageEntry({
          id: "bad",
          source: "fixture",
          start: 0,
          duration,
          view: world.view,
        }),
      /valid timing/,
    );
  const shot = Shot({
    id: "shot",
    source: "fixture",
    start: 0,
    duration: 2,
    world,
    mediaClips: [footage],
  });
  footage.url = "/changed.mp4";
  assert.equal(shot.mediaClips![0].url, "/video.mp4");
});
