import test from "node:test";
import assert from "node:assert/strict";
import { AAC_CODEC, aacDecoderConfig } from "../src/engine/codecs/aac";
import { av1CodecString } from "../src/engine/codecs/av1";
import { hevcCodecString } from "../src/engine/codecs/hevc";
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

test("HEVC codec strings preserve profile space, reversed compatibility, tier and constraints", () => {
  const description = new Uint8Array(23);
  description.set([
    1, 0x62, 0x60, 0, 0, 1, 0xb0, 0, 0x02, 0, 0, 0, 153, 0xf0, 0, 0xfc, 0xfd,
    0xf8, 0xf8, 0, 0, 3, 0,
  ]);
  assert.equal(
    hevcCodecString(description, "hev1"),
    "hev1.A2.80000006.H153.B0.00.02",
  );
  assert.throws(() => hevcCodecString(description, "hvc1"), /VPS, SPS and PPS/);
  const padded = new Uint8Array(27);
  padded.set(description, 2);
  assert.equal(
    hevcCodecString(padded.subarray(2, 25), "hev1"),
    "hev1.A2.80000006.H153.B0.00.02",
  );
  for (const [offset, value] of [
    [0, 2],
    [13, 0],
    [15, 0],
    [17, 0],
    [21, 2],
    [22, 1],
  ]) {
    const invalid = description.slice();
    invalid[offset] = value;
    assert.throws(() => hevcCodecString(invalid, "hev1"), /hvcC/);
  }
  assert.throws(
    () => hevcCodecString(new Uint8Array([...description, 0]), "hev1"),
    /trailing hvcC/,
  );
});

test("AV1 configuration derives 8/10/12-bit profiles and rejects malformed headers", () => {
  assert.equal(
    av1CodecString(new Uint8Array([0x81, 4, 0x0c, 0])),
    "av01.0.04M.08",
  );
  assert.equal(
    av1CodecString(new Uint8Array([0x81, 8, 0xcc, 0])),
    "av01.0.08H.10",
  );
  assert.equal(
    av1CodecString(new Uint8Array([0x81, 0x48, 0x60, 0])),
    "av01.2.08M.12",
  );
  for (const header of [
    [0x81, 4],
    [0x80, 4, 0x0c, 0],
    [0x81, 0x64, 0, 0],
    [0x81, 4, 0x20, 0],
    [0x81, 4, 0x80, 0],
    [0x81, 4, 0x0c, 1],
    [0x81, 4, 0x0c, 0x80],
  ])
    assert.throws(() => av1CodecString(new Uint8Array(header)), /av1C/);
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
