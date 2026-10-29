import { build } from "vite";
import { chromium, type Browser } from "playwright-core";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type {} from "../src/cli-browser";
import { projectPlugin, type ResolvedProject } from "./project";
import { mediaResponse } from "./media-response";
import { sendExportFile } from "./export-files";
import type { ExportJobRunner } from "./export-jobs";

export interface ExportRunnerOptions {
  runtimeRoot: string;
  project: ResolvedProject;
  sourceRuntime?: boolean;
  browser?: string;
  channel?: string;
  mediaLoading?: "full" | "range";
  mediaActivation?: "eager" | "active-only";
  timeout?: number;
}

export function headlessExportRunner(
  options: ExportRunnerOptions,
): ExportJobRunner {
  const { runtimeRoot, project, sourceRuntime } = options;
  const publicRoot = existsSync(join(project.directory, "public"))
    ? join(project.directory, "public")
    : join(runtimeRoot, "dist/public");
  const mime: Record<string, string> = {
    ".js": "text/javascript",
    ".json": "application/json",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".avif": "image/avif",
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  };
  return {
    async prepare({ directory, request, signal }) {
      signal.throwIfAborted();
      // Bundle every imported source module before queueing. No HMR or live source
      // imports remain in the renderer. Large public media stays on disk, not copied.
      await build({
        configFile: false,
        root: project.directory,
        logLevel: "silent",
        publicDir: false,
        plugins: [
          projectPlugin(
            project.manifest,
            join(
              runtimeRoot,
              sourceRuntime
                ? "src/engine/project-settings-schema.ts"
                : "dist/schema.js",
            ),
            request.settings,
          ),
        ],
        resolve: {
          alias: [
            {
              find: /^ritween$/,
              replacement: join(
                runtimeRoot,
                sourceRuntime ? "src/index.ts" : "dist/index.js",
              ),
            },
          ],
        },
        define: {
          "globalThis.__ritweenRangeVideo": JSON.stringify(
            options.mediaLoading === "range",
          ),
          "globalThis.__ritweenMediaActivation": JSON.stringify(
            options.mediaActivation ?? "eager",
          ),
        },
        build: {
          outDir: join(directory, "snapshot"),
          emptyOutDir: true,
          copyPublicDir: false,
          assetsInlineLimit: 0,
          rollupOptions: {
            input: join(
              runtimeRoot,
              sourceRuntime ? "src/cli-browser.ts" : "dist/renderer.js",
            ),
            output: { entryFileNames: "renderer.js" },
          },
        },
      });
      signal.throwIfAborted();
    },
    async run({ directory, output, signal, stage, progress, saving }) {
      const snapshot = join(directory, "snapshot");
      const media = mediaResponse(publicRoot);
      const server = createServer((req, res) => {
        media(req, res, (error?: unknown) => {
          void (async () => {
            if (error) throw error;
            if (req.method !== "GET" && req.method !== "HEAD") {
              res.statusCode = 405;
              res.end();
              return;
            }
            const path = decodeURIComponent(
              new URL(req.url ?? "/", "http://localhost").pathname,
            );
            if (path === "/") {
              res.setHeader("Content-Type", "text/html");
              res.end(
                '<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="/renderer.js"></script></body></html>',
              );
              return;
            }
            for (const root of [snapshot, publicRoot]) {
              try {
                const base = await realpath(root);
                const file = await realpath(resolve(base, "." + path));
                const local = relative(base, file);
                if (local.startsWith("..") || isAbsolute(local)) continue;
                await sendExportFile(
                  req,
                  res,
                  file,
                  mime[extname(file).toLowerCase()] ??
                    "application/octet-stream",
                );
                return;
              } catch (error) {
                if (
                  !["ENOENT", "ENOTDIR"].includes(
                    (error as NodeJS.ErrnoException).code ?? "",
                  )
                )
                  throw error;
              }
            }
            res.statusCode = 404;
            res.end();
          })().catch((error) => {
            if (!res.headersSent) {
              res.statusCode = 500;
              res.end(String(error));
            } else res.destroy();
          });
        });
      });
      let browser: Browser | undefined;
      const abort = () => {
        void browser?.close().catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      const timer = options.timeout
        ? setTimeout(() => abortWithTimeout(), options.timeout)
        : undefined;
      let timedOut = false;
      const abortWithTimeout = () => {
        timedOut = true;
        abort();
      };
      try {
        signal.throwIfAborted();
        await new Promise<void>((done, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", done);
        });
        await mkdir(join(directory, "downloads"));
        try {
          browser = await chromium.launch({
            headless: true,
            ...(options.browser
              ? { executablePath: resolve(options.browser) }
              : { channel: options.channel ?? "chrome" }),
            downloadsPath: join(directory, "downloads"),
            args: ["--enable-unsafe-webgpu"],
            timeout: 120_000,
          });
        } catch (error) {
          throw Error(
            `Could not launch Chrome/Chromium. Install Chrome or start preview with --channel or --browser. ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        signal.throwIfAborted();
        if (timedOut) throw Error("Export timed out.");
        const page = await browser.newPage({ acceptDownloads: true });
        page.setDefaultTimeout(120_000);
        let rejectFailure!: (error: Error) => void;
        const failure = new Promise<never>((_, reject) => {
          rejectFailure = reject;
        });
        void failure.catch(() => {});
        page.on("pageerror", rejectFailure);
        page.on("crash", () =>
          rejectFailure(Error("The headless renderer crashed.")),
        );
        browser.on("disconnected", () =>
          rejectFailure(Error("The headless renderer disconnected.")),
        );
        await page.exposeFunction("ritweenStage", (value: string) =>
          stage(value, false),
        );
        await page.exposeFunction("ritweenStageComplete", (value: string) =>
          stage(value, true),
        );
        await page.exposeFunction(
          "ritweenProgress",
          ({ done, total }: { done: number; total: number }) =>
            progress(done, total),
        );
        const address = server.address();
        if (!address || typeof address === "string")
          throw Error("Renderer server did not start.");
        await page.goto(`http://127.0.0.1:${address.port}`);
        await Promise.race([
          page.waitForFunction(() => !!window.ritween),
          failure,
        ]);
        const metadata = await page.evaluate(() => window.ritween.metadata());
        progress(0, Math.ceil(metadata.duration * metadata.exportFps));
        const [download, details] = await Promise.race([
          Promise.all([
            page.waitForEvent("download", { timeout: 0 }),
            page.evaluate(() => window.ritween.export({})),
          ]),
          failure,
        ]);
        signal.throwIfAborted();
        saving();
        await download.saveAs(output);
        if (timedOut) throw Error("Export timed out.");
        signal.throwIfAborted();
        return { name: metadata.name, frames: details.frames };
      } catch (error) {
        if (timedOut) throw Error("Export timed out.");
        throw error;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        try {
          await browser?.close();
        } finally {
          server.closeAllConnections();
          await new Promise<void>((done) => server.close(() => done()));
        }
      }
    },
  };
}
