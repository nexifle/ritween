import type { Plugin, Connect } from "vite";
import type { ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { ExportJobs, exportJobId, type ExportJobRunner } from "./export-jobs";
import {
  headlessExportRunner,
  type ExportRunnerOptions,
} from "./export-runner";
import { sendExportFile } from "./export-files";

export function exportJobsMiddleware(
  jobs: ExportJobs,
  streams: Set<ServerResponse>,
): Connect.NextHandleFunction {
  return async (req, res, next) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (
      path !== "/__ritween/exports" &&
      !path.startsWith("/__ritween/exports/")
    )
      return next();
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    if (
      (req.headers.origin &&
        req.headers.origin !== `http://${req.headers.host}` &&
        req.headers.origin !== `https://${req.headers.host}`) ||
      req.headers["sec-fetch-site"] === "cross-site"
    ) {
      res.statusCode = 403;
      res.end(
        JSON.stringify({ error: "Exports require a same-origin request." }),
      );
      return;
    }
    try {
      if (path === "/__ritween/exports/events" && req.method === "GET") {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();
        streams.add(res);
        const snapshot = () => {
          if (!res.destroyed && res.writableLength < 256 * 1024)
            res.write(`data: ${JSON.stringify({ jobs: jobs.list() })}\n\n`);
          else if (res.writableLength >= 256 * 1024) res.destroy();
        };
        const unsubscribe = jobs.subscribe(snapshot);
        const heartbeat = setInterval(snapshot, 1000);
        res.once("close", () => {
          clearInterval(heartbeat);
          unsubscribe();
          streams.delete(res);
        });
        snapshot();
        return;
      }
      if (path === "/__ritween/exports") {
        if (req.method === "GET") {
          res.end(JSON.stringify({ jobs: jobs.list() }));
          return;
        }
        if (req.method === "POST") {
          if (!req.headers["content-type"]?.startsWith("application/json"))
            throw Error("Expected application/json.");
          let body = "";
          for await (const chunk of req) {
            body += chunk;
            if (Buffer.byteLength(body) > 65536)
              throw Error("Export request is too large.");
          }
          const job = await jobs.submit(JSON.parse(body));
          res.statusCode = 202;
          res.end(JSON.stringify({ job }));
          return;
        }
      }
      const match = /^\/__ritween\/exports\/([^/]+)(?:\/(file|cancel))?$/.exec(
        path,
      );
      if (match && exportJobId.test(match[1])) {
        const [, id, action] = match;
        if (
          action === "file" &&
          (req.method === "GET" || req.method === "HEAD")
        ) {
          const file = jobs.file(id);
          await sendExportFile(
            req,
            res,
            file,
            "video/mp4",
            jobs.list().find((job) => job.id === id)!.filename,
          );
          return;
        }
        if (action === "cancel" && req.method === "POST") {
          await jobs.cancel(id);
          res.end(JSON.stringify({ jobs: jobs.list() }));
          return;
        }
        if (!action && req.method === "DELETE") {
          await jobs.remove(id);
          res.end(JSON.stringify({ jobs: jobs.list() }));
          return;
        }
      } else if (path !== "/__ritween/exports") {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "Export not found." }));
        return;
      }
      res.statusCode = 405;
      res.end(JSON.stringify({ error: "Unsupported export operation." }));
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      res.statusCode = /not found/i.test(message)
        ? 404
        : /active|queue is full|storage is full|stopping/i.test(message)
          ? 409
          : 400;
      res.end(JSON.stringify({ error: message }));
    }
  };
}

export function exportJobsPlugin(
  options: ExportRunnerOptions & {
    cacheRoot?: string;
    runner?: ExportJobRunner;
  },
): Plugin {
  return {
    name: "ritween-export-jobs",
    async configureServer(server) {
      const manifest = await realpath(options.project.manifest);
      const key = createHash("sha256").update(manifest).digest("hex");
      const jobs = await ExportJobs.create({
        root: options.cacheRoot ?? join(homedir(), ".ritween", "exports", key),
        runner: options.runner ?? headlessExportRunner(options),
      });
      const streams = new Set<ServerResponse>();
      server.middlewares.use(exportJobsMiddleware(jobs, streams));
      const originalClose = server.close.bind(server);
      let closing: Promise<void> | undefined;
      server.close = () =>
        (closing ??= (async () => {
          jobs.stop();
          for (const stream of streams) stream.end();
          try {
            await originalClose();
          } finally {
            await jobs.close();
          }
        })());
    },
  };
}
