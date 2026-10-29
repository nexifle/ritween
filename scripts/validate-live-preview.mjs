import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { nodeCli } from "./node-cli.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = join(root, "artifacts/live-preview");
await mkdir(artifacts, { recursive: true });
const directory = await mkdtemp(join(artifacts, "consumer-"));
const cli = process.env.CLI_BINARY
  ? nodeCli(resolve(process.env.CLI_BINARY))
  : { command: process.execPath, args: [join(root, "bin/ritween.mjs")] };
const manifest = (name = "Live fixture", duration = 4) => `export default {
  name: ${JSON.stringify(name)}, resolution: [320,180], aspectRatio: [16,9], duration: ${duration},
  scenes: [{id:"scene",name:"Scene",source:"scene.js",start:0,duration:${duration},create,transition:{type:"cut"}}]
}; import create from "./scene.js";`;
const helper = (green, wait = 0, invalid = false) =>
  `export const green = ${green}; export const wait = ${wait}; export const invalid = ${invalid};`;
await writeFile(join(directory, "manifest.js"), manifest());
await writeFile(join(directory, "helper.js"), helper(0.2));
await writeFile(
  join(directory, "scene.js"),
  `import {green,wait,invalid} from "./helper.js";
export default function create() { return {
  async setup() {
    globalThis.liveSetups = (globalThis.liveSetups ?? 0) + 1;
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    if (invalid) throw Error("Fixture setup failed");
  },
  render({encoder,target,localTime}) {
    const pass = encoder.beginRenderPass({colorAttachments:[{view:target.createView(),clearValue:{r:localTime/4,g:green,b:0.4,a:1},loadOp:"clear",storeOp:"store"}]}); pass.end();
  },
  dispose() { globalThis.liveDisposals = (globalThis.liveDisposals ?? 0) + 1; }
}; }`,
);
const child = spawn(
  cli.command,
  [...cli.args, "preview", directory, "--port", "0"],
  {
    cwd: directory,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let output = "";
let stderr = "";
child.stderr.on("data", (data) => {
  stderr += data;
});
let browser;
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error(`Preview startup timed out: ${stderr}`)),
      30000,
    );
    child.stdout.on("data", (data) => {
      output += data;
      const address = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (address) {
        clearTimeout(timer);
        resolve(address);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(Error(`Preview exited ${code}: ${stderr}`));
    });
  });
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL ?? "chrome",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.error("Browser:", message.text());
  });
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Play"]')?.disabled === false,
  );
  const token = await page.evaluate(
    () => (globalThis.liveDocument = crypto.randomUUID()),
  );
  const scrubber = page.getByRole("slider", { name: "Playback scrubber" });
  await scrubber.fill("1.5");
  await page.getByRole("slider", { name: "Preview volume" }).fill("-18");
  const canvas = page.locator("canvas").first();
  const pixel = async () => {
    const png = await canvas.screenshot();
    return page.evaluate(
      async (bytes) => {
        const image = await createImageBitmap(
          new Blob([new Uint8Array(bytes)], { type: "image/png" }),
        );
        const target = document.createElement("canvas");
        target.width = image.width;
        target.height = image.height;
        const context = target.getContext("2d");
        context.drawImage(image, 0, 0);
        image.close();
        return [
          ...context.getImageData(
            Math.floor(target.width / 2),
            Math.floor(target.height / 2),
            1,
            1,
          ).data,
        ];
      },
      [...png],
    );
  };
  const waitFor = async (condition, label) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await delay(50);
    }
    await page.screenshot({ path: join(artifacts, "failure.png") });
    throw Error(
      `Timed out: ${label}\n${stderr}\n${errors.join("\n")}\n${await page.locator("body").innerText()}`,
    );
  };
  const expectGreen = (green) =>
    waitFor(
      async () => Math.abs((await pixel())[1] - green * 255) < 3,
      `green ${green}`,
    );
  const expectReady = () =>
    page.waitForFunction(
      () => document.querySelector('[aria-label="Play"]')?.disabled === false,
    );
  await expectGreen(0.2);
  await page.screenshot({ path: join(artifacts, "before.png") });
  await writeFile(join(directory, "helper.js"), helper(0.8));
  await expectGreen(0.8);
  await expectReady();
  assert.equal(await scrubber.inputValue(), "1.5");
  assert.equal(
    await page.getByRole("slider", { name: "Preview volume" }).inputValue(),
    "-18",
  );
  assert.equal(
    await page.evaluate(() => globalThis.liveDocument),
    token,
    "Code edits must not reload the document",
  );

  const sceneCode = await readFile(join(directory, "scene.js"), "utf8");
  await writeFile(
    join(directory, "scene.js"),
    sceneCode.replace("g:green", "g:green*0.5"),
  );
  await expectGreen(0.4);
  await expectReady();
  await waitFor(
    async () =>
      (
        await page.locator("[data-scene-source]").first().textContent()
      ).includes("green*0.5"),
    "source inspector updates",
  );
  await writeFile(join(directory, "scene.js"), sceneCode);
  await expectGreen(0.8);
  await expectReady();

  await writeFile(join(directory, "helper.js"), helper(0.1, 0, true));
  await page.getByText("Fixture setup failed", { exact: true }).waitFor();
  await expectGreen(0.8);
  await writeFile(join(directory, "helper.js"), helper(0.6));
  await expectGreen(0.6);
  await expectReady();

  await writeFile(join(directory, "helper.js"), "export const green = ;");
  await page.getByText(/Project update failed/).waitFor();
  await writeFile(join(directory, "helper.js"), helper(0.4));
  await expectGreen(0.4);
  await expectReady();

  const setups = await page.evaluate(() => globalThis.liveSetups);
  await writeFile(join(directory, "helper.js"), helper(0.1, 800));
  await page.waitForFunction(
    (previous) => globalThis.liveSetups > previous,
    setups,
  );
  await writeFile(join(directory, "helper.js"), helper(0.9));
  await expectGreen(0.9);
  await expectReady();
  await delay(900);
  await expectGreen(0.9);

  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForFunction(
    () =>
      Number(document.querySelector('[aria-label="Playback scrubber"]').value) >
      1.6,
  );
  await writeFile(join(directory, "helper.js"), helper(0.7));
  await expectGreen(0.7);
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Pause"]')?.disabled === false,
  );
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  assert.ok(
    Number(await scrubber.inputValue()) > 1.6,
    "Playing updates must not reset the clock",
  );
  await scrubber.fill("1.5");

  await writeFile(
    join(directory, "manifest.js"),
    manifest("Updated fixture", 1),
  );
  await page.getByText("Updated fixture", { exact: true }).waitFor();
  await expectReady();
  assert.equal(await scrubber.inputValue(), "1");
  assert.equal(await page.evaluate(() => globalThis.liveDocument), token);
  await waitFor(
    async () =>
      page.evaluate(
        () => globalThis.liveSetups - globalThis.liveDisposals === 1,
      ),
    "one live scene after replacements",
  );
  const response = await page.request.patch(`${url}/__ritween/settings`, {
    data: { type: "update-export-settings", patch: { fps: 60 } },
  });
  assert.equal(response.ok(), true);
  await waitFor(
    async () => (await scrubber.getAttribute("step")) === String(1 / 60),
    "settings update without reload",
  );
  assert.equal(await page.evaluate(() => globalThis.liveDocument), token);

  const setupCount = await page.evaluate(() => globalThis.liveSetups);
  await writeFile(join(directory, "helper.js"), helper(0.7, 2000));
  // Wait for this specific revision, not the previous enabled transport.
  await page.waitForFunction(
    (previous) => globalThis.liveSetups > previous,
    setupCount,
  );
  await expectReady();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export Video", exact: true }).click();
  await page.getByRole("region", { name: "Export activity" }).waitFor();
  await writeFile(
    join(directory, "scene.js"),
    sceneCode + "\n// Deferred fixture\n",
  );
  await writeFile(
    join(directory, "manifest.js"),
    manifest("Deferred fixture", 1),
  );
  await waitFor(
    async () =>
      (
        await page.locator("[data-scene-source]").first().textContent()
      ).includes("Deferred fixture"),
    "HMR arrives during export",
  );
  assert.equal(
    await page
      .getByRole("heading", { name: "Updated fixture", exact: true })
      .count(),
    1,
    "Export must keep its original composition",
  );
  const exported = await download;
  await exported.saveAs(join(artifacts, "snapshot-export.mp4"));
  await page
    .getByRole("heading", { name: "Deferred fixture", exact: true })
    .waitFor();
  await expectReady();
  assert.equal(await page.evaluate(() => globalThis.liveDocument), token);
  await page.screenshot({ path: join(artifacts, "after.png") });
  // Syntax errors are expected during the recovery case; other runtime errors are not.
  assert.deepEqual(
    errors.filter(
      (message) =>
        !/Unexpected token|Failed to fetch dynamically imported module|Importing a module script failed/.test(
          message,
        ),
    ),
    [],
  );
  console.log(
    JSON.stringify(
      {
        status: "passed",
        directory,
        checks: [
          "imported helper and scene visual updates",
          "source inspector update",
          "playback resumes after update",
          "export snapshot and deferred update",
          "playhead and volume preservation",
          "setup failure recovery",
          "syntax error recovery",
          "latest revision wins",
          "duration clamp",
          "scene disposal",
          "settings HMR",
          "no document reload",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  const closed = new Promise((resolve) => child.once("exit", resolve));
  if (child.exitCode === null) {
    child.kill("SIGINT");
    await closed;
  }
}
