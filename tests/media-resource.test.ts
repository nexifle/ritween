import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ASSET_BYTES,
  fetchAsset,
  readAssetResponse,
  resolveAssetUrl,
} from "../src/engine/media/resource";
import {
  audioFile,
  fadeGain,
  pcmChunkRange,
  pcmClipRange,
} from "../src/engine/media/audio-file";
import {
  forwardAbortSignals,
  frameOverlapsPresentation,
} from "../src/engine/media/video-resource";

async function withBrowserFetch<T>(
  implementation: typeof fetch,
  run: () => Promise<T>,
) {
  const previousFetch = globalThis.fetch;
  const previousLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "https://studio.example/editor" },
  });
  globalThis.fetch = implementation;
  try {
    return await run();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousLocation)
      Object.defineProperty(globalThis, "location", previousLocation);
    else delete (globalThis as { location?: Location }).location;
  }
}

test("asset URLs are same-origin HTTP(S) and never local file URLs", () => {
  assert.equal(
    resolveAssetUrl("/media/clip.mp4", "https://studio.example/editor").href,
    "https://studio.example/media/clip.mp4",
  );
  assert.equal(
    resolveAssetUrl(
      "https://studio.example/a.wav",
      "https://studio.example/editor",
    ).origin,
    "https://studio.example",
  );
  assert.throws(
    () =>
      resolveAssetUrl(
        "https://cdn.example/a.mp4",
        "https://studio.example/editor",
      ),
    /same-origin/,
  );
  assert.throws(
    () =>
      resolveAssetUrl(
        "file:///Users/person/a.mp4",
        "https://studio.example/editor",
      ),
    /same-origin/,
  );
  assert.throws(
    () =>
      resolveAssetUrl(
        "blob:https://studio.example/asset",
        "https://studio.example/editor",
      ),
    /same-origin/,
  );
});

test("asset fetch enforces same-origin mode and returns streamed bytes", async () => {
  let requestOptions: RequestInit | undefined;
  const bytes = await withBrowserFetch(
    async (_input, init) => {
      requestOptions = init;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.of(1, 2));
            controller.enqueue(Uint8Array.of(3, 4));
            controller.close();
          },
        }),
      );
    },
    () => fetchAsset("/media/clip.wav"),
  );
  assert.deepEqual([...new Uint8Array(bytes)], [1, 2, 3, 4]);
  assert.equal(requestOptions?.mode, "same-origin");
  assert.equal(requestOptions?.credentials, "same-origin");
  assert.equal(requestOptions?.redirect, "error");
});

test("asset stream rejects advertised and actual bytes above the limit", async () => {
  await assert.rejects(
    readAssetResponse(
      new Response("x", {
        headers: { "content-length": String(MAX_ASSET_BYTES + 1) },
      }),
    ),
    /128 MiB/,
  );
  await assert.rejects(
    readAssetResponse(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.of(1, 2));
            controller.enqueue(Uint8Array.of(3, 4));
            controller.close();
          },
        }),
      ),
      undefined,
      3,
    ),
    /encoded resource limit/,
  );
});

test("asset stream cancels a pending read when its signal aborts", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1));
      },
      pull() {
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  const controller = new AbortController();
  const pending = readAssetResponse(response, controller.signal, 10);
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(Error("cancel asset read"));
  await assert.rejects(pending, /cancel asset read/);
  assert.equal(cancelled, true);
});

test("audio file decodes through the managed context and trims at its source offset", async () => {
  const scheduled: unknown[][] = [];
  const automation: unknown[][] = [];
  const buffer = { duration: 4 } as AudioBuffer;
  const destination = {} as AudioNode;
  const source = {
    buffer: null,
    loop: false,
    loopStart: 0,
    loopEnd: 0,
    connect(target: AudioNode) {
      return target;
    },
    start(...args: number[]) {
      scheduled.push(["start", ...args]);
    },
    stop(...args: number[]) {
      scheduled.push(["stop", ...args]);
    },
  } as unknown as AudioBufferSourceNode;
  const gain = {
    gain: {
      value: 1,
      setValueAtTime(value: number, time: number) {
        automation.push(["set", value, time]);
      },
      linearRampToValueAtTime(value: number, time: number) {
        automation.push(["linear", value, time]);
      },
    },
    connect(target: AudioNode) {
      return target;
    },
  } as unknown as GainNode;
  let decodedBytes = 0;
  const context = {
    async decodeAudioData(bytes: ArrayBuffer) {
      decodedBytes = bytes.byteLength;
      return buffer;
    },
    createBufferSource: () => source,
    createGain: () => gain,
  } as unknown as BaseAudioContext;
  const clip = audioFile({ url: "/music.wav", offset: 1, volume: 0.5 })();

  await withBrowserFetch(
    async () => new Response(Uint8Array.of(9, 8, 7)),
    () =>
      clip.schedule({
        context,
        destination,
        signal: new AbortController().signal,
        start: 10,
        duration: 2,
        at: (localTime) => 10 + localTime,
      }),
  );

  assert.equal(decodedBytes, 3);
  assert.equal(source.buffer, buffer);
  assert.equal(source.loop, false);
  assert.equal(source.loopStart, 1);
  assert.equal(source.loopEnd, 3);
  assert.deepEqual(scheduled, [
    ["start", 10, 1, 2],
    ["stop", 12],
  ]);
  assert.deepEqual(automation[0], ["set", 0, 10]);
  assert.deepEqual(automation.at(-1), ["linear", 0, 12]);
});

test("audio decode wait aborts with its clip signal", async () => {
  let finishDecode!: (buffer: AudioBuffer) => void;
  const buffer = { duration: 1 } as AudioBuffer;
  const context = {
    decodeAudioData: () =>
      new Promise<AudioBuffer>((resolve) => (finishDecode = resolve)),
  } as unknown as BaseAudioContext;
  const controller = new AbortController();
  const clip = audioFile({ url: "/music.wav" })();
  const pending = withBrowserFetch(
    async () => new Response(Uint8Array.of(1)),
    () =>
      clip.schedule({
        context,
        destination: {} as AudioNode,
        signal: controller.signal,
        start: 0,
        duration: 1,
        at: (localTime) => localTime,
      }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(Error("cancel audio decode"));
  await assert.rejects(pending, /cancel audio decode/);
  finishDecode(buffer);
});

test("gain fade is bounded to the clip interval", () => {
  const events: unknown[][] = [];
  const gain = {
    setValueAtTime(value: number, time: number) {
      events.push(["set", value, time]);
    },
    linearRampToValueAtTime(value: number, time: number) {
      events.push(["linear", value, time]);
    },
  } as unknown as AudioParam;
  fadeGain(gain, 2, 1, 0.25);
  assert.deepEqual(events, [
    ["set", 0, 2],
    ["linear", 0.25, 2.01],
    ["set", 0.25, 2.99],
    ["linear", 0, 3],
  ]);
  assert.throws(() => fadeGain(gain, 0, -1, 1), /fade range/);
});

test("video frame selection keeps frames overlapping edit start, but not future PTS", () => {
  assert.equal(
    frameOverlapsPresentation(90_000, 20_000, 100_000, 200_000, 100_000),
    true,
  );
  assert.equal(
    frameOverlapsPresentation(100_001, 20_000, 100_000, 200_000, 100_000),
    false,
  );
  assert.equal(
    frameOverlapsPresentation(80_000, 20_000, 100_000, 200_000, 100_000),
    false,
  );
  assert.equal(
    frameOverlapsPresentation(200_000, 10_000, 100_000, 200_000, 210_000),
    false,
  );
});

test("PCM clips audio to edit bounds while retaining leading empty-edit silence", () => {
  const range = pcmClipRange(0, 4, 0.5, 2.5, 44_100);
  assert.ok(range);
  assert.equal(range.frameCount, 110_250);
  assert.equal(range.audibleStartFrame, 22_050);

  const straddling = pcmChunkRange(490_000, 1_024, range);
  assert.ok(straddling);
  assert.equal(straddling.targetStart, 22_050);
  assert.equal(straddling.sourceStart, 441);

  const emptyEdit = pcmClipRange(0, 0.5, 1, 3, 44_100);
  assert.ok(emptyEdit);
  assert.equal(emptyEdit.frameCount, 22_050);
  assert.equal(emptyEdit.audibleStartFrame >= emptyEdit.clipEndFrame, true);
  assert.equal(pcmChunkRange(0, 1_024, emptyEdit), null);
});

test("PCM chunks map continuously on a nearest-sample 44.1 kHz grid", () => {
  const rate = 44_100;
  const chunkFrames = 1_024;
  const range = pcmClipRange(0, (chunkFrames * 4) / rate, 0, 1, rate);
  assert.ok(range);
  assert.equal(range.frameCount, chunkFrames * 4);

  const chunks = Array.from({ length: 4 }, (_, index) =>
    pcmChunkRange(
      Math.round((index * chunkFrames * 1_000_000) / rate),
      chunkFrames,
      range,
    ),
  );
  assert.deepEqual(
    chunks.map((chunk) => chunk && [chunk.targetStart, chunk.frameCount]),
    [0, 1, 2, 3].map((index) => [index * chunkFrames, chunkFrames]),
  );
});

test("abort forwarders detach listeners from long-lived signals", () => {
  const source = new AbortController();
  const destination = new AbortController();
  let added = 0;
  let removed = 0;
  const originalAdd = source.signal.addEventListener.bind(source.signal);
  const originalRemove = source.signal.removeEventListener.bind(source.signal);
  source.signal.addEventListener = ((type, listener, options) => {
    if (type === "abort") added++;
    return originalAdd(type, listener, options);
  }) as typeof source.signal.addEventListener;
  source.signal.removeEventListener = ((type, listener, options) => {
    if (type === "abort") removed++;
    return originalRemove(type, listener, options);
  }) as typeof source.signal.removeEventListener;

  const cleanup = forwardAbortSignals([source.signal], destination);
  assert.equal(added, 1);
  assert.equal(removed, 0);
  cleanup();
  assert.equal(removed, 1);
  source.abort(Error("late cancellation"));
  assert.equal(destination.signal.aborted, false);
});
