import assert from "node:assert/strict";
import test from "node:test";
import { SequentialVideo } from "../src/engine/decode/sequential-video";

test("aborting an asynchronous sample read never submits its late chunk", async () => {
  const original = globalThis.VideoDecoder;
  let submitted = 0;
  let closed = 0;
  class Decoder {
    state = "configured";
    decodeQueueSize = 0;
    configure() {}
    decode() {
      submitted++;
    }
    close() {
      this.state = "closed";
      closed++;
    }
  }
  globalThis.VideoDecoder = Decoder as unknown as typeof VideoDecoder;
  const session = new SequentialVideo({ codec: "avc1.42001e" });
  const controller = new AbortController();
  let finish!: (chunk: EncodedVideoChunk) => void;
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  try {
    const result = session.read(
      0,
      0,
      0,
      1,
      0,
      () => {
        started();
        return new Promise<EncodedVideoChunk>((resolve) => {
          finish = resolve;
        });
      },
      controller.signal,
    );
    await reading;
    controller.abort(new Error("cancel sample"));
    finish({ timestamp: 0 } as EncodedVideoChunk);
    await assert.rejects(result, /cancel sample/);
    assert.equal(submitted, 0);
    assert.equal(closed, 1);
    assert.equal(session.usage.frames, 0);
  } finally {
    session.dispose();
    globalThis.VideoDecoder = original;
  }
});
