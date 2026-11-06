/** Run an authored rules schedule in one public FrameSource/browser session.
 * node scripts/validate-rule-schedule.mjs --project PATH --rules PATH
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { createServer } from "vite";
const { values } = parseArgs({
  options: {
    project: { type: "string" },
    rules: { type: "string" },
    output: { type: "string", default: "artifacts/g4/schedule.json" },
  },
});
if (!values.project || !values.rules)
  throw Error("Requires --project manifest and --rules JSON.");
const root = fileURLToPath(new URL("../", import.meta.url));
const projectPath = resolve(values.project);
const rulesText = await readFile(values.rules, "utf8");
const server = await createServer({
  root,
  configFile: false,
  logLevel: "error",
  optimizeDeps: { noDiscovery: true },
  plugins: [
    {
      name: "rule-validation-page",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/") return next();
          res.setHeader("Content-Type", "text/html");
          res.end("<!doctype html><title>Rule validation</title>");
        });
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 0,
    fs: { allow: [root, dirname(projectPath)] },
  },
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
  await page.goto(server.resolvedUrls.local[0]);
  // Session ownership remains here; every scheduled time uses this one FrameSource.
  const report = await page.evaluate(
    async ({ projectPath, rulesText, runner, packageVersion }) => {
      const api = await import("/src/index.ts");
      const { validateRuleSchedule } = await import(runner);
      const manifest = await import(`/@fs/${projectPath}`);
      const project = manifest.project ?? manifest.default;
      const rules = api.parseRules(rulesText);
      const source = await api.FrameSource.create(project, {
        inspect: true,
        width: project.resolution[0],
        height: project.resolution[1],
      });
      try {
        const captures = [];
        const capture = async (time) => {
          const blob = await source.canvas.convertToBlob({ type: "image/png" });
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = "";
          for (const byte of bytes) binary += String.fromCharCode(byte);
          captures.push({ time, png: btoa(binary) });
        };
        const schedule = await validateRuleSchedule({
          rules,
          evaluateRules: api.evaluateRules,
          summarizeRuleSchedule: api.summarizeRuleSchedule,
          inspect: async (time) => {
            if (time < 0 || time > project.duration)
              throw Error(
                `Scheduled time ${time} is outside project duration.`,
              );
            await source.render(time);
            await capture(time);
            return api.buildInspectionDocument({
              packageVersion,
              project,
              frame: source.inspectFrame(),
            });
          },
        });
        const seekTimes =
          schedule.times.length > 1
            ? [schedule.times[0], schedule.times.at(-1), schedule.times[0]]
            : [];
        const seek = [];
        for (const time of seekTimes) {
          await source.render(time);
          const document = api.buildInspectionDocument({
            packageVersion,
            project,
            frame: source.inspectFrame(),
          });
          await capture(time);
          seek.push({
            pixels: captures.at(-1).png,
            time,
            geometry: JSON.stringify(document.scenes.map((s) => s.tree)),
          });
        }
        const seekEvidence = {
          times: seekTimes,
          sameSession: true,
          repeatedGeometryEqual:
            seek.length === 3 && seek[0].geometry === seek[2].geometry,
          distinctGeometry:
            seek.length === 3 && seek[0].geometry !== seek[1].geometry,
          repeatedPixelsEqual: seek.length === 3 && seek[0].pixels === seek[2].pixels,
          distinctPixels: seek.length === 3 && seek[0].pixels !== seek[1].pixels,
        };
        return {
          ...schedule,
          captures,
          fontProof: manifest.fontProof,
          environment: { browser: navigator.userAgent, gpu: (await navigator.gpu.requestAdapter())?.info },
          identity: { projectPath, packageVersion, project: project.name },
          method: "CPU assertions after real browser render; not raster proof",
          reviewerStatus: "not-reviewed",
          seekEvidence,
        };
      } finally {
        source.dispose();
      }
    },
    {
      projectPath,
      rulesText,
      runner: "/scripts/authoring-rule-checks.mjs",
      packageVersion: JSON.parse(
        await readFile(join(root, "package.json"), "utf8"),
      ).version,
    },
  );
  await mkdir(dirname(resolve(values.output)), { recursive: true });
  const captureDir = `${resolve(values.output)}.captures`;
  await mkdir(captureDir, { recursive: true });
  for (const [index, capture] of report.captures.entries()) {
    const path = join(captureDir, `${index}-${capture.time}.png`);
    await writeFile(path, Buffer.from(capture.png, "base64"));
    report.captures[index] = { time: capture.time, path, method: "WebGPU FrameSource canvas PNG", reviewerStatus: "not-reviewed" };
  }
  await writeFile(values.output, JSON.stringify(report, null, 2));
  if (report.failed) process.exitCode = 1;
  console.log(
    `Rule schedule: ${report.times.length} time(s), ${report.failed ? "FAIL" : "PASS"}; ${values.output}`,
  );
} finally {
  await browser?.close();
  await server.close();
}
