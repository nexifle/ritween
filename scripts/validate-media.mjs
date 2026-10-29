import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { startServer } from "../cli/server.ts";
import { resolveProject } from "../cli/project.ts";

const base = process.env.BASE_URL ?? "http://localhost:5173";
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = fileURLToPath(
  new URL("../artifacts/native-media/", import.meta.url),
);
await mkdir(`${directory}/public/media`, { recursive: true });
const browser = await chromium.launch({
  channel: process.env.CHROME_CHANNEL ?? "chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
let server;
try {
  const page = await browser.newPage();
  if (process.env.RITWEEN_RANGE_MEDIA === "1") {
    await page.addInitScript(() => {
      globalThis.__ritweenRangeVideo = true;
    });
  }
  await page.goto(base);
  const fixture = await page.evaluate(async () => {
    const { exportMp4 } =
      await import("/src/engine/export/formats/mp4/export-mp4.ts");
    const project = {
      name: "Native media fixture",
      resolution: [320, 180],
      aspectRatio: [16, 9],
      duration: 2,
      scenes: [
        {
          id: "source",
          name: "Source",
          source: "manifest.ts",
          start: 0,
          duration: 2,
          transition: { type: "cut" },
          create: () => ({
            setup() {},
            render({ encoder, target, localTime }) {
              const pass = encoder.beginRenderPass({
                colorAttachments: [
                  {
                    view: target.createView(),
                    clearValue:
                      localTime < 1
                        ? { r: 1, g: 0, b: 0, a: 1 }
                        : { r: 0, g: 0, b: 1, a: 1 },
                    loadOp: "clear",
                    storeOp: "store",
                  },
                ],
              });
              pass.end();
            },
            dispose() {},
          }),
        },
      ],
      audioTracks: [
        {
          id: "tone",
          name: "Tone",
          clips: [
            {
              id: "tone",
              name: "Tone",
              start: 0,
              duration: 2,
              create: () => ({
                schedule(host) {
                  const osc = host.context.createOscillator();
                  const gain = host.context.createGain();
                  osc.frequency.value = 660;
                  gain.gain.value = 0.1;
                  osc.connect(gain).connect(host.destination);
                  osc.start(host.at(0));
                  osc.stop(host.at(host.duration));
                },
              }),
            },
          ],
        },
      ],
    };
    const result = await exportMp4(project, {
      width: 320,
      height: 180,
      fps: 24,
    });
    const image = new OffscreenCanvas(80, 80);
    const ctx = image.getContext("2d");
    ctx.fillStyle = "#00ff00";
    ctx.fillRect(0, 0, 80, 80);
    const wav = new ArrayBuffer(44 + 48000 * 2);
    const header = new DataView(wav);
    const text = (offset, value) => {
      for (let i = 0; i < value.length; i++)
        header.setUint8(offset + i, value.charCodeAt(i));
    };
    text(0, "RIFF");
    header.setUint32(4, wav.byteLength - 8, true);
    text(8, "WAVE");
    text(12, "fmt ");
    header.setUint32(16, 16, true);
    header.setUint16(20, 1, true);
    header.setUint16(22, 1, true);
    header.setUint32(24, 48000, true);
    header.setUint32(28, 96000, true);
    header.setUint16(32, 2, true);
    header.setUint16(34, 16, true);
    text(36, "data");
    header.setUint32(40, 96000, true);
    for (let i = 0; i < 48000; i++) {
      header.setInt16(
        44 + i * 2,
        Math.round(Math.sin((2 * Math.PI * 440 * i) / 48000) * 8192),
        true,
      );
    }
    return {
      wav: Array.from(new Uint8Array(wav)),
      video: Array.from(new Uint8Array(await result.blob.arrayBuffer())),
      image: Array.from(
        new Uint8Array(await (await image.convertToBlob()).arrayBuffer()),
      ),
    };
  });
  await writeFile(
    `${directory}/public/media/source.mp4`,
    new Uint8Array(fixture.video),
  );
  await writeFile(
    `${directory}/public/media/tone.wav`,
    new Uint8Array(fixture.wav),
  );
  await writeFile(
    `${directory}/public/media/still.png`,
    new Uint8Array(fixture.image),
  );
  await writeFile(
    `${directory}/manifest.ts`,
    `import { videoClip, imageScene, type Project } from "ritween";
export const project: Project = { name: "Native media", resolution: [320,180], aspectRatio: [16,9], duration: 2,
scenes: [videoClip({ id: "footage", name: "Footage", source: "manifest.ts", url: "/media/source.mp4", start: 0,
trim: { in: 0.25, out: 1.25 }, audio: { muted: false } }),
imageScene({ id: "still", name: "Still", source: "manifest.ts", url: "/media/still.png", start: 1, duration: 1,
transform: { x: 160, y: 90, width: 80, height: 80 } })] };
`,
  );
  await writeFile(
    `${directory}/manifest.settings.json`,
    JSON.stringify({ version: 1, audioClips: { footage: { muted: false } } }),
  );
  const project = await resolveProject(directory, false, root);
  server = await startServer({
    runtimeRoot: root,
    project,
    watch: false,
    mediaLoading: process.env.RITWEEN_RANGE_MEDIA === "1" ? "range" : "full",
    mediaActivation:
      process.env.RITWEEN_ACTIVE_MEDIA === "1" ? "active-only" : "eager",
  });
  const address = server.url;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(address);
  try {
    await page
      .getByText("Runtime connected", { exact: true })
      .waitFor({ timeout: 30000 });
  } catch (error) {
    await page.screenshot({ path: `${directory}/failure.png`, fullPage: true });
    console.error({ errors, body: await page.locator("body").innerText() });
    throw error;
  }
  const report = await page.evaluate(async (engineRoot) => {
    const { project: authored } = await import("/@id/__x00__ritween-project");
    const { resolveMediaProject } = await import(
      `${engineRoot}/media/project.ts`
    );
    const { Renderer } = await import(`${engineRoot}/render/renderer.ts`);
    const { renderAudio } = await import(`${engineRoot}/render/audio.ts`);
    const { exportMp4 } = await import(
      `${engineRoot}/export/formats/mp4/export-mp4.ts`
    );
    const { checkMediaActivation } = await import(
      `${engineRoot.replace(/src\/engine$/, "scripts/media-activation-checks.mjs")}`
    );
    const activation = await checkMediaActivation(engineRoot);
    const project = resolveMediaProject(authored);
    const canvas = new OffscreenCanvas(320, 180);
    const renderer = await Renderer.create(canvas, project);
    const read = async (time) => {
      await renderer.renderAsync(time);
      await renderer.device.queue.onSubmittedWorkDone();
      const copy = new OffscreenCanvas(320, 180);
      const ctx = copy.getContext("2d");
      ctx.drawImage(canvas, 0, 0);
      return {
        center: Array.from(ctx.getImageData(160, 90, 1, 1).data),
        corner: Array.from(ctx.getImageData(10, 10, 1, 1).data),
      };
    };
    let first, blue, repeated, image, end;
    try {
      first = await read(0);
      blue = await read(0.9);
      repeated = await read(0);
      image = await read(1.5);
      end = await read(2);
    } finally {
      renderer.dispose();
    }
    const scaledCanvas = new OffscreenCanvas(640, 360);
    const scaledRenderer = await Renderer.create(scaledCanvas, project);
    let scaledImage;
    try {
      await scaledRenderer.renderAsync(1.5);
      await scaledRenderer.device.queue.onSubmittedWorkDone();
      const copy = new OffscreenCanvas(640, 360);
      const ctx = copy.getContext("2d");
      ctx.drawImage(scaledCanvas, 0, 0);
      scaledImage = {
        center: Array.from(ctx.getImageData(320, 180, 1, 1).data),
        inside: Array.from(ctx.getImageData(390, 180, 1, 1).data),
        outside: Array.from(ctx.getImageData(410, 180, 1, 1).data),
      };
    } finally {
      scaledRenderer.dispose();
    }
    const mix = await renderAudio(project, [], 24);
    const peak = mix
      ? Math.max(...mix.getChannelData(0).subarray(5000, 10000).map(Math.abs))
      : 0;
    const { audioFile } = await import(`${engineRoot}/decode/audio-file.ts`);
    const wavMix = await renderAudio(
      {
        ...project,
        settings: undefined,
        audioTracks: [
          {
            id: "wav",
            name: "WAV",
            clips: [
              {
                id: "wav",
                name: "WAV",
                start: 0,
                duration: 2,
                create: audioFile({ url: "/media/tone.wav", loop: true }),
              },
            ],
          },
        ],
      },
      [],
      24,
    );
    const wavPeak = wavMix
      ? Math.max(
          ...wavMix.getChannelData(0).subarray(60000, 65000).map(Math.abs),
        )
      : 0;
    const { loadVideoTexture, videoResource } = await import(
      `${engineRoot}/render/visual.ts`
    );
    const descriptors = [0.25, 1.25].map((offset, i) =>
      videoResource({
        id: `layer-${i}`,
        name: `Layer ${i}`,
        url: "/media/source.mp4",
        start: 0,
        duration: 0.5,
        offset,
      }),
    );
    const customProject = {
      ...project,
      duration: 0.5,
      audioTracks: undefined,
      settings: undefined,
      mediaClips: descriptors,
      scenes: [
        {
          id: "custom",
          name: "Custom",
          source: "manifest.ts",
          start: 0,
          duration: 0.5,
          transition: { type: "cut" },
          create: () => {
            let textures = [];
            let pipeline, bind;
            return {
              async setup(context) {
                for (const descriptor of descriptors)
                  textures.push(await loadVideoTexture(context, descriptor));
                const shader = context.device.createShaderModule({
                  code: `
                @group(0) @binding(0) var left: texture_2d<f32>;
                @group(0) @binding(1) var right: texture_2d<f32>;
                @vertex fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
                  let p = array<vec2f, 3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.));
                  return vec4f(p[i],0.,1.);
                }
                @fragment fn fragment(@builtin(position) p: vec4f) -> @location(0) vec4f {
                  if (p.x < 160.) { return textureLoad(left,vec2i(i32(p.x)*2,i32(p.y)),0); }
                  return textureLoad(right,vec2i((i32(p.x)-160)*2,i32(p.y)),0);
                }`,
                });
                pipeline = await context.device.createRenderPipelineAsync({
                  layout: "auto",
                  vertex: { module: shader, entryPoint: "vertex" },
                  fragment: {
                    module: shader,
                    entryPoint: "fragment",
                    targets: [{ format: context.format }],
                  },
                  primitive: { topology: "triangle-list" },
                });
                bind = context.device.createBindGroup({
                  layout: pipeline.getBindGroupLayout(0),
                  entries: textures.map((texture, binding) => ({
                    binding,
                    resource: texture.texture.createView(),
                  })),
                });
              },
              async prepareFrame(context) {
                await Promise.all(
                  textures.map((texture) => texture.prepareFrame(context)),
                );
              },
              render({ encoder, target }) {
                const pass = encoder.beginRenderPass({
                  colorAttachments: [
                    {
                      view: target.createView(),
                      clearValue: { r: 0, g: 0, b: 0, a: 1 },
                      loadOp: "clear",
                      storeOp: "store",
                    },
                  ],
                });
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, bind);
                pass.draw(3);
                pass.end();
              },
              dispose() {
                for (const texture of textures) texture.dispose();
              },
            };
          },
        },
      ],
    };
    const customCanvas = new OffscreenCanvas(320, 180);
    const customRenderer = await Renderer.create(customCanvas, customProject);
    let custom;
    try {
      await customRenderer.renderAsync(0);
      await customRenderer.device.queue.onSubmittedWorkDone();
      const copy = new OffscreenCanvas(320, 180);
      const ctx = copy.getContext("2d");
      ctx.drawImage(customCanvas, 0, 0);
      custom = {
        left: Array.from(ctx.getImageData(80, 90, 1, 1).data),
        right: Array.from(ctx.getImageData(240, 90, 1, 1).data),
        audioIds: resolveMediaProject(customProject).audioTracks.map(
          (track) => track.clips[0].id,
        ),
      };
    } finally {
      customRenderer.dispose();
    }
    const muted = await renderAudio(
      {
        ...project,
        settings: { version: 1, audioClips: { footage: { muted: true } } },
      },
      [],
      24,
    );
    const output = await exportMp4(project, {
      width: 320,
      height: 180,
      fps: 24,
    });
    return {
      activation,
      first,
      blue,
      repeated,
      image,
      end,
      peak,
      scaledImage,
      wavPeak,
      custom,
      muted: muted === null,
      frames: output.frames,
      bytes: output.blob.size,
    };
  }, `/@fs${root}src/engine`);
  assert.ok(
    report.first.center[0] > 200 && report.first.center[2] < 40,
    "Frame awal harus merah",
  );
  assert.ok(
    report.blue.center[2] > 200 && report.blue.center[0] < 40,
    "Trim harus mencapai frame biru",
  );
  assert.deepEqual(
    report.first,
    report.repeated,
    "Seek mundur harus deterministik",
  );
  assert.ok(
    report.image.center[1] > 200 && report.image.corner[1] < 20,
    "Penempatan gambar harus mempertahankan background",
  );
  assert.deepEqual(
    report.image,
    report.end,
    "Endpoint harus mempertahankan frame terakhir",
  );
  assert.ok(
    report.peak > 0.01,
    "Audio footage harus berhasil diekstrak dan dicampur",
  );
  assert.equal(
    report.muted,
    true,
    "Mute per clip harus menghilangkan audio export",
  );
  assert.ok(
    report.scaledImage.center[1] > 200 &&
      report.scaledImage.inside[1] > 200 &&
      report.scaledImage.outside[1] < 20,
    "Transform harus tetap memakai koordinat komposisi saat resolusi output berubah",
  );
  assert.ok(
    report.wavPeak > 0.1,
    "WAV BGM harus tetap terdengar setelah satu loop",
  );
  assert.ok(
    report.custom.left[0] > 200 && report.custom.right[2] > 200,
    "Custom WebGPU scene harus menggambar dua video dengan offset independen",
  );
  assert.deepEqual(report.custom.audioIds, ["layer-0", "layer-1"]);
  assert.equal(report.frames, 48);
  await page.getByRole("button", { name: "Mute Footage", exact: true }).click();
  await page
    .getByRole("button", { name: "Unmute Footage", exact: true })
    .waitFor();
  const saved = JSON.parse(
    await readFile(`${directory}/manifest.settings.json`, "utf8"),
  );
  assert.equal(saved.audioClips.footage.muted, true);
  await page.reload();
  await page
    .getByRole("button", { name: "Unmute Footage", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Unmute Footage", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Mute Footage", exact: true })
    .waitFor();
  await page.screenshot({ path: `${directory}/studio.png`, fullPage: true });
  assert.deepEqual(errors, []);
  report.rangeVideo = process.env.RITWEEN_RANGE_MEDIA === "1";
  report.activeOnly = process.env.RITWEEN_ACTIVE_MEDIA === "1";
  const reportName = `report${report.activeOnly ? "-active" : ""}${report.rangeVideo ? "-range" : ""}.json`;
  await writeFile(
    `${directory}/${reportName}`,
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify({ ok: true, ...report }, null, 2));
} finally {
  await browser.close();
  await server?.server.close();
}
