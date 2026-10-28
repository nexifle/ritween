import assert from "node:assert/strict";
import test from "node:test";
import { readAssetResponse } from "../src/engine/media/resource";
import { audioFile } from "../src/engine/decode/audio-file";

test("rejected asset responses cancel their unowned body", async () => {
  for (const kind of ["http", "abort", "limit", "header"] as const) {
    let cancellations = 0;
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancellations++;
        },
      }),
      {
        status: kind === "http" ? 403 : 200,
        headers: kind === "header" ? { "content-length": "invalid" } : {},
      },
    );
    const controller = new AbortController();
    if (kind === "abort") controller.abort(Error("cancelled"));
    await assert.rejects(
      readAssetResponse(response, controller.signal, kind === "limit" ? 0 : 10),
    );
    assert.equal(cancellations, 1, kind);
    assert.equal(response.body?.locked, false);
  }
});

test("stale audio completion cannot overwrite a newer context cache", async () => {
  const previousFetch = globalThis.fetch;
  const previousLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "https://studio.example/" },
  });
  globalThis.fetch = async () => new Response(Uint8Array.of(1));
  try {
    let finish!: (buffer: AudioBuffer) => void;
    let started!: () => void;
    const decoding = new Promise<void>((resolve) => {
      started = resolve;
    });
    const contextA = {
      decodeAudioData: () => {
        started();
        return new Promise<AudioBuffer>((resolve) => {
          finish = resolve;
        });
      },
    } as unknown as BaseAudioContext;
    let loadsB = 0;
    const contextB = {
      decodeAudioData: async () => {
        loadsB++;
        return { duration: 1 } as AudioBuffer;
      },
    } as unknown as BaseAudioContext;
    const source = audioFile({ url: "/audio.wav", offset: 2 })();
    const host = (context: BaseAudioContext) => ({
      context,
      destination: {} as AudioNode,
      start: 0,
      duration: 1,
      at: (time: number) => time,
    });
    const first = source.schedule(host(contextA));
    await decoding;
    await source.schedule(host(contextB));
    finish({ duration: 100 } as AudioBuffer);
    await first;
    // A stale buffer would try to schedule through B's deliberately absent node factory.
    await source.schedule(host(contextB));
    assert.equal(loadsB, 1);
    source.dispose?.();
    source.dispose?.();
    await assert.rejects(source.schedule(host(contextB)), /disposed/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousLocation)
      Object.defineProperty(globalThis, "location", previousLocation);
    else delete (globalThis as { location?: Location }).location;
  }
});
