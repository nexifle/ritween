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
import { parseOptions, help } from "./options.mjs";
import { resolveProject } from "./project.mjs";
import { startServer } from "./server.mjs";
import { chromium } from "playwright-core";
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export async function main(argv = process.argv.slice(2)) {
  let options, server, browser, temporary, task;
  let cancelled = false;
  let interrupted = false;
  let timer;
  let rejectStop;
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
    options = parseOptions(argv);
    if (options.help) {
      console.log(help);
      return;
    }
    if (options.version) {
      console.log(
        JSON.parse(await readFile(join(runtimeRoot, "package.json"), "utf8"))
          .version,
      );
      return;
    }
    const project = await resolveProject(
      options.project,
      options.demo,
      runtimeRoot,
    );
    const output = resolve(options.output);
    if (options.command !== "preview" && !options.force) {
      try {
        await access(output);
        throw Error(`Output exists: ${output}. Pass --force to replace it.`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    if (options.command !== "preview")
      timer = setTimeout(
        () =>
          rejectStop(
            Error(`Command timed out after ${options.timeout / 1000} seconds.`),
          ),
        options.timeout,
      );
    const started = performance.now();
    // The timer/signal races include server and browser startup, not just rendering.
    async function execute() {
      const serving = await startServer({
        runtimeRoot,
        project,
        port: options.command === "preview" ? options.port : 0,
      });
      server = serving.server;
      if (cancelled || interrupted) throw Error("Cancelled.");
      if (options.command === "preview") {
        const result = {
          command: "preview",
          url: serving.url,
          manifest: project.manifest,
        };
        console.log(
          options.json
            ? JSON.stringify(result)
            : `Ritween preview: ${serving.url}\nProject: ${project.manifest}\nSource changes reload automatically. Press Ctrl+C to stop.`,
        );
        if (options.open) {
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
          ...(options.browser
            ? { executablePath: resolve(options.browser) }
            : { channel: options.channel ?? "chrome" }),
          args: ["--enable-unsafe-webgpu"],
          timeout: options.timeout,
        });
      } catch (error) {
        throw Error(
          `Could not launch Chrome/Chromium. Install Chrome, use --channel chromium with an installed Playwright browser, or pass --browser PATH. ${error.message}`,
        );
      }
      if (cancelled || interrupted) throw Error("Cancelled.");
      const page = await browser.newPage({ acceptDownloads: true });
      page.setDefaultTimeout(options.timeout);
      const initializationFailure = new Promise((_, reject) =>
        page.once("pageerror", reject),
      );
      void initializationFailure.catch(() => {});
      const failures = [];
      page.on("pageerror", (error) => failures.push(error.message));
      await page.exposeFunction("ritweenStage", (stage) => {
        console.error(
          options.json
            ? JSON.stringify({ event: "stage", stage })
            : `Export: ${stage}`,
        );
      });
      let lastPercent = -1;
      await page.exposeFunction("ritweenProgress", ({ done, total }) => {
        const percent = Math.floor((done / total) * 10) * 10;
        if (percent !== lastPercent) {
          lastPercent = percent;
          console.error(
            options.json
              ? JSON.stringify({ event: "progress", done, total, percent })
              : `Export ${percent}% (${done}/${total} frames)`,
          );
        }
      });
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
            `Renderer did not initialize: ${error.message}`,
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
      if (options.command === "frame" && options.time > metadata.duration)
        throw Error(
          `Frame time ${options.time}s exceeds composition duration ${metadata.duration}s.`,
        );
      if (
        options.command === "frame" &&
        options.frame !== undefined &&
        options.frame >= Math.ceil(metadata.duration * options.fps)
      )
        throw Error(
          `Frame index must be less than ${Math.ceil(metadata.duration * options.fps)} for this composition at ${options.fps} FPS.`,
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
                  fps: options.fps,
                  bitrate: options.bitrate,
                  latencyMode: options.latencyMode,
                  keyFrameInterval: options.keyFrameInterval,
                }),
          options,
        ),
      ]);
      if (failures.length) throw Error(failures.join("\n"));
      if (cancelled) throw Error("Cancelled.");
      await mkdir(dirname(output), { recursive: true });
      temporary = join(
        dirname(output),
        `.${basename(output)}.${randomUUID()}.tmp`,
      );
      await download.saveAs(temporary);
      if (cancelled) throw Error("Cancelled.");
      if (options.force) await rename(temporary, output);
      else {
        await copyFile(temporary, output, constants.COPYFILE_EXCL);
        await rm(temporary);
      }
      temporary = undefined;
      const result = {
        command: options.command,
        output,
        project: metadata.name,
        ...details,
        elapsedSeconds: (performance.now() - started) / 1000,
      };
      console.log(
        options.json
          ? JSON.stringify(result)
          : `Saved ${output}\n${options.command === "frame" ? `Frame at ${details.time}s · ${details.width}×${details.height}` : `${details.frames} frames · ${details.duration}s · ${details.width}×${details.height} at ${details.fps} FPS`} · ${(details.bytes / 2 ** 20).toFixed(2)} MiB\nCompleted in ${result.elapsedSeconds.toFixed(2)}s`,
      );
    }
    // Keep execute handled even when cancellation wins.
    task = execute();
    await Promise.race([task, stop]);
  } catch (error) {
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
