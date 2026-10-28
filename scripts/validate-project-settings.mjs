import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { startServer } from "../cli/server.ts";
import { settingsPath } from "../cli/project-settings.ts";

const directory = await mkdtemp(join(tmpdir(), "ritween-settings-browser-"));
const manifest = join(directory, "manifest.js");
let server;
let browser;
let page;
try {
  await writeFile(
    manifest,
    `
    const tone = (id, frequency) => ({ id, name: id, clips: [{ id, name: id, start: 0, duration: 1, create: () => ({ schedule(host) {
      globalThis.schedules ??= {};
      globalThis.schedules[id] = (globalThis.schedules[id] ?? 0) + 1;
      const oscillator = new OscillatorNode(host.context, { frequency });
      const gain = new GainNode(host.context, { gain: 0.05 });
      oscillator.connect(gain).connect(host.destination);
      oscillator.start(0); oscillator.stop(1);
    } }) }] });
    export const project = { name: "Settings fixture", duration: 1, resolution: [64,64], aspectRatio: [1,1],
      scenes: [{id:"scene",name:"Scene",source:"scene.js",start:0,duration:1,transition:{type:"cut"},create:()=>({setup(){},render(){},dispose(){}})}],
      audioTracks: [tone("voice",440),tone("music",880)] };
  `,
  );
  const running = await startServer({
    runtimeRoot: process.cwd(),
    project: { manifest, directory },
  });
  server = running.server;
  browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--autoplay-policy=user-gesture-required"],
  });
  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(running.url);
  await page.getByText("Runtime connected", { exact: true }).waitFor();
  await page
    .getByTestId("track-names")
    .getByRole("button", { name: "Mute voice", exact: true })
    .click();
  await page
    .getByTestId("track-names")
    .getByRole("button", { name: "Unmute voice", exact: true })
    .waitFor();
  const unmute = page.getByTestId("track-names").getByRole("button", {
    name: "Unmute voice",
    exact: true,
  });
  assert.equal(await unmute.getAttribute("aria-pressed"), "true");
  await unmute.click();
  await page
    .getByTestId("track-names")
    .getByRole("button", { name: "Mute voice", exact: true })
    .waitFor();
  assert.equal(
    JSON.parse(await readFile(settingsPath(manifest), "utf8")).audioTracks.voice
      .muted,
    false,
  );
  await page.reload();
  await page.getByText("Runtime connected", { exact: true }).waitFor();
  await page
    .getByTestId("track-names")
    .getByRole("button", { name: "Mute voice", exact: true })
    .click();
  await page
    .getByTestId("track-names")
    .getByRole("button", { name: "Unmute voice", exact: true })
    .waitFor();
  // A failed filesystem update must leave the last saved mute in effect.
  await page.route("**/__ritween/settings", (route) =>
    route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: "fixture disk failure" }),
    }),
  );
  await page
    .getByTestId("track-names")
    .getByRole("button", { name: "Unmute voice", exact: true })
    .click();
  await page
    .getByText("Mute was not saved: fixture disk failure", { exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByTestId("track-names")
      .getByRole("button", { name: "Unmute voice", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await page.unroute("**/__ritween/settings");
  const choose = async (id, value) => {
    await page.locator(`#${id}`).selectOption(value);
    await page.waitForFunction(() => !document.querySelector("#fps").disabled);
    assert.equal(await page.locator(`#${id}`).inputValue(), value);
  };
  await choose("resolution", "360x360");
  await choose("fps", "24");
  await choose("video-bitrate", "2000000");
  await choose("encoding-mode", "realtime");
  await choose("keyframe-interval", "4");
  const savedExport = {
    resolution: [360, 360],
    fps: 24,
    bitrate: 2000000,
    latencyMode: "realtime",
    keyFrameInterval: 4,
  };
  assert.deepEqual(
    JSON.parse(await readFile(settingsPath(manifest), "utf8")).export,
    savedExport,
  );
  await page.reload();
  await page.getByText("Runtime connected", { exact: true }).waitFor();
  for (const [id, value] of [
    ["resolution", "360x360"],
    ["fps", "24"],
    ["video-bitrate", "2000000"],
    ["encoding-mode", "realtime"],
    ["keyframe-interval", "4"],
  ])
    assert.equal(await page.locator(`#${id}`).inputValue(), value);
  await choose("video-bitrate", "0");
  assert.equal(
    JSON.parse(await readFile(settingsPath(manifest), "utf8")).export.bitrate,
    "auto",
  );
  await page.route("**/__ritween/settings", (route) =>
    route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: "fixture disk failure" }),
    }),
  );
  await page.locator("#fps").selectOption("60");
  await page
    .getByText("Export settings was not saved: fixture disk failure", {
      exact: true,
    })
    .waitFor();
  assert.equal(await page.locator("#fps").inputValue(), "24");
  await page.unroute("**/__ritween/settings");
  // Exercise the real CLI parser, bridge and MP4 encoding with saved defaults.
  const runCli = async (flags, output) => {
    const result = await promisify(execFile)(
      process.execPath,
      [
        "bin/ritween.mjs",
        "export",
        manifest,
        "--json",
        "-o",
        join(directory, output),
        ...flags,
      ],
      { cwd: process.cwd(), timeout: 60000 },
    );
    return JSON.parse(result.stdout.trim());
  };
  const defaults = await runCli([], "saved.mp4");
  assert.equal(defaults.width, 360);
  assert.equal(defaults.height, 360);
  assert.equal(defaults.fps, 24);
  assert.equal(defaults.frames, 24);
  assert.equal(defaults.latencyMode, "realtime");
  assert.equal(defaults.keyFrameInterval, 4);
  assert.equal(defaults.bitrate, 500000);
  const overridden = await runCli(
    [
      "--resolution",
      "64x64",
      "--fps",
      "60",
      "--bitrate",
      "2000000",
      "--latency-mode",
      "quality",
      "--keyframe-interval",
      "1",
    ],
    "overridden.mp4",
  );
  assert.equal(overridden.width, 64);
  assert.equal(overridden.height, 64);
  assert.equal(overridden.fps, 60);
  assert.equal(overridden.frames, 60);
  assert.equal(overridden.bitrate, 2000000);
  assert.equal(overridden.latencyMode, "quality");
  assert.equal(overridden.keyFrameInterval, 1);
  // A fresh CLI renderer uses persisted settings without studio state/options.
  await page.goto(`${running.url}/__ritween/render`);
  await page.waitForFunction(() => !!window.ritween);
  const report = await page.evaluate(async () => {
    const { project } = await import("/@id/virtual:ritween-project");
    const { renderAudio } = await import("/src/engine/render/audio.ts");
    globalThis.schedules = {};
    const mix = await renderAudio(project, [], 30);
    const partial = {
      schedules: { ...globalThis.schedules },
      samples: mix.length,
      audible: mix.getChannelData(0).some((value) => Math.abs(value) > 0.001),
    };
    const allMuted = {
      ...project,
      settings: {
        version: 1,
        audioTracks: { voice: { muted: true }, music: { muted: true } },
      },
    };
    globalThis.schedules = {};
    const silent = await renderAudio(allMuted, [], 30);
    const { exportMp4: exportVideo } =
      await import("/src/engine/export/formats/mp4/export-mp4.ts");
    const videoOnly = await exportVideo(allMuted, {
      width: 64,
      height: 64,
      fps: 30,
    });
    const mp4 = new TextDecoder("latin1").decode(
      await videoOnly.blob.arrayBuffer(),
    );
    return {
      partial,
      noSoundtrack: silent === null,
      videoOnly: mp4.includes("vide") && !mp4.includes("soun"),
      silentSchedules: globalThis.schedules,
    };
  });
  assert.deepEqual(report.partial.schedules, { music: 1 });
  assert.equal(report.partial.samples, 48000);
  assert.equal(report.partial.audible, true);
  assert.equal(report.noSoundtrack, true);
  assert.equal(report.videoOnly, true);
  assert.deepEqual(report.silentSchedules, {});
  assert.deepEqual(errors, []);
  console.log(
    "PASS: persisted mute and export controls, reload, save failures, CLI defaults and explicit overrides, excluded audio sources and video-only MP4.",
  );
} catch (error) {
  if (page) console.error(await page.locator("body").innerText());
  throw error;
} finally {
  await browser?.close();
  await server?.close();
  await rm(directory, { recursive: true, force: true });
}
