import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";

/** Stream downloads instead of materializing exported videos in Node or the studio. */
export async function sendExportFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  type: string,
  filename?: string,
) {
  const info = await stat(file);
  if (!info.isFile()) throw Error("Not a file.");
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Accept-Ranges", "bytes");
  if (filename)
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="video.mp4"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (value) => `%${value.charCodeAt(0).toString(16)}`)}`,
    );
  let start = 0,
    end = info.size - 1;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (match && (match[1] || match[2])) {
      start = match[1]
        ? Number(match[1])
        : Math.max(0, info.size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(end, Number(match[2])) : end;
    } else start = -1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start > end
    ) {
      res.statusCode = 416;
      res.setHeader("Content-Range", `bytes */${info.size}`);
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${info.size}`);
  }
  res.setHeader("Content-Length", Math.max(0, end - start + 1));
  if (req.method === "HEAD" || !info.size) {
    res.end();
    return;
  }
  try {
    await pipeline(createReadStream(file, { start, end }), res);
  } catch (error) {
    if (!res.destroyed) throw error;
  }
}
