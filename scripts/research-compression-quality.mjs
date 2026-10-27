// Six still-frame quality checks against lossless renderer snapshots, not a temporal quality test.
import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolveProject } from "../cli/project.mjs";
import { startServer } from "../cli/server.mjs";
const root = process.cwd(),
  dir = `${root}/artifacts/compression-research`;
const project = await resolveProject("../video9", false, root);
const { server, url } = await startServer({ runtimeRoot: root, project });
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const times = [0.5, 27.5, 42.5, 56.5, 73.5, 85.5];
try {
  const page = await browser.newPage();
  await page.goto(`${url}/__ritween/render`);
  await page.waitForFunction(() => !!window.ritween);
  const images = await page.evaluate(
    async ({ times, projectModule }) => {
      const { Renderer } = await import("/src/engine/renderer.ts");
      const { project } = await import(projectModule);
      const canvas = new OffscreenCanvas(1080, 1920);
      const r = await Renderer.create(canvas, project);
      const images = [];
      try {
        for (const t of times) {
          r.render(t);
          await r.device.queue.onSubmittedWorkDone();
          const blob = await canvas.convertToBlob({ type: "image/png" });
          images.push(
            await new Promise((resolve) => {
              const f = new FileReader();
              f.onload = () => resolve(f.result.split(",")[1]);
              f.readAsDataURL(blob);
            }),
          );
        }
      } finally {
        r.dispose();
      }
      return images;
    },
    { times, projectModule: "/@fs" + project.manifest },
  );
  for (let i = 0; i < images.length; i++)
    await writeFile(
      `${dir}/reference-${i + 1}.png`,
      Buffer.from(images[i], "base64"),
    );
} finally {
  await browser.close();
  await server.close();
}
function run(args) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-y", ...args], {
    encoding: "utf8",
    maxBuffer: 4e6,
  });
  if (r.status !== 0) throw Error(r.stderr);
  return r.stderr;
}
const results = [];
for (const id of [
  "all-intra-27m",
  "gop-27m",
  "gop-6m",
  "gop-quality-6m",
  "gop-quality-qp24",
]) {
  const select =
    "select=eq(n\\,30)+eq(n\\,150)+eq(n\\,270)+eq(n\\,390)+eq(n\\,510)+eq(n\\,630)";
  run([
    "-r",
    "60",
    "-i",
    `${dir}/${id}.h264`,
    "-vf",
    select,
    "-fps_mode",
    "vfr",
    `${dir}/${id}-%d.png`,
  ]);
  const log = run([
    "-framerate",
    "1",
    "-i",
    `${dir}/${id}-%d.png`,
    "-framerate",
    "1",
    "-i",
    `${dir}/reference-%d.png`,
    "-filter_complex",
    "[0:v]format=yuv444p[a];[1:v]format=yuv444p[b];[a][b]ssim",
    "-f",
    "null",
    "-",
  ]);
  results.push({
    id,
    ssim: log.split("\n").find((l) => l.includes("SSIM Y:")),
  });
}
await writeFile(
  `${dir}/still-quality.json`,
  JSON.stringify(
    {
      times,
      method:
        "6 decoded frames vs lossless PNG renderer snapshots, FFmpeg RGB to yuv444p for both; not a full temporal test",
      results,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(results, null, 2));
