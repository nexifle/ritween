import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { exportFilename } from "../src/engine/export/filename";
import {
  exportJobActive,
  type ExportJob,
  type ExportJobRequest,
} from "../src/engine/export/job";
import { parseProjectSettings } from "../src/engine/project-settings-schema";

export const exportJobId =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export interface ExportJobRunner {
  prepare(context: {
    directory: string;
    request: ExportJobRequest;
    signal: AbortSignal;
  }): Promise<void>;
  run(context: {
    directory: string;
    output: string;
    signal: AbortSignal;
    stage: (stage: string, complete: boolean) => void;
    progress: (done: number, total: number) => void;
    saving: () => void;
  }): Promise<{ name: string; frames: number }>;
}
interface Entry {
  job: ExportJob;
  controller: AbortController;
  task?: Promise<void>;
  sample?: { time: number; done: number };
}

/** Files belong to a server session, never to a browser tab or HTTP connection. */
export class ExportJobs {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private queue = Promise.resolve();
  private closing?: Promise<void>;
  private stopping = false;
  private lastProgress = 0;

  private constructor(
    private directory: string,
    private runner: ExportJobRunner,
    private maxBytes: number,
  ) {}

  static async create({
    root,
    runner,
    maxBytes = 4 * 2 ** 30,
  }: {
    root: string;
    runner: ExportJobRunner;
    maxBytes?: number;
  }) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(root, "session-"));
    const jobs = new ExportJobs(directory, runner, maxBytes);
    try {
      await writeFile(
        join(directory, "owner.json"),
        JSON.stringify({ pid: process.pid }),
        { mode: 0o600 },
      );
      await jobs.recover(root);
      return jobs;
    } catch (error) {
      // Keep any adopted artifacts discoverable if recovery itself fails.
      await writeFile(
        join(directory, "owner.json"),
        JSON.stringify({ pid: 0 }),
      ).catch(() => {});
      throw error;
    }
  }

  private async recover(root: string) {
    for (const session of await readdir(root, { withFileTypes: true })) {
      const source = join(root, session.name);
      if (
        !session.isDirectory() ||
        !session.name.startsWith("session-") ||
        source === this.directory
      )
        continue;
      let owner: { pid?: number };
      try {
        owner = JSON.parse(await readFile(join(source, "owner.json"), "utf8"));
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" &&
          !(error instanceof SyntaxError)
        )
          throw error;
        // Another server may still be creating its owner record.
        const info = await stat(source).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!info || Date.now() - info.mtimeMs < 60_000) continue;
        owner = {};
      }
      if (Number.isInteger(owner.pid) && owner.pid! > 0) {
        try {
          process.kill(owner.pid!, 0);
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
        }
      }
      const claimed = join(this.directory, `recovered-${randomUUID()}`);
      try {
        await rename(source, claimed);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const item of await this.recoveryFiles(claimed)) {
        const from = item.path;
        const to = join(this.directory, item.name);
        await rename(from, to);
        let saved: Partial<ExportJob> = {};
        try {
          saved = JSON.parse(await readFile(join(to, "job.json"), "utf8"));
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== "ENOENT" &&
            !(error instanceof SyntaxError)
          )
            throw error;
        }
        const output = await stat(join(to, "output.mp4")).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        const job = this.newJob({
          id: item.name,
          name:
            typeof saved.name === "string"
              ? saved.name.slice(0, 512)
              : "Recovered export",
          settings: { version: 1 },
        });
        job.createdAt =
          typeof saved.createdAt === "number" ? saved.createdAt : Date.now();
        job.elapsedSeconds =
          typeof saved.elapsedSeconds === "number" ? saved.elapsedSeconds : 0;
        job.done = Number.isSafeInteger(saved.done) ? saved.done! : 0;
        job.total = Number.isSafeInteger(saved.total) ? saved.total! : 0;
        job.finishedAt = Date.now();
        job.recovered = true;
        job.status =
          output?.isFile() && output.size > 0
            ? "completed"
            : saved.status === "failed" || saved.status === "cancelled"
              ? saved.status
              : "interrupted";
        job.bytes = job.status === "completed" ? output!.size : 0;
        job.percent = job.status === "completed" ? 100 : 0;
        job.error =
          job.status === "interrupted"
            ? "The previous server stopped before this export finished."
            : job.status !== "completed" && typeof saved.error === "string"
              ? saved.error
              : "";
        const entry = { job, controller: new AbortController() };
        this.entries.set(job.id, entry);
        await this.cleanWork(job.id);
        await this.persist(entry);
      }
      await rm(claimed, { recursive: true, force: true });
    }
  }

  private async recoveryFiles(
    directory: string,
  ): Promise<{ name: string; path: string }[]> {
    const found: { name: string; path: string }[] = [];
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const path = join(directory, item.name);
      if (exportJobId.test(item.name)) found.push({ name: item.name, path });
      else if (item.name.startsWith("recovered-"))
        found.push(...(await this.recoveryFiles(path)));
    }
    return found;
  }

  private newJob(request: ExportJobRequest): ExportJob {
    return {
      id: request.id,
      name: request.name,
      filename: exportFilename(request.name),
      status: "preparing",
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      done: 0,
      total: 0,
      stages: [],
      percent: 0,
      elapsedSeconds: 0,
      etaSeconds: null,
      bytes: 0,
      error: "",
      recovered: false,
    };
  }

  list(): ExportJob[] {
    return [...this.entries.values()]
      .map(({ job }) => ({
        ...job,
        stages: [...job.stages],
        elapsedSeconds:
          job.startedAt && !job.finishedAt
            ? (Date.now() - job.startedAt) / 1000
            : job.elapsedSeconds,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed() {
    for (const listener of this.listeners) listener();
  }
  private path(id: string) {
    return join(this.directory, id);
  }
  private entry(id: string) {
    const entry = this.entries.get(id);
    if (!entry) throw Error("Export not found.");
    return entry;
  }
  private async persist(entry: Entry) {
    const file = join(this.path(entry.job.id), "job.json");
    const temporary = `${file}.tmp`;
    await writeFile(temporary, JSON.stringify(entry.job), { mode: 0o600 });
    await rename(temporary, file);
  }
  private async cleanWork(id: string) {
    for (const name of ["snapshot", "downloads", "output.part", "job.json.tmp"])
      await rm(join(this.path(id), name), { recursive: true, force: true });
  }

  async submit(input: ExportJobRequest) {
    if (this.stopping) throw Error("The preview server is stopping.");
    if (
      !input ||
      !exportJobId.test(input.id) ||
      typeof input.name !== "string" ||
      !input.name ||
      input.name.length > 512
    )
      throw Error("Expected an export ID, project name, and project settings.");
    const request = {
      ...input,
      settings: parseProjectSettings(input.settings),
    };
    const existing = this.entries.get(request.id);
    if (existing) return { ...existing.job };
    if (
      this.entries.size >= 50 ||
      this.list().reduce((sum, job) => sum + job.bytes, 0) >= this.maxBytes
    )
      throw Error(
        "Temporary export storage is full. Download and delete finished exports before starting another.",
      );
    if (this.list().filter(exportJobActive).length >= 3)
      throw Error("The export queue is full. Wait for an export to finish.");
    const entry: Entry = {
      job: this.newJob(request),
      controller: new AbortController(),
    };
    this.entries.set(request.id, entry);
    const initialized = mkdir(this.path(request.id), { mode: 0o700 }).then(() =>
      this.persist(entry),
    );
    const previous = this.queue;
    entry.task = initialized
      .then(() => this.execute(entry, request, previous))
      .catch((error) => {
        entry.job.status = "failed";
        entry.job.error = `Could not store export state: ${error instanceof Error ? error.message : String(error)}`;
        this.changed();
        console.error(entry.job.error);
      });
    this.queue = Promise.all([previous, entry.task]).then(() => {});
    await initialized;
    this.changed();
    return { ...entry.job };
  }

  private async execute(
    entry: Entry,
    request: ExportJobRequest,
    previous: Promise<void>,
  ) {
    const { job, controller } = entry;
    const signal = controller.signal;
    try {
      signal.throwIfAborted();
      await this.runner.prepare({
        directory: this.path(job.id),
        request,
        signal,
      });
      signal.throwIfAborted();
      job.status = "queued";
      this.changed();
      await new Promise<void>((resolve, reject) => {
        const aborted = () => reject(signal.reason);
        signal.addEventListener("abort", aborted, { once: true });
        previous.then(() => {
          signal.removeEventListener("abort", aborted);
          resolve();
        });
        if (signal.aborted) aborted();
      });
      signal.throwIfAborted();
      job.status = "running";
      job.startedAt = Date.now();
      await this.persist(entry);
      signal.throwIfAborted();
      this.changed();
      const details = await this.runner.run({
        directory: this.path(job.id),
        output: join(this.path(job.id), "output.part"),
        signal,
        stage: (stage, complete) => {
          job.stages = complete
            ? job.stages.filter((value) => value !== stage)
            : [...new Set([...job.stages, stage])];
          this.changed();
        },
        progress: (done, total) => {
          if (
            !Number.isSafeInteger(done) ||
            !Number.isSafeInteger(total) ||
            done < 0 ||
            total <= 0 ||
            done > total
          )
            return;
          job.done = done;
          job.total = total;
          job.percent = Math.min(99, Math.floor((done / total) * 100));
          const now = Date.now();
          const sample = (entry.sample ??= { time: now, done });
          if (now - sample.time >= 2000 && done > sample.done) {
            job.etaSeconds =
              done < total
                ? ((total - done) * (now - sample.time)) /
                  (done - sample.done) /
                  1000
                : null;
            entry.sample = { time: now, done };
          }
          if (done === total) job.etaSeconds = null;
          if (now - this.lastProgress >= 250 || done === total) {
            this.lastProgress = now;
            this.changed();
          }
        },
        saving: () => {
          job.status = "saving";
          job.etaSeconds = null;
          this.changed();
        },
      });
      signal.throwIfAborted();
      job.name = details.name;
      job.filename = exportFilename(details.name);
      job.done = job.total = details.frames;
      const output = join(this.path(job.id), "output.mp4");
      const info = await stat(join(this.path(job.id), "output.part"));
      if (!info.isFile() || !info.size)
        throw Error("The renderer did not produce an MP4 file.");
      const retained = this.list()
        .filter((value) => value.id !== job.id)
        .reduce((sum, value) => sum + value.bytes, 0);
      if (retained + info.size > this.maxBytes)
        throw Error(
          "Temporary export storage is full. Download and delete older exports, then retry.",
        );
      job.bytes = info.size;
      // Persist the result description before atomically publishing the completed file.
      await this.persist(entry);
      signal.throwIfAborted();
      await rename(join(this.path(job.id), "output.part"), output);
      job.status = "completed";
      job.percent = 100;
    } catch (error) {
      job.status = signal.aborted ? "cancelled" : "failed";
      job.bytes = 0;
      job.error = signal.aborted
        ? "Export cancelled."
        : error instanceof Error
          ? error.message
          : String(error);
      await rm(join(this.path(job.id), "output.mp4"), { force: true });
    } finally {
      job.finishedAt = Date.now();
      job.elapsedSeconds = job.startedAt
        ? (job.finishedAt - job.startedAt) / 1000
        : 0;
      job.stages = [];
      job.etaSeconds = null;
      await this.cleanWork(job.id);
      await this.persist(entry);
      this.changed();
    }
  }

  async cancel(id: string) {
    const entry = this.entry(id);
    if (exportJobActive(entry.job))
      entry.controller.abort(Error("Export cancelled."));
    this.changed();
  }
  file(id: string) {
    const entry = this.entry(id);
    if (entry.job.status !== "completed")
      throw Error("Export file is not ready.");
    return join(this.path(id), "output.mp4");
  }
  async remove(id: string) {
    const entry = this.entry(id);
    if (exportJobActive(entry.job))
      throw Error("Cancel the active export before deleting it.");
    await entry.task;
    await rm(this.path(id), { recursive: true, force: true });
    this.entries.delete(id);
    this.changed();
  }
  async idle() {
    await Promise.all([...this.entries.values()].map((entry) => entry.task));
  }
  stop() {
    this.stopping = true;
    for (const entry of this.entries.values())
      entry.controller.abort(Error("Preview server stopped."));
  }
  close() {
    this.stop();
    return (this.closing ??= (async () => {
      await this.idle();
      await rm(this.directory, { recursive: true, force: true });
      this.listeners.clear();
    })());
  }
}
