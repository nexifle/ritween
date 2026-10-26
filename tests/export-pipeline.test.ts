import { test } from "node:test";
import assert from "node:assert/strict";
import { runExportPipelines } from "../src/engine/export-pipeline";
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test("parallel export starts both jobs before either completes", async () => {
  const audio = deferred<string>(),
    video = deferred<string>();
  const started: string[] = [];
  const result = runExportPipelines(
    "parallel",
    undefined,
    async () => {
      started.push("audio");
      return audio.promise;
    },
    async () => {
      started.push("video");
      return video.promise;
    },
  );
  assert.deepEqual(started, ["audio", "video"]);
  video.resolve("H264");
  audio.resolve("AAC");
  assert.deepEqual(await result, ["AAC", "H264"]);
});

test("sequential baseline waits for audio before starting video", async () => {
  const audio = deferred<string>(),
    started: string[] = [];
  const result = runExportPipelines(
    "sequential",
    undefined,
    async () => {
      started.push("audio");
      return audio.promise;
    },
    async () => {
      started.push("video");
      return "H264";
    },
  );
  assert.deepEqual(started, ["audio"]);
  audio.resolve("AAC");
  assert.deepEqual(await result, ["AAC", "H264"]);
  assert.deepEqual(started, ["audio", "video"]);
});

for (const failing of ["audio", "video"]) {
  test(`${failing} failure aborts its sibling, preserves the error and awaits cleanup`, async () => {
    const fail = deferred<void>(),
      cleanup = deferred<void>(),
      aborted = deferred<void>();
    const error = new Error(`${failing} failed`);
    let cleaned = false,
      returned = false;
    const bad = async () => {
      await fail.promise;
      throw error;
    };
    const sibling = async (signal: AbortSignal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted.resolve();
            resolve();
          },
          { once: true },
        ),
      );
      await cleanup.promise;
      cleaned = true;
      signal.throwIfAborted();
      return "unused";
    };
    const result = runExportPipelines(
      "parallel",
      undefined,
      failing === "audio" ? bad : sibling,
      failing === "video" ? bad : sibling,
    );
    const rejected = assert.rejects(result, (caught) => {
      returned = true;
      return caught === error;
    });
    fail.resolve();
    await aborted.promise;
    assert.equal(returned, false);
    cleanup.resolve();
    await rejected;
    assert.equal(cleaned, true);
  });
}

test("user cancellation aborts both jobs and rejects with the original reason", async () => {
  const controller = new AbortController(),
    error = new Error("cancelled");
  let closed = 0;
  const job = async (signal: AbortSignal) => {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    closed++;
    signal.throwIfAborted();
  };
  const result = runExportPipelines("parallel", controller.signal, job, job);
  const rejected = assert.rejects(result, (caught) => caught === error);
  controller.abort(error);
  await rejected;
  assert.equal(closed, 2);
});

test("already-cancelled exports and invalid modes start neither job", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const job = async () => {
    calls++;
  };
  await assert.rejects(
    runExportPipelines("parallel", controller.signal, job, job),
    { name: "AbortError" },
  );
  await assert.rejects(
    runExportPipelines("invalid" as "parallel", undefined, job, job),
    /Unsupported export pipeline/,
  );
  assert.equal(calls, 0);
});
