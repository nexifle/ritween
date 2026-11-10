/**
 * Independent frozen-snapshot replay for the G0/G7 baseline
 * (docs/plans/declarative-layout-hardening.md §13.1: "preserve the baseline
 * artifact so it remains executable", §13.4: "If either batch cannot be
 * reproduced under the recorded environment, repair the benchmark environment").
 *
 * This is a separate process with its own browser launch, serving only the
 * frozen snapshot and the dependencies `npm ci` installed inside it — no live
 * checkout source, no live node_modules. It records what actually matched
 * (environment, font, tree/node counts, pass counts, pixel calibration) and the
 * honest per-metric difference between the baseline and replay summaries.
 *
 * Usage: node scripts/layout-baseline-replay.mjs <baseline-artifact-dir>
 * Writes replay-report.json into that directory. Timing is never expected to be
 * identical; pass counts and node counts are.
 */
import { chromium } from "playwright";
import { createServer } from "vite";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifySnapshotBytes } from "./layout-baseline-snapshot.mjs";
import {
  findEnvironmentDrift,
  recordRunEnvironment,
} from "./layout-baseline-reproducibility.mjs";

const baselineDir = process.argv[2];
if (!baselineDir) {
  console.error(
    "Usage: node scripts/layout-baseline-replay.mjs <baseline-artifact-dir>",
  );
  process.exit(2);
}
const baseline = JSON.parse(
  await readFile(join(baselineDir, "baseline-report.json"), "utf8"),
);
const snapshotRoot = join(baselineDir, "snapshot");
const manifest = JSON.parse(
  await readFile(join(snapshotRoot, "manifest.json"), "utf8"),
);
const { warmup } = baseline.environment.contract;
const { measured } = baseline.environment.contract;
// Replay uses the baseline's own per-fixture run count so the summaries are
// comparable; it is a separate browser launch, not a second batch.
const runsPerFixture = baseline.environment.contract.runs;

const beforeReplay = await verifySnapshotBytes(snapshotRoot, manifest);

const server = await createServer({
  configFile: false,
  root: snapshotRoot,
  logLevel: "warn",
  optimizeDeps: { noDiscovery: true },
  plugins: [
    {
      name: "replay-page",
      configureServer(s) {
        s.middlewares.use((req, res, next) => {
          if (req.url === "/favicon.ico") {
            res.statusCode = 204;
            res.end();
            return;
          }
          if (req.url !== "/") return next();
          res.setHeader("Content-Type", "text/html");
          res.end("<!doctype html><title>layout baseline replay</title>");
        });
      },
    },
  ],
  server: { host: "127.0.0.1", port: 0 },
});
await server.listen();
const browser = await chromium.launch({
  channel: process.env.CHROME_CHANNEL ?? "chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

const replayRuns = [];
for (const fixture of ["regression", "stress"]) {
  for (let index = 0; index < runsPerFixture; index++) {
    console.log(`replay fixture ${fixture} run ${index + 1}/${runsPerFixture}`);
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.goto(server.resolvedUrls.local[0]);
    const outcome = await page.evaluate(
      async ({ fixture, warmup, measured }) => {
        const { runHarness } =
          await import("/scripts/layout-baseline-harness.ts");
        return runHarness({ fixture, warmup, measured });
      },
      { fixture, warmup, measured },
    );
    const env = await page.evaluate(async () => {
      const adapter = await navigator.gpu.requestAdapter();
      return {
        userAgent: navigator.userAgent,
        adapter: adapter
          ? {
              vendor: adapter.info.vendor,
              architecture: adapter.info.architecture,
              device: adapter.info.device,
              description: adapter.info.description,
              isFallbackAdapter: adapter.info.isFallbackAdapter,
            }
          : null,
      };
    });
    await page.close();
    replayRuns.push({
      batch: "replay",
      fixture,
      run: index + 1,
      result: outcome.result,
      environment: recordRunEnvironment({
        browserVersion: browser.version(),
        ...env,
      }),
      errors,
    });
  }
}
await browser.close();
await server.close();
const afterReplay = await verifySnapshotBytes(snapshotRoot, manifest);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return Number.isInteger(middle)
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[Math.floor(middle)];
}
const values = (runs, fixture, path) =>
  runs.filter((r) => r.fixture === fixture).map((r) => path(r.result));

// The baseline batch summaries already are median-of-five per metric; the replay
// summary is the median of its own runs, so the difference is the honest
// baseline-vs-replay spread, never an assertion that timings match.
const METRICS = {
  endToEndMs: (r) => r.endToEndMs.median,
  endToEndMsP95: (r) => r.endToEndMs.p95,
  layoutCpuMicrobenchmarkMedianMs: (r) => r.layoutCpuMicrobenchmark.medianMs,
  layoutCpuMicrobenchmarkP95Ms: (r) => r.layoutCpuMicrobenchmark.p95Ms,
  beginRenderPasses: (r) => r.gpu.beginRenderPasses.median,
  measuredPhaseRenderTargetCreations: (r) =>
    r.gpu.measuredPhaseRenderTargetCreations,
};
const metricComparison = {};
for (const fixture of ["regression", "stress"]) {
  metricComparison[fixture] = {};
  for (const [metric, read] of Object.entries(METRICS)) {
    const baselineBatch1 = baseline.batchSummaries[0][fixture][metric].median;
    const baselineBatch2 = baseline.batchSummaries[1][fixture][metric].median;
    const replay = median(values(replayRuns, fixture, read));
    metricComparison[fixture][metric] = {
      baselineBatch1,
      baselineBatch2,
      replay,
      replayVsBatch1: Math.abs(replay - baselineBatch1),
      replayVsBatch2: Math.abs(replay - baselineBatch2),
    };
  }
}

// Identity comparisons: values a replay must match exactly, unlike timings.
const baselineRuns = baseline.runs;
const identityComparison = {};
for (const fixture of ["regression", "stress"]) {
  const recorded = baselineRuns.filter((r) => r.fixture === fixture);
  const first = recorded[0].result;
  const replay = replayRuns.find((r) => r.fixture === fixture).result;
  identityComparison[fixture] = {
    tree: {
      baseline: first.tree,
      replay: replay.tree,
      matches: JSON.stringify(first.tree) === JSON.stringify(replay.tree),
    },
    fixtureCounts: {
      baseline: first.fixtureCounts,
      replay: replay.fixtureCounts,
      matches:
        JSON.stringify(first.fixtureCounts) ===
        JSON.stringify(replay.fixtureCounts),
    },
    passCounts: {
      baseline: recorded.map((r) => r.result.gpu.beginRenderPasses.median),
      replay: values(
        replayRuns,
        fixture,
        (r) => r.gpu.beginRenderPasses.median,
      ),
      matches:
        new Set([
          ...recorded.map((r) => r.result.gpu.beginRenderPasses.median),
          ...values(replayRuns, fixture, (r) => r.gpu.beginRenderPasses.median),
        ]).size === 1,
    },
    pixelProof: {
      baseline: first.pixelProof,
      replay: replay.pixelProof,
      matches:
        JSON.stringify(first.pixelProof) === JSON.stringify(replay.pixelProof),
    },
    fontFaces: {
      baseline: first.fontProof.faces,
      replay: replay.fontProof.faces,
      matches:
        JSON.stringify(first.fontProof.faces) ===
        JSON.stringify(replay.fontProof.faces),
    },
    rasterProof: {
      baseline: first.fontProof.rasterProof,
      replay: replay.fontProof.rasterProof,
      matches:
        JSON.stringify(first.fontProof.rasterProof) ===
        JSON.stringify(replay.fontProof.rasterProof),
    },
  };
}

// Environment identity is compared across the baseline runs AND the replay runs
// with the same check the driver uses, so a browser/GPU/font change between the
// two captures is drift rather than "reproduced".
const crossRunDrift = findEnvironmentDrift([...baselineRuns, ...replayRuns]);
const mismatchedIdentities = [];
for (const [fixture, comparison] of Object.entries(identityComparison))
  for (const [key, value] of Object.entries(comparison))
    if (!value.matches) mismatchedIdentities.push(`${fixture} ${key}`);

const report = {
  generatedAt: new Date().toISOString(),
  baselineDirectory: baselineDir,
  replayContract: { warmup, measured, runsPerFixture },
  snapshotIntegrity: {
    beforeReplay,
    afterReplay,
    verified: beforeReplay.verified && afterReplay.verified,
    method:
      "manifest entries re-hashed from the frozen snapshot bytes before and after the replay browser session",
  },
  isolation: {
    servedRoot: snapshotRoot,
    dependencies: "npm ci inside the snapshot from its own lockfile",
    freshBrowser: true,
    liveCheckoutUsed: false,
  },
  environmentIdentity: {
    verified: crossRunDrift.length === 0,
    comparedRuns: baselineRuns.length + replayRuns.length,
    baselineBatches: baseline.environment.contract.batches,
    drift: crossRunDrift,
  },
  identityComparison,
  metricComparison,
  // Timing is expected to differ between captures; only identities must match.
  verdict: {
    replayable:
      beforeReplay.verified &&
      afterReplay.verified &&
      crossRunDrift.length === 0 &&
      mismatchedIdentities.length === 0,
    mismatchedIdentities,
    note: "Metric values are recorded per metric above and are not expected to be identical between captures; node counts, pass counts, font faces and pixel calibration are.",
  },
};
await writeFile(
  join(baselineDir, "replay-report.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report.verdict, null, 2));
console.log(JSON.stringify(metricComparison, null, 2));
if (!report.verdict.replayable) process.exitCode = 1;
