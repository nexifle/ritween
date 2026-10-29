import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { normalizePath } from "vite";
import { startServer } from "../cli/server.ts";
import { resolveProject } from "../cli/project.ts";
const runtimeRoot = process.cwd();
const project = await resolveProject(".", true, runtimeRoot);
const { server, url } = await startServer({ runtimeRoot, project });
let browser;
try {
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL ?? "chrome",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${url}/__ritween/render`);
  await page.waitForFunction(() => !!window.ritween);
  const report = await page.evaluate(async (sourceRoot) => {
    const { project: demo } = await import("/@id/virtual:ritween-project");
    const { exportMp4: exportVideo } =
      await import(`${sourceRoot}/engine/export/formats/mp4/export-mp4.ts`);
    const { Renderer } = await import(`${sourceRoot}/engine/render/renderer.ts`);
    const { MP4Muxer } =
      await import(`${sourceRoot}/engine/export/formats/mp4/muxer.ts`);
    let created = 0,
      disposed = 0,
      finalized = 0;
    const create = Renderer.create,
      finalize = MP4Muxer.prototype.finalize;
    Renderer.create = async (...args) => {
      const renderer = await create.apply(Renderer, args);
      created++;
      const dispose = renderer.dispose.bind(renderer);
      let closed = false;
      renderer.dispose = () => {
        if (!closed) {
          closed = true;
          disposed++;
        }
        dispose();
      };
      return renderer;
    };
    MP4Muxer.prototype.finalize = function () {
      finalized++;
      return finalize.call(this);
    };
    const options = { width: 640, height: 360, fps: 30 };
    const compact = {
      ...demo,
      duration: 1,
      scenes: [{ ...demo.scenes[0], start: 0, duration: 1 }],
      audioTracks: [],
    };
    const successful = [];
    try {
      for (const pipeline of ["sequential", "parallel"]) {
        const output = await exportVideo(compact, { ...options, pipeline });
        successful.push({
          pipeline,
          frames: output.frames,
          duration: output.duration,
        });
      }
      const failures = [];
      const before = finalized;
      const audioError = new Error("audio pipeline failed");
      const badAudio = {
        ...compact,
        audioTracks: [
          {
            id: "a",
            name: "a",
            clips: [
              {
                id: "bad",
                name: "bad",
                start: 0,
                duration: 1,
                create: () => ({
                  async schedule() {
                    await new Promise((r) => setTimeout(r, 30));
                    throw audioError;
                  },
                }),
              },
            ],
          },
        ],
      };
      try {
        await exportVideo(badAudio, { ...options, pipeline: "parallel" });
        throw Error("audio error was lost");
      } catch (error) {
        if (!error.message.includes("audio pipeline failed")) throw error;
        failures.push("audio");
      }
      const delayedAudio = {
        id: "a",
        name: "a",
        clips: [
          {
            id: "waiting",
            name: "waiting",
            start: 0,
            duration: 1,
            create: () => ({
              async schedule(host) {
                await new Promise((r) => setTimeout(r, 100));
                const osc = new OscillatorNode(host.context);
                osc.connect(host.destination);
                osc.start(0);
                osc.stop(1);
              },
            }),
          },
        ],
      };
      const videoError = new Error("video pipeline failed");
      const badVideo = {
        ...compact,
        audioTracks: [delayedAudio],
        scenes: [
          {
            ...compact.scenes[0],
            create: () => {
              const scene = demo.scenes[0].create();
              let frames = 0;
              const render = scene.render.bind(scene);
              return {
                ...scene,
                render(ctx) {
                  if (++frames === 2) throw videoError;
                  render(ctx);
                },
              };
            },
          },
        ],
      };
      try {
        await exportVideo(badVideo, { ...options, pipeline: "parallel" });
        throw Error("video error was lost");
      } catch (error) {
        if (error !== videoError) throw error;
        failures.push("video");
      }
      const controller = new AbortController();
      try {
        await exportVideo(
          { ...compact, audioTracks: [delayedAudio] },
          {
            ...options,
            pipeline: "parallel",
            signal: controller.signal,
            onProgress(done) {
              if (done === 1) controller.abort();
            },
          },
        );
        throw Error("cancellation was lost");
      } catch (error) {
        if (error.name !== "AbortError") throw error;
        failures.push("cancel");
      }
      let setupStarted,
        sceneDisposed = false,
        hungDevice;
      const started = new Promise((resolve) => {
        setupStarted = resolve;
      });
      const hungSetup = {
        ...compact,
        scenes: [
          {
            ...compact.scenes[0],
            create: () => ({
              async setup({ device }) {
                hungDevice = device;
                setupStarted();
                await new Promise(() => {});
              },
              render() {},
              dispose() {
                sceneDisposed = true;
                throw Error("author dispose failed");
              },
            }),
          },
        ],
        audioTracks: [
          {
            id: "a",
            name: "a",
            clips: [
              {
                id: "setup-failure",
                name: "setup-failure",
                start: 0,
                duration: 1,
                create: () => ({
                  async schedule() {
                    await started;
                    throw Error("cancel hung setup");
                  },
                }),
              },
            ],
          },
        ],
      };
      try {
        await exportVideo(hungSetup, { ...options, pipeline: "parallel" });
        throw Error("hung setup was accepted");
      } catch (error) {
        if (!error.message.includes("cancel hung setup")) throw error;
        failures.push("setup-cancel");
      }
      const hungDeviceReason = (await hungDevice.lost).reason;
      if (!sceneDisposed || hungDeviceReason !== "destroyed")
        throw Error("Cancelled setup retained GPU resources");
      // Let abandoned author continuations settle: expired facades must not leak native nodes or unhandled errors.
      await new Promise((r) => setTimeout(r, 150));
      return {
        successful,
        failures,
        created,
        disposed,
        finalized,
        failedExportsMuxed: finalized - before,
        hungSetupDisposed: sceneDisposed,
        hungDeviceReason,
      };
    } finally {
      Renderer.create = create;
      MP4Muxer.prototype.finalize = finalize;
    }
  }, `/@fs${normalizePath(runtimeRoot)}/src`);
  for (const output of report.successful) {
    assert.equal(output.frames, 30);
    assert.equal(output.duration, 1);
  }
  assert.deepEqual(report.failures, [
    "audio",
    "video",
    "cancel",
    "setup-cancel",
  ]);
  assert.equal(report.created, report.disposed);
  assert.equal(report.failedExportsMuxed, 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(report, null, 2));
  console.log(
    "PASS: both modes, sibling cancellation, renderer cleanup, no MP4 on failure, no late unhandled errors.",
  );
} finally {
  await browser?.close();
  await server.close();
}
