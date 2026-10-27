import test from "node:test";
import assert from "node:assert/strict";
import type { MediaClip, Project, Scene } from "../src/engine/types";
import {
  resolveMediaProject,
  validateMediaClip,
} from "../src/engine/media/project";
import {
  imageScene,
  videoClip,
  videoResource,
} from "../src/engine/media/visual";

const emptyScene = (): Scene => ({ setup() {}, render() {}, dispose() {} });
const base = (): Project => ({
  name: "Media",
  duration: 5,
  resolution: [320, 180],
  aspectRatio: [16, 9],
  scenes: [
    {
      id: "main",
      name: "Main",
      source: "manifest.ts",
      start: 0,
      duration: 5,
      transition: { type: "cut" },
      create: emptyScene,
    },
  ],
});
const clip = (): MediaClip => ({
  id: "footage",
  name: "Footage",
  url: "/media/shot.mp4",
  start: 0,
  duration: 5,
  offset: 2,
});

test("video helper derives duration and linked audio from a single trim descriptor", () => {
  const scene = videoClip({
    id: "shot",
    name: "Shot",
    source: "manifest.ts",
    url: "/media/shot.mp4",
    start: 0,
    trim: { in: 2, out: 7 },
    audio: { muted: true, volume: 0.5 },
  });
  assert.equal(scene.duration, 5);
  const project = resolveMediaProject({ ...base(), scenes: [scene] });
  const audio = project.audioTracks![0].clips[0];
  assert.equal(audio.id, "shot");
  assert.equal(audio.duration, 5);
  assert.equal(audio.muted, true);
  assert.equal(resolveMediaProject(project), project);
});

test("multiple video resources in one custom scene retain independent audio IDs", () => {
  const first = videoResource(clip());
  const second = videoResource({ ...clip(), id: "other", muted: true });
  const original = { ...base(), mediaClips: [first, second] };
  const result = resolveMediaProject(original);
  assert.deepEqual(
    result.audioTracks!.map((t) => t.clips[0].id),
    ["footage", "other"],
  );
  assert.equal(original.audioTracks, undefined);
  assert.equal(Object.isFrozen(first), true);
  original.mediaClips = [first];
  assert.equal(resolveMediaProject(original).audioTracks!.length, 1);
});

test("one descriptor registered at project and scene level is materialized once", () => {
  const media = clip();
  const project = base();
  project.mediaClips = [media];
  project.scenes = [{ ...project.scenes[0], mediaClips: [media] }];
  assert.equal(resolveMediaProject(project).audioTracks!.length, 1);
});

test("duplicate clip IDs and clips outside composition fail before media I/O", () => {
  assert.throws(
    () => resolveMediaProject({ ...base(), mediaClips: [clip(), clip()] }),
    /Duplicate media clip/,
  );
  assert.throws(
    () =>
      resolveMediaProject({ ...base(), mediaClips: [{ ...clip(), start: 1 }] }),
    /exceeds project/,
  );
  assert.throws(
    () =>
      resolveMediaProject({
        ...base(),
        mediaClips: [clip()],
        audioTracks: [
          {
            id: "music",
            name: "Music",
            clips: [
              {
                id: "footage",
                name: "Existing",
                start: 0,
                duration: 1,
                create: () => ({ schedule() {} }),
              },
            ],
          },
        ],
      }),
    /Duplicate audio\/media/,
  );
});

test("invalid trims and descriptors reject negative, nonfinite, and invalid controls", () => {
  for (const invalid of [
    { duration: 0 },
    { offset: -1 },
    { start: NaN },
    { volume: -1 },
    { muted: "yes" },
  ]) {
    assert.throws(
      () => validateMediaClip({ ...clip(), ...invalid } as MediaClip),
      /Invalid media clip/,
    );
  }
  assert.throws(
    () =>
      videoClip({
        id: "x",
        name: "X",
        source: "manifest.ts",
        url: "/x.mp4",
        start: 0,
        trim: { in: 3, out: 2 },
      }),
    /Invalid media clip/,
  );
});

test("image helper produces a standard sequential scene entry", () => {
  const scene = imageScene({
    id: "still",
    name: "Still",
    source: "manifest.ts",
    url: "/image.png",
    start: 0,
    duration: 5,
  });
  assert.deepEqual(scene.transition, { type: "cut" });
  assert.equal(scene.duration, 5);
  assert.equal(scene.mediaClips, undefined);
  assert.equal(scene.create().prepareFrame, undefined);
});
