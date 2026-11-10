import assert from "node:assert/strict";
import { test } from "node:test";
import {
  matchSharedElements,
  multiply,
} from "../src/engine/render/shared-elements";
import { collectSharedElements } from "../src/authoring/shared-elements";
import { Box, Composition, World, evaluateView } from "../src/authoring/index";
import {
  sceneAudioEnvelope,
  sceneAudioGain,
} from "../src/engine/render/audio-envelope";
import type { Project, Transition } from "../src/engine/types";
import { validateProject } from "../src/engine/timeline";

test("shared IDs match screen poses deterministically with eased progress", () => {
  const a = [{ id: "hero", matrix: [20, 0, 0, 20, 0, 0] }],
    b = [{ id: "hero", matrix: [40, 0, 0, 40, 60, 20] }];
  const [left, right] = matchSharedElements(a, b, 0.5);
  assert.deepEqual(
    multiply(left.get("hero")!, a[0].matrix),
    [30, 0, 0, 30, 30, 10],
  );
  assert.deepEqual(
    multiply(right.get("hero")!, b[0].matrix),
    [30, 0, 0, 30, 30, 10],
  );
  assert.deepEqual(matchSharedElements(a, b, 0.5), [left, right]);
  assert.equal(matchSharedElements(a, [], 0.5)[0].size, 0);
  assert.throws(() => matchSharedElements([...a, ...a], b, 0.5), /Duplicate/);
  assert.throws(
    () =>
      matchSharedElements([{ id: "hero", matrix: [0, 0, 0, 0, 0, 0] }], b, 0.5),
    /singular/,
  );
});

test("nested shared element poses include viewport placement and output scaling", () => {
  const world = World(() => Box({ width: 20, height: 10 }).id("hero"), {
    size: [100, 100],
  });
  const frame = evaluateView(Composition(world).offset(10, 20), {
    time: 0,
    width: 200,
    height: 200,
    measureText: () => 0,
  });
  const poses = collectSharedElements(frame, [200, 200], [400, 400]);
  assert.deepEqual(poses, [{ id: "hero", matrix: [40, 0, 0, 20, 20, 40] }]);
});

test("scene-linked audio follows overlap and opt-out leaves music independent", () => {
  const scene = (id: string, start: number, transition: Transition) => ({
    id,
    start,
    duration: 2,
    name: id,
    source: "test",
    create: () => ({ setup() {}, render() {}, dispose() {} }),
    transition,
  });
  const p: Project = {
    name: "test",
    resolution: [100, 100],
    aspectRatio: [1, 1],
    duration: 3,
    scenes: [
      scene("a", 0, { type: "cut" }),
      scene("b", 1, { type: "crossfade", duration: 1 }),
    ],
  };
  const clip = (sceneId?: string) => ({
    id: "sound",
    name: "sound",
    start: 0,
    duration: 3,
    sceneId,
    create: () => ({ schedule() {} }),
  });
  const a = sceneAudioEnvelope(p, clip("a"))!,
    b = sceneAudioEnvelope(p, clip("b"))!;
  for (const t of [1, 1.25, 1.5, 1.75])
    assert.equal(sceneAudioGain(a, t) + sceneAudioGain(b, t), 1);
  assert.equal(sceneAudioGain(b, 1.5), 0.5);
  assert.equal(sceneAudioGain(b, 0.5), 0);
  assert.equal(sceneAudioEnvelope(p, clip()), undefined);
  const disabled = {
    ...p,
    scenes: [
      p.scenes[0],
      {
        ...p.scenes[1],
        transition: {
          type: "crossfade" as const,
          duration: 1,
          audioCrossfade: false,
        },
      },
    ],
  };
  assert.equal(sceneAudioEnvelope(disabled, clip("a"))!.fadeOut, 0);
  assert.equal(sceneAudioEnvelope(disabled, clip("b"))!.fadeIn, 0);
  validateProject({
    ...p,
    scenes: [
      p.scenes[0],
      {
        ...p.scenes[1],
        transition: {
          type: "custom",
          duration: 1,
          shader: "fn transition() {}",
        },
      },
    ],
  });
  assert.throws(
    () =>
      validateProject({
        ...p,
        scenes: [
          p.scenes[0],
          { ...p.scenes[1], transition: { type: "custom", duration: 1 } },
        ],
      }),
    /transition/,
  );
  assert.throws(() => sceneAudioEnvelope(p, clip("missing")), /Unknown/);
});
