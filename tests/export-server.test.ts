import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExportJobs, type ExportJobRunner } from "../cli/export-jobs";
import { exportJobsMiddleware } from "../cli/export-server";

async function fixture(run?: ExportJobRunner["run"]) {
  const root = await mkdtemp(join(tmpdir(), "ritween-export-api-"));
  const jobs = await ExportJobs.create({
    root,
    runner: {
      async prepare() {},
      run:
        run ??
        (async ({ output, progress }) => {
          progress(24, 24);
          await writeFile(output, "MP4 fixture");
          return { name: "API test", frames: 24 };
        }),
    },
  });
  const streams = new Set<import("node:http").ServerResponse>();
  const middleware = exportJobsMiddleware(jobs, streams);
  const server = createServer((req, res) =>
    middleware(req, res, () => {
      res.statusCode = 404;
      res.end();
    }),
  );
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No address");
  const url = `http://127.0.0.1:${address.port}/__ritween/exports`;
  return {
    jobs,
    url,
    async close() {
      for (const stream of streams) stream.end();
      await jobs.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
const input = () => ({
  id: randomUUID(),
  name: "API test",
  settings: { version: 1 },
});
const post = (url: string, value: unknown, headers = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(value),
  });

test("export API submits, discovers, streams downloads and deletes managed artifacts", async () => {
  const f = await fixture();
  try {
    const request = input();
    const created = await post(f.url, request);
    assert.equal(created.status, 202);
    assert.equal((await created.json()).job.id, request.id);
    await f.jobs.idle();
    const snapshot = await (await fetch(f.url)).json();
    assert.equal(snapshot.jobs[0].status, "completed");
    const url = `${f.url}/${request.id}/file`;
    const response = await fetch(url);
    assert.equal(await response.text(), "MP4 fixture");
    assert.match(response.headers.get("content-disposition")!, /attachment/);
    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.headers.get("content-length"), "11");
    assert.equal(await head.text(), "");
    const range = await fetch(url, { headers: { Range: "bytes=0-2" } });
    assert.equal(range.status, 206);
    assert.equal(await range.text(), "MP4");
    assert.equal(
      (await fetch(url, { headers: { Range: "bytes=20-30" } })).status,
      416,
    );
    assert.equal(
      (await fetch(`${f.url}/${request.id}`, { method: "DELETE" })).status,
      200,
    );
    assert.equal((await fetch(url)).status, 404);
  } finally {
    await f.close();
  }
});

test("export API rejects cross-origin execution, malformed commands and filesystem destinations", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await post(f.url, input(), { Origin: "https://evil.example" })).status,
      403,
    );
    assert.equal(
      (await fetch(f.url, { headers: { "Sec-Fetch-Site": "cross-site" } }))
        .status,
      403,
    );
    assert.equal(
      (await post(f.url, { ...input(), id: "../../outside" })).status,
      400,
    );
    assert.equal(
      (await post(f.url, { ...input(), settings: { version: 2 } })).status,
      400,
    );
    assert.equal(
      (await fetch(f.url, { method: "POST", body: "{}" })).status,
      400,
    );
    assert.equal((await fetch(`${f.url}/invalid/file`)).status, 404);
    assert.deepEqual(f.jobs.list(), []);
  } finally {
    await f.close();
  }
});

test("SSE reconnect sends an authoritative snapshot without cancelling server-owned work", async () => {
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const f = await fixture(async ({ output, progress }) => {
    progress(2, 24);
    await gate;
    await writeFile(output, "MP4 fixture");
    return { name: "API test", frames: 24 };
  });
  try {
    const request = input();
    await post(f.url, request);
    for (let connection = 0; connection < 2; connection++) {
      const response = await fetch(`${f.url}/events`);
      assert.match(response.headers.get("content-type")!, /text\/event-stream/);
      const reader = response.body!.getReader();
      const initial = new TextDecoder().decode((await reader.read()).value);
      assert.match(initial, new RegExp(request.id));
      await reader.cancel();
    }
    release();
    await f.jobs.idle();
    assert.equal(f.jobs.list()[0].status, "completed");
  } finally {
    release();
    await f.close();
  }
});
