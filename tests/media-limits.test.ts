import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ASSET_BYTES,
  MAX_AUDIO_SOURCE_BYTES,
  MAX_FULL_ASSET_BYTES,
  MAX_MEDIA_SNAPSHOT_BYTES,
  MAX_PCM_BYTES,
  MAX_TEXTURE_BYTES,
} from "../src/engine/media/limits";
import { MAX_ASSET_BYTES as resourceLimit } from "../src/engine/media/resource";
import { AUDIO_LIMITS } from "../src/engine/render/live-mix";

test("central media budgets preserve existing limits and compatibility exports", () => {
  for (const limit of [
    MAX_ASSET_BYTES,
    MAX_AUDIO_SOURCE_BYTES,
    MAX_FULL_ASSET_BYTES,
    MAX_MEDIA_SNAPSHOT_BYTES,
    MAX_PCM_BYTES,
  ]) {
    assert.equal(limit, 128 * 2 ** 20);
  }
  assert.equal(MAX_TEXTURE_BYTES, 64 * 2 ** 20);
  assert.equal(resourceLimit, MAX_ASSET_BYTES);
  assert.equal(AUDIO_LIMITS.sourceBufferBytes, MAX_AUDIO_SOURCE_BYTES);
});
