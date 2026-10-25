import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const base = process.env.BASE_URL ?? "http://localhost:5173";
const browser = await chromium.launch({
  channel: process.env.CHROME_CHANNEL ?? "chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const artifacts = new URL("../artifacts/", import.meta.url);
await mkdir(artifacts, { recursive: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1120 },
  acceptDownloads: true,
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(base);
  await page
    .getByText("Runtime connected", { exact: true })
    .waitFor({ timeout: 30000 });
  const seek = async (time) => {
    await page
      .getByRole("slider", { name: "Playback scrubber" })
      .evaluate((el, t) => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        ).set;
        setter.call(el, String(t));
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, time);
    await page.waitForTimeout(100);
  };
  await seek(0.8);
  await page.screenshot({
    path: new URL("desktop.png", artifacts).pathname,
    fullPage: true,
  });
  await seek(5.2);
  const first = await page.locator("canvas").screenshot();
  await seek(1);
  await seek(5.2);
  assert.ok(
    first.equals(await page.locator("canvas").screenshot()),
    "Seeking to 5.2s must reproduce identical GPU pixels",
  );
  await page.getByRole("button", { name: "Next frame", exact: true }).click();
  await page
    .getByRole("button", { name: "Previous frame", exact: true })
    .click();
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  assert.ok(Number(await page.getByRole("slider").inputValue()) > 0);
  const downloadEvent = page.waitForEvent("download", { timeout: 120000 });
  await page.getByRole("button", { name: "Export Video", exact: true }).click();
  const download = await downloadEvent;
  await download.saveAs(new URL("source-to-motion.mp4", artifacts).pathname);
  await page.getByRole("status").filter({ hasText: "240 frames" }).waitFor();
  const report = await page.evaluate(async () => {
    const link = document.querySelector("a[download]");
    const blob = await (await fetch(link.href)).blob();
    const data = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(data.buffer);
    const found = {};
    const containers = ["moov", "trak", "mdia", "minf", "stbl"];
    function walk(start, end) {
      for (let pos = start; pos < end;) {
        const size = view.getUint32(pos);
        if (size < 8 || pos + size > end) throw Error("Invalid MP4 box");
        const type = new TextDecoder().decode(data.subarray(pos + 4, pos + 8));
        found[type] = pos;
        if (containers.includes(type)) walk(pos + 8, pos + size);
        pos += size;
      }
    }
    walk(0, data.length);
    const count = view.getUint32(found.stsz + 16),
      timescale = view.getUint32(found.mdhd + 20),
      duration = view.getUint32(found.mdhd + 24) / timescale;
    const sampleEntry = found.stsd + 16;
    const avcC = sampleEntry + 86;
    const description = data.slice(avcC + 8, avcC + view.getUint32(avcC));
    let decoded = 0;
    const timestamps = [];
    let decoderError;
    const decoder = new VideoDecoder({
      output(frame) {
        decoded++;
        timestamps.push(frame.timestamp);
        frame.close();
      },
      error(e) {
        decoderError = String(e);
      },
    });
    decoder.configure({
      codec: `avc1.${Array.from(description.slice(1, 4), (n) => n.toString(16).padStart(2, "0")).join("")}`,
      codedWidth: 1280,
      codedHeight: 720,
      description,
    });
    let offset = view.getUint32(found.stco + 16);
    for (let i = 0; i < count; i++) {
      const size = view.getUint32(found.stsz + 20 + 4 * i);
      decoder.decode(
        new EncodedVideoChunk({
          type: "key",
          timestamp: Math.round((i * 1e6) / timescale),
          duration:
            Math.round(((i + 1) * 1e6) / timescale) -
            Math.round((i * 1e6) / timescale),
          data: data.subarray(offset, offset + size),
        }),
      );
      offset += size;
      if (i % 12 === 11) await decoder.flush();
    }
    await decoder.flush();
    decoder.close();
    if (decoderError) throw Error(decoderError);
    const video = document.createElement("video");
    video.muted = true;
    video.src = link.href;
    document.body.append(video);
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(Error("MP4 playback failed"));
    });
    const seekable = [];
    for (const time of [0.5, 5.2, 7.5]) {
      video.currentTime = time;
      await new Promise((resolve, reject) => {
        video.onseeked = resolve;
        video.onerror = reject;
      });
      seekable.push({
        requested: time,
        actual: video.currentTime,
        width: video.videoWidth,
        height: video.videoHeight,
      });
    }
    const playbackDuration = video.duration;
    video.remove();
    return {
      samples: count,
      decoded,
      duration,
      playbackDuration,
      firstTimestamp: timestamps[0],
      lastTimestamp: timestamps.at(-1),
      seekable,
      bytes: data.length,
    };
  });
  assert.equal(report.samples, 240);
  assert.equal(report.decoded, 240);
  assert.equal(report.duration, 8);
  assert.equal(report.playbackDuration, 8);
  assert.equal(report.firstTimestamp, 0);
  assert.equal(report.lastTimestamp, 7966667);
  for (const seek of report.seekable) {
    assert.ok(Math.abs(seek.actual - seek.requested) < 0.04);
    assert.equal(seek.width, 1280);
    assert.equal(seek.height, 720);
  }
  await page.getByRole("button", { name: "Export Video", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Export cancelled." })
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await seek(0.8);
  await page.screenshot({
    path: new URL("mobile.png", artifacts).pathname,
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    "Mobile must not overflow horizontally",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    new URL("validation.json", artifacts),
    JSON.stringify(
      {
        ...report,
        deterministicSeek: true,
        cancellation: true,
        mobileOverflow: false,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(report, null, 2));
  console.log(
    "PASS: GPU seek determinism, transport, real export, 240 decoded frames, MP4 playback/seeking, cancellation, mobile layout.",
  );
} finally {
  await browser.close();
}
