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
import { nodeCli } from "./node-cli.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const cli = process.env.CLI_BINARY
  ? nodeCli(resolve(process.env.CLI_BINARY))
  : { command: process.execPath, args: [join(root, "bin/ritween.mjs")] };
const executable = cli.command;
const prefix = cli.args;
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
  const textExport = await run([
    "export",
    "--resolution",
    "320x180",
    "--fps",
    "24",
    "-o",
    join(artifacts, "text-progress.mp4"),
    "--force",
  ]);
  assert.match(textExport.stdout, /^Export completed in [\d.]+s\n/);
  assert.match(textExport.stdout, /\n  Output  .*text-progress\.mp4\n/);
  assert.match(textExport.stdout, /\n  Video   320×180 · 24 FPS · 1s\n/);
  assert.match(textExport.stdout, /\n  Frames  24\n/);
  assert.match(textExport.stderr, /Export · Preparing renderer/);
  assert.match(textExport.stderr, /Export · Encoding video/);
  assert.match(textExport.stderr, /Export 100% · 24\/24 frames/);
  assert.match(textExport.stderr, /Export · Finalizing MP4/);
  assert.match(textExport.stderr, /Export · Saving file/);
  assert.doesNotMatch(textExport.stderr, /[\r\u001b]|Export:|video-encode/);
  const video = join(artifacts, "video.mp4");
  const exportLog = await run([
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
  ]);
  const exported = JSON.parse(exportLog.stdout);
  const exportEvents = exportLog.stderr
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(
    exportEvents.every(({ event }) => ["stage", "progress"].includes(event)),
  );
  assert.ok(
    exportEvents.some(
      ({ event, stage }) => event === "stage" && stage === "mux",
    ),
  );
  assert.equal(
    exportEvents.filter(({ event }) => event === "progress").at(-1).percent,
    100,
  );
  assert.doesNotMatch(exportLog.stderr, /[\r\u001b]/);
  assert.equal(exported.bitrate, 2000000);
  assert.equal(exported.latencyMode, "quality");
  assert.equal(exported.keyFrameInterval, 1);
  assert.equal(exported.frames, 240);
  assert.equal(exported.duration, 8);
  assert.ok((await stat(video)).size > 100000);
  // Reuse the native export as imported footage, without external fixtures.
  const mediaProject = join(directory, "media-project");
  await mkdir(join(mediaProject, "public"), { recursive: true });
  const padding = Buffer.alloc(600_000);
  padding.writeUInt32BE(padding.length, 0);
  padding.write("free", 4);
  await writeFile(
    join(mediaProject, "public/source.mp4"),
    Buffer.concat([await readFile(video), padding]),
  );
  await writeFile(
    join(mediaProject, "manifest.ts"),
    `import { videoClip } from "ritween";
export default { name: "Imported media", resolution: [320,180], aspectRatio: [16,9], duration: 1,
scenes: [videoClip({id:"footage",name:"Footage",source:"manifest.ts",url:"/source.mp4",start:0,trim:{in:1,out:2},audio:{muted:false}})] };`,
  );
  const mediaResults = [];
  for (const mode of ["full", "range"]) {
    for (const command of ["frame", "export"]) {
      const output = join(
        artifacts,
        `imported-${mode}.${command === "frame" ? "png" : "mp4"}`,
      );
      const result = JSON.parse(
        (
          await run([
            command,
            "--project",
            mediaProject,
            "--media-loading",
            mode,
            ...(command === "frame"
              ? ["--time", ".5"]
              : ["--resolution", "640x360", "--fps", "24"]),
            "-o",
            output,
            "--force",
            "--json",
          ])
        ).stdout,
      );
      assert.equal(result.mediaLoading, mode);
      assert.ok(
        result.mediaRequests[
          mode === "range" ? "partialResponses" : "fullResponses"
        ] > 0,
      );
      assert.equal(result.mediaRequests.rangeRequests > 0, mode === "range");
      if (command === "export") assert.equal(result.frames, 24);
      mediaResults.push(result);
    }
  }
  assert.deepEqual(
    await readFile(join(artifacts, "imported-full.png")),
    await readFile(join(artifacts, "imported-range.png")),
  );
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
  await mkdir(join(directory, "public"), { recursive: true });
  const preview = spawn(
    executable,
    [
      ...prefix,
      "preview",
      "--project",
      directory,
      "--port",
      "0",
      "--media-loading",
      "range",
      "--json",
    ],
    { cwd: directory, stdio: ["ignore", "pipe", "pipe"] },
  );
  let previewStderr = "";
  preview.stderr.on("data", (data) => {
    previewStderr += data;
  });
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
    assert.equal(event.mediaLoading, "range");
    assert.match(await (await fetch(event.url)).text(), /studio\.js/);
    const favicon = await fetch(`${event.url}/favicon.svg`);
    assert.equal(favicon.status, 200);
    assert.match(
      favicon.headers.get("content-type") ?? "",
      /^image\/svg\+xml\b/,
    );
    assert.equal(
      await favicon.text(),
      await readFile(join(root, "public/favicon.svg"), "utf8"),
    );
    const webBrowser = await chromium.launch({
      channel: "chrome",
      headless: true,
      args: ["--enable-unsafe-webgpu"],
    });
    try {
      const tab = await webBrowser.newPage();
      await tab.goto(event.url);
      await tab.getByText("Runtime connected", { exact: true }).waitFor();
      assert.ok(
        await tab.evaluate(async () => {
          const icon = new Image();
          icon.src = document.querySelector('link[rel="icon"]').href;
          await icon.decode();
          return icon.naturalWidth > 0 && icon.naturalHeight > 0;
        }),
      );
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
      const documentToken = await tab.evaluate(
        () => (globalThis.cliDocument = crypto.randomUUID()),
      );
      const saved = await tab.request.patch(`${event.url}/__ritween/settings`, {
        data: { type: "update-export-settings", patch: { fps: 60 } },
      });
      assert.ok(saved.ok());
      await tab.waitForFunction(
        () =>
          document
            .querySelector('[aria-label="Playback scrubber"]')
            ?.getAttribute("step") === String(1 / 60),
      );
      assert.equal(
        await tab.evaluate(() => globalThis.cliDocument),
        documentToken,
      );
      await tab.getByText("Runtime connected", { exact: true }).waitFor();
      await mkdir(join(directory, "public"), { recursive: true });
      await writeFile(
        join(directory, "public/source.mp4"),
        await readFile(join(mediaProject, "public/source.mp4")),
      );
      // Restarting is unnecessary: preview applies the updated manifest live.
      const partial = tab.waitForResponse(
        (response) =>
          response.url().endsWith("/source.mp4") && response.status() === 206,
      );
      await writeFile(
        manifestPath,
        await readFile(join(mediaProject, "manifest.ts")),
      );
      const response = await partial;
      assert.match(response.request().headers().range, /^bytes=/);
      await tab.getByText("Runtime connected", { exact: true }).waitFor();
    } finally {
      await webBrowser.close();
    }
    const closed = new Promise((resolve) => preview.on("exit", resolve));
    preview.kill("SIGINT");
    // Windows terminates the process instead of delivering POSIX SIGINT.
    assert.equal(await closed, process.platform === "win32" ? null : 0);
    assert.doesNotMatch(previewStderr, /\[BABEL\].*deoptimised/);
  } finally {
    if (preview.exitCode === null) preview.kill("SIGTERM");
  }
  const report = {
    executable,
    mediaResults,
    passed: [
      "help",
      "PNG timestamp preview",
      "PNG frame index determinism",
      "overwrite protection",
      "external TSX manifest with JS scene",
      "out-of-range rejection",
      "timeout cleanup",
      "plain-text export progress and labeled result",
      "JSON export progress contract",
      "240-frame MP4 export",
      "native playback and seeking",
      "studio SVG favicon with project public assets",
      "web preview, external source HMR, and signal shutdown",
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
