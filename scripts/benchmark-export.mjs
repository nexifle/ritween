import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
const repeats = Number(process.env.BENCH_REPEATS ?? 3);
if (!Number.isInteger(repeats) || repeats < 1)
  throw Error("BENCH_REPEATS must be a positive integer.");
const browser = await chromium.launch({
  channel: process.env.CHROME_CHANNEL ?? "chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const directory = new URL("../artifacts/", import.meta.url);
await mkdir(directory, { recursive: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1120 } });
const results = [];
try {
  await page.goto(process.env.BASE_URL ?? "http://localhost:5173");
  await page
    .getByText("Runtime connected", { exact: true })
    .waitFor({ timeout: 30000 });
  const environment = await page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter();
    const info = adapter.info;
    return {
      userAgent: navigator.userAgent,
      gpu: {
        vendor: info.vendor,
        architecture: info.architecture,
        device: info.device,
        description: info.description,
        isFallbackAdapter: info.isFallbackAdapter,
      },
      hardwareConcurrency: navigator.hardwareConcurrency,
    };
  });
  Object.assign(environment, {
    browserVersion: browser.version(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    ramGiB: os.totalmem() / 2 ** 30,
    mode: "Headless Chrome, WebGPU enabled; preview initialized and paused; exports run sequentially.",
  });
  const run = (options) =>
    page.evaluate(async (options) => {
      const { exportVideo } = await import("/src/engine/export.ts");
      const { project } = await import("/src/project/manifest.ts");
      const start = performance.now();
      const output = await exportVideo(project, options);
      const milliseconds = performance.now() - start;
      return {
        ...options,
        milliseconds,
        frames: output.frames,
        duration: output.duration,
        bytes: output.blob.size,
        exportFps: output.frames / (milliseconds / 1000),
        realtimeMultiple: output.duration / (milliseconds / 1000),
      };
    }, options);
  console.log("Environment:", JSON.stringify(environment));
  console.log("Warm-up: 720p30 (excluded)");
  const warmup = await run({ width: 1280, height: 720, fps: 30 });
  console.log(
    `Warm-up completed in ${(warmup.milliseconds / 1000).toFixed(3)}s`,
  );
  const presets = [
    [640, 360],
    [1280, 720],
    [1920, 1080],
  ].flatMap(([width, height]) =>
    [24, 30, 60].map((fps) => ({ width, height, fps })),
  );
  // Rotate preset order between rounds to reduce a fixed-order thermal bias.
  for (let round = 0; round < repeats; round++) {
    const ordered = [
      ...presets.slice((round * 3) % presets.length),
      ...presets.slice(0, (round * 3) % presets.length),
    ];
    for (const preset of ordered) {
      try {
        const result = { round: round + 1, ...(await run(preset)) };
        if (result.frames !== 8 * preset.fps || result.duration !== 8)
          throw Error("Export frame count or duration mismatch.");
        results.push(result);
        console.log(
          `${preset.width}x${preset.height} ${preset.fps}fps [${round + 1}/${repeats}]: ${(result.milliseconds / 1000).toFixed(3)}s, ${result.exportFps.toFixed(1)} export fps, ${result.realtimeMultiple.toFixed(2)}x realtime, ${(result.bytes / 2 ** 20).toFixed(2)} MiB`,
        );
      } catch (error) {
        results.push({ round: round + 1, ...preset, error: String(error) });
        console.log("FAILED", preset, String(error));
      }
      await writeFile(
        new URL("benchmark-export.json", directory),
        JSON.stringify({ environment, warmup, repeats, results }, null, 2),
      );
    }
  }
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const summary = presets.map((preset) => {
    const samples = results.filter(
      (r) => r.width === preset.width && r.fps === preset.fps && !r.error,
    );
    if (!samples.length) return { ...preset, error: "No successful runs" };
    const seconds = median(samples.map((r) => r.milliseconds / 1000));
    return {
      ...preset,
      successfulRuns: samples.length,
      medianSeconds: seconds,
      minSeconds: Math.min(...samples.map((r) => r.milliseconds / 1000)),
      maxSeconds: Math.max(...samples.map((r) => r.milliseconds / 1000)),
      exportFps: (8 * preset.fps) / seconds,
      realtimeMultiple: 8 / seconds,
      medianMiB: median(samples.map((r) => r.bytes / 2 ** 20)),
    };
  });
  await writeFile(
    new URL("benchmark-export.json", directory),
    JSON.stringify({ environment, warmup, repeats, summary, results }, null, 2),
  );
  const report = `# Export benchmark\n\nMeasured ${new Date().toISOString()} on ${environment.cpu}, ${environment.ramGiB.toFixed(0)} GiB RAM, ${environment.platform} ${environment.release}, Chrome ${environment.browserVersion}.\n\n${environment.mode} First 720p30 warm-up: ${(warmup.milliseconds / 1000).toFixed(3)} seconds (excluded from medians); ${repeats} runs per preset with rotating order. Timing includes codec capability check, GPU device and scene setup, all frame rendering/encoding, encoder flush, MP4 muxing, and cleanup. Module loading and download/disk writing are excluded. Each run exports the shipped eight-second composition using the unchanged production export function. The codec chooses its own hardware/software path; GPU adapter metadata does not prove hardware encoding.\n\n| Preset | Frames | Median time | Range | Export FPS | Realtime | Size |\n|---|---:|---:|---:|---:|---:|---:|\n${summary.map((s) => (s.error ? `| ${s.width}×${s.height} / ${s.fps} | — | Failed | — | — | — | — |` : `| ${s.width}×${s.height} / ${s.fps} | ${8 * s.fps} | ${s.medianSeconds.toFixed(3)} s | ${s.minSeconds.toFixed(3)}–${s.maxSeconds.toFixed(3)} s | ${s.exportFps.toFixed(1)} | ${s.realtimeMultiple.toFixed(2)}× | ${s.medianMiB.toFixed(2)} MiB |`)).join("\n")}\n\nRealtime is video duration divided by export time; values above 1 are faster than realtime. These measurements apply to this scene workload and machine; browser headless mode, thermals, GPU load, shader complexity and encoder implementations affect results. Successful runs assert frame count and exact duration; this benchmark does not independently decode each MP4. Use npm run test:browser for media playback/decoding validation. Raw measurements and environment are in artifacts/benchmark-export.json.\n\nReproduce with the Vite dev server running: npm run benchmark:export. Override BENCH_REPEATS, BASE_URL or CHROME_CHANNEL as needed.\n`;
  await writeFile(new URL("../BENCHMARK.md", import.meta.url), report);
  console.log("\nSummary:", JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
}
