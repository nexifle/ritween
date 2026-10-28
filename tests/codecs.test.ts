import test from "node:test";
import assert from "node:assert/strict";
import { AAC_CODEC, aacDecoderConfig } from "../src/engine/codecs/aac";
import {
  H264_CODEC,
  h264CodecString,
  h264DecoderConfig,
} from "../src/engine/codecs/h264";

test("H.264 derives the input profile instead of forcing the export profile", () => {
  assert.equal(h264CodecString(new Uint8Array([1, 0x42, 0, 0x2a])), H264_CODEC);
  assert.equal(
    h264CodecString(new Uint8Array([1, 0x64, 0x0c, 0x1f])),
    "avc1.640c1f",
  );
  assert.throws(() => h264CodecString(new Uint8Array([1, 0x42, 0])));
  assert.throws(() => h264CodecString(new Uint8Array([0, 0x42, 0, 0x2a])));
});

test("decoder configs preserve media parameters and own their description bytes", () => {
  const avc = new Uint8Array([1, 0x42, 0, 0x1f]);
  const video = h264DecoderConfig(avc, 1280, 720);
  assert.deepEqual(video, {
    codec: "avc1.42001f",
    codedWidth: 1280,
    codedHeight: 720,
    description: avc,
  });
  assert.notEqual(video.description, avc);
  const asc = new Uint8Array([0x11, 0x90]);
  const audio = aacDecoderConfig(asc, 48000, 2);
  assert.deepEqual(audio, {
    codec: AAC_CODEC,
    sampleRate: 48000,
    numberOfChannels: 2,
    description: asc,
  });
  assert.notEqual(audio.description, asc);
});
