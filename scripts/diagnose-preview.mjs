import { chromium } from "playwright-core";
import { startServer } from "../cli/server.ts";
import { resolveProject } from "../cli/project.ts";

const runtimeRoot = process.cwd();
const project = await resolveProject(
  process.argv[2] ?? ".",
  !process.argv[2],
  runtimeRoot,
);
const { server, url } = await startServer({ runtimeRoot, project });
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--autoplay-policy=user-gesture-required"],
});
try {
  const page = await browser.newPage();
  await page.goto(`${url}/__ritween/render`);
  await page.waitForFunction(() => !!window.ritween);
  const report = await page.evaluate(async () => {
    const { project } = await import("/@id/virtual:ritween-project");
    const { PreviewAudio } = await import("/src/engine/render/audio.ts");
    let schedules = 0;
    const clips = [];
    for (const track of project.audioTracks ?? []) {
      for (const clip of track.clips) {
        const create = clip.create;
        clip.create = () => {
          const source = create();
          return {
            async schedule(host) {
              schedules++;
              const start = performance.now();
              await source.schedule(host);
              clips.push({ id: clip.id, ms: performance.now() - start });
            },
          };
        };
      }
    }
    const player = new PreviewAudio();
    const start = performance.now();
    if (player.prepare) await player.prepare(project);
    const preparationMs = performance.now() - start;
    const play = async (muted = []) => {
      const before = schedules;
      const begin = performance.now();
      await player.play(0, project, muted);
      const playMs = performance.now() - begin;
      await new Promise((resolve, reject) => {
        const poll = () => {
          if ((player.heardTime() ?? 0) > 0.01) resolve();
          else if (performance.now() - begin > 30000)
            reject(Error("Audio clock did not advance"));
          else requestAnimationFrame(poll);
        };
        poll();
      });
      const heardMs = performance.now() - begin;
      player.stop();
      return { playMs, heardMs, schedules: schedules - before };
    };
    // Run with a real user activation from Playwright after this setup resolves.
    window.previewProbe = {
      player,
      play,
      preparationMs,
      clips,
      get schedules() {
        return schedules;
      },
    };
    return { preparationMs };
  });
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.textContent = "Probe playback";
    button.onclick = () => {
      window.probeResult = window.previewProbe.play();
    };
    document.body.append(button);
  });
  await page.getByRole("button", { name: "Probe playback" }).click();
  report.first = await page.evaluate(() => window.probeResult);
  report.repeat = await page.evaluate(() => window.previewProbe.play());
  report.muted = await page.evaluate(async () => {
    const { project } = await import("/@id/virtual:ritween-project");
    return window.previewProbe.play(
      [project.audioTracks?.[0]?.id].filter(Boolean),
    );
  });
  report.unmuted = await page.evaluate(() => window.previewProbe.play());
  report.clips = await page.evaluate(() => window.previewProbe.clips);
  await page.evaluate(() => window.previewProbe.player.dispose());
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await server.close();
}
