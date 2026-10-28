import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchAssetRange,
  MAX_RANGE_BYTES,
} from "../src/engine/media/byte-range";
import {
  MAX_ASSET_BYTES,
  withAssetRequest,
} from "../src/engine/media/resource";

test("asset requests bound concurrent body reads and cancel queued consumers", async () => {
  let active = 0;
  let peak = 0;
  let calls = 0;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const run = async () => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    try {
      await gate;
    } finally {
      active--;
    }
  };
  const requests = Array.from({ length: 5 }, () =>
    withAssetRequest(undefined, run),
  );
  const controller = new AbortController();
  const cancelled = withAssetRequest(controller.signal, run);
  const rejection = assert.rejects(cancelled, /queued cancellation/);
  assert.equal(active, 4);
  assert.equal(calls, 4);
  controller.abort(Error("queued cancellation"));
  await rejection;
  finish();
  await Promise.all(requests);
  assert.equal(calls, 5);
  assert.equal(peak, 4);
  assert.equal(active, 0);
});

test("asset range validates responses and keeps full-download fallback bounded", async () => {
  const previousFetch = globalThis.fetch;
  const location = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "https://example.test/" },
  });
  let response: Response;
  let calls = 0;
  let expectedRange = "bytes=2-3";
  globalThis.fetch = (async (url, options) => {
    calls++;
    assert.equal(String(url), "https://example.test/video.mp4");
    assert.equal(options?.redirect, "error");
    assert.equal(options?.mode, "same-origin");
    assert.equal(new Headers(options?.headers).get("range"), expectedRange);
    return response;
  }) as typeof fetch;
  const read = () => fetchAssetRange("/video.mp4", 2, 4);
  try {
    response = new Response(new Uint8Array([2, 3]), {
      status: 206,
      headers: { "content-range": "bytes 2-3/8" },
    });
    const range = await read();
    assert.deepEqual([...new Uint8Array(range.bytes)], [2, 3]);
    assert.deepEqual(
      { ...range, bytes: undefined },
      { bytes: undefined, start: 2, length: 8, full: false, version: null },
    );
    expectedRange = "bytes=2-7";
    response = new Response(new Uint8Array([2, 3]), {
      status: 206,
      headers: { "content-range": "bytes 2-3/4" },
    });
    assert.deepEqual(
      new Uint8Array((await fetchAssetRange("/video.mp4", 2, 8)).bytes),
      new Uint8Array([2, 3]),
    );
    expectedRange = "bytes=2-3";
    response = new Response(new Uint8Array([0, 1, 2, 3]));
    assert.equal((await read()).full, true);
    for (const contentRange of [
      "bytes 1-2/8",
      "bytes 2-3/*",
      `bytes 2-3/${MAX_ASSET_BYTES + 1}`,
      "bytes 2-3/3",
    ]) {
      response = new Response(new Uint8Array([2, 3]), {
        status: 206,
        headers: { "content-range": contentRange },
      });
      await assert.rejects(read, /Content-Range/);
      assert.equal(response.body?.locked, false);
    }
    response = new Response(new Uint8Array([2]), {
      status: 206,
      headers: { "content-range": "bytes 2-3/8" },
    });
    await assert.rejects(read, /truncated/);
    response = new Response(new Uint8Array([0, 1, 2, 3]), {
      headers: { "content-length": "8" },
    });
    await assert.rejects(read, /Content-Length/);
    response = new Response(new Uint8Array([2, 3]), {
      status: 206,
      headers: { "content-range": "bytes 2-3/8", "content-encoding": "gzip" },
    });
    await assert.rejects(read, /Encoded range/);
    response = new Response(null, { status: 416 });
    await assert.rejects(read, /416/);
    response = new Response(null, {
      headers: { "content-length": String(MAX_ASSET_BYTES + 1) },
    });
    await assert.rejects(read, /128 MiB/);
    for (const status of [200, 206]) {
      response = new Response(new Uint8Array([2, 3]), {
        status,
        headers: { etag: '"new"', "content-range": "bytes 2-3/8" },
      });
      await assert.rejects(
        () => fetchAssetRange("/video.mp4", 2, 4, undefined, '"old"'),
        /version changed/,
      );
    }
    const before = calls;
    await assert.rejects(
      () => fetchAssetRange("/video.mp4", 0, MAX_RANGE_BYTES + 1),
      /Invalid/,
    );
    await assert.rejects(
      () => fetchAssetRange("https://other.test/video.mp4", 2, 4),
      /same-origin/,
    );
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      () => fetchAssetRange("/video.mp4", 2, 4, abort.signal),
      /abort/i,
    );
    assert.equal(calls, before);
  } finally {
    globalThis.fetch = previousFetch;
    if (location) Object.defineProperty(globalThis, "location", location);
    else Reflect.deleteProperty(globalThis, "location");
  }
});
