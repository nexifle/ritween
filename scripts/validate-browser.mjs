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
  await page.getByRole("button", { name: "Mute A1", exact: true }).click();
  await page.getByRole("button", { name: "Unmute A1", exact: true }).click();
  await page.getByRole("button", { name: "Mute mix", exact: true }).click();
  await page.getByRole("button", { name: "Unmute mix", exact: true }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  assert.ok(
    Number(
      await page
        .getByRole("slider", { name: "Playback scrubber" })
        .inputValue(),
    ) > 0,
  );
  await page
    .getByLabel("Video bitrate", { exact: true })
    .selectOption("4000000");
  await page.getByLabel("Keyframe interval", { exact: true }).selectOption("1");
  await page.evaluate(() => {
    const configure = VideoEncoder.prototype.configure;
    window.exportEncoderConfig = null;
    VideoEncoder.prototype.configure = function (config) {
      window.exportEncoderConfig = config;
      return configure.call(this, config);
    };
  });
  const downloadEvent = page.waitForEvent("download", { timeout: 120000 });
  await page.getByRole("button", { name: "Export Video", exact: true }).click();
  const download = await downloadEvent;
  await download.saveAs(new URL("source-to-motion.mp4", artifacts).pathname);
  const encoderConfig = await page.evaluate(() => window.exportEncoderConfig);
  assert.equal(encoderConfig.bitrate, 4000000);
  assert.equal(encoderConfig.latencyMode, "quality");
  await page.getByRole("status").filter({ hasText: "240 frames" }).waitFor();
  const report = await page.evaluate(async () => {
    const link = document.querySelector("a[download]");
    const blob = await (await fetch(link.href)).blob();
    const data = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(data.buffer);
    const found = {};
    const containers = ["moov", "trak", "mdia", "minf", "stbl", "edts"];
    const traks = [];
    function walk(start, end, into) {
      for (let pos = start; pos < end;) {
        const size = view.getUint32(pos);
        if (size < 8 || pos + size > end) throw Error("Invalid MP4 box");
        const type = new TextDecoder().decode(data.subarray(pos + 4, pos + 8));
        if (type === "trak") traks.push({});
        const bag = type === "trak" ? traks[traks.length - 1] : into;
        if (bag) bag[type] = pos;
        if (!into && type !== "trak") found[type] = pos;
        if (containers.includes(type)) walk(pos + 8, pos + size, bag ?? into);
        pos += size;
      }
    }
    walk(0, data.length, null);
    const videoTrack = traks.find((trak) => {
      const handler = trak.hdlr;
      return (
        handler &&
        new TextDecoder().decode(data.subarray(handler + 16, handler + 20)) ===
          "vide"
      );
    });
    const audio = traks.find((trak) => {
      const handler = trak.hdlr;
      return (
        handler &&
        new TextDecoder().decode(data.subarray(handler + 16, handler + 20)) ===
          "soun"
      );
    });
    if (!videoTrack) throw Error("Missing video track");
    Object.assign(found, videoTrack);
    const count = view.getUint32(found.stsz + 16),
      timescale = view.getUint32(found.mdhd + 20),
      duration = view.getUint32(found.mdhd + 24) / timescale;
    const sampleEntry = found.stsd + 16;
    const avcC = sampleEntry + 86;
    const description = data.slice(avcC + 8, avcC + view.getUint32(avcC));
    const syncCount = view.getUint32(found.stss + 12);
    const syncSamples = new Set(
      Array.from({ length: syncCount }, (_, i) =>
        view.getUint32(found.stss + 16 + 4 * i),
      ),
    );
    if (!syncSamples.has(1) || syncCount < 8 || syncCount >= count)
      throw Error("Missing GOP sync samples");
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
          type: syncSamples.has(i + 1) ? "key" : "delta",
          timestamp: Math.round((i * 1e6) / timescale),
          duration:
            Math.round(((i + 1) * 1e6) / timescale) -
            Math.round((i * 1e6) / timescale),
          data: data.subarray(offset, offset + size),
        }),
      );
      offset += size;
      while (decoder.decodeQueueSize >= 16 && !decoderError)
        await new Promise((r) => setTimeout(r, 0));
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
    let audioRms = 0;
    let audioFrames = 0;
    if (!audio?.stsd || !audio.stsz || !audio.stco || !audio.mdhd)
      throw Error("Missing audio track");
    const audioRate = view.getUint32(audio.mdhd + 20);
    const audioCount = view.getUint32(audio.stsz + 16);
    const audioEntry = audio.stsd + 16;
    let esds = 0;
    for (
      let pos = audioEntry + 36;
      pos + 8 <= audioEntry + view.getUint32(audioEntry);
    ) {
      const size = view.getUint32(pos);
      const type = new TextDecoder().decode(data.subarray(pos + 4, pos + 8));
      if (type === "esds") esds = pos;
      if (size < 8) break;
      pos += size;
    }
    if (!esds) throw Error("Missing AAC descriptor");
    const findAsc = (start, end) => {
      let pos = start;
      while (pos + 2 <= end) {
        const tag = data[pos];
        let size = 0;
        let i = pos + 1;
        for (let n = 0; n < 4 && i < end; n++) {
          const byte = data[i++];
          size = (size << 7) | (byte & 0x7f);
          if ((byte & 0x80) === 0) break;
        }
        const body = i;
        const next = body + size;
        if (tag === 5) return data.slice(body, next);
        const nestedStart = tag === 3 ? body + 3 : tag === 4 ? body + 13 : -1;
        if (nestedStart >= 0) {
          const nested = findAsc(nestedStart, next);
          if (nested) return nested;
        }
        pos = next;
      }
      return null;
    };
    const asc = findAsc(esds + 12, esds + view.getUint32(esds));
    if (!asc) throw Error("Missing AAC AudioSpecificConfig");
    const audioDecoder = new AudioDecoder({
      output(frame) {
        const plane = new Float32Array(
          frame.allocationSize({ planeIndex: 0, format: "f32-planar" }) / 4,
        );
        frame.copyTo(plane, { planeIndex: 0, format: "f32-planar" });
        let sum = 0;
        for (const sample of plane) sum += sample * sample;
        audioRms += sum;
        audioFrames += frame.numberOfFrames;
        frame.close();
      },
      error(e) {
        decoderError = String(e);
      },
    });
    audioDecoder.configure({
      codec: "mp4a.40.2",
      sampleRate: audioRate,
      numberOfChannels: 2,
      description: asc,
    });
    let audioOffset = view.getUint32(audio.stco + 16);
    for (let i = 0; i < audioCount; i++) {
      const size = view.getUint32(audio.stsz + 20 + 4 * i);
      audioDecoder.decode(
        new EncodedAudioChunk({
          type: "key",
          timestamp: Math.round((i * 1024 * 1e6) / audioRate),
          duration: Math.round((1024 * 1e6) / audioRate),
          data: data.subarray(audioOffset, audioOffset + size),
        }),
      );
      audioOffset += size;
    }
    await audioDecoder.flush();
    audioDecoder.close();
    if (decoderError) throw Error(decoderError);
    return {
      samples: count,
      decoded,
      duration,
      playbackDuration,
      firstTimestamp: timestamps[0],
      lastTimestamp: timestamps.at(-1),
      seekable,
      bytes: data.length,
      audioRate,
      audioFrames,
      audioRms,
      tracks: traks.length,
    };
  });
  assert.equal(report.samples, 240);
  assert.equal(report.decoded, 240);
  assert.equal(report.duration, 8);
  assert.equal(report.playbackDuration, 8);
  assert.equal(report.tracks, 2);
  assert.equal(report.audioRate, 48000);
  assert.ok(report.audioFrames > 0);
  assert.ok(report.audioRms > 1, "scheduled notes should survive AAC");
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
  const offlineAudio = await page.evaluate(async () => {
    const { renderAudio } = await import("/src/engine/audio.ts");
    const { project } = await import("/src/project/manifest.ts");
    const times = [0, 0.1, 0.5, 0.5001, 0.7499, 1, 1.25, 1.5, 1.999];
    const { renderEagerAudio } = await import("/scripts/audio-reference.mjs");
    const make = (factories, onVoice = () => {}) => ({
      ...project,
      duration: 2,
      scenes: [{ ...project.scenes[0], start: 0, duration: 2 }],
      audioTracks: [
        {
          id: "test",
          name: "test",
          clips: [
            {
              id: "voices",
              name: "voices",
              start: 0,
              duration: 2,
              create: () => ({
                schedule(host) {
                  const delay = new DelayNode(host.context, {
                    delayTime: 0.05,
                  });
                  delay.connect(host.destination);
                  for (const when of times) {
                    const run = () => {
                      onVoice(when);
                      const osc = factories
                        ? host.context.createOscillator()
                        : new OscillatorNode(host.context);
                      osc.frequency.value = 220 + when * 100;
                      const gain = new GainNode(host.context, { gain: 0 });
                      gain.gain.setValueAtTime(0, when);
                      gain.gain.linearRampToValueAtTime(0.05, when + 0.005);
                      gain.gain.linearRampToValueAtTime(0, when + 0.08);
                      osc.connect(gain).connect(delay);
                      osc.start(when);
                      osc.stop(when + 0.08);
                    };
                    run();
                  }
                },
              }),
            },
          ],
        },
      ],
    });
    const eager = await renderEagerAudio(make(false), [], 24);
    const lazyProject = make(true);
    const lazy = await renderAudio(lazyProject, [], 24);
    let maxDifference = 0;
    for (let c = 0; c < eager.numberOfChannels; c++) {
      const a = eager.getChannelData(c),
        b = lazy.getChannelData(c);
      for (let i = 0; i < a.length; i++)
        maxDifference = Math.max(maxDifference, Math.abs(a[i] - b[i]));
    }
    const cacheReused = lazy === (await renderAudio(lazyProject, [], 24));
    const mutedIsSilent =
      (await renderAudio(lazyProject, ["test"], 24)) === null;
    const controller = new AbortController();
    let cancelled = false;
    try {
      await renderAudio(
        make(true, (when) => {
          if (when >= 1) controller.abort();
        }),
        [],
        24,
        controller.signal,
      );
    } catch (error) {
      cancelled = error.name === "AbortError";
    }
    let failurePropagated = false;
    try {
      await renderAudio(
        make(true, (when) => {
          if (when >= 1) throw Error("voice failed");
        }),
        [],
        24,
      );
    } catch (error) {
      failurePropagated = error.message.includes("voice failed");
    }
    const custom = (schedule) => {
      const result = make(false);
      result.audioTracks[0].clips[0].create = () => ({ schedule });
      return result;
    };
    const effectScore = custom((host) => {
      const ctx = host.context;
      const bus = ctx.createGain();
      bus.gain.value = 0.05;
      const impulse = ctx.createBuffer(1, 64, ctx.sampleRate);
      impulse.getChannelData(0)[0] = 1;
      impulse.getChannelData(0)[30] = 0.2;
      const room = new ConvolverNode(ctx, {
        buffer: impulse,
        normalize: false,
      });
      const shaper = ctx.createWaveShaper();
      shaper.curve = new Float32Array([-1, -0.5, 0, 0.5, 1]);
      shaper.oversample = "2x";
      bus.connect(room).connect(shaper).connect(host.destination);
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 5;
      const depth = ctx.createGain();
      depth.gain.value = 0.01;
      lfo.connect(depth).connect(bus.gain);
      lfo.start(0);
      lfo.stop(2);
      const wave = ctx.createPeriodicWave(
        new Float32Array([0, 0, 0]),
        new Float32Array([0, 1, 0.1]),
      );
      for (const when of [0.1, 0.75, 1.5]) {
        const osc = ctx.createOscillator();
        osc.setPeriodicWave(wave);
        const filter = ctx.createBiquadFilter();
        const gain = ctx.createGain();
        gain.gain.value = 0;
        gain.gain.setValueCurveAtTime(
          new Float32Array([0, 0.2, 0.1]),
          when,
          0.2,
        );
        gain.gain.setValueAtTime(0, when + 0.3);
        gain.gain.cancelScheduledValues(when + 0.3);
        gain.gain.setValueAtTime(0.05, when + 0.25);
        gain.gain.cancelAndHoldAtTime(when + 0.27);
        gain.gain.linearRampToValueAtTime(0, when + 0.35);
        osc.connect(filter).connect(gain).connect(bus);
        osc.start(when);
        osc.stop(when + 0.4);
      }
    });
    const effectNative = await renderEagerAudio(effectScore, [], 24);
    const effectManaged = await renderAudio(effectScore, [], 24);
    let effectDifference = 0;
    for (let c = 0; c < effectNative.numberOfChannels; c++) {
      const a = effectNative.getChannelData(c),
        b = effectManaged.getChannelData(c);
      for (let i = 0; i < a.length; i++)
        effectDifference = Math.max(effectDifference, Math.abs(a[i] - b[i]));
    }
    const violations = [];
    const reject = async (schedule, expected) => {
      try {
        await renderAudio(custom(schedule), [], 24);
      } catch (error) {
        if (error.message.includes(expected)) {
          violations.push(expected);
          return;
        }
        throw error;
      }
      throw Error("Managed audio accepted invalid schedule: " + expected);
    };
    await reject(
      (host) => host.context.createAnalyser(),
      "Unsupported audio context API",
    );
    await reject(
      (host) => new PannerNode(host.context),
      "Unsupported audio node",
    );
    await reject(
      (host) => new GainNode(host.context).gain.setValueAtTime(NaN, 0),
      "Invalid audio parameter value",
    );
    await reject(
      (host) => host.context.createBuffer(2, 40_000_000, 48_000),
      "128 MiB",
    );
    await reject((host) => {
      for (let i = 0; i < 16_001; i++) new GainNode(host.context);
    }, "nodes limit");
    await reject((host) => {
      new GainNode(host.context).gain.automationRate = "a-rate";
    }, "Unsupported audio parameter property");
    await reject(
      (host) => host.context.decodeAudioData(new ArrayBuffer(1), () => {}),
      "promise-based decodeAudioData",
    );
    let retained;
    await renderAudio(
      custom((host) => {
        retained = host;
      }),
      [],
      24,
    );
    let retainedHostRejected = false;
    try {
      retained.context.createGain();
    } catch (error) {
      retainedHostRejected = error.message.includes("scheduling has finished");
    }
    const constructor = globalThis.OscillatorNode;
    await Promise.all(
      [0, 1].map(() =>
        renderAudio(
          custom(async (host) => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            const osc = new OscillatorNode(host.context);
            osc.connect(host.destination);
            osc.start(0);
            osc.stop(0.1);
          }),
          [],
          24,
        ),
      ),
    );
    const constructorsRestored = constructor === globalThis.OscillatorNode;
    return {
      maxDifference,
      effectDifference,
      retainedHostRejected,
      constructorsRestored,
      violations,
      cacheReused,
      mutedIsSilent,
      cancelled,
      failurePropagated,
    };
  });
  assert.ok(
    offlineAudio.maxDifference < 1e-5,
    "deferred voices must preserve native PCM across suspension boundaries and shared delay tails",
  );
  assert.ok(
    offlineAudio.effectDifference < 1e-5,
    "managed factories, default filters, modulation, periodic waves, convolution and automation must preserve native PCM",
  );
  assert.equal(offlineAudio.violations.length, 7);
  assert.equal(offlineAudio.retainedHostRejected, true);
  assert.equal(offlineAudio.constructorsRestored, true);
  for (const key of [
    "cacheReused",
    "mutedIsSilent",
    "cancelled",
    "failurePropagated",
  ])
    assert.equal(offlineAudio[key], true, key);
  assert.deepEqual(errors, []);
  await writeFile(
    new URL("validation.json", artifacts),
    JSON.stringify(
      {
        ...report,
        offlineAudio,
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
    "PASS: GPU seek determinism, transport, real export, 240 decoded frames, MP4 playback/seeking, cancellation, mobile layout, managed audio PCM/effects/limits/cache/mute/abort/failure/concurrency.",
  );
} finally {
  await browser.close();
}
