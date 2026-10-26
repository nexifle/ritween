import assert from "node:assert/strict";
import { test } from "node:test";
import { groupVoices, valueAt, type MixNode } from "../src/engine/live-mix";

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
  assert.deepEqual(bass.voices[0].ids.sort((a, b) => a - b), [0, 1, 2, 3]);
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
  assert.equal(valueAt(0, [{ op: "set", value: 0, time: 1 }, { op: "linear", value: 10, time: 3 }], 2), 5);
  const approached = valueAt(
    0,
    [{ op: "target", value: 10, time: 0, constant: 1 }],
    1,
  );
  assert.ok(approached > 6 && approached < 7);
  assert.equal(
    valueAt(4, [
      { op: "set", value: 4, time: 0 },
      { op: "expo", value: 16, time: 2 },
    ], 1),
    8,
  );
});
