import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExportJobs, type ExportJobRunner } from "../cli/export-jobs";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const request = () => ({
  id: randomUUID(),
  name: "Test video",
  settings: { version: 1 as const },
});
const runner: ExportJobRunner = {
  async prepare() {},
  async run({ output, progress }) {
    progress(24, 24);
    await writeFile(output, "MP4 fixture");
    return { name: "Test video", frames: 24 };
  },
};
async function fixture(run = runner, maxBytes?: number) {
  const root = await mkdtemp(join(tmpdir(), "ritween-jobs-test-"));
  const jobs = await ExportJobs.create({ root, runner: run, maxBytes });
  return {
    root,
    jobs,
    async close() {
      await jobs.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("jobs survive client disconnection and publish completion only after saving", async () => {
  const saving = gate();
  const f = await fixture({
    ...runner,
    async run(context) {
      context.progress(24, 24);
      await saving.promise;
      return runner.run(context);
    },
  });
  try {
    const input = request();
    const job = await f.jobs.submit(input);
    const unsubscribe = f.jobs.subscribe(() => {});
    unsubscribe();
    await new Promise((done) => setImmediate(done));
    assert.notEqual(f.jobs.list()[0].status, "completed");
    assert.ok(f.jobs.list()[0].percent <= 99);
    assert.equal((await f.jobs.submit(input)).id, job.id);
    saving.resolve();
    await f.jobs.idle();
    const completed = f.jobs.list()[0];
    assert.equal(completed.status, "completed");
    assert.equal(completed.percent, 100);
    assert.equal(completed.bytes, 11);
    assert.equal(await readFile(f.jobs.file(job.id), "utf8"), "MP4 fixture");
  } finally {
    saving.resolve();
    await f.close();
  }
});

test("renders are serialized and deleting an active export is rejected", async () => {
  const render = gate();
  let active = 0,
    peak = 0;
  const f = await fixture({
    ...runner,
    async run(context) {
      peak = Math.max(peak, ++active);
      try {
        await render.promise;
        return await runner.run(context);
      } finally {
        active--;
      }
    },
  });
  try {
    const first = await f.jobs.submit(request());
    await f.jobs.submit(request());
    await assert.rejects(f.jobs.remove(first.id), /active/i);
    render.resolve();
    await f.jobs.idle();
    assert.equal(peak, 1);
    await f.jobs.remove(first.id);
    assert.equal(f.jobs.list().length, 1);
    assert.throws(() => f.jobs.file(first.id), /not found/i);
  } finally {
    render.resolve();
    await f.close();
  }
});

test("cancellation removes partial output, releases the queue and graceful shutdown removes managed files", async () => {
  const started = gate();
  const f = await fixture({
    ...runner,
    async run(context) {
      context.signal.throwIfAborted();
      await writeFile(context.output, "partial");
      await new Promise<void>((_, reject) => {
        context.signal.addEventListener(
          "abort",
          () => reject(context.signal.reason),
          { once: true },
        );
        started.resolve();
      });
      throw Error("unreachable");
    },
  });
  try {
    const job = await f.jobs.submit(request());
    await started.promise;
    await f.jobs.cancel(job.id);
    await f.jobs.idle();
    assert.equal(f.jobs.list()[0].status, "cancelled");
    assert.throws(() => f.jobs.file(job.id), /not ready/i);
    await f.jobs.close();
    assert.deepEqual(await readdir(f.root), []);
  } finally {
    await f.close();
  }
});

test("crash recovery retains completed files, removes partial files, and exposes interrupted jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "ritween-recovery-test-"));
  const old = join(root, "session-crashed");
  await mkdir(old);
  await writeFile(join(old, "owner.json"), JSON.stringify({ pid: 2147483647 }));
  const completed = request(),
    interrupted = request();
  for (const [input, status] of [
    [completed, "completed"],
    [interrupted, "running"],
  ] as const) {
    const directory = join(old, input.id);
    await mkdir(directory);
    await writeFile(
      join(directory, "job.json"),
      JSON.stringify({
        ...input,
        filename: "test-video.mp4",
        status,
        createdAt: Date.now(),
        startedAt: Date.now(),
        finishedAt: null,
        done: 0,
        total: 24,
        stages: [],
        percent: 0,
        elapsedSeconds: 0,
        etaSeconds: null,
        bytes: 11,
        error: "",
        recovered: false,
      }),
    );
    await writeFile(
      join(directory, status === "completed" ? "output.mp4" : "output.part"),
      "MP4 fixture",
    );
  }
  const jobs = await ExportJobs.create({ root, runner });
  try {
    assert.equal(jobs.list().length, 2);
    assert.equal(
      jobs.list().find((job) => job.id === completed.id)?.recovered,
      true,
    );
    assert.equal(
      await readFile(jobs.file(completed.id), "utf8"),
      "MP4 fixture",
    );
    assert.equal(
      jobs.list().find((job) => job.id === interrupted.id)?.status,
      "interrupted",
    );
    await jobs.remove(completed.id);
    assert.equal(jobs.list().length, 1);
  } finally {
    await jobs.close();
    assert.deepEqual(await readdir(root), []);
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "cancelling a middle queued job never lets later jobs bypass an active render",
  { timeout: 5000 },
  async () => {
    const render = gate();
    const started = gate();
    let active = 0;
    let peak = 0;
    const f = await fixture({
      ...runner,
      async run(context) {
        peak = Math.max(peak, ++active);
        started.resolve();
        try {
          await render.promise;
          return await runner.run(context);
        } finally {
          active--;
        }
      },
    });
    try {
      const first = await f.jobs.submit(request());
      await started.promise;
      const middle = await f.jobs.submit(request());
      const last = await f.jobs.submit(request());
      await assert.rejects(f.jobs.submit(request()), /queue is full/i);
      await f.jobs.cancel(middle.id);
      while (
        f.jobs.list().find((job) => job.id === middle.id)?.status !==
        "cancelled"
      )
        await new Promise((done) => setImmediate(done));
      await f.jobs.remove(middle.id);
      await new Promise((done) => setTimeout(done, 30));
      assert.equal(
        f.jobs.list().find((job) => job.id === first.id)?.status,
        "running",
      );
      assert.notEqual(
        f.jobs.list().find((job) => job.id === last.id)?.status,
        "running",
      );
      render.resolve();
      await f.jobs.idle();
      assert.equal(peak, 1);
      assert.ok(f.jobs.list().every((job) => job.status === "completed"));
    } finally {
      render.resolve();
      await f.close();
    }
  },
);

test("storage quota refuses new results without evicting existing videos and deletion frees capacity", async () => {
  const f = await fixture(runner, 15);
  try {
    const first = await f.jobs.submit(request());
    await f.jobs.idle();
    const second = await f.jobs.submit(request());
    await f.jobs.idle();
    const failed = f.jobs.list().find((job) => job.id === second.id)!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.bytes, 0);
    assert.match(failed.error, /storage is full/i);
    assert.equal(await readFile(f.jobs.file(first.id), "utf8"), "MP4 fixture");
    const session = (await readdir(f.root))[0];
    assert.deepEqual(await readdir(join(f.root, session, second.id)), [
      "job.json",
    ]);
    await f.jobs.remove(first.id);
    const third = await f.jobs.submit(request());
    await f.jobs.idle();
    assert.equal(
      f.jobs.list().find((job) => job.id === third.id)?.status,
      "completed",
    );
  } finally {
    await f.close();
  }
});

test("job history is bounded and explicit deletion permits another export", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 50; i++) {
      await f.jobs.submit(request());
      await f.jobs.idle();
    }
    await assert.rejects(f.jobs.submit(request()), /storage is full/i);
    assert.equal(f.jobs.list().length, 50);
    await f.jobs.remove(f.jobs.list()[0].id);
    await f.jobs.submit(request());
    await f.jobs.idle();
    assert.equal(f.jobs.list().length, 50);
  } finally {
    await f.close();
  }
});

test("recovery survives a crash during earlier recovery and preserves terminal errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "ritween-nested-recovery-"));
  const old = join(root, "session-crashed");
  const nested = join(old, `recovered-${randomUUID()}`);
  await mkdir(nested, { recursive: true });
  await writeFile(join(old, "owner.json"), JSON.stringify({ pid: 0 }));
  const completed = request();
  const failed = request();
  for (const input of [completed, failed]) {
    const directory = join(nested, input.id);
    await mkdir(directory);
    await writeFile(
      join(directory, "job.json"),
      JSON.stringify({
        ...input,
        status: "failed",
        error: "Native encoder unavailable.",
      }),
    );
    if (input === completed)
      await writeFile(join(directory, "output.mp4"), "MP4 fixture");
    else await writeFile(join(directory, "output.part"), "partial");
  }
  const jobs = await ExportJobs.create({ root, runner });
  try {
    assert.equal(
      await readFile(jobs.file(completed.id), "utf8"),
      "MP4 fixture",
    );
    const recovered = jobs.list().find((job) => job.id === failed.id)!;
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.error, "Native encoder unavailable.");
    assert.equal(recovered.recovered, true);
    assert.equal(jobs.list().length, 2);
  } finally {
    await jobs.close();
    assert.deepEqual(await readdir(root), []);
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "graceful shutdown cancels active rendering, refuses submissions and removes partial files",
  { timeout: 5000 },
  async () => {
    const started = gate();
    const f = await fixture({
      ...runner,
      async run({ output, signal }) {
        signal.throwIfAborted();
        await writeFile(output, "partial");
        await new Promise<void>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
          started.resolve();
        });
        throw Error("unreachable");
      },
    });
    try {
      await f.jobs.submit(request());
      await started.promise;
      f.jobs.stop();
      await assert.rejects(f.jobs.submit(request()), /stopping/i);
      await f.jobs.close();
      assert.deepEqual(await readdir(f.root), []);
    } finally {
      await f.close();
    }
  },
);

test("a second live server never adopts or deletes another server's files", async () => {
  const f = await fixture();
  const other = await ExportJobs.create({ root: f.root, runner });
  try {
    const job = await f.jobs.submit(request());
    await f.jobs.idle();
    assert.deepEqual(other.list(), []);
    await other.close();
    assert.equal(await readFile(f.jobs.file(job.id), "utf8"), "MP4 fixture");
  } finally {
    await other.close();
    await f.close();
  }
});
