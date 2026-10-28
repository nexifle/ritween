import assert from "node:assert/strict";
import test from "node:test";
import {
  byteSourceUsage,
  openByteSource,
} from "../src/engine/media/byte-source";

test("byte source caches blocks, bounds retention and releases disposed owners", async () => {
  const original = globalThis.fetch;
  const location = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "https://example.test/" },
  });
  const bytes = new Uint8Array(10 * 2 ** 20);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 8);
  bytes.set([109, 111, 111, 118], 4);
  view.setUint32(8, bytes.length - 8);
  bytes.set([109, 100, 97, 116], 12);
  for (let i = 16; i < bytes.length; i++) bytes[i] = i % 251;
  let requests = 0;
  globalThis.fetch = (async (_url, options) => {
    requests++;
    const match = /bytes=(\d+)-(\d+)/.exec(
      new Headers(options?.headers).get("range")!,
    );
    assert.ok(match);
    const start = Number(match[1]),
      end = Number(match[2]) + 1;
    return new Response(bytes.slice(start, end), {
      status: 206,
      headers: {
        etag: '"v1"',
        "content-range": `bytes ${start}-${end - 1}/${bytes.length}`,
      },
    });
  }) as typeof fetch;
  try {
    const [source, sibling] = await Promise.all([
      openByteSource("/video.mp4"),
      openByteSource("https://example.test/video.mp4#second-scene"),
    ]);
    assert.equal(requests, 1, "metadata requests are shared across owners");
    const first = await source.read(16, 100);
    assert.deepEqual(first, bytes.slice(16, 100));
    const before = requests;
    first.fill(0);
    assert.deepEqual(await source.read(16, 100), bytes.slice(16, 100));
    assert.equal(requests, before);
    assert.deepEqual(
      await source.read(262140, 262150),
      bytes.slice(262140, 262150),
    );
    for (let at = 0; at < bytes.length; at += 262144)
      await source.read(at, at + 1);
    assert.ok(source.usage.cacheBytes <= 8 * 2 ** 20);
    const after = requests;
    await source.read(16, 100);
    assert.equal(requests, after + 1);
    const serve = globalThis.fetch;
    let started!: () => void;
    const active = new Promise<void>((resolve) => {
      started = resolve;
    });
    let networkAborted = false;
    globalThis.fetch = (async (_url, options) => {
      started();
      return new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            networkAborted = true;
            reject(options.signal!.reason);
          },
          { once: true },
        );
      });
    }) as typeof fetch;
    const readAbort = new AbortController();
    const interrupted = source.read(262144, 262145, readAbort.signal);
    const rejected = assert.rejects(interrupted, /cancel read/);
    await active;
    readAbort.abort(Error("cancel read"));
    await rejected;
    assert.equal(networkAborted, true);
    let finish!: () => void;
    let begin!: () => void;
    const sharedStarted = new Promise<void>((resolve) => {
      begin = resolve;
    });
    let sharedRequests = 0;
    let sharedAborted = false;
    globalThis.fetch = (async (_url, options) => {
      sharedRequests++;
      begin();
      return new Promise<Response>((resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            sharedAborted = true;
            reject(options.signal!.reason);
          },
          { once: true },
        );
        finish = () =>
          resolve(
            new Response(bytes.slice(262144, 524288), {
              status: 206,
              headers: {
                etag: '"v1"',
                "content-range": `bytes 262144-524287/${bytes.length}`,
              },
            }),
          );
      });
    }) as typeof fetch;
    const consumerAbort = new AbortController();
    const cancelled = source.read(262144, 262145, consumerAbort.signal);
    const survivor = sibling.read(262144, 262145);
    const cancellation = assert.rejects(cancelled, /one consumer/);
    await sharedStarted;
    consumerAbort.abort(Error("one consumer cancelled"));
    await cancellation;
    assert.equal(sharedAborted, false);
    finish();
    assert.deepEqual(await survivor, bytes.slice(262144, 262145));
    assert.equal(sharedRequests, 1);
    globalThis.fetch = serve;
    const other = await openByteSource("/other.mp4");
    for (let at = 0; at < bytes.length; at += 262144)
      await other.read(at, at + 1);
    assert.ok(source.usage.cacheBytes + other.usage.cacheBytes <= 8 * 2 ** 20);
    other.dispose();
    assert.deepEqual(
      await source.read(262144, 262145),
      bytes.slice(262144, 262145),
    );
    const cacheBeforeChange = source.usage.cacheBytes;
    globalThis.fetch = (async (...args) => {
      const response = await serve(...args);
      response.headers.set("etag", '"v2"');
      return response;
    }) as typeof fetch;
    await assert.rejects(() => source.read(16, 100), /version changed/);
    assert.equal(source.usage.cacheBytes, cacheBeforeChange);
    globalThis.fetch = serve;
    source.dispose();
    source.dispose();
    assert.deepEqual(await sibling.read(16, 100), bytes.slice(16, 100));
    sibling.dispose();
    assert.deepEqual(byteSourceUsage(), {
      sources: 0,
      cacheBytes: 0,
      fullBytes: 0,
    });
    assert.deepEqual(source.usage, { cacheBytes: 0, fullBytes: 0 });
    await assert.rejects(() => source.read(16, 100), /disposed/);
    const owners = await Promise.all(
      Array.from({ length: 16 }, (_, i) => openByteSource(`/owner-${i}.mp4`)),
    );
    try {
      await assert.rejects(
        () => openByteSource("/owner-overflow.mp4"),
        /owner limit/,
      );
      assert.equal(byteSourceUsage().sources, 16);
    } finally {
      for (const owner of owners) owner.dispose();
    }
    assert.deepEqual(byteSourceUsage(), {
      sources: 0,
      cacheBytes: 0,
      fullBytes: 0,
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => openByteSource("/video.mp4", controller.signal),
      /abort/i,
    );
  } finally {
    globalThis.fetch = original;
    if (location) Object.defineProperty(globalThis, "location", location);
    else Reflect.deleteProperty(globalThis, "location");
  }
});
