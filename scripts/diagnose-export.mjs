import { chromium } from "playwright-core";
import { startServer } from "../cli/server.mjs";
import { resolveProject } from "../cli/project.mjs";
const runtimeRoot = process.cwd();
const track = process.argv[3];
const seconds = Number(process.argv[4]) || 90;
const compare = process.argv.includes("--compare");
const project = await resolveProject(
  process.argv[2] ?? "../video9",
  false,
  runtimeRoot,
);
const { server, url } = await startServer({ runtimeRoot, project });
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
try {
  const page = await browser.newPage();
  await page.goto(`${url}/__ritween/render`);
  await page.waitForFunction(() => !!window.ritween);
  await page.exposeFunction("report", (value) =>
    console.log(JSON.stringify(value)),
  );
  await page.evaluate(
    async ({ track, seconds, compare }) => {
      const { project } = await import("/@id/virtual:ritween-project");
      const { renderAudio } = await import("/src/engine/audio.ts");
      const { encodeAac } = await import("/src/engine/export.ts");
      const { Renderer } = await import("/src/engine/renderer.ts");
      const NativeOffline = globalThis.OfflineAudioContext;
      globalThis.OfflineAudioContext = class extends NativeOffline {
        constructor(channels, length, rate) {
          super(channels, Math.min(length, seconds * rate), rate);
        }
      };
      let last = performance.now(),
        worst = 0;
      const heartbeat = setInterval(() => {
        const now = performance.now();
        worst = Math.max(worst, now - last - 50);
        last = now;
      }, 50);
      const measure = async (name, fn) => {
        const t = performance.now();
        const value = await fn();
        await window.report({
          phase: name,
          seconds: (performance.now() - t) / 1000,
          maxHeartbeatDelayMs: worst,
        });
        return value;
      };
      for (const track of project.audioTracks ?? [])
        for (const clip of track.clips) {
          const create = clip.create;
          clip.create = () => {
            const source = create();
            return {
              async schedule(host) {
                await measure("schedule:" + clip.id, () =>
                  source.schedule(host),
                );
              },
            };
          };
        }
      const muted = (project.audioTracks ?? [])
        .filter((t) => track && t.id !== track)
        .map((t) => t.id);
      await window.report({
        tracks: (project.audioTracks ?? []).map((t) => ({
          id: t.id,
          clips: t.clips.length,
        })),
      });
      const audio = await measure("audio-mix", () =>
        renderAudio(project, muted, 24),
      );
      if (audio && compare) {
        const { renderEagerAudio } =
          await import("/scripts/audio-reference.mjs");
        const baseline = await measure("eager-audio-mix", () =>
          renderEagerAudio(project, muted, 24),
        );
        let maxDifference = 0,
          squared = 0;
        for (let c = 0; c < audio.numberOfChannels; c++) {
          const a = audio.getChannelData(c),
            b = baseline.getChannelData(c);
          for (let i = 0; i < a.length; i++) {
            const delta = a[i] - b[i];
            maxDifference = Math.max(maxDifference, Math.abs(delta));
            squared += delta * delta;
          }
        }
        await window.report({
          comparison: {
            maxDifference,
            rmsDifference: Math.sqrt(
              squared / (audio.length * audio.numberOfChannels),
            ),
          },
        });
        if (maxDifference > 0.0001)
          throw Error("Deferred audio differs from eager mix");
      }
      if (audio) await measure("aac", () => encodeAac(audio));
      const r = await measure("scene-setup", () =>
        Renderer.create(new OffscreenCanvas(360, 640), project),
      );
      await measure("render-24-frames", async () => {
        for (let i = 0; i < 24; i++) {
          r.render(i / 24);
          await r.device.queue.onSubmittedWorkDone();
        }
      });
      r.dispose();
      clearInterval(heartbeat);
    },
    { track, seconds, compare },
  );
} finally {
  await browser.close();
  await server.close();
}
