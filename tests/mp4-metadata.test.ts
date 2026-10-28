import assert from "node:assert/strict";
import test from "node:test";
import { readMp4Metadata } from "../src/engine/media/mp4-metadata";

function box(type: string, payload: number) {
  const bytes = new Uint8Array(payload + 8);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set(
    [...type].map((c) => c.charCodeAt(0)),
    4,
  );
  return bytes;
}

test("MP4 metadata reads skip media payload with moov before or after mdat", async () => {
  const originalFetch = globalThis.fetch;
  const location = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "https://example.test/" },
  });
  try {
    for (const tail of [false, true]) {
      const moov = box("moov", 32);
      const mdat = box("mdat", 1_000_000);
      const bytes = new Uint8Array(moov.length + mdat.length);
      bytes.set(tail ? mdat : moov);
      bytes.set(tail ? moov : mdat, tail ? mdat.length : moov.length);
      const reads: [number, number][] = [];
      globalThis.fetch = (async (_url, options) => {
        const match = /^bytes=(\d+)-(\d+)$/.exec(
          new Headers(options?.headers).get("range")!,
        );
        assert.ok(match);
        const start = Number(match[1]);
        const end = Math.min(Number(match[2]) + 1, bytes.length);
        reads.push([start, end]);
        if (start !== 0 || reads.length > 1)
          assert.equal(
            new Headers(options?.headers).get("if-range"),
            '"fixture-v1"',
          );
        return new Response(bytes.slice(start, end), {
          status: 206,
          headers: {
            etag: '"fixture-v1"',
            "content-range": `bytes ${start}-${end - 1}/${bytes.length}`,
          },
        });
      }) as typeof fetch;
      const result = await readMp4Metadata("/test.mp4");
      assert.deepEqual(new Uint8Array(result.moov), moov);
      const mediaStart = (tail ? 0 : moov.length) + 8;
      assert.deepEqual(result.mdats, [
        { start: mediaStart, end: mediaStart + 1_000_000 },
      ]);
      assert.ok(
        reads.reduce((sum, [start, end]) => sum + end - start, 0) <
          mdat.byteLength,
      );
      assert.equal(result.full, null);
    }
    for (const type of [
      "moof",
      "mvex",
      "mfra",
      "traf",
      "tfhd",
      "trun",
      "trex",
      "sinf",
      "schm",
      "schi",
      "tenc",
      "senc",
      "saiz",
      "saio",
      "pssh",
      "encv",
      "enca",
      "uuid",
    ]) {
      const forbidden = new Uint8Array([
        ...box("moov", 0),
        ...box("mdat", 600_000),
        ...box(type, 0),
      ]);
      globalThis.fetch = (async (_url, options) => {
        const match = /bytes=(\d+)-(\d+)/.exec(
          new Headers(options?.headers).get("range")!,
        )!;
        const start = Number(match[1]);
        const end = Math.min(Number(match[2]) + 1, forbidden.length);
        return new Response(forbidden.slice(start, end), {
          status: 206,
          headers: {
            etag: '"forbidden"',
            "content-range": `bytes ${start}-${end - 1}/${forbidden.length}`,
          },
        });
      }) as typeof fetch;
      await assert.rejects(
        () => readMp4Metadata("/forbidden.mp4"),
        /unsupported fragmented or encrypted/,
      );
    }
    const invalid = box("mdat", 0);
    new DataView(invalid.buffer).setUint32(0, 1000);
    globalThis.fetch = (async () => new Response(invalid)) as typeof fetch;
    await assert.rejects(() => readMp4Metadata("/bad.mp4"), /bounds/);
    const moov = box("moov", 0);
    const mdat = box("mdat", 1_000_000);
    const full = new Uint8Array([...moov, ...mdat]);
    for (const etag of [null, 'W/"weak-version"']) {
      let calls = 0;
      globalThis.fetch = (async (_url, options) => {
        calls++;
        if (new Headers(options?.headers).has("range")) {
          return new Response(full.slice(0, 512 * 1024), {
            status: 206,
            headers: {
              "content-range": `bytes 0-524287/${full.length}`,
              ...(etag ? { etag } : {}),
            },
          });
        }
        return new Response(full);
      }) as typeof fetch;
      const fallback = await readMp4Metadata("/weak.mp4");
      assert.deepEqual(new Uint8Array(fallback.full!), full);
      assert.equal(fallback.version, null);
      assert.equal(calls, 2);
    }
    const small = new Uint8Array([...box("moov", 0), ...box("mdat", 8)]);
    let smallCalls = 0;
    globalThis.fetch = (async () => {
      smallCalls++;
      return new Response(small, {
        status: 206,
        headers: {
          etag: '"small"',
          "content-range": `bytes 0-${small.length - 1}/${small.length}`,
        },
      });
    }) as typeof fetch;
    assert.deepEqual(
      new Uint8Array((await readMp4Metadata("/small.mp4")).full!),
      small,
    );
    assert.equal(smallCalls, 1);
    globalThis.fetch = (async () => new Response(full)) as typeof fetch;
    assert.deepEqual(
      new Uint8Array((await readMp4Metadata("/full.mp4")).full!),
      full,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (location) Object.defineProperty(globalThis, "location", location);
    else Reflect.deleteProperty(globalThis, "location");
  }
});
