import assert from "node:assert/strict";
import { test } from "node:test";
import {
  groupVoices,
  LiveMix,
  offsetAfterElapsed,
  valueAt,
  type MixNode,
} from "../src/engine/live-mix";
import type { Project } from "../src/engine/types";

const node = (
  id: number,
  start: number | null,
  outs: number[],
  stop: number | null = start == null ? null : start + 0.2,
): MixNode => ({ id, kind: "n", start, stop, outs });

test("notes that start together share a voice, and a bus across the score stays shared", () => {
  const bass = groupVoices([
    node(0, 1, [2]),
    node(1, 1, [2]),
    node(2, null, [3]),
    node(3, null, []),
  ]);
  assert.equal(bass.voices.length, 1);
  assert.deepEqual(
    bass.voices[0].ids.sort((a, b) => a - b),
    [0, 1, 2, 3],
  );
  assert.deepEqual(bass.shared, []);

  const bus = groupVoices([
    node(0, 0, [2], 0.2),
    node(1, 10, [2], 10.2),
    node(2, null, []),
  ]);
  assert.deepEqual(
    bus.voices.map((voice) => voice.ids),
    [[0], [1]],
  );
  assert.deepEqual(bus.shared, [2]);
});

test("param value follows set, linear, and target events", () => {
  assert.equal(
    valueAt(
      0,
      [
        { op: "set", value: 0, time: 1 },
        { op: "linear", value: 10, time: 3 },
      ],
      2,
    ),
    5,
  );
  const approached = valueAt(
    0,
    [{ op: "target", value: 10, time: 0, constant: 1 }],
    1,
  );
  assert.ok(approached > 6 && approached < 7);
  assert.equal(
    valueAt(
      4,
      [
        { op: "set", value: 4, time: 0 },
        { op: "expo", value: 16, time: 2 },
      ],
      1,
    ),
    8,
  );
});

test("overlapping source clusters preserve one shared graph instead of duplicating effect state", () => {
  const score = groupVoices([
    node(0, 0, [3]),
    node(1, 0.03, [3, 4]),
    node(2, 0.06, [4]),
    node(3, null, [5]),
    node(4, null, [5]),
    node(5, null, []),
  ]);
  assert.deepEqual(score.voices, []);
  assert.deepEqual(score.shared, [0, 1, 2, 3, 4, 5]);
});

test("large scores classify every voice once and keep cyclic delay buses shared", () => {
  const count = 2000;
  const sources = Array.from({ length: count }, (_, i) =>
    node(i, i * 0.1, [count]),
  );
  const score = groupVoices([
    ...sources,
    node(count, null, [count + 1]),
    node(count + 1, null, [count]),
  ]);
  assert.equal(score.voices.length, count);
  assert.equal(new Set(score.voices.flatMap((voice) => voice.ids)).size, count);
  assert.deepEqual(score.shared, [count, count + 1]);
});

test("late preview starts wrap offsets through the export loop range", () => {
  // Start at 1.25s; 12.5s later this is 5 complete loop periods plus 0.75s.
  assert.equal(offsetAfterElapsed(1.25, 12.5, 1, 3), 1.75);
  // The initial prefix before loopStart plays once before looping.
  assert.equal(offsetAfterElapsed(0.25, 4, 1, 3), 2.25);
  assert.equal(offsetAfterElapsed(0.25, 0.5, 1, 3), 0.75);
});

test("muted clips skip preview preparation and surface errors only when unmuted", async () => {
  class StubAudioNode {
    gain = {
      setTargetAtTime() {},
    } as unknown as AudioParam;
    connect<T>(destination: T) {
      return destination;
    }
    disconnect() {}
  }
  class StubGainNode extends StubAudioNode {
    constructor(_context: BaseAudioContext, options?: GainOptions) {
      super();
      if (options?.gain != null)
        (this.gain as unknown as { value: number }).value = options.gain;
    }
  }
  class StubDynamicsCompressorNode extends StubGainNode {}

  const globals = globalThis as unknown as Record<string, unknown>;
  const keys = ["GainNode", "DynamicsCompressorNode"];
  const originals = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  Object.defineProperty(globalThis, "GainNode", {
    configurable: true,
    writable: true,
    value: StubGainNode,
  });
  Object.defineProperty(globalThis, "DynamicsCompressorNode", {
    configurable: true,
    writable: true,
    value: StubDynamicsCompressorNode,
  });

  const base: Project = {
    name: "Lazy audio",
    duration: 1,
    resolution: [640, 360],
    aspectRatio: [16, 9],
    scenes: [
      {
        id: "scene",
        name: "Scene",
        source: "scene.ts",
        start: 0,
        duration: 1,
        transition: { type: "cut" },
        create: () => {
          throw Error("unused");
        },
      },
    ],
  };
  let mutedSchedules = 0;
  let audibleSchedules = 0;
  const previewProject: Project = {
    ...base,
    audioTracks: [
      {
        id: "muted-track",
        name: "Muted track",
        clips: [
          {
            id: "missing",
            name: "Missing muted asset",
            start: 0,
            duration: 1,
            muted: true,
            create: () => ({
              schedule() {
                mutedSchedules++;
                throw Error("unsupported asset");
              },
            }),
          },
        ],
      },
      {
        id: "audible-track",
        name: "Audible track",
        clips: [
          {
            id: "audible",
            name: "Audible",
            start: 0,
            duration: 1,
            create: () => ({
              schedule() {
                audibleSchedules++;
              },
            }),
          },
        ],
      },
    ],
  };
  const mix = new LiveMix(
    { currentTime: 0 } as AudioContext,
    new StubAudioNode() as unknown as AudioNode,
  );
  try {
    const first = mix.prepare(previewProject, []);
    assert.equal(mix.prepare(previewProject, []), first);
    const prepared = await first;
    assert.equal(prepared, true);
    assert.equal(audibleSchedules, 1);
    assert.equal(mutedSchedules, 0);
    await assert.rejects(
      mix.setMuted([], []),
      /Audio clip "missing": unsupported asset/,
    );
    assert.equal(mutedSchedules, 1);
  } finally {
    mix.dispose();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globals, key);
    }
  }
});
