import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import type { Connect } from "vite";

import {
  MAX_ASSET_BYTES,
  MAX_MEDIA_SNAPSHOT_BYTES,
} from "../src/engine/media/limits";

/** Serve public MP4 snapshots so validators always describe the bytes sent. */
export function mediaResponse(root: string): Connect.NextHandleFunction {
  const snapshots = new Map<
    string,
    { identity: string; bytes: Buffer; etag: string }
  >();
  let retained = 0;
  return async (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    let path: string;
    try {
      path = decodeURIComponent(
        new URL(req.url ?? "/", "http://localhost").pathname,
      );
    } catch {
      res.statusCode = 400;
      res.end();
      return;
    }
    if (!path.toLowerCase().endsWith(".mp4")) return next();
    try {
      const base = await realpath(root);
      const file = await realpath(resolve(base, "." + path));
      const local = relative(base, file);
      if (
        local === ".." ||
        local.startsWith(".." + sep) ||
        resolve(base, local) !== file
      ) {
        res.statusCode = 403;
        res.end();
        return;
      }
      const handle = await open(file, "r");
      let bytes: Buffer;
      let etag: string;
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) return next();
        if (stat.size > MAX_ASSET_BYTES) {
          res.statusCode = 413;
          res.end();
          return;
        }
        const identity = [
          stat.dev,
          stat.ino,
          stat.size,
          stat.mtimeMs,
          stat.ctimeMs,
        ].join(":");
        const cached = snapshots.get(file);
        if (cached?.identity === identity) {
          snapshots.delete(file);
          snapshots.set(file, cached);
          bytes = cached.bytes;
          etag = cached.etag;
        } else {
          // Read at most the limit plus one even if the file grows after stat().
          const chunks: Buffer[] = [];
          let total = 0;
          for (;;) {
            const chunk = Buffer.alloc(
              Math.min(256 * 1024, MAX_ASSET_BYTES + 1 - total),
            );
            const { bytesRead } = await handle.read(chunk);
            if (!bytesRead) break;
            total += bytesRead;
            if (total > MAX_ASSET_BYTES) {
              res.statusCode = 413;
              res.end();
              return;
            }
            chunks.push(chunk.subarray(0, bytesRead));
          }
          bytes = Buffer.concat(chunks, total);
          etag = '"' + createHash("sha256").update(bytes).digest("hex") + '"';
          const after = await handle.stat();
          if (
            [
              after.dev,
              after.ino,
              after.size,
              after.mtimeMs,
              after.ctimeMs,
            ].join(":") === identity
          ) {
            const old = snapshots.get(file);
            if (old) {
              retained -= old.bytes.length;
              snapshots.delete(file);
            }
            while (
              retained + bytes.length > MAX_MEDIA_SNAPSHOT_BYTES &&
              snapshots.size
            ) {
              const oldest = snapshots.keys().next().value!;
              retained -= snapshots.get(oldest)!.bytes.length;
              snapshots.delete(oldest);
            }
            snapshots.set(file, { identity, bytes, etag });
            retained += bytes.length;
          }
        }
      } finally {
        await handle.close();
      }
      if (res.destroyed) return;
      res.setHeader("ETag", etag);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Content-Type", "video/mp4");
      if (
        req.headers["if-none-match"]
          ?.split(",")
          .some(
            (value) =>
              value.trim().replace(/^W\//, "") === etag || value.trim() === "*",
          )
      ) {
        res.statusCode = 304;
        res.end();
        return;
      }
      let start = 0,
        end = bytes.length;
      const range = req.headers.range;
      if (
        range &&
        (!req.headers["if-range"] || req.headers["if-range"] === etag)
      ) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (match && (match[1] || match[2])) {
          start = match[1]
            ? Number(match[1])
            : Math.max(0, end - Number(match[2]));
          end =
            match[1] && match[2] ? Math.min(end, Number(match[2]) + 1) : end;
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start >= end
          ) {
            res.statusCode = 416;
            res.setHeader("Content-Range", `bytes */${bytes.length}`);
            res.end();
            return;
          }
          res.statusCode = 206;
          res.setHeader(
            "Content-Range",
            `bytes ${start}-${end - 1}/${bytes.length}`,
          );
        }
      }
      res.setHeader("Content-Length", end - start);
      res.end(req.method === "HEAD" ? undefined : bytes.subarray(start, end));
    } catch (error) {
      if (
        ["ENOENT", "ENOTDIR"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        return next();
      next(error);
    }
  };
}
