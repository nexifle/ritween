import { test } from "node:test";
import assert from "node:assert/strict";
import { waitForEncoderCapacity } from "../src/engine/encoder-queue";

class Encoder extends EventTarget {
  encodeQueueSize = 4;
  drain(size: number) {
    this.encodeQueueSize = size;
    this.dispatchEvent(new Event("dequeue"));
  }
}

test("encoder backpressure waits for capacity, ignores a still-full dequeue, and does not flush", async () => {
  const encoder = new Encoder();
  let resumed = false;
  const waiting = waitForEncoderCapacity(encoder, 4, []).then(() => {
    resumed = true;
  });
  encoder.drain(4);
  await Promise.resolve();
  assert.equal(resumed, false);
  encoder.drain(3);
  await waiting;
  assert.equal(resumed, true);
  await waitForEncoderCapacity(encoder, 4, []);
});

test("encoder backpressure rejects on cancellation and codec failure, including an already-aborted signal", async () => {
  for (const alreadyAborted of [true, false]) {
    const encoder = new Encoder();
    const failure = new AbortController();
    const error = new Error("codec failed");
    if (alreadyAborted) failure.abort(error);
    const waiting = waitForEncoderCapacity(encoder, 4, [
      undefined,
      failure.signal,
    ]);
    const rejection = assert.rejects(waiting, (caught) => caught === error);
    if (!alreadyAborted) failure.abort(error);
    await rejection;
    encoder.drain(0);
  }
});
