import assert from "node:assert/strict";
import test from "node:test";
import { createSampleIndex } from "../src/engine/decode/sample-index";
import type { Mp4Sample } from "../src/engine/decode/formats/mp4";

test("indexed seek matches decode-order scanning with reordered and duplicate PTS", () => {
  for (const timestamps of [
    [0, 3, 1, 2, 6, 4, 5],
    [2, 1, 1, 0, 5, 4, 3],
  ]) {
    const samples: Mp4Sample[] = timestamps.map((timestamp, index) => ({
      timestamp,
      decodeTimestamp: index,
      duration: 1,
      offset: index,
      size: 1,
      key: index === 1 || index === 4,
    }));
    const index = createSampleIndex(samples);
    for (let time = -1; time <= 8; time += 0.25) {
      let start = -1;
      for (let i = 0; i < samples.length; i++)
        if (samples[i].key && samples[i].timestamp <= time) start = i;
      if (start < 0) start = samples.findIndex((sample) => sample.key);
      let end = start;
      for (let i = start; i < samples.length; i++)
        if (samples[i].timestamp <= time) end = i;
      assert.deepEqual(index.range(time), { start, end });
    }
  }
});

test("sample index rejects tracks without keyframes and supports large tracks", () => {
  assert.throws(() => createSampleIndex([]), /keyframe/);
  const samples = Array.from({ length: 150_000 }, (_, index) => ({
    timestamp: index,
    decodeTimestamp: index,
    duration: 1,
    offset: index,
    size: 1,
    key: true,
  }));
  assert.deepEqual(createSampleIndex(samples).range(149_999), {
    start: 149_999,
    end: 149_999,
  });
});
