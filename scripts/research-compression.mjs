// Research harness: elementary H.264 only; does not modify production export.
import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import { resolveProject } from "../cli/project.mjs";
import { startServer } from "../cli/server.mjs";
import os from "node:os";
const root = process.cwd(),
  full = process.env.RESEARCH_FULL === "1",
  dir = `${root}/artifacts/compression-research${full ? "-full" : ""}`;
await mkdir(dir, { recursive: true });
const project = await resolveProject("../video9", false, root);
const { server, url } = await startServer({ runtimeRoot: root, project });
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const report = {
  at: new Date().toISOString(),
  cpu: os.cpus()[0].model,
  browser: browser.version(),
  segments: full ? [0] : [0, 27, 42, 56, 73, 85],
  secondsPerSegment: full ? 90 : 2,
  fps: 60,
  width: 1080,
  height: 1920,
  results: [],
};
try {
  const page = await browser.newPage();
  await page.goto(`${url}/__rimotion/render`);
  await page.waitForFunction(() => !!window.rimotion);
  const cases = [
    {
      id: "all-intra-27m",
      allIntra: true,
      bitrate: 27371520,
      latencyMode: "realtime",
    },
    { id: "gop-27m", bitrate: 27371520, latencyMode: "realtime" },
    { id: "gop-6m", bitrate: 6000000, latencyMode: "realtime" },
    { id: "gop-quality-6m", bitrate: 6000000, latencyMode: "quality" },
    {
      id: "gop-quality-qp24",
      bitrateMode: "quantizer",
      qp: 24,
      latencyMode: "quality",
    },
  ];
  const selected = full
    ? cases.filter((c) => c.id === "gop-quality-6m")
    : cases;
  for (let round = 1; round <= (full ? 1 : 3); round++)
    for (const test of round % 2 ? selected : [...selected].reverse()) {
      const result = await page
        .evaluate(
          async ({ test, segments, secondsPerSegment, projectModule }) => {
            const { Renderer } = await import("/src/engine/renderer.ts");
            const { project } = await import(projectModule);
            if (
              project.duration !== 90 ||
              project.resolution[0] !== 1080 ||
              project.resolution[1] !== 1920
            )
              throw Error("Unexpected project manifest");
            const config = {
              codec: "avc1.42002a",
              width: 1080,
              height: 1920,
              framerate: 60,
              latencyMode: test.latencyMode,
              bitrateMode: test.bitrateMode ?? "variable",
              avc: { format: "annexb" },
              ...(test.bitrate ? { bitrate: test.bitrate } : {}),
            };
            const support = await VideoEncoder.isConfigSupported(config);
            if (!support.supported) return { unsupported: true, config };
            let error;
            const chunks = [];
            let keys = 0,
              frames = 0;
            const timestamps = [];
            const encoder = new VideoEncoder({
              output(c) {
                const b = new Uint8Array(c.byteLength);
                c.copyTo(b);
                chunks.push(b);
                keys += c.type === "key";
                frames++;
                timestamps.push(c.timestamp);
              },
              error(e) {
                error = String(e);
              },
            });
            const start = performance.now();
            const canvas = new OffscreenCanvas(1080, 1920);
            let renderer;
            try {
              encoder.configure(config);
              renderer = await Renderer.create(canvas, project, (e) => {
                error = e;
              });
              const setupMs = performance.now() - start;
              let i = 0;
              for (const at of segments)
                for (let f = 0; f < secondsPerSegment * 60; f++, i++) {
                  if (error) throw Error(error);
                  renderer.render(at + f / 60);
                  await renderer.device.queue.onSubmittedWorkDone();
                  const frame = new VideoFrame(canvas, {
                    timestamp: Math.round((i * 1e6) / 60),
                    duration:
                      Math.round(((i + 1) * 1e6) / 60) -
                      Math.round((i * 1e6) / 60),
                  });
                  encoder.encode(frame, {
                    keyFrame: !!test.allIntra || f % 120 === 0,
                    ...(test.qp ? { avc: { quantizer: test.qp } } : {}),
                  });
                  frame.close();
                  while (encoder.encodeQueueSize >= 4) {
                    if (error) throw Error(error);
                    await new Promise((r) => setTimeout(r, 0));
                  }
                  if (i % 4 === 0) await new Promise((r) => setTimeout(r, 0));
                }
              await encoder.flush();
              if (error) throw Error(error);
              const ms = performance.now() - start;
              const blob = new Blob(chunks);
              const data = await new Promise((r) => {
                const reader = new FileReader();
                reader.onload = () => r(reader.result.split(",")[1]);
                reader.readAsDataURL(blob);
              });
              return {
                config,
                supportedConfig: support.config,
                projectName: project.name,
                projectDuration: project.duration,
                frames,
                keys,
                setupMs,
                ms,
                bytes: blob.size,
                monotonicTimestamps: timestamps.every(
                  (t, i) => !i || t > timestamps[i - 1],
                ),
                data,
              };
            } finally {
              encoder.close();
              renderer?.dispose();
            }
          },
          {
            test,
            segments: report.segments,
            secondsPerSegment: report.secondsPerSegment,
            projectModule: "/@fs" + project.manifest,
          },
        )
        .catch((e) => ({ error: String(e) }));
      if (result.data) {
        await writeFile(
          `${dir}/${test.id}.h264`,
          Buffer.from(result.data, "base64"),
        );
        delete result.data;
      }
      report.results.push({ round, ...test, ...result });
      await writeFile(`${dir}/results.json`, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report.results.at(-1)));
    }
} finally {
  await browser.close();
  await server.close();
}
