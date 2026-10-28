import assert from "node:assert/strict";
import test from "node:test";
import { SequentialVideo } from "../src/engine/decode/sequential-video";

test("sequential sessions reuse decoding, return owned clones, restart and close late frames", async () => {
  const original = globalThis.VideoDecoder;
  let created = 0;
  let submitted = 0;
  let closed = 0;
  const decoders: Stub[] = [];
  const frame = (timestamp: number) =>
    ({
      timestamp,
      codedWidth: 2,
      codedHeight: 2,
      clone: () => frame(timestamp),
      close() {
        closed++;
      },
    }) as unknown as VideoFrame;
  class Stub {
    state = "configured";
    decodeQueueSize = 0;
    constructor(readonly callbacks: VideoDecoderInit) {
      created++;
      decoders.push(this);
    }
    configure() {}
    decode(chunk: EncodedVideoChunk) {
      submitted++;
      this.callbacks.output(frame(chunk.timestamp));
    }
    async flush() {}
    close() {
      this.state = "closed";
    }
  }
  globalThis.VideoDecoder = Stub as unknown as typeof VideoDecoder;
  const session = new SequentialVideo({ codec: "avc1.42001e" });
  const chunk = (i: number) => ({ timestamp: i }) as EncodedVideoChunk;
  try {
    const controller = new AbortController();
    const first = await session.read(0, 0, 0, 10, 0, chunk, controller.signal);
    first.close();
    const second = await session.read(1, 0, 1, 10, 1, chunk, controller.signal);
    second.close();
    assert.equal(created, 1);
    assert.equal(submitted, 2);
    assert.ok(session.usage.peakFrames <= 12);
    assert.ok(session.usage.peakBytes <= 96 * 2 ** 20);
    (await session.read(0, 0, 0, 10, 0, chunk, controller.signal)).close();
    assert.equal(created, 2);
    const before = closed;
    decoders[0].callbacks.output(frame(99));
    assert.equal(closed, before + 1);
    session.dispose();
    assert.equal(session.usage.frames, 0);
    assert.equal(session.usage.bytes, 0);
    const after = closed;
    session.dispose();
    assert.equal(closed, after);
    controller.abort();
    await assert.rejects(
      session.read(0, 0, 0, 10, 0, chunk, controller.signal),
    );
  } finally {
    session.dispose();
    globalThis.VideoDecoder = original;
  }
});

test("abort interrupts an EOF flush even if the native promise never settles", async () => {
  const original = globalThis.VideoDecoder;
  let flushing!: () => void;
  const started = new Promise<void>((resolve) => {
    flushing = resolve;
  });
  let closed = 0;
  class Stub {
    state = "configured";
    decodeQueueSize = 0;
    configure() {}
    decode() {}
    flush() {
      flushing();
      return new Promise<void>(() => {});
    }
    close() {
      this.state = "closed";
      closed++;
    }
  }
  globalThis.VideoDecoder = Stub as unknown as typeof VideoDecoder;
  const session = new SequentialVideo({ codec: "avc1.42001e" });
  try {
    const controller = new AbortController();
    const pending = session.read(
      0,
      0,
      0,
      1,
      0,
      () => ({ timestamp: 0 }) as EncodedVideoChunk,
      controller.signal,
    );
    await started;
    controller.abort(Error("cancel EOF flush"));
    await assert.rejects(pending, /cancel EOF flush/);
    assert.equal(closed, 1);
    assert.equal(session.usage.frames, 0);
  } finally {
    session.dispose();
    globalThis.VideoDecoder = original;
  }
});

test("oversized native output is closed rather than retained above the byte budget", async () => {
  const original = globalThis.VideoDecoder;
  let closed = 0;
  class Stub {
    state = "configured";
    decodeQueueSize = 0;
    constructor(readonly callbacks: VideoDecoderInit) {}
    configure() {}
    decode() {
      this.callbacks.output({
        timestamp: 0,
        codedWidth: 8192,
        codedHeight: 8192,
        close() {
          closed++;
        },
      } as unknown as VideoFrame);
    }
    close() {
      this.state = "closed";
    }
  }
  globalThis.VideoDecoder = Stub as unknown as typeof VideoDecoder;
  const session = new SequentialVideo({ codec: "avc1.42001e" });
  try {
    await assert.rejects(
      session.read(
        0,
        0,
        0,
        10,
        0,
        () => ({ timestamp: 0 }) as EncodedVideoChunk,
        new AbortController().signal,
      ),
      /budget/,
    );
    assert.equal(closed, 1);
    assert.equal(session.usage.frames, 0);
    assert.equal(session.usage.bytes, 0);
  } finally {
    session.dispose();
    globalThis.VideoDecoder = original;
  }
});
