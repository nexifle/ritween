/**
 * G0/G7 baseline driver (docs/plans/declarative-layout-hardening.md §13).
 *
 * Serves this checkout through Vite (same source paths candidates will use),
 * runs the harness module in a real WebGPU Chrome, and records:
 * - environment identity: browser, GPU adapter, font proof, source/build identity.
 * - per-run results: 60 warmup + >=300 measured frames per fixture.
 * - batch summaries as the median of the five per-run values, per §13.4.
 * - selected-frame PNGs (A→B→A) for pixel calibration.
 * Artifacts land under artifacts/declarative-layout-hardening/baseline/<stamp>/
 * (git-ignored). Every batch is served from a frozen snapshot of the checkout
 * whose dependencies are installed by `npm ci` inside the snapshot from its own
 * lockfile, so the artifact stays executable without the live checkout.
 *
 * The report separates claims by what was measured: `snapshotIntegrity` (frozen
 * bytes unchanged), `environmentIdentity` (one environment across all runs) and
 * `replay` (left unavailable here — scripts/layout-baseline-replay.mjs measures
 * an independent replay in a separate browser session).
 */
import { chromium } from "playwright";
import { createServer } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createFrozenSnapshot,
  sha256File,
  verifySnapshotBytes,
} from "./layout-baseline-snapshot.mjs";
import {
  findEnvironmentDrift,
  recordRunEnvironment,
} from "./layout-baseline-reproducibility.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const outDir = new URL(
  `../artifacts/declarative-layout-hardening/baseline/${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}/`,
  import.meta.url,
);
await mkdir(outDir, { recursive: true });

const WARMUP = Number(process.env.BASELINE_WARMUP ?? 60);
const MEASURED = Number(process.env.BASELINE_MEASURED ?? 300);
const RUNS = Number(process.env.BASELINE_RUNS ?? 5);
const BATCHES = Number(process.env.BASELINE_BATCHES ?? 2);
if (
  !Number.isInteger(WARMUP) ||
  WARMUP < 60 ||
  !Number.isInteger(MEASURED) ||
  MEASURED < 300 ||
  !Number.isInteger(RUNS) ||
  RUNS !== 5 ||
  !Number.isInteger(BATCHES) ||
  BATCHES !== 2
)
  throw Error(
    "G7 contract requires warmup>=60, measured>=300, exactly 5 runs per batch and exactly 2 batches; override via env only upward from these minima.",
  );

function gitIdentity() {
  try {
    const sha = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
    const status = execSync("git status --porcelain", { cwd: root })
      .toString()
      .trim();
    return { sha, dirtyTree: status.length > 0 };
  } catch (error) {
    return { sha: null, error: String(error) };
  }
}

// Freeze the executable snapshot FIRST (copied files hashed at the
// destination, dependencies installed inside the snapshot from its own
// lockfile), then serve it: /src and /tests inside the page resolve to the
// frozen copy, never the live checkout.
const snapshotRoot = join(outDir.pathname, "snapshot");
const snapshotManifest = await createFrozenSnapshot({
  checkoutRoot: root,
  snapshotDir: snapshotRoot,
});
console.log(
  `snapshot: ${snapshotRoot} (${Object.keys(snapshotManifest.files).length} files, ${snapshotManifest.dependencies.installedPackages} packages)`,
);
const snapshotIdentity = await verifySnapshotBytes(
  snapshotRoot,
  snapshotManifest,
);
if (!snapshotIdentity.verified)
  throw Error(
    `Frozen snapshot bytes do not match the manifest: ${snapshotIdentity.mismatches.join("; ")}`,
  );

const server = await createServer({
  configFile: false,
  root: snapshotRoot,
  logLevel: "warn",
  optimizeDeps: { noDiscovery: true },
  plugins: [
    {
      name: "baseline-page",
      configureServer(s) {
        s.middlewares.use((req, res, next) => {
          // Chrome probes /favicon.ico; answering 204 keeps the clean run free
          // of a 404 console entry that is otherwise indistinguishable from a
          // real load failure.
          if (req.url === "/favicon.ico") {
            res.statusCode = 204;
            res.end();
            return;
          }
          if (req.url !== "/") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            '<!doctype html><title>layout baseline</title><script type="module">globalThis.ready = true;</script>',
          );
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

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? sorted[0];
}

const environment = {
  browserVersion: browser.version(),
  userAgent: null,
  adapter: null,
  fontProof: null,
  git: gitIdentity(),
  contract: {
    warmup: WARMUP,
    measured: MEASURED,
    runs: RUNS,
    batches: BATCHES,
  },
};
environment.snapshot = {
  directory: snapshotRoot,
  manifest: "snapshot/manifest.json",
  manifestSha256: sha256File(join(snapshotRoot, "manifest.json")),
  files: snapshotManifest.files,
  dependencies: snapshotManifest.dependencies,
  identity: snapshotIdentity,
};

const runFixture = async (fixture, index, batch) => {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(server.resolvedUrls.local[0]);
  // Served by Vite so /src and /tests imports resolve to the served root.
  const harnessUrl = `/scripts/layout-baseline-harness.ts`;
  const outcome = await page.evaluate(
    async ({ fixture, warmup, measured, harnessUrl }) => {
      const { runHarness } = await import(harnessUrl);
      return runHarness({ fixture, warmup, measured });
    },
    { fixture, warmup: WARMUP, measured: MEASURED, harnessUrl },
  );
  // Save selected-frame PNGs for this run (A→B→A from harness pixelStates).
  let frameIndex = 0;
  for (const frame of outcome.frames) {
    const name = `fixture-${fixture}-batch${batch}-run${index + 1}-t${String(frame.time).replace(".", "_")}-${frameIndex}.png`;
    await writeFile(
      new URL(name, outDir),
      Buffer.from(frame.pngBase64, "base64"),
    );
    frameIndex++;
  }
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
  // Recorded per run, not once: the identity check compares each run, so a field
  // the runs never record would compare undefined to undefined and prove nothing.
  return {
    result: outcome.result,
    environment: recordRunEnvironment({
      browserVersion: browser.version(),
      ...env,
    }),
    errors,
  };
};

const batches = [];
for (let batch = 0; batch < BATCHES; batch++) {
  const runs = [];
  for (const fixture of ["regression", "stress"]) {
    for (let index = 0; index < RUNS; index++) {
      console.log(
        `batch ${batch + 1}/${BATCHES} fixture ${fixture} run ${index + 1}/${RUNS}`,
      );
      const run = await runFixture(fixture, index, batch + 1);
      runs.push({ batch: batch + 1, fixture, run: index + 1, ...run });
      if (run.errors.length)
        console.error(`page errors: ${run.errors.slice(0, 5).join("; ")}`);
    }
  }
  batches.push(runs);
}

// Gate statistics per §13.4: for every gated metric, each batch's summary is
// the median of its five run values; p95 of the five run medians is recorded
// alongside; noise is the absolute difference between the two unchanged
// batch summaries, computed per metric after both batches complete.
function runValues(runs, fixture, path) {
  return runs.filter((r) => r.fixture === fixture).map((r) => path(r.result));
}
// Batch summary per §13.4: median of the five run values. When the gated
// metric is itself a p95, the batch p95 summary is the MEDIAN OF THE FIVE
// PER-RUN P95 VALUES, never a percentile recomputed over run medians.
function gateSummary(values) {
  return { values, median: median(values) };
}
const batchSummaries = batches.map((runs, batch) => ({
  batch: batch + 1,
  regression: {
    endToEndMs: gateSummary(
      runValues(runs, "regression", (r) => r.endToEndMs.median),
    ),
    endToEndMsP95: gateSummary(
      runValues(runs, "regression", (r) => r.endToEndMs.p95),
    ),
    layoutCpuMicrobenchmarkMedianMs: gateSummary(
      runValues(runs, "regression", (r) => r.layoutCpuMicrobenchmark.medianMs),
    ),
    layoutCpuMicrobenchmarkP95Ms: gateSummary(
      runValues(runs, "regression", (r) => r.layoutCpuMicrobenchmark.p95Ms),
    ),
    beginRenderPasses: gateSummary(
      runValues(runs, "regression", (r) => r.gpu.beginRenderPasses.median),
    ),
    measuredPhaseRenderTargetCreations: gateSummary(
      runValues(
        runs,
        "regression",
        (r) => r.gpu.measuredPhaseRenderTargetCreations,
      ),
    ),
  },
  stress: {
    endToEndMs: gateSummary(
      runValues(runs, "stress", (r) => r.endToEndMs.median),
    ),
    endToEndMsP95: gateSummary(
      runValues(runs, "stress", (r) => r.endToEndMs.p95),
    ),
    layoutCpuMicrobenchmarkMedianMs: gateSummary(
      runValues(runs, "stress", (r) => r.layoutCpuMicrobenchmark.medianMs),
    ),
    layoutCpuMicrobenchmarkP95Ms: gateSummary(
      runValues(runs, "stress", (r) => r.layoutCpuMicrobenchmark.p95Ms),
    ),
    beginRenderPasses: gateSummary(
      runValues(runs, "stress", (r) => r.gpu.beginRenderPasses.median),
    ),
    measuredPhaseRenderTargetCreations: gateSummary(
      runValues(
        runs,
        "stress",
        (r) => r.gpu.measuredPhaseRenderTargetCreations,
      ),
    ),
  },
}));
// Noise per metric (§13.4): the absolute difference between the two unchanged
// batch summaries. This is a measurement, not a reproducibility verdict —
// reproducibility is verified separately from environment identity below.
const noise = {};
for (const fixture of ["regression", "stress"]) {
  noise[fixture] = {};
  for (const metric of Object.keys(batchSummaries[0][fixture])) {
    const a = batchSummaries[0][fixture][metric].median;
    const b = batchSummaries[1][fixture][metric].median;
    noise[fixture][metric] = {
      batch1: a,
      batch2: b,
      absoluteNoise: Math.abs(a - b),
    };
  }
}

environment.adapter = batches[0][0].environment.adapter;
environment.userAgent = batches[0][0].environment.userAgent;
// Font proof from the first recorded run; every run's faces are compared in the
// environment-identity check below, so one copy is the environment record.
environment.fontProof = batches[0][0].result.fontProof;

// Pixel calibration: decoded-RGBA equality for A→B→A, recorded BEFORE any
// candidate comparison. The harness decodes the pixels in the page and throws
// on a violated contract, so these values are the accepted calibration.
const pixelCalibration = {};
for (const fixture of ["regression", "stress"]) {
  const run = batches[0].find((r) => r.fixture === fixture && r.run === 1);
  pixelCalibration[fixture] = run ? run.result.pixelProof : null;
}
environment.pixelCalibration = pixelCalibration;

// Two separate claims, named for what each one actually measured (§13.4):
// - snapshotIntegrity: the frozen bytes still match the manifest after the runs.
//   This proves the artifact did not change; it does NOT prove replayability.
// - environmentIdentity: every run in both batches recorded the same browser,
//   adapter, user agent, font faces and raster probe, and no page errored.
// Replayability is measured by scripts/layout-baseline-replay.mjs in a separate
// browser session and recorded in replay-report.json; it is not claimed here.
const environmentDrift = findEnvironmentDrift(batches.flat());
const afterRunBytes = await verifySnapshotBytes(snapshotRoot, snapshotManifest);
const snapshotIntegrity = {
  verified: afterRunBytes.verified,
  files: afterRunBytes.files,
  mismatches: afterRunBytes.mismatches,
  method:
    "every manifest entry re-hashed from the frozen snapshot bytes after all runs completed",
};
const environmentIdentity = {
  verified: environmentDrift.length === 0,
  comparedRuns: batches.flat().length,
  independentBatches: BATCHES,
  fields: [
    "browserVersion",
    "userAgent",
    "adapter",
    "fontFaces",
    "rasterProof",
  ],
  method:
    "each run recorded its own browser version, adapter, user agent, font face hashes and raster probe in a freshly launched page; all runs in both batches compared and required error-free",
  drift: environmentDrift,
};
const replay = {
  available: false,
  reason:
    "replayability of the frozen snapshot is measured separately by scripts/layout-baseline-replay.mjs; see replay-report.json in this directory",
};
if (!snapshotIntegrity.verified)
  throw Error(
    `Frozen snapshot bytes changed during the run: ${snapshotIntegrity.mismatches.join("; ")}`,
  );
if (!environmentIdentity.verified)
  throw Error(
    `Baseline runs did not share one environment; repair the environment before applying any gate: ${environmentDrift.join(" | ")}`,
  );

environment.snapshot.integrity = snapshotIntegrity;
environment.environmentIdentity = environmentIdentity;
environment.replay = replay;

const report = {
  generatedAt: new Date().toISOString(),
  environment,
  batchSummaries,
  noise,
  snapshotIntegrity,
  environmentIdentity,
  replay,
  runs: batches.flatMap((runs, batch) =>
    runs.map((run) => ({ batch: batch + 1, ...run })),
  ),
};
await writeFile(
  new URL("baseline-report.json", outDir),
  JSON.stringify(report, null, 2),
);
console.log(`wrote ${new URL("baseline-report.json", outDir).pathname}`);
console.log(JSON.stringify(batchSummaries, null, 2));

await browser.close();
await server.close();
