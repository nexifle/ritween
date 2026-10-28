import assert from "node:assert/strict";
import { compareDecodedAudio } from "./media-comparison.mjs";
import { chromium } from "playwright-core";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import os from "node:os";
import { startServer } from "../cli/server.ts";
import { resolveProject } from "../cli/project.ts";
const repeats = Number(process.env.BENCH_REPEATS ?? 3);
if (!Number.isInteger(repeats) || repeats < 1)
  throw Error("BENCH_REPEATS must be positive.");
const root = process.cwd(),
  directory = resolve("artifacts/pipeline-benchmark");
await mkdir(directory, { recursive: true });
const results = [],
  warmups = [],
  validations = [];
const environment = {
  at: new Date().toISOString(),
  cpu: os.cpus()[0]?.model,
  logicalCpus: os.cpus().length,
  ramGiB: os.totalmem() / 2 ** 30,
  platform: os.platform(),
  release: os.release(),
  arch: os.arch(),
};
const browser = await chromium.launch({
  channel: process.env.CHROME_CHANNEL ?? "chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
environment.browser = browser.version();
const workloads = [
  { id: "demo", input: ".", demo: true, width: 1280, height: 720 },
  {
    id: "video9",
    input: process.argv[2] ?? "../video9",
    demo: false,
    width: 720,
    height: 1280,
  },
];
const fileName = (id, pipeline) => join(directory, `${id}-${pipeline}.mp4`);
async function persist() {
  await writeFile(
    join(directory, "results.json"),
    JSON.stringify(
      { environment, repeats, warmups, results, validations },
      null,
      2,
    ),
  );
}
function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    const chunks = [],
      errors = [];
    child.stdout.on("data", (b) => chunks.push(b));
    child.stderr.on("data", (b) => errors.push(b));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks).toString())
        : reject(
            Error(
              Buffer.concat(errors).toString() || `${command} exited ${code}`,
            ),
          ),
    );
  });
}
function decodedHash(file, track) {
  return new Promise((resolve, reject) => {
    const args =
      track === "audio"
        ? ["-map", "0:a:0", "-f", "f32le"]
        : ["-map", "0:v:0", "-f", "framemd5"];
    const child = spawn("ffmpeg", ["-v", "error", "-i", file, ...args, "-"]);
    const hash = createHash("sha256");
    let errors = "";
    child.stdout.on("data", (b) => hash.update(b));
    child.stderr.on("data", (b) => (errors += b));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(hash.digest("hex")) : reject(Error(errors)),
    );
  });
}
try {
  for (const workload of workloads) {
    const project = await resolveProject(workload.input, workload.demo, root);
    const { server, url } = await startServer({ runtimeRoot: root, project });
    const page = await browser.newPage({ acceptDownloads: true });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.goto(`${url}/__ritween/render`);
      await page.waitForFunction(() => !!window.ritween);
      const metadata = await page.evaluate(() => window.ritween.metadata());
      const session = await page.context().newCDPSession(page);
      const run = async (pipeline, cache) => {
        await page.evaluate(() => {
          window.pipelineBenchmarkBlob = null;
        });
        await session.send("HeapProfiler.collectGarbage");
        const result = await page.evaluate(
          async ({ pipeline, cache, width, height }) => {
            const { project } = await import("/@id/virtual:ritween-project");
            const { exportMp4: exportVideo } =
              await import("/src/engine/export/formats/mp4/export-mp4.ts");
            const { renderAudio } = await import("/src/engine/render/audio.ts");
            // A new weak-cache key every run, including warm runs. No old PCM survives GC.
            const composition = { ...project };
            let preparationMs = 0;
            if (cache === "warm") {
              const started = performance.now();
              await renderAudio(composition, [], 30);
              preparationMs = performance.now() - started;
            }
            const started = performance.now(),
              events = [];
            let firstFrameMs = null,
              last = started,
              maxHeartbeatDelayMs = 0;
            const heartbeat = setInterval(() => {
              const now = performance.now();
              maxHeartbeatDelayMs = Math.max(
                maxHeartbeatDelayMs,
                now - last - 25,
              );
              last = now;
            }, 25);
            try {
              const output = await exportVideo(composition, {
                width,
                height,
                fps: 30,
                pipeline,
                onStage: (stage) =>
                  events.push({
                    stage,
                    event: "start",
                    ms: performance.now() - started,
                  }),
                onStageComplete: (stage) =>
                  events.push({
                    stage,
                    event: "complete",
                    ms: performance.now() - started,
                  }),
                onProgress: (done) => {
                  if (done === 1) firstFrameMs = performance.now() - started;
                },
              });
              const elapsedMs = performance.now() - started;
              maxHeartbeatDelayMs = Math.max(
                maxHeartbeatDelayMs,
                performance.now() - last - 25,
              );
              window.pipelineBenchmarkBlob = output.blob;
              return {
                elapsedMs,
                firstFrameMs,
                maxHeartbeatDelayMs,
                preparationMs,
                events,
                frames: output.frames,
                duration: output.duration,
                bytes: output.blob.size,
              };
            } finally {
              clearInterval(heartbeat);
            }
          },
          { pipeline, cache, width: workload.width, height: workload.height },
        );
        assert.equal(result.frames, Math.ceil(metadata.duration * 30));
        assert.equal(result.duration, result.frames / 30);
        assert.deepEqual(errors, []);
        return {
          ...result,
          workload: workload.id,
          pipeline,
          cache,
          width: workload.width,
          height: workload.height,
          fps: 30,
        };
      };
      // Full unmeasured runs prime shaders, codecs, WAV fetches and both code paths.
      for (const pipeline of ["sequential", "parallel"]) {
        const result = await run(pipeline, "cold");
        warmups.push(result);
        console.log(
          `${workload.id} warmup ${pipeline}: ${(result.elapsedMs / 1000).toFixed(3)}s`,
        );
        await persist();
      }
      for (let round = 0; round < repeats; round++) {
        const caches = round % 2 ? ["warm", "cold"] : ["cold", "warm"];
        for (const cache of caches) {
          const modes =
            (round + (cache === "warm" ? 1 : 0)) % 2
              ? ["parallel", "sequential"]
              : ["sequential", "parallel"];
          for (const pipeline of modes) {
            const result = {
              round: round + 1,
              ...(await run(pipeline, cache)),
            };
            results.push(result);
            console.log(
              `${workload.id} ${cache} ${pipeline} ${round + 1}/${repeats}: ${(result.elapsedMs / 1000).toFixed(3)}s; first frame ${(result.firstFrameMs / 1000).toFixed(3)}s; heartbeat ${result.maxHeartbeatDelayMs.toFixed(1)}ms`,
            );
            await persist();
            if (round === repeats - 1 && cache === "cold") {
              const downloaded = page.waitForEvent("download");
              await page.evaluate(() => {
                const a = document.createElement("a");
                a.href = URL.createObjectURL(window.pipelineBenchmarkBlob);
                a.download = "benchmark.mp4";
                a.click();
              });
              const download = await downloaded;
              await download.saveAs(fileName(workload.id, pipeline));
              await download.delete();
            }
          }
        }
      }
    } finally {
      await page.close();
      await server.close();
    }
  }
  // Decode only after timing all samples, so validation does not compete with benchmarks.
  for (const workload of workloads) {
    const outputs = [];
    for (const pipeline of ["sequential", "parallel"]) {
      const file = fileName(workload.id, pipeline);
      const media = JSON.parse(
        await capture("ffprobe", [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_name,codec_type,width,height,nb_frames,duration:format=duration",
          "-of",
          "json",
          file,
        ]),
      );
      const video = media.streams.find((s) => s.codec_type === "video"),
        audio = media.streams.find((s) => s.codec_type === "audio");
      const expected = workload.id === "demo" ? 8 : 90;
      assert.equal(Number(video.nb_frames), expected * 30);
      assert.equal(Number(video.duration), expected);
      assert.equal(Number(audio.duration), expected);
      // Sequential decodes also verify that each entire saved stream is readable.
      const audioHash = await decodedHash(file, "audio"),
        videoHash = await decodedHash(file, "video");
      outputs.push({ pipeline, file, media, audioHash, videoHash });
    }
    validations.push({
      workload: workload.id,
      outputs,
      audioDifference: await compareDecodedAudio(
        outputs[0].file,
        outputs[1].file,
      ),
      audioIdentical: outputs[0].audioHash === outputs[1].audioHash,
      videoIdentical: outputs[0].videoHash === outputs[1].videoHash,
    });
    await persist();
    console.log(
      `Validated ${workload.id}: identical decoded audio=${validations.at(-1).audioIdentical}, video=${validations.at(-1).videoIdentical}`,
    );
  }
  const median = (values) => {
    const v = [...values].sort((a, b) => a - b),
      m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };
  const summary = [];
  for (const workload of workloads)
    for (const cache of ["cold", "warm"]) {
      const pair = { workload: workload.id, cache };
      for (const pipeline of ["sequential", "parallel"]) {
        const rows = results.filter(
          (r) =>
            r.workload === workload.id &&
            r.cache === cache &&
            r.pipeline === pipeline,
        );
        pair[pipeline] = {
          medianSeconds: median(rows.map((r) => r.elapsedMs)) / 1000,
          minSeconds: Math.min(...rows.map((r) => r.elapsedMs)) / 1000,
          maxSeconds: Math.max(...rows.map((r) => r.elapsedMs)) / 1000,
          medianFirstFrameSeconds:
            median(rows.map((r) => r.firstFrameMs)) / 1000,
          medianHeartbeatMs: median(rows.map((r) => r.maxHeartbeatDelayMs)),
          medianMiB: median(rows.map((r) => r.bytes)) / 2 ** 20,
        };
      }
      pair.parallelImprovementPercent =
        (1 - pair.parallel.medianSeconds / pair.sequential.medianSeconds) * 100;
      summary.push(pair);
    }
  await writeFile(
    join(directory, "results.json"),
    JSON.stringify(
      { environment, repeats, warmups, results, validations, summary },
      null,
      2,
    ),
  );
  const report = `# Audio/video pipeline benchmark\n\nMeasured ${environment.at} on ${environment.cpu}, ${environment.ramGiB.toFixed(0)} GiB RAM, ${environment.platform} ${environment.release}, Chrome ${environment.browser}.\n\n${repeats} measured runs per project/cache/pipeline combination, after one full warmup per pipeline. Workloads run one at a time in headless Chrome, at 30 FPS: demo 1280×720 (8 s), video9 working copy 720×1280 (90 s). Both modes use the same production render/encoding code; only scheduling differs. Pipeline order alternates between rounds and cache cases.\n\n| Workload | PCM cache | Sequential median (range) | Parallel median (range) | Parallel improvement | First submitted video frame, sequential / parallel |\n|---|---|---:|---:|---:|---:|\n${summary.map((r) => `| ${r.workload} | ${r.cache} | ${r.sequential.medianSeconds.toFixed(3)} s (${r.sequential.minSeconds.toFixed(3)}–${r.sequential.maxSeconds.toFixed(3)}) | ${r.parallel.medianSeconds.toFixed(3)} s (${r.parallel.minSeconds.toFixed(3)}–${r.parallel.maxSeconds.toFixed(3)}) | ${r.parallelImprovementPercent.toFixed(1)}% | ${r.sequential.medianFirstFrameSeconds.toFixed(3)} / ${r.parallel.medianFirstFrameSeconds.toFixed(3)} s |`).join("\n")}\n\nPositive improvement means parallel was faster. Cold means a fresh PCM cache key; source WAV bytes, browser/OS caches and shaders are already primed. Warm means the PCM mix is explicitly prepared before the timer, as a repeat export would reuse it. Every trial uses a new project object, and explicit GC between trials releases prior blobs/weak-cache entries. The cold result includes graph compilation, asset decoding, mixing, AAC, GPU/encoder setup, all video frames, flushing, muxing and cleanup. Module loading, warm-cache preparation and downloading/writing the file are outside the timer.\n\nAll samples check frame count and duration. Last cold outputs from each pipeline are saved and fully decoded after all timing runs.\n\n${validations.map((v) => `- ${v.workload}: frame/stream durations valid; decoded audio identical: ${v.audioIdentical}; decoded video frame hashes identical: ${v.videoIdentical}.`).join("\n")}\n\nNo hardware-encoding or peak-memory claim is made. Queue bounds are unchanged, but concurrent jobs can overlap allocations; the heartbeat measures event-loop delay, not end-to-end UI latency. Timing is workload/machine-specific, and these small repeated samples do not establish a confidence interval.\n\nRaw samples, stage timelines, warmups, environment, heartbeat delays and decode checks: [benchmarks/export-pipelines.json](benchmarks/export-pipelines.json). Decoded sample differences are recorded separately from exact hashes; use \`node scripts/diagnose-pipeline-audio.mjs ../video9\` to test repeatability with both independent and identical cached PCM.\n\nReproduce from the repository root: \`BENCH_REPEATS=${repeats} node scripts/benchmark-pipelines.mjs ../video9\`. Requires Chrome and ffmpeg/ffprobe.\n`;
  await mkdir("benchmarks", { recursive: true });
  await writeFile(
    "benchmarks/export-pipelines.json",
    JSON.stringify(
      { environment, repeats, warmups, results, validations, summary },
      null,
      2,
    ),
  );
  await writeFile("EXPORT_PIPELINE_BENCHMARK.md", report);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
}
