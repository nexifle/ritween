// Smoke gate for the G0 baseline harness: proves the font is really loaded, the
// device instrumentation survives every frame, the production frame path runs,
// and pixel calibration holds — before any full baseline batch is attempted.
// Small run (60 warmup + 10 measured) for both fixtures; writes to artifacts/.
import { chromium } from "playwright";
import { createServer } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const outDir = new URL(
  "../artifacts/declarative-layout-hardening/smoke/",
  import.meta.url,
);
await mkdir(outDir, { recursive: true });

const server = await createServer({
  configFile: false,
  root,
  logLevel: "warn",
  optimizeDeps: { noDiscovery: true },
  plugins: [
    {
      name: "smoke-page",
      configureServer(s) {
        s.middlewares.use((req, res, next) => {
          // Answer Chrome's favicon probe so a clean smoke has no 404 noise.
          if (req.url === "/favicon.ico") {
            res.statusCode = 204;
            res.end();
            return;
          }
          if (req.url !== "/") return next();
          res.setHeader("Content-Type", "text/html");
          res.end("<!doctype html><title>smoke</title>");
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

const failures = [];
/** One assertion block per contract so a failure names the broken invariant. */
function check(label, condition, detail) {
  if (condition) return;
  failures.push(`${label}: ${detail}`);
}

for (const fixture of ["regression", "stress"]) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(server.resolvedUrls.local[0]);
  const outcome = await page.evaluate(async (fixture) => {
    const { runHarness } = await import("/scripts/layout-baseline-harness.ts");
    return runHarness({ fixture, warmup: 60, measured: 10 });
  }, fixture);
  let i = 0;
  for (const frame of outcome.frames) {
    await writeFile(
      new URL(
        `smoke-${fixture}-t${String(frame.time).replace(".", "_")}-${i}.png`,
        outDir,
      ),
      Buffer.from(frame.pngBase64, "base64"),
    );
    i++;
  }
  const result = outcome.result;
  console.log(`\n=== ${fixture} ===`);
  console.log(JSON.stringify(result, null, 2));

  const faces = result.fontProof.faces;
  check(
    `${fixture} font`,
    faces.length === 2 && faces.every((face) => face.sha256MatchesFixture),
    JSON.stringify(faces),
  );
  const raster = result.fontProof.rasterProof;
  check(
    `${fixture} font rasterizes`,
    raster.width400 !== raster.fallbackWidth &&
      raster.width700 !== raster.fallbackWidth &&
      raster.width400 !== raster.width700,
    JSON.stringify(raster),
  );
  check(
    `${fixture} gpu passes nonzero`,
    result.gpu.beginRenderPasses.median > 0 &&
      result.gpu.beginRenderPasses.p95 > 0,
    JSON.stringify(result.gpu.beginRenderPasses),
  );
  check(
    `${fixture} texture creation counted`,
    result.gpu.renderTargetTexturesCreated > 0,
    String(result.gpu.renderTargetTexturesCreated),
  );
  check(
    `${fixture} microbenchmark measured`,
    result.layoutCpuMicrobenchmark.measureCalls > 0 &&
      result.layoutCpuMicrobenchmark.medianMs > 0,
    JSON.stringify(result.layoutCpuMicrobenchmark),
  );
  check(
    `${fixture} end-to-end measured`,
    result.endToEndMs.median > 0,
    JSON.stringify(result.endToEndMs),
  );
  check(
    `${fixture} pixel repeat identical`,
    result.pixelProof.repeatIdentical,
    String(result.pixelProof.repeatDifferingBytes),
  );
  // Static stress fixture must render identically at A and B; the animated
  // regression fixture must actually differ.
  check(
    `${fixture} pixel state contrast`,
    fixture === "regression"
      ? result.pixelProof.aVsBDiffer
      : !result.pixelProof.aVsBDiffer,
    String(result.pixelProof.aVsBDifferingBytes),
  );
  if (fixture === "stress")
    check(
      "stress layout node count",
      result.fixtureCounts.actualLayoutNodes ===
        result.fixtureCounts.expectedLayoutNodes,
      `${result.fixtureCounts.actualLayoutNodes} != ${result.fixtureCounts.expectedLayoutNodes}`,
    );
  check(`${fixture} page clean`, errors.length === 0, JSON.stringify(errors));
  await page.close();
}

await browser.close();
await server.close();

if (failures.length) {
  console.error(`\nSMOKE FAILED (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else
  console.log(
    "\nSMOKE PASSED: font, GPU instrumentation, frame path, pixel calibration",
  );
