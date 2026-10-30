import type { Browser } from "playwright-core";
import type { ViteDevServer } from "vite";
import type {} from "../src/cli-browser";
import { fileURLToPath } from "node:url";
import { dirname, resolve, basename, join } from "node:path";
import {
  access,
  mkdir,
  copyFile,
  rename,
  rm,
  readFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { parseOptions, help } from "./options.ts";
import { exportFilename } from "../src/engine/export/filename";
import { resolveProject } from "./project.ts";
import { startServer } from "./server.ts";
import { chromium } from "playwright-core";
import { createExportProgress, formatExportResult } from "./export-progress.ts";
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function checkOutput(output: string, force?: boolean) {
  if (force) return;
  try {
    await access(output);
    throw Error(`Output exists: ${output}. Pass --force to replace it.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  let options:
    Extract<ReturnType<typeof parseOptions>, { command: string }> | undefined;
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  let temporary: string | undefined;
  let task: Promise<void> | undefined;
  let exportProgress: ReturnType<typeof createExportProgress> | undefined;
  let cancelled = false;
  let interrupted = false;
  let timer;
  let rejectStop!: (reason: Error) => void;
  const stop = new Promise((_, reject) => {
    rejectStop = reject;
  });
  // A handler is attached before installing signal listeners, avoiding unhandled rejection.
  void stop.catch(() => {});
  const interrupt = () => {
    interrupted = true;
    rejectStop(Error("Cancelled."));
  };
  try {
    const parsed = parseOptions(argv);
    if (parsed.help) {
      console.log(help);
      return;
    }
    if (parsed.version) {
      console.log(
        JSON.parse(await readFile(join(runtimeRoot, "package.json"), "utf8"))
          .version,
      );
      return;
    }
    if (!("command" in parsed)) return;
    options = parsed;
    const activeOptions = parsed;
    const project = await resolveProject(
      activeOptions.project,
      activeOptions.demo,
      runtimeRoot,
    );
    if (
      activeOptions.command !== "preview" &&
      activeOptions.output !== undefined
    )
      await checkOutput(resolve(activeOptions.output), activeOptions.force);
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    if (activeOptions.command !== "preview")
      timer = setTimeout(
        () =>
          rejectStop(
            Error(
              `Command timed out after ${activeOptions.timeout / 1000} seconds.`,
            ),
          ),
        activeOptions.timeout,
      );
    const started = performance.now();
    if (activeOptions.command === "export")
      exportProgress = createExportProgress({ json: activeOptions.json });
    // The timer/signal races include server and browser startup, not just rendering.
    async function execute() {
      const serving = await startServer({
        runtimeRoot,
        project,
        port: activeOptions.command === "preview" ? activeOptions.port : 0,
        watch: activeOptions.command === "preview",
        mediaLoading: activeOptions.mediaLoading,
        mediaActivation: activeOptions.mediaActivation,
        exports: {
          browser: activeOptions.browser,
          channel: activeOptions.channel,
          timeout: activeOptions.previewExportTimeout,
        },
      });
      server = serving.server;
      if (cancelled || interrupted) throw Error("Cancelled.");
      if (activeOptions.command === "preview") {
        const result = {
          command: "preview",
          mediaLoading: activeOptions.mediaLoading,
          url: serving.url,
          manifest: project.manifest,
        };
        console.log(
          activeOptions.json
            ? JSON.stringify(result)
            : `Ritween preview: ${serving.url}\nProject: ${project.manifest}\nSource changes reload automatically. Press Ctrl+C to stop.`,
        );
        if (activeOptions.open) {
          const command =
            process.platform === "darwin"
              ? "open"
              : process.platform === "win32"
                ? "cmd"
                : "xdg-open";
          const args =
            process.platform === "win32"
              ? ["/c", "start", "", serving.url]
              : [serving.url];
          const child = spawn(command, args, {
            stdio: "ignore",
            detached: true,
          });
          child.on("error", (e) =>
            console.error(`Could not open browser: ${e.message}`),
          );
          child.unref();
        }
        await stop;
        return;
      }
      try {
        browser = await chromium.launch({
          headless: true,
          ...(activeOptions.browser
            ? { executablePath: resolve(activeOptions.browser) }
            : { channel: activeOptions.channel ?? "chrome" }),
          args: ["--enable-unsafe-webgpu"],
          timeout: activeOptions.timeout,
        });
      } catch (error) {
        throw Error(
          `Could not launch Chrome/Chromium. Install Chrome, use --channel chromium with an installed Playwright browser, or pass --browser PATH. ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (cancelled || interrupted) throw Error("Cancelled.");
      const page = await browser.newPage({ acceptDownloads: true });
      const mediaRequests = {
        rangeRequests: 0,
        partialResponses: 0,
        fullResponses: 0,
      };
      page.on("response", (response) => {
        if (response.headers()["content-type"]?.split(";")[0] !== "video/mp4")
          return;
        if (response.request().headers().range) mediaRequests.rangeRequests++;
        if (response.status() === 206) mediaRequests.partialResponses++;
        if (response.status() === 200) mediaRequests.fullResponses++;
      });
      page.setDefaultTimeout(activeOptions.timeout);
      const initializationFailure = new Promise((_, reject) =>
        page.once("pageerror", reject),
      );
      void initializationFailure.catch(() => {});
      const failures: string[] = [];
      page.on("pageerror", (error) => failures.push(error.message));
      await page.exposeFunction("ritweenStage", (stage: string) => {
        exportProgress?.stage(stage);
      });
      await page.exposeFunction("ritweenStageComplete", (stage: string) => {
        exportProgress?.stageComplete(stage);
      });
      await page.exposeFunction(
        "ritweenProgress",
        ({ done, total }: { done: number; total: number }) => {
          exportProgress?.update(done, total);
        },
      );
      await page.goto(`${serving.url}/__ritween/render`);
      try {
        await Promise.race([
          initializationFailure,
          page.waitForFunction(
            () =>
              !!window.ritween ||
              !!document.querySelector("vite-error-overlay"),
          ),
        ]);
      } catch (error) {
        throw Error(
          failures.join("\n") ||
            `Renderer did not initialize: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (await page.locator("vite-error-overlay").count())
        throw Error(
          await page
            .locator("vite-error-overlay")
            .evaluate(
              (el) =>
                el.shadowRoot?.textContent ?? "Source compilation failed.",
            ),
        );
      if (failures.length) throw Error(failures.join("\n"));
      const metadata = await page.evaluate(() => window.ritween.metadata());
      const output = resolve(
        activeOptions.output ?? exportFilename(metadata.name),
      );
      if (activeOptions.output === undefined)
        await checkOutput(output, activeOptions.force);
      if (
        activeOptions.command === "frame" &&
        activeOptions.time > metadata.duration
      )
        throw Error(
          `Frame time ${activeOptions.time}s exceeds composition duration ${metadata.duration}s.`,
        );
      if (
        activeOptions.command === "frame" &&
        activeOptions.frame !== undefined &&
        activeOptions.frame >= Math.ceil(metadata.duration * activeOptions.fps)
      )
        throw Error(
          `Frame index must be less than ${Math.ceil(metadata.duration * activeOptions.fps)} for this composition at ${activeOptions.fps} FPS.`,
        );
      const [download, details] = await Promise.all([
        page.waitForEvent("download"),
        page.evaluate(
          async (options) =>
            options.command === "frame"
              ? window.ritween.frame({
                  time: options.time,
                  width: options.width,
                  height: options.height,
                })
              : window.ritween.export({
                  width: options.width,
                  height: options.height,
                  ...options.exportOverrides,
                }),
          activeOptions,
        ),
      ]);
      if (failures.length) throw Error(failures.join("\n"));
      if (cancelled) throw Error("Cancelled.");
      exportProgress?.saving();
      await mkdir(dirname(output), { recursive: true });
      temporary = join(
        dirname(output),
        `.${basename(output)}.${randomUUID()}.tmp`,
      );
      await download.saveAs(temporary);
      if (cancelled) throw Error("Cancelled.");
      if (activeOptions.force) await rename(temporary, output);
      else {
        await copyFile(temporary, output, constants.COPYFILE_EXCL);
        await rm(temporary);
      }
      temporary = undefined;
      const result = {
        command: activeOptions.command,
        mediaLoading: activeOptions.mediaLoading,
        mediaRequests,
        output,
        project: metadata.name,
        ...details,
        elapsedSeconds: (performance.now() - started) / 1000,
      };
      exportProgress?.stop();
      console.log(
        activeOptions.json
          ? JSON.stringify(result)
          : "time" in details
            ? `Saved ${output}\nFrame at ${details.time}s · ${details.width}×${details.height} · ${(details.bytes / 2 ** 20).toFixed(2)} MiB\nCompleted in ${result.elapsedSeconds.toFixed(2)}s`
            : formatExportResult({
                ...details,
                output,
                elapsedSeconds: result.elapsedSeconds,
              }),
      );
    }
    // Keep execute handled even when cancellation wins.
    task = execute();
    await Promise.race([task, stop]);
  } catch (error) {
    exportProgress?.stop();
    if (interrupted && options?.command === "preview") {
      process.exitCode = 0;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      options?.json || argv.includes("--json")
        ? JSON.stringify({ event: "error", message })
        : `Ritween: ${message}`,
    );
    process.exitCode = interrupted ? 130 : 1;
  } finally {
    exportProgress?.stop();
    cancelled = true;
    clearTimeout(timer);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await browser?.close().catch(() => {});
    await server?.close().catch(() => {});
    // Startup can finish after a signal. Wait for the handled task, then close late resources too.
    await task?.catch(() => {});
    await browser?.close().catch(() => {});
    await server?.close().catch(() => {});
    if (temporary) await rm(temporary, { force: true }).catch(() => {});
  }
}
