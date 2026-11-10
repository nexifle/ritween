/**
 * Browser proof for the layout-baseline Canvas 2D measureText probe.
 *
 * Runs production FrameSource frames through scripts/layout-baseline-harness.ts
 * in real WebGPU Chrome. Not a G7 gate, not a five-run batch, and it does not
 * write or modify baseline snapshot bytes, manifests, or replay artifacts.
 *
 * Usage: node scripts/layout-baseline-measurer.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const port = 5179;
const server = await createServer({
  configFile: false,
  root,
  logLevel: "warn",
  optimizeDeps: { noDiscovery: true },
  plugins: [
    {
      name: "measurer-page",
      configureServer(s) {
        s.middlewares.use((req, res, next) => {
          if (req.url === "/favicon.ico") {
            res.statusCode = 204;
            res.end();
            return;
          }
          if (req.url !== "/") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            '<!doctype html><link rel="icon" href="data:,"><title>measurer</title>',
          );
        });
      },
    },
  ],
  server: { host: "127.0.0.1", port, strictPort: true },
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL ?? "chrome",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(server.resolvedUrls.local[0]);
  const report = await page.evaluate(async () => {
    const proto = CanvasRenderingContext2D.prototype;
    const nativeMeasure = proto.measureText;
    const { installCanvas2dMeasureTextProbe, runHarness } =
      await import("/scripts/layout-baseline-harness.ts");
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    const probe = installCanvas2dMeasureTextProbe();
    let forwarded = false;
    try {
      forwarded = context.measureText("Mg").width > 0;
      throw Error("create failed");
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "create failed")
        throw error;
    } finally {
      probe.restore();
    }
    const restoredBeforeRun = proto.measureText === nativeMeasure;

    const queueProto = GPUQueue.prototype;
    const queueDescriptor = Object.getOwnPropertyDescriptor(
      queueProto,
      "onSubmittedWorkDone",
    );
    const nativeQueue = queueProto.onSubmittedWorkDone;
    let queueWaits = 0;
    queueProto.onSubmittedWorkDone = function (...args) {
      queueWaits += 1;
      return nativeQueue.apply(this, args);
    };
    const decode = async (base64) => {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const bitmap = await createImageBitmap(
        new Blob([bytes], { type: "image/png" }),
      );
      const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = surface.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    };
    try {
      const options = {
        fixture: "regression",
        warmup: 2,
        measured: 3,
        frameTime: 0,
      };
      const instrumented = await runHarness({
        ...options,
        canvas2dProbe: true,
      });
      const queueWaitsDuringInstrumented = queueWaits;
      const plain = await runHarness({ ...options, canvas2dProbe: false });
      const pixelDifferingBytes = [];
      for (let i = 0; i < instrumented.frames.length; i++) {
        const left = await decode(instrumented.frames[i].pngBase64);
        const right = await decode(plain.frames[i].pngBase64);
        let differing = 0;
        const length = Math.max(left.length, right.length);
        for (let b = 0; b < length; b++) if (left[b] !== right[b]) differing++;
        pixelDifferingBytes.push(differing);
      }
      return {
        forwarded,
        restoredBeforeRun,
        restoredAfterRuns: proto.measureText === nativeMeasure,
        queueWaitsDuringInstrumented,
        pixelDifferingBytes,
        instrumented: instrumented.result,
        plain: {
          canvas2dMeasureText: plain.result.canvas2dMeasureText,
          frameTiming: plain.result.frameTiming,
          endToEndMs: plain.result.endToEndMs,
          g7: plain.result.g7,
          gpuPasses: plain.result.gpu.beginRenderPasses,
        },
      };
    } finally {
      if (queueDescriptor)
        Object.defineProperty(
          queueProto,
          "onSubmittedWorkDone",
          queueDescriptor,
        );
      else delete queueProto.onSubmittedWorkDone;
    }
  });

  assert.equal(errors.length, 0, errors.join("; "));
  assert.equal(report.forwarded, true);
  assert.equal(report.restoredBeforeRun, true);
  assert.equal(report.restoredAfterRuns, true);
  assert.ok(
    report.queueWaitsDuringInstrumented > 0,
    "GPU queue was not awaited",
  );
  assert.deepEqual(report.pixelDifferingBytes, [0, 0, 0]);

  const canvas = report.instrumented.canvas2dMeasureText;
  assert.equal(canvas.available, true);
  assert.match(canvas.semantics, /Not a ViewRenderer\.measureText count/);
  assert.ok(canvas.setup.canvas2dMeasureTextCalls > 0);
  assert.equal(canvas.warmup.frames, 2);
  assert.ok(canvas.warmup.totalCanvas2dMeasureTextCalls > 0);
  assert.ok(canvas.warmup.totalRasterMgCalls > 0);
  assert.equal(canvas.measured.frames, 3);
  assert.equal(canvas.measured.perFrame.length, 3);
  assert.equal(
    canvas.measured.totalCanvas2dMeasureTextCalls,
    canvas.measured.perFrame.reduce(
      (sum, frame) => sum + frame.canvas2dMeasureTextCalls,
      0,
    ),
  );
  assert.ok(canvas.measured.totalCanvas2dMeasureTextCalls > 0);
  assert.equal(canvas.measured.callsSummary.available, true);
  assert.equal(canvas.capture.frames, 3);
  assert.ok(canvas.capture.totalCanvas2dMeasureTextCalls > 0);
  assert.equal(canvas.layoutMeasurerCalls.available, false);
  assert.equal(canvas.rootMeasurementCanvasCalls.available, false);
  assert.equal(canvas.textReuse.available, false);
  assert.equal("count" in canvas.layoutMeasurerCalls, false);
  assert.equal(report.instrumented.measureCalls.available, false);
  assert.equal(report.instrumented.gpu.texturesReused.available, false);
  assert.ok(report.instrumented.gpu.beginRenderPasses.median > 0);
  assert.equal(report.instrumented.g7.complete, false);
  assert.equal(
    report.instrumented.frameTiming.comparableToFrozenUninstrumentedBaseline,
    false,
  );
  assert.equal(
    report.instrumented.frameTiming.performanceGate,
    "not-applicable",
  );
  assert.match(report.instrumented.frameTiming.reason, /overhead/);
  assert.equal(report.plain.canvas2dMeasureText.available, false);
  assert.equal(report.plain.frameTiming.distribution, "uninstrumented");
  assert.equal(report.plain.frameTiming.performanceGate, "not-applicable");
  assert.equal(report.plain.g7.complete, false);

  const evidence = {
    queueWaitsDuringInstrumented: report.queueWaitsDuringInstrumented,
    pixelDifferingBytes: report.pixelDifferingBytes,
    setup: canvas.setup,
    warmup: {
      frames: canvas.warmup.frames,
      totalCanvas2dMeasureTextCalls:
        canvas.warmup.totalCanvas2dMeasureTextCalls,
      totalRasterMgCalls: canvas.warmup.totalRasterMgCalls,
      perFrame: canvas.warmup.perFrame,
    },
    measured: {
      frames: canvas.measured.frames,
      totalCanvas2dMeasureTextCalls:
        canvas.measured.totalCanvas2dMeasureTextCalls,
      totalRasterMgCalls: canvas.measured.totalRasterMgCalls,
      perFrame: canvas.measured.perFrame,
      callsSummary: canvas.measured.callsSummary,
    },
    capture: {
      frames: canvas.capture.frames,
      totalCanvas2dMeasureTextCalls:
        canvas.capture.totalCanvas2dMeasureTextCalls,
      totalRasterMgCalls: canvas.capture.totalRasterMgCalls,
      perFrame: canvas.capture.perFrame,
    },
    unavailable: {
      measureCalls: report.instrumented.measureCalls,
      layoutMeasurerCalls: canvas.layoutMeasurerCalls,
      rootMeasurementCanvasCalls: canvas.rootMeasurementCanvasCalls,
      textReuse: canvas.textReuse,
      texturesReused: report.instrumented.gpu.texturesReused,
      g7: report.instrumented.g7,
    },
    frameTiming: {
      instrumented: report.instrumented.frameTiming,
      uninstrumented: report.plain.frameTiming,
      instrumentedEndToEndMs: report.instrumented.endToEndMs,
      uninstrumentedEndToEndMs: report.plain.endToEndMs,
      performanceComparison: "not-a-gate",
    },
  };
  console.log(JSON.stringify(evidence, null, 2));
  console.log(
    "MEASURER PASSED: production FrameSource samples counted; pixels unchanged; timings not a gate. G7 is not complete.",
  );
} finally {
  await browser?.close();
  await server.close();
}
