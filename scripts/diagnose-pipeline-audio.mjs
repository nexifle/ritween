/** Separate repeatability check, deliberately excluded from timing benchmarks. */
import { chromium } from "playwright-core";
import { startServer } from "../cli/server.mjs";
import { resolveProject } from "../cli/project.mjs";
import { mkdir, writeFile } from "node:fs/promises";
const root = process.cwd();
const project = await resolveProject(
  process.argv[2] ?? "../video9",
  false,
  root,
);
const { server, url } = await startServer({ runtimeRoot: root, project });
let browser;
try {
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL ?? "chrome",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage();
  await page.goto(`${url}/__rimotion/render`);
  await page.waitForFunction(() => !!window.rimotion);
  await page.exposeFunction("audioReport", (r) =>
    console.log(JSON.stringify(r)),
  );
  const results = await page.evaluate(async () => {
    const { project } = await import("/@id/virtual:rimotion-project");
    const { exportVideo } = await import("/src/engine/export.ts");
    const OriginalData = globalThis.AudioData,
      OriginalEncoder = globalThis.AudioEncoder;
    const composition = { ...project },
      results = [];
    let samples,
      chunks,
      timestamps,
      at = 0,
      reference;
    globalThis.AudioData = class extends OriginalData {
      constructor(options) {
        super(options);
        samples.set(options.data, at);
        at += options.data.length;
      }
    };
    function Encoder(init) {
      return new OriginalEncoder({
        ...init,
        output(chunk, meta) {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          chunks.push(data);
          timestamps.push(chunk.timestamp);
          init.output(chunk, meta);
        },
      });
    }
    Encoder.prototype = OriginalEncoder.prototype;
    Encoder.isConfigSupported =
      OriginalEncoder.isConfigSupported.bind(OriginalEncoder);
    globalThis.AudioEncoder = Encoder;
    const hash = async (data) =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
    try {
      for (const [pipeline, cache] of [
        ["sequential", "cold"],
        ["sequential", "cold"],
        ["parallel", "cold"],
        ["sequential", "warm"],
        ["parallel", "warm"],
      ]) {
        // First cold run seeds the reference project's PCM; fresh keys force subsequent cold mixes.
        const p =
          results.length === 0 || cache === "warm"
            ? composition
            : { ...project };
        samples = new Float32Array(
          Math.ceil((project.duration * 48000) / 1024) * 1024 * 2,
        );
        at = 0;
        chunks = [];
        timestamps = [];
        await exportVideo(p, { width: 720, height: 1280, fps: 30, pipeline });
        if (!reference) reference = samples.slice();
        let max = 0,
          squared = 0,
          changed = 0;
        for (let i = 0; i < at; i++) {
          const delta = samples[i] - reference[i];
          if (delta) changed++;
          max = Math.max(max, Math.abs(delta));
          squared += delta * delta;
        }
        const encoded = new Uint8Array(
          chunks.reduce((n, c) => n + c.length, 0),
        );
        let offset = 0;
        for (const c of chunks) {
          encoded.set(c, offset);
          offset += c.length;
        }
        const report = {
          pipeline,
          cache,
          pcmHash: await hash(samples.buffer),
          aacHash: await hash(encoded.buffer),
          maxPcmDifference: max,
          rmsPcmDifference: Math.sqrt(squared / at),
          changedPcmSamples: changed,
          pcmSamples: at,
          aacChunks: chunks.length,
          firstTimestamp: timestamps[0],
          lastTimestamp: timestamps.at(-1),
        };
        results.push(report);
        await window.audioReport(report);
      }
      return results;
    } finally {
      globalThis.AudioData = OriginalData;
      globalThis.AudioEncoder = OriginalEncoder;
    }
  });
  const first = results[0];
  for (const result of results) {
    if (
      result.aacChunks !== first.aacChunks ||
      result.firstTimestamp !== first.firstTimestamp ||
      result.lastTimestamp !== first.lastTimestamp
    )
      throw Error("Pipeline changed audio sample timing.");
    if (
      result.cache === "warm" &&
      (result.pcmHash !== first.pcmHash || result.aacHash !== first.aacHash)
    )
      throw Error("Pipeline changed encoding of identical PCM.");
    if (result.maxPcmDifference > 1e-5)
      throw Error(
        "Independent audio mix exceeded PCM repeatability tolerance.",
      );
  }
  await mkdir("artifacts/pipeline-benchmark", { recursive: true });
  await writeFile(
    "artifacts/pipeline-benchmark/audio-repeatability.json",
    JSON.stringify(results, null, 2),
  );
} finally {
  await browser?.close();
  await server.close();
}
