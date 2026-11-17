import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { parseMp4 } from "../src/engine/decode/formats/mp4.ts";

const run = promisify(execFile);
const root = process.cwd();
await mkdir(resolve(root, "artifacts"), { recursive: true });
const directory = await mkdtemp(resolve(root, "artifacts/linux-export-"));
try {
  const manifest = resolve(directory, "manifest.ts");
  await writeFile(
    manifest,
    `
    import { project as demo } from ${JSON.stringify(resolve(root, "src/project/manifest.ts"))};
    export const project = {
      ...demo,
      duration: 1,
      scenes: [{ ...demo.scenes[0], start: 0, duration: 1 }],
      audioTracks: demo.audioTracks.map(track => ({
        ...track, clips: track.clips.map(clip => ({ ...clip, duration: 1 })),
      })),
    };
  `,
  );
  const video = resolve(directory, "video.mp4");
  const image = resolve(directory, "frame.png");
  const cli = resolve(root, "bin/ritween.mjs");
  await run(
    process.execPath,
    [
      cli,
      "export",
      manifest,
      "--resolution",
      "360p",
      "--fps",
      "24",
      "-o",
      video,
    ],
    { timeout: 120000 },
  );
  const bytes = await readFile(video);
  const media = parseMp4(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  const videoTrack = media.tracks.find((track) => track.kind === "video");
  const audioTrack = media.tracks.find((track) => track.kind === "audio");
  assert.equal(videoTrack.samples.length, 24);
  assert.ok(videoTrack.codec.startsWith("avc1."));
  assert.equal(audioTrack.codec, "mp4a.40.2");
  assert.equal(media.duration, 1);
  assert.equal(audioTrack.presentationEnd - audioTrack.presentationStart, 1);
  await run(
    process.execPath,
    [
      cli,
      "frame",
      manifest,
      "--time",
      "0.5",
      "--resolution",
      "360p",
      "-o",
      image,
    ],
    { timeout: 120000 },
  );
  const png = await readFile(image);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 640);
  assert.equal(png.readUInt32BE(20), 360);
  console.log(
    "Linux CLI validation passed: H.264/AAC MP4 and PNG frame rendering.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
