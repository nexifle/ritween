import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEncodingOptions } from "../src/engine/export/settings";

test("export defaults scale bitrate by pixels and FPS with matching portrait behavior", () => {
  assert.deepEqual(resolveEncodingOptions(1920, 1080, 60), {
    bitrate: 6_000_000,
    latencyMode: "quality",
    keyFrameInterval: 2,
  });
  assert.equal(resolveEncodingOptions(1080, 1920, 60).bitrate, 6_000_000);
  assert.equal(resolveEncodingOptions(1920, 1080, 30).bitrate, 3_000_000);
  assert.equal(resolveEncodingOptions(640, 360, 24).bitrate, 500_000);
  assert.deepEqual(
    resolveEncodingOptions(640, 360, 30, {
      bitrate: 2_000_000,
      latencyMode: "realtime",
      keyFrameInterval: 0.5,
    }),
    {
      bitrate: 2_000_000,
      latencyMode: "realtime",
      keyFrameInterval: 0.5,
    },
  );
});

test("invalid encoding controls fail before native encoding starts", () => {
  for (const bitrate of [0, -1, NaN, Infinity, 1.5, 100_000_001])
    assert.throws(
      () => resolveEncodingOptions(1920, 1080, 60, { bitrate }),
      /bitrate/,
    );
  for (const keyFrameInterval of [0, -1, NaN, Infinity, 61])
    assert.throws(
      () => resolveEncodingOptions(1920, 1080, 60, { keyFrameInterval }),
      /interval/,
    );
  assert.throws(
    () =>
      resolveEncodingOptions(1920, 1080, 60, {
        latencyMode: "invalid" as "quality",
      }),
    /latency/,
  );
});
