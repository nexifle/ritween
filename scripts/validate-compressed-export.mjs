import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { startServer } from "../cli/server.mjs";
import { resolveProject } from "../cli/project.mjs";
const root = process.cwd(),
  directory = `${root}/artifacts/compressed-export`;
await mkdir(directory, { recursive: true });
const project = await resolveProject(".", true, root);
const { server, url } = await startServer({ runtimeRoot: root, project });
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
function ffmpeg(args) {
  const run = spawnSync("ffmpeg", ["-v", "error", ...args], { maxBuffer: 8e6 });
  assert.equal(run.status, 0, run.stderr.toString());
  assert.equal(run.stderr.length, 0, run.stderr.toString());
  return run.stdout;
}
const results = [];
try {
  const page = await browser.newPage({ acceptDownloads: true });
  await page.goto(`${url}/__rimotion/render`);
  await page.waitForFunction(() => !!window.rimotion);
  for (const fps of [24, 30, 60]) {
    const file = `${directory}/pulse-${fps}.mp4`;
    const [download, output] = await Promise.all([
      page.waitForEvent("download"),
      page.evaluate(async (fps) => {
        const { project: demo } = await import("/@id/__x00__rimotion-project");
        const { exportVideo } = await import("/src/engine/export.ts");
        const { renderAudio } = await import("/src/engine/audio.ts");
        const project = {
          ...demo,
          duration: 3,
          scenes: [
            { ...demo.scenes[0], start: 0, duration: 1.25 },
            { ...demo.scenes[1], start: 1.25, duration: 1.75 },
          ],
          audioTracks: [
            {
              id: "pulse",
              name: "Pulse",
              clips: [
                {
                  id: "pulse",
                  name: "Pulse",
                  start: 0,
                  duration: 3,
                  create: () => ({
                    schedule(host) {
                      for (const at of [0, 1.05, 2.4]) {
                        const oscillator = host.context.createOscillator();
                        const gain = host.context.createGain();
                        oscillator.frequency.value = 440;
                        gain.gain.value = 0.2;
                        oscillator.connect(gain).connect(host.destination);
                        oscillator.start(at);
                        oscillator.stop(at + 0.2);
                      }
                    },
                  }),
                },
              ],
            },
          ],
        };
        const pcm = await renderAudio(project, [], fps);
        const output = await exportVideo(project, {
          width: 640,
          height: 360,
          fps,
          keyFrameInterval: 1,
        });
        const audio = new Blob([pcm.getChannelData(0).slice().buffer]);
        const reference = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(",")[1]);
          reader.readAsDataURL(audio);
        });
        const link = document.createElement("a");
        link.download = "pulse.mp4";
        link.href = URL.createObjectURL(output.blob);
        link.click();
        return {
          frames: output.frames,
          duration: output.duration,
          reference,
          bytes: output.blob.size,
        };
      }, fps),
    ]);
    await download.saveAs(file);
    assert.equal(output.frames, fps * 3);
    const probe = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-count_frames",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        file,
      ],
      { encoding: "utf8" },
    );
    assert.equal(probe.status, 0, probe.stderr);
    const metadata = JSON.parse(probe.stdout);
    const video = metadata.streams.find((s) => s.codec_type === "video");
    assert.equal(Number(video.nb_read_frames), fps * 3);
    assert.equal(Number(video.duration), 3);
    const frameInfo = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_frames",
        "-show_entries",
        "frame=key_frame,best_effort_timestamp_time",
        "-of",
        "json",
        file,
      ],
      { encoding: "utf8" },
    );
    assert.equal(frameInfo.status, 0, frameInfo.stderr);
    const frames = JSON.parse(frameInfo.stdout).frames;
    assert.equal(
      frames[Math.ceil(1.25 * fps)].key_frame,
      1,
      "scene cut must be a keyframe",
    );
    assert.ok(
      frames.some((f) => !f.key_frame),
      "must contain inter frames",
    );
    ffmpeg(["-i", file, "-f", "null", "-"]);
    // Check audio independently of the muxer by comparing decoded samples to cached input PCM.
    const decoded = ffmpeg([
      "-i",
      file,
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-f",
      "f32le",
      "-",
    ]);
    const reference = Buffer.from(output.reference, "base64");
    assert.ok(decoded.length >= reference.length);
    assert.ok(decoded.length - reference.length <= 1024 * 4);
    const samples = reference.length / 4;
    const windows = [
      [0, 0.3],
      [1, 1.4],
      [2.3, 2.8],
    ];
    const correlations = windows.map(([start, end]) => {
      let best = { offset: 0, correlation: -1 };
      for (let offset = -8; offset <= 8; offset++) {
        let dot = 0,
          a2 = 0,
          b2 = 0;
        for (
          let i = Math.max(8, Math.ceil(start * 48000));
          i < Math.min(samples - 8, end * 48000);
          i++
        ) {
          const a = reference.readFloatLE(i * 4),
            b = decoded.readFloatLE((i + offset) * 4);
          dot += a * b;
          a2 += a * a;
          b2 += b * b;
        }
        const correlation = dot / Math.sqrt(a2 * b2);
        if (correlation > best.correlation) best = { offset, correlation };
      }
      assert.ok(
        Math.abs(best.offset) <= 1,
        `audio offset: ${JSON.stringify(best)}`,
      );
      assert.ok(
        best.correlation > 0.99,
        `audio correlation: ${JSON.stringify(best)}`,
      );
      return best;
    });
    // Browser playback and seeks must decode inter frames through their preceding keyframe.
    const seeks = await page.evaluate(
      async (bytes) => {
        const blob = new Blob([new Uint8Array(bytes)], { type: "video/mp4" });
        const video = document.createElement("video");
        video.muted = true;
        const url = URL.createObjectURL(blob);
        video.src = url;
        try {
          await new Promise((resolve, reject) => {
            video.onloadedmetadata = resolve;
            video.onerror = reject;
          });
          const results = [];
          for (const at of [0.5, 1.24, 1.26, 2.9]) {
            const seeked = new Promise((resolve, reject) => {
              video.onseeked = resolve;
              video.onerror = reject;
            });
            video.currentTime = at;
            await seeked;
            results.push(video.currentTime);
          }
          return results;
        } finally {
          video.removeAttribute("src");
          video.load();
          URL.revokeObjectURL(url);
        }
      },
      Array.from(await (await import("node:fs/promises")).readFile(file)),
    );
    results.push({
      fps,
      frames: output.frames,
      bytes: output.bytes,
      correlations,
      seeks,
      keyframes: frames.filter((f) => f.key_frame).length,
    });
  }
  await writeFile(
    `${directory}/validation.json`,
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
  await server.close();
}
