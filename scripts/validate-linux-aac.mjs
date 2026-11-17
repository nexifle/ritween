import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright";

const server = await createServer({
  configFile: false,
  optimizeDeps: {
    noDiscovery: true,
    include: ["mediabunny", "@mediabunny/aac-encoder"],
  },
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "aac-validation",
      configureServer(server) {
        server.middlewares.use("/__aac-check", (_req, res) => {
          res.setHeader("Content-Type", "text/html");
          res.end("<!doctype html><title>AAC validation</title>");
        });
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL ?? "chrome",
    headless: true,
  });
  const page = await browser.newPage();
  await page.goto(`${server.resolvedUrls.local[0]}__aac-check`);
  const result = await page.evaluate(async () => {
    const { encodeAac } = await import("/src/engine/export/encoders/aac.ts");
    const buffer = new AudioBuffer({
      length: 48000,
      sampleRate: 48000,
      numberOfChannels: 2,
    });
    for (let c = 0; c < 2; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i++)
        data[i] = 0.5 * Math.sin((2 * Math.PI * (c ? 880 : 440) * i) / 48000);
    }
    const nativeSupported =
      typeof AudioEncoder !== "undefined" &&
      (
        await AudioEncoder.isConfigSupported({
          codec: "mp4a.40.2",
          sampleRate: 48000,
          numberOfChannels: 2,
          bitrate: 128000,
        })
      ).supported;
    const encoded = await encodeAac(buffer);
    // Also cover browsers with no WebCodecs audio encoding classes at all.
    const originalEncoder = globalThis.AudioEncoder;
    const originalData = globalThis.AudioData;
    globalThis.AudioEncoder = undefined;
    globalThis.AudioData = undefined;
    let fallback;
    try {
      fallback = await encodeAac(buffer);
    } finally {
      globalThis.AudioEncoder = originalEncoder;
      globalThis.AudioData = originalData;
    }
    const planes = [[], []];
    let failure;
    const decoder = new AudioDecoder({
      output(frame) {
        for (let c = 0; c < 2; c++) {
          const data = new Float32Array(frame.numberOfFrames);
          frame.copyTo(data, { planeIndex: c, format: "f32-planar" });
          planes[c].push(...data);
        }
        frame.close();
      },
      error(error) {
        failure = error;
      },
    });
    try {
      decoder.configure({
        codec: "mp4a.40.2",
        sampleRate: 48000,
        numberOfChannels: 2,
        description: fallback.description,
      });
      for (let i = 0; i < fallback.chunks.length; i++)
        decoder.decode(
          new EncodedAudioChunk({
            type: "key",
            timestamp: Math.round(((i * 1024) / 48000) * 1e6),
            data: fallback.chunks[i],
          }),
        );
      await decoder.flush();
      if (failure) throw failure;
    } finally {
      decoder.close();
    }
    const correlations = planes.map((pcm, channel) => {
      let dot = 0,
        actual = 0,
        expected = 0;
      for (let i = 2048; i < 46000; i++) {
        const a = pcm[i + fallback.primingSamples];
        const b = buffer.getChannelData(channel)[i];
        dot += a * b;
        actual += a * a;
        expected += b * b;
      }
      return dot / Math.sqrt(actual * expected);
    });
    const controller = new AbortController();
    controller.abort();
    let cancelled = false;
    try {
      await encodeAac(buffer, controller.signal);
    } catch (error) {
      cancelled = error.name === "AbortError";
    }
    const during = new AbortController();
    setTimeout(() => during.abort(), 10);
    let cancelledDuring = false;
    try {
      await encodeAac(buffer, during.signal);
    } catch (error) {
      cancelledDuring = error.name === "AbortError";
    }
    // A fresh export after cancellation must still work.
    const retry = await encodeAac(buffer);
    return {
      nativeSupported,
      packets: encoded.chunks.length,
      fallbackPackets: fallback.chunks.length,
      priming: fallback.primingSamples,
      correlations,
      cancelled,
      cancelledDuring,
      retryPackets: retry.chunks.length,
    };
  });
  assert.ok(result.packets >= 47);
  assert.equal(result.fallbackPackets, 48);
  assert.equal(result.priming, 1024);
  assert.ok(
    result.correlations.every((value) => value > 0.98),
    JSON.stringify(result),
  );
  assert.ok(result.cancelled);
  assert.ok(result.cancelledDuring);
  assert.ok(result.retryPackets >= 47);
  console.log("AAC browser validation passed:", result);
} finally {
  await browser?.close();
  await server.close();
}
