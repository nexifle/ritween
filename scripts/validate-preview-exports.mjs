import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { nodeCli } from "./node-cli.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = join(root, "artifacts/preview-exports");
await mkdir(artifacts, { recursive: true });
const directory = await mkdtemp(join(artifacts, "run-"));
const manifest = join(directory, "manifest.js");
await writeFile(
  manifest,
  `import create from './scene.js';
export default { name: 'Backend export fixture', duration: 2, resolution: [64,64], aspectRatio: [1,1],
  settings: { version: 1, export: { resolution: [64,64], fps: 24, bitrate: 500000 } },
  scenes: [{ id: 'fixture', name: 'Fixture', start: 0, duration: 2, create, transition: { type: 'cut' } }] };`,
);
await writeFile(
  join(directory, "scene.js"),
  `export default function create() { return {
  async setup() { await new Promise(resolve => setTimeout(resolve, 1500)); },
  render({encoder,target}) { const pass = encoder.beginRenderPass({colorAttachments:[{view:target.createView(),
    clearValue:{r:0.1,g:0.6,b:0.3,a:1},loadOp:'clear',storeOp:'store'}]}); pass.end(); }, dispose() {}
}; }`,
);
const cli = process.env.CLI_BINARY
  ? nodeCli(resolve(process.env.CLI_BINARY))
  : { command: process.execPath, args: [join(root, "bin/ritween.mjs")] };
let child;
let url;
let stderr = "";
async function start() {
  stderr = "";
  child = spawn(
    cli.command,
    [
      ...cli.args,
      "preview",
      directory,
      "--port",
      "0",
      "--json",
      "--channel",
      process.env.CHROME_CHANNEL ?? "chrome",
    ],
    {
      cwd: directory,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const process_ = child;
  process_.stderr.on("data", (data) => {
    stderr += data;
  });
  url = await new Promise((done, reject) => {
    let text = "";
    const timer = setTimeout(
      () => reject(Error(`Server startup timed out: ${stderr}`)),
      30_000,
    );
    process_.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    process_.once("exit", (code) => {
      clearTimeout(timer);
      reject(Error(`Server exited ${code}: ${stderr}`));
    });
    process_.stdout.on("data", (data) => {
      text += data;
      for (const line of text.split("\n")) {
        try {
          const event = JSON.parse(line);
          if (event.url) {
            clearTimeout(timer);
            done(event.url);
            return;
          }
        } catch {}
      }
    });
  });
}
async function stop(signal = "SIGTERM") {
  const process_ = child;
  child = undefined;
  if (!process_ || process_.exitCode !== null || process_.signalCode !== null)
    return;
  const exited = once(process_, "exit");
  const timer = setTimeout(() => process_.kill("SIGKILL"), 30_000);
  process_.kill(signal);
  try {
    const [code, received] = await exited;
    if (signal !== "SIGKILL")
      assert.equal(code, 0, `Shutdown failed (${received}): ${stderr}`);
  } finally {
    clearTimeout(timer);
  }
}
async function until(check, description) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw Error(`Timed out: ${description}\n${stderr}`);
}
async function jobs() {
  return (await (await fetch(`${url}/__ritween/exports`)).json()).jobs;
}
const cache = join(
  homedir(),
  ".ritween/exports",
  createHash("sha256")
    .update(await realpath(manifest))
    .digest("hex"),
);
const browser = await chromium.launch({
  channel: process.env.CHROME_CHANNEL ?? "chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
try {
  await start();
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1440, height: 1000 },
  });
  await context.addInitScript(() => {
    window.exportEncoderCreations = 0;
    const Native = window.VideoEncoder;
    if (Native)
      window.VideoEncoder = new Proxy(Native, {
        construct(Target, args) {
          window.exportEncoderCreations++;
          return Reflect.construct(Target, args);
        },
      });
  });
  let page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page
    .getByRole("button", { name: "Export Video", exact: true })
    .waitFor();
  const settingsTab = page.getByRole("tab", { name: "Settings", exact: true });
  await settingsTab.focus();
  await page.keyboard.press("End");
  assert.equal(
    await page
      .getByRole("tab", { name: /^Exports/ })
      .getAttribute("aria-selected"),
    "true",
  );
  await page.keyboard.press("Home");
  assert.equal(await settingsTab.getAttribute("aria-selected"), "true");
  const compactLayout = () =>
    page
      .getByRole("tabpanel", { name: "Settings", exact: true })
      .evaluate((element) => {
        const content = element.firstElementChild;
        return {
          height: element.clientHeight,
          content: content.getBoundingClientRect().height,
          scroll: element.scrollHeight,
        };
      });
  await until(async () => {
    const layout = await compactLayout();
    return Math.abs(layout.height - layout.content) <= 2;
  }, "export panel fits its content instead of reserving empty space");
  const compact = await compactLayout();
  assert.ok(
    compact.scroll <= compact.height + 1,
    "Default settings need no scrolling",
  );
  const encoding = page.locator("summary").filter({ hasText: "Encoding" });
  await encoding.click();
  await until(async () => {
    const layout = await compactLayout();
    return (
      layout.height > compact.height + 50 &&
      Math.abs(layout.height - layout.content) <= 2
    );
  }, "export panel grows with encoding controls");
  await page.screenshot({
    path: join(directory, "encoding.png"),
    fullPage: true,
  });
  await encoding.click();
  await until(async () => {
    const layout = await compactLayout();
    return Math.abs(layout.height - compact.height) <= 2;
  }, "closing encoding returns space to scene source");
  await page
    .getByRole("button", { name: "About exports", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "About exports", exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.getByText("Runtime connected", { exact: true }).waitFor();
  await page.screenshot({
    path: join(directory, "settings.png"),
    fullPage: true,
  });
  const submitted = page.waitForResponse(
    (response) =>
      response.url().endsWith("/__ritween/exports") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Export Video", exact: true }).click();
  const created = await (await submitted).json();
  const id = created.job.id;
  assert.equal(await page.evaluate(() => window.exportEncoderCreations), 0);
  await page.getByRole("progressbar", { name: "Export progress" }).waitFor();
  await page.screenshot({
    path: join(directory, "running.png"),
    fullPage: true,
  });
  await page.reload();
  await page.getByRole("tab", { name: /^Exports/ }).click();
  await page.locator(`[data-export-id="${id}"]`).waitFor();
  await page.close();
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page
    .getByText("Your video is ready", { exact: true })
    .waitFor({ timeout: 120_000 });
  const completed = (await jobs()).find((job) => job.id === id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.done, 48);
  assert.equal(completed.percent, 100);
  assert.ok(completed.bytes > 0);
  assert.equal(
    await page.evaluate(() => window.exportEncoderCreations),
    0,
    "The user's tab must never create an export encoder",
  );
  const downloading = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download MP4", exact: true }).click();
  const saved = join(directory, "downloaded.mp4");
  await (await downloading).saveAs(saved);
  const bytes = await readFile(saved);
  assert.equal(bytes.subarray(4, 8).toString(), "ftyp");
  const playback = await page.evaluate(async (id) => {
    const blob = await (await fetch(`/__ritween/exports/${id}/file`)).blob();
    const video = document.createElement("video");
    video.src = URL.createObjectURL(blob);
    try {
      await new Promise((done, reject) => {
        video.onloadedmetadata = done;
        video.onerror = () => reject(Error("Export did not decode"));
      });
      return {
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
      };
    } finally {
      URL.revokeObjectURL(video.src);
    }
  }, id);
  assert.equal(playback.duration, 2);
  assert.equal(playback.width, 64);
  await page.getByText("Runtime connected", { exact: true }).waitFor();
  await page.screenshot({
    path: join(directory, "completed.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await page.screenshot({
    path: join(directory, "completed-light.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await page.setViewportSize({ width: 1100, height: 800 });
  await until(async () => {
    const layout = await compactLayout();
    return Math.abs(layout.height - layout.content) <= 2;
  }, "smaller sidebar retains the content height");
  await page.screenshot({
    path: join(directory, "completed-narrow.png"),
    fullPage: true,
  });
  const downloadButton = await page
    .getByRole("link", { name: "Download MP4", exact: true })
    .boundingBox();
  const panel = await page
    .getByRole("tabpanel", { name: "Settings", exact: true })
    .boundingBox();
  assert.ok(
    downloadButton &&
      panel &&
      downloadButton.y >= panel.y &&
      downloadButton.y + downloadButton.height <= panel.y + panel.height + 1,
    "Primary download remains visible in a smaller sidebar",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });

  // Unexpected termination leaves completed files recoverable on the next preview.
  await stop("SIGKILL");
  await start();
  await page.goto(url);
  await page.getByRole("tab", { name: /^Exports/ }).click();
  await page
    .locator(`[data-export-id="${id}"]`)
    .getByText(/Recovered/)
    .waitFor();
  await page.getByText("Runtime connected", { exact: true }).waitFor();
  await page.screenshot({
    path: join(directory, "recovered-files.png"),
    fullPage: true,
  });
  assert.equal(
    (await fetch(`${url}/__ritween/exports/${id}/file`)).status,
    200,
  );
  await page
    .locator(`[data-export-id="${id}"]`)
    .getByRole("button", { name: /^Delete / })
    .click();
  await until(
    async () => !(await jobs()).some((job) => job.id === id),
    "manual artifact deletion",
  );

  // Cancel a real headless job and prove that the renderer queue remains usable.
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Export Video", exact: true }).click();
  const active = await until(
    async () => (await jobs()).find((job) => job.status === "running"),
    "headless job startup",
  );
  const cancelled = await fetch(
    `${url}/__ritween/exports/${active.id}/cancel`,
    { method: "POST" },
  );
  assert.equal(cancelled.status, 200);
  await until(
    async () =>
      (await jobs()).find((job) => job.id === active.id)?.status ===
      "cancelled",
    "headless cancellation",
  );
  assert.notEqual(
    (await fetch(`${url}/__ritween/exports/${active.id}/file`)).status,
    200,
  );
  await page.getByRole("button", { name: "Export Video", exact: true }).click();
  await until(
    async () => (await jobs()).some((job) => job.status === "completed"),
    "export after cancellation",
  );
  await page.screenshot({
    path: join(directory, "recovered-and-reexported.png"),
    fullPage: true,
  });
  await stop();
  assert.deepEqual(
    await readdir(cache),
    [],
    "Graceful shutdown removes all session artifacts",
  );
  assert.ok(
    (await readFile(saved)).length > 0,
    "The user's downloaded copy is not deleted",
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        directory,
        playback,
        checks: [
          "real CLI",
          "compact settings without scrolling",
          "keyboard tab navigation and contextual help",
          "light/dark and smaller sidebar layouts",
          "no tab-side encoding",
          "refresh and closed-tab survival",
          "MP4 download/playback",
          "crash recovery",
          "manual deletion",
          "cancellation",
          "queue reuse",
          "graceful cleanup",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await stop();
  await browser.close();
}
