import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright";
const root = fileURLToPath(new URL("../", import.meta.url));
const executable = process.env.CLI_BINARY
  ? resolve(process.env.CLI_BINARY)
  : process.execPath;
const prefix = process.env.CLI_BINARY ? [] : [join(root, "bin/ritween.mjs")];
const directory = await mkdtemp(join(tmpdir(), "ritween-cli-test-"));
const artifacts = join(root, "artifacts/cli");
await mkdir(artifacts, { recursive: true });
function run(args, { cwd = directory, expected = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...prefix, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        assert.equal(code, expected, `${args.join(" ")}\n${stdout}\n${stderr}`);
        resolve({ stdout, stderr });
      } catch (error) {
        reject(error);
      }
    });
  });
}
const png = async (path) => {
  const data = await readFile(path);
  assert.equal(data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), data };
};
try {
  const help = await run(["--help"]);
  assert.match(help.stdout, /ritween frame/);
  const frame = join(artifacts, "frame.png");
  await rm(frame, { force: true });
  const result = JSON.parse(
    (
      await run([
        "preview",
        "--project",
        root,
        "--time",
        "5.2",
        "-o",
        frame,
        "--json",
      ])
    ).stdout,
  );
  assert.equal(result.time, 5.2);
  assert.equal(result.width, 1280);
  assert.equal(result.height, 720);
  const image = await png(frame);
  assert.equal(image.width, 1280);
  assert.ok(
    image.data.length > 10000,
    "Procedural frame must contain actual image data",
  );
  const overwrite = await run(
    ["frame", "--project", root, "-o", frame, "--json"],
    { expected: 1 },
  );
  assert.match(overwrite.stderr, /Output exists/);
  assert.ok(image.data.equals(await readFile(frame)));
  const indexed = join(artifacts, "indexed.png");
  await run([
    "frame",
    "--project",
    root,
    "--frame",
    "156",
    "--fps",
    "30",
    "-o",
    indexed,
    "--force",
    "--json",
  ]);
  assert.ok(
    image.data.equals(await readFile(indexed)),
    "Timestamp and frame-index renders must be identical",
  );
  await writeFile(
    join(directory, "manifest.tsx"),
    `import type { Project } from 'ritween'; import create from './scene.js'; export default {name:'External fixture',resolution:[320,180],aspectRatio:[16,9],duration:1,scenes:[{id:'external',name:'External',source:'scene.js',start:0,duration:1,create,transition:{type:'cut'}}]} satisfies Project;`,
  );
  await writeFile(
    join(directory, "scene.js"),
    `export default function create(){return {setup(){},render({encoder,target,localTime}){const p=encoder.beginRenderPass({colorAttachments:[{view:target.createView(),clearValue:{r:localTime,g:.2,b:.4,a:1},loadOp:'clear',storeOp:'store'}]});p.end();},dispose(){}}}`,
  );
  const external = join(artifacts, "external.png");
  const externalResult = JSON.parse(
    (await run(["frame", "--time", ".5", "-o", external, "--force", "--json"]))
      .stdout,
  );
  assert.equal(externalResult.project, "External fixture");
  assert.equal((await png(external)).width, 320);
  await run(
    ["frame", "--time", "2", "-o", join(artifacts, "invalid.png"), "--json"],
    { expected: 1 },
  );
  const timeout = await run(
    [
      "export",
      "--demo",
      "--timeout",
      "0.001",
      "-o",
      join(artifacts, "timeout.mp4"),
      "--json",
    ],
    { expected: 1 },
  );
  assert.match(timeout.stderr, /timed out/);
  const video = join(artifacts, "video.mp4");
  const exported = JSON.parse(
    (
      await run([
        "export",
        "--project",
        root,
        "--resolution",
        "720p",
        "--bitrate",
        "2000000",
        "--keyframe-interval",
        "1",
        "--fps",
        "30",
        "-o",
        video,
        "--force",
        "--json",
      ])
    ).stdout,
  );
  assert.equal(exported.bitrate, 2000000);
  assert.equal(exported.latencyMode, "quality");
  assert.equal(exported.keyFrameInterval, 1);
  assert.equal(exported.frames, 240);
  assert.equal(exported.duration, 8);
  assert.ok((await stat(video)).size > 100000);
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  try {
    const page = await browser.newPage();
    const media = await page.evaluate(
      async (bytes) => {
        const blob = new Blob([new Uint8Array(bytes)], { type: "video/mp4" });
        const video = document.createElement("video");
        video.src = URL.createObjectURL(blob);
        await new Promise((resolve, reject) => {
          video.onloadedmetadata = resolve;
          video.onerror = reject;
        });
        video.currentTime = 5.2;
        await new Promise((resolve, reject) => {
          video.onseeked = resolve;
          video.onerror = reject;
        });
        return {
          duration: video.duration,
          width: video.videoWidth,
          height: video.videoHeight,
          time: video.currentTime,
        };
      },
      Array.from(await readFile(video)),
    );
    assert.deepEqual(media, {
      duration: 8,
      width: 1280,
      height: 720,
      time: 5.2,
    });
  } finally {
    await browser.close();
  }
  // Start the persistent preview against a separate source tree; check UI and graceful shutdown.
  const preview = spawn(
    executable,
    [...prefix, "preview", "--project", directory, "--port", "0", "--json"],
    { cwd: directory, stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    const event = await new Promise((resolve, reject) => {
      let text = "";
      preview.stdout.on("data", (data) => {
        text += data;
        try {
          resolve(JSON.parse(text.trim()));
        } catch {}
      });
      preview.on("error", reject);
      preview.on("exit", (code) => reject(Error(`Preview exited: ${code}`)));
      setTimeout(
        () => reject(Error("Preview startup timed out")),
        20000,
      ).unref();
    });
    assert.match(await (await fetch(event.url)).text(), /src\/main.tsx/);
    const webBrowser = await chromium.launch({
      channel: "chrome",
      headless: true,
      args: ["--enable-unsafe-webgpu"],
    });
    try {
      const tab = await webBrowser.newPage();
      await tab.goto(event.url);
      await tab.getByText("Runtime connected", { exact: true }).waitFor();
      await tab
        .getByRole("heading", { name: "External fixture", exact: true })
        .waitFor();
      const manifestPath = join(directory, "manifest.tsx");
      await writeFile(
        manifestPath,
        (await readFile(manifestPath, "utf8")).replace(
          "External fixture",
          "Reloaded fixture",
        ),
      );
      await tab
        .getByRole("heading", { name: "Reloaded fixture", exact: true })
        .waitFor();
      await tab.getByText("Runtime connected", { exact: true }).waitFor();
      const canvas = tab.locator("canvas");
      assert.equal(await canvas.getAttribute("width"), "320");
    } finally {
      await webBrowser.close();
    }
    const closed = new Promise((resolve) => preview.on("exit", resolve));
    preview.kill("SIGINT");
    assert.equal(await closed, 0);
  } finally {
    if (preview.exitCode === null) preview.kill("SIGTERM");
  }
  const report = {
    executable,
    passed: [
      "help",
      "PNG timestamp preview",
      "PNG frame index determinism",
      "overwrite protection",
      "external TSX manifest with JS scene",
      "out-of-range rejection",
      "timeout cleanup",
      "240-frame MP4 export",
      "native playback and seeking",
      "web preview, external source reload, and signal shutdown",
    ],
  };
  await writeFile(
    join(artifacts, "validation.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
