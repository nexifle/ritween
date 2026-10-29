import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaResponse } from "../cli/media-response";

test("public media uses content-based strong ETags and validates conditional ranges", async () => {
  const root = await mkdtemp(join(tmpdir(), "ritween-etag-"));
  await writeFile(join(root, "clip.mp4"), "abcdefgh");
  const middleware = mediaResponse(root);
  const server = createServer((req, res) =>
    middleware(req, res, () => {
      res.statusCode = 404;
      res.end();
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const full = await fetch(url + "/clip.mp4");
    const etag = full.headers.get("etag")!;
    assert.match(etag, /^"[a-f0-9]{64}"$/);
    assert.equal(await full.text(), "abcdefgh");
    const range = await fetch(url + "/clip.mp4", {
      headers: { Range: "bytes=2-3", "If-Range": etag },
    });
    assert.equal(range.status, 206);
    assert.equal(await range.text(), "cd");
    assert.equal(range.headers.get("content-range"), "bytes 2-3/8");
    const unchanged = await fetch(url + "/clip.mp4", {
      headers: { "If-None-Match": etag },
    });
    assert.equal(unchanged.status, 304);
    await writeFile(join(root, "clip.mp4"), "ABCDEFGH");
    const changed = await fetch(url + "/clip.mp4", {
      headers: { Range: "bytes=2-3", "If-Range": etag },
    });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get("etag"), etag);
    assert.equal(await changed.text(), "ABCDEFGH");
    const invalid = await fetch(url + "/clip.mp4", {
      headers: { Range: "bytes=99-100" },
    });
    assert.equal(invalid.status, 416);
    const suffix = await fetch(url + "/clip.mp4", {
      headers: { Range: "bytes=-2" },
    });
    assert.equal(await suffix.text(), "GH");
    const head = await fetch(url + "/clip.mp4", { method: "HEAD" });
    assert.equal(head.headers.get("content-length"), "8");
    assert.equal(await head.text(), "");
    const outside = await mkdtemp(join(tmpdir(), "ritween-private-"));
    try {
      await writeFile(join(outside, "secret.mp4"), "private");
      await symlink(outside, join(root, "outside"));
      const escaped = await fetch(url + "/outside/secret.mp4");
      assert.equal(escaped.status, 403);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});
