import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { resolveProject } from "../cli/project.ts";
import { startServer } from "../cli/server.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(`${root}artifacts`, { recursive: true });
const directory = await mkdtemp(`${root}artifacts/mp4-input-`);
await mkdir(`${directory}/public/media`, { recursive: true });
const media = `${directory}/public/media`;
const ffmpeg = (...args) =>
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], {
    stdio: "pipe",
    timeout: 120_000,
  });

// Keep media samples beyond the initial 512 KiB Range probe.
ffmpeg(
  "-f",
  "lavfi",
  "-i",
  "color=c=red:s=160x90:r=12:d=1",
  "-f",
  "lavfi",
  "-i",
  "color=c=blue:s=160x90:r=12:d=1",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440:sample_rate=48000:duration=2",
  "-filter_complex",
  "[0:v][1:v]concat=n=2:v=1:a=0[v]",
  "-map",
  "[v]",
  "-map",
  "2:a",
  "-af",
  "afade=t=in:st=0.4:d=0.005,afade=t=out:st=1.6:d=0.005",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-g",
  "12",
  "-bf",
  "0",
  "-c:a",
  "aac",
  "-moov_size",
  "1048576",
  `${media}/avc1.mp4`,
);
ffmpeg(
  "-i",
  `${media}/avc1.mp4`,
  "-map",
  "0",
  "-c",
  "copy",
  "-tag:v",
  "avc3",
  "-bsf:v",
  "h264_mp4toannexb",
  `${media}/avc3.mp4`,
);
ffmpeg(
  "-i",
  `${media}/avc1.mp4`,
  "-map",
  "0",
  "-c:a",
  "copy",
  "-c:v",
  "libx265",
  "-x265-params",
  "pools=1:frame-threads=1:log-level=error",
  "-g",
  "12",
  "-bf",
  "0",
  "-tag:v",
  "hvc1",
  "-moov_size",
  "1048576",
  `${media}/hvc1.mp4`,
);
ffmpeg(
  "-i",
  `${media}/hvc1.mp4`,
  "-map",
  "0",
  "-c",
  "copy",
  "-tag:v",
  "hev1",
  `${media}/hev1.mp4`,
);
ffmpeg(
  "-i",
  `${media}/avc1.mp4`,
  "-map",
  "0",
  "-c:a",
  "copy",
  "-c:v",
  "libaom-av1",
  "-cpu-used",
  "8",
  "-crf",
  "35",
  "-g",
  "12",
  "-moov_size",
  "1048576",
  `${media}/av01.mp4`,
);
ffmpeg(
  "-i",
  `${media}/avc1.mp4`,
  "-vn",
  "-c:a",
  "pcm_f32le",
  `${media}/reference.wav`,
);
await writeFile(
  `${directory}/manifest.ts`,
  `import { videoClip, type Project } from "ritween";
export const project: Project = { name: "MP4 input compatibility", resolution: [160,90], aspectRatio: [16,9], duration: 2,
scenes: [videoClip({ id: "input", name: "Input", source: "manifest.ts", url: "/media/avc1.mp4", start: 0, trim: { in: 0, out: 2 }, audio: { muted: true } })] };
`,
);
const range = process.env.RITWEEN_RANGE_MEDIA === "1";
const project = await resolveProject(directory, false, root);
const server = await startServer({
  runtimeRoot: root,
  project,
  watch: false,
  mediaLoading: range ? "range" : "full",
});
let browser;
try {
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL ?? "chrome",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage();
  const errors = [];
  const rangeReads = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const headers = request.headers();
    const start = /^bytes=(\d+)-/.exec(headers.range ?? "");
    if (headers["if-range"] && start && Number(start[1]) >= 512 * 1024)
      rangeReads.push({
        path: new URL(request.url()).pathname,
        range: headers.range,
      });
  });
  await page.goto(server.url);
  try {
    await page
      .getByText("Runtime connected", { exact: true })
      .waitFor({ timeout: 30_000 });
  } catch (error) {
    await page.screenshot({ path: `${directory}/failure.png` });
    console.error({
      directory,
      errors,
      body: await page.locator("body").innerText(),
    });
    throw error;
  }
  await page.screenshot({ path: `${directory}/studio.png` });
  const report = await page.evaluate(
    async ({ root, range }) => {
      const engine = `/@fs${root}src/engine`;
      const { parseMp4, parseMp4Metadata } = await import(
        `${engine}/decode/formats/mp4.ts`
      );
      const { readMp4Metadata } = await import(
        `${engine}/media/mp4-metadata.ts`
      );
      const { openVideo } = await import(`${engine}/decode/video-resource.ts`);
      const { decodeVideoAudio } = await import(
        `${engine}/decode/audio-file.ts`
      );
      const context = new OfflineAudioContext(1, 96_000, 48_000);
      const reference = await context.decodeAudioData(
        await (await fetch("/media/reference.wav")).arrayBuffer(),
      );
      const rmsError = (pcm, offset) => {
        const ref = reference.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < pcm.length; i++)
          sum += (pcm[i] - (ref[offset + i] ?? 0)) ** 2;
        return Math.sqrt(sum / pcm.length);
      };
      const results = [];
      if (Boolean(globalThis.__ritweenRangeVideo) !== range)
        throw Error(
          "Server did not initialize the requested media-loading mode",
        );
      for (const name of ["avc1", "avc3", "hvc1", "hev1", "av01"]) {
        const url = `/media/${name}.mp4`;
        const bytes = await (await fetch(url)).arrayBuffer();
        const input = parseMp4(bytes);
        const metadata = await readMp4Metadata(url);
        const partial = parseMp4Metadata(
          metadata.moov,
          metadata.mdats,
          metadata.length,
        );
        if (JSON.stringify(input) !== JSON.stringify(partial))
          throw Error(`${name}: metadata differs from full parse`);
        const track = input.tracks.find((track) => track.kind === "video");
        const config = {
          codec: track.codec,
          codedWidth: track.width,
          codedHeight: track.height,
          ...(name === "av01" ? {} : { description: track.description }),
        };
        const { supported } = await VideoDecoder.isConfigSupported(config);
        const result = {
          name,
          codec: track.codec,
          supported,
          samples: track.samples.length,
          sampleDataOffset: track.samples[0].offset,
          modes: [],
          audio: [],
        };
        if (supported) {
          for (const sequential of [false, true]) {
            globalThis.__ritweenSequentialVideo = sequential;
            const video = await openVideo(url);
            const pixels = [];
            try {
              for (const time of [0.1, 0.4, 0.7, 1.1, 1.4, 1.7, 0.1, 2]) {
                const frame = await video.frameAt(time).catch((error) => {
                  throw Error(
                    `${name}, sequential=${sequential}, time=${time}: ${error}`,
                  );
                });
                try {
                  const canvas = new OffscreenCanvas(1, 1);
                  const ctx = canvas.getContext("2d");
                  ctx.drawImage(frame, 0, 0, 1, 1);
                  pixels.push(Array.from(ctx.getImageData(0, 0, 1, 1).data));
                } finally {
                  frame.close();
                }
              }
            } finally {
              video.dispose();
            }
            result.modes.push({ sequential, pixels });
          }
        } else {
          const video = await openVideo(url);
          try {
            let error;
            try {
              await video.frameAt(0.1);
            } catch (reason) {
              error = String(reason);
            }
            if (!error?.includes("cannot decode MP4 video codec"))
              throw Error(
                `${name}: unsupported codec did not fail explicitly: ${error}`,
              );
          } finally {
            video.dispose();
          }
        }
        for (const [offset, duration] of [
          [0, 2],
          [0.35, 1.4],
        ]) {
          const audio = await decodeVideoAudio(url, context, offset, duration);
          if (!audio) throw Error(`${name}: missing linked audio`);
          const pcm = audio.getChannelData(0);
          let peak = 0;
          let onset = -1;
          for (let i = 0; i < pcm.length; i++) {
            peak = Math.max(peak, Math.abs(pcm[i]));
            if (onset < 0 && Math.abs(pcm[i]) > 0.02)
              onset = i / audio.sampleRate;
          }
          result.audio.push({
            offset,
            duration: audio.duration,
            peak,
            onset,
            rmsError: rmsError(pcm, Math.round(offset * audio.sampleRate)),
          });
        }
        results.push(result);
      }
      return { range, results };
    },
    { root, range },
  );
  assert.deepEqual(errors, []);
  report.rangeReads = rangeReads;
  for (const result of report.results) {
    assert.equal(result.samples, 24);
    if (["avc1", "hvc1", "av01"].includes(result.name)) {
      assert.ok(result.sampleDataOffset > 512 * 1024);
      if (range)
        assert.ok(
          rangeReads.some((read) => read.path === `/media/${result.name}.mp4`),
          `${result.name}: missing versioned Range reads beyond the initial probe`,
        );
    }
    if (["avc1", "avc3", "av01"].includes(result.name))
      assert.ok(
        result.supported,
        `${result.name} must decode in the validation browser`,
      );
    for (const mode of result.modes) {
      for (let i = 0; i < mode.pixels.length; i++) {
        const pixel = mode.pixels[i];
        const red = i < 3 || i === 6;
        assert.ok(
          red
            ? pixel[0] > 200 && pixel[2] < 40
            : pixel[2] > 200 && pixel[0] < 40,
          `${result.name}: wrong frame ${i}, sequential=${mode.sequential}: ${pixel}`,
        );
      }
      assert.deepEqual(mode.pixels[0], mode.pixels[6]);
    }
    for (const audio of result.audio) {
      assert.ok(audio.peak > 0.08, `${result.name}: missing audible tone`);
      assert.ok(
        Math.abs(audio.onset - (0.4 - audio.offset)) < 0.025,
        `${result.name}: audio onset shifted: ${JSON.stringify(audio)}`,
      );
      assert.ok(
        audio.rmsError < 0.015,
        `${result.name}: audio differs from independent FFmpeg reference: ${JSON.stringify(audio)}`,
      );
    }
  }
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        directory,
        range,
        results: report.results.map(({ name, codec, supported, audio }) => ({
          name,
          codec,
          decoding: supported ? "passed" : "unavailable in this browser",
          audio,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.server.close();
}
