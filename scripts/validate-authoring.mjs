import assert from "node:assert/strict";
import { validateStageTwo } from "./authoring-stage-two-checks.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({
  configFile: false,
  root,
  logLevel: "warn",
  optimizeDeps: { noDiscovery: true },
  plugins: [
    {
      name: "authoring-validation-page",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/") return next();
          res.setHeader("Content-Type", "text/html");
          res.end("<!doctype html><title>Authoring validation</title>");
        });
      },
    },
  ],
  resolve: { alias: { ritween: `${root}src/index.ts` } },
  server: { host: "127.0.0.1", port: 0 },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL ?? "chrome",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage();
  await page.goto(server.resolvedUrls.local[0]);
  const report = await page.evaluate(async () => {
    const {
      FrameSource,
      Stage,
      Overlay,
      Box,
      Text,
      ZStack,
      Camera,
      keyframes,
      World,
      Composition,
      Shot,
      exportMp4,
    } = await import("/src/index.ts");
    const { project } = await import("/examples/authoring/manifest.ts");
    const errors = [];
    const source = await FrameSource.create(project, {
      width: 960,
      height: 540,
      onError: (error) => errors.push(error),
    });
    const capture = async (time) => {
      const canvas = await source.render(time);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    };
    let title, chart;
    try {
      title = await capture(1.5);
      chart = await capture(4.2);
      await capture(0);
      const repeated = await capture(4.2);
      if (JSON.stringify(chart) !== JSON.stringify(repeated))
        throw Error("Backward seek changed pixels.");
    } finally {
      source.dispose();
    }
    let stage;
    const fixture = {
      name: "Overlap",
      resolution: [100, 100],
      aspectRatio: [1, 1],
      duration: 1,
      scenes: [
        {
          id: "overlap",
          name: "Overlap",
          source: "fixture.ts",
          start: 0,
          duration: 1,
          transition: { type: "cut" },
          create: () =>
            (stage = Stage(
              () =>
                ZStack([
                  Box({ width: 80, height: 80, fill: "#FF0000" }),
                  Box({ width: 80, height: 80, fill: "#0000FF" }),
                ])
                  .opacity(0.5)
                  .frame({ width: "fill", height: "fill" }),
              { background: "#FFFFFF" },
            )),
        },
      ],
    };
    const overlap = await FrameSource.create(fixture, {
      width: 100,
      height: 100,
      onError: (e) => errors.push(e),
    });
    let pixel, tree;
    try {
      const canvas = await overlap.render(0.5);
      const copy = new OffscreenCanvas(100, 100),
        p = copy.getContext("2d");
      p.drawImage(canvas, 0, 0);
      pixel = [...p.getImageData(50, 50, 1, 1).data];
      tree = stage.inspect();
    } finally {
      overlap.dispose();
    }
    const cameraFixture = {
      ...fixture,
      scenes: [
        {
          ...fixture.scenes[0],
          create: () =>
            (stage = Stage(
              () =>
                Box({ width: 10, height: 10, fill: "#FF0000" }).offset(70, 20),
              {
                designSize: [100, 100],
                background: "#FFFFFF",
                camera: ({ localTime }) =>
                  Camera({
                    x: 70,
                    y: 20,
                    zoom: 2,
                    rotation: localTime < 0.5 ? 0 : Math.PI / 2,
                  }),
              },
            )),
        },
      ],
    };
    const cameraSource = await FrameSource.create(cameraFixture, {
      width: 200,
      height: 100,
      onError: (e) => errors.push(e),
    });
    const cameraPixels = [];
    try {
      for (const time of [0, 0.75, 0]) {
        const canvas = await cameraSource.render(time);
        const copy = new OffscreenCanvas(200, 100),
          p = copy.getContext("2d");
        p.drawImage(canvas, 0, 0);
        cameraPixels.push(
          [110, 40, 60].map((x, i) => [
            ...p.getImageData(i === 0 ? x : 110, i === 0 ? 60 : x, 1, 1).data,
          ]),
        );
        if (stage.inspect().camera.zoom !== 2)
          throw Error("Missing inspected camera state.");
      }
    } finally {
      cameraSource.dispose();
    }
    const { project: cameraProject } =
      await import("/examples/camera/manifest.ts");
    const cameraWorld = await FrameSource.create(cameraProject, {
      width: 960,
      height: 540,
      onError: (e) => errors.push(e),
    });
    const cameraShots = [];
    try {
      for (const time of [0.5, 3, 6, 0.5]) {
        const canvas = await cameraWorld.render(time);
        cameraShots.push(
          Array.from(
            new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer()),
          ),
        );
      }
      if (JSON.stringify(cameraShots[0]) !== JSON.stringify(cameraShots[3]))
        throw Error("Camera backward seek changed pixels.");
    } finally {
      cameraWorld.dispose();
    }
    const compositionWorld = World(
      () =>
        ZStack(
          [
            Box({ width: 100, height: 100, fill: "#FF0000" }),
            Composition(
              World(() => Box({ width: 20, height: 20, fill: "#00FF00" }), {
                size: [20, 20],
              }),
            ).offset(20, 0),
          ],
          { align: "start" },
        ),
      { size: [100, 100] },
    );
    const compositionProject = {
      ...fixture,
      scenes: [
        Shot({
          id: "nested",
          source: "fixture.ts",
          start: 0,
          duration: 1,
          world: compositionWorld,
          designSize: [100, 100],
          camera: { x: 0, y: 0, zoom: 2, anchor: [0, 0] },
          overlay: () =>
            Box({ width: 10, height: 10, fill: "#0000FF" }).offset(80, 80),
        }),
      ],
    };
    const composed = await FrameSource.create(compositionProject, {
      width: 100,
      height: 100,
      onError: (e) => errors.push(e),
    });
    let compositionPixels;
    try {
      const canvas = await composed.render(0);
      const copy = new OffscreenCanvas(100, 100),
        p = copy.getContext("2d");
      p.drawImage(canvas, 0, 0);
      compositionPixels = [
        [45, 5],
        [85, 85],
        [75, 75],
      ].map(([x, y]) => [...p.getImageData(x, y, 1, 1).data]);
    } finally {
      composed.dispose();
    }
    const alphaWorld = World(
      () => Box({ width: 100, height: 100, fill: "#FF0000" }).opacity(0.5),
      { size: [100, 100] },
    );
    const alphaProject = {
      ...fixture,
      scenes: [
        {
          ...fixture.scenes[0],
          create: () =>
            Stage(
              () =>
                Composition(
                  World(() => Composition(alphaWorld), { size: [100, 100] }),
                ).opacity(0.5),
              { background: "#FFFFFF" },
            ),
        },
      ],
    };
    const alphaSource = await FrameSource.create(alphaProject, {
      width: 100,
      height: 100,
      onError: (e) => errors.push(e),
    });
    let compositionAlpha;
    try {
      const canvas = await alphaSource.render(0);
      const copy = new OffscreenCanvas(100, 100),
        p = copy.getContext("2d");
      p.drawImage(canvas, 0, 0);
      compositionAlpha = [...p.getImageData(50, 50, 1, 1).data];
    } finally {
      alphaSource.dispose();
    }
    const { renderAudio } = await import("/src/engine/render/audio.ts");
    const audioScenes = [0, 1].map((i) =>
      Shot({
        id: `audio-${i}`,
        source: "fixture",
        start: i,
        duration: 2,
        world: alphaWorld,
        transition: i ? { type: "crossfade", duration: 1 } : { type: "cut" },
      }),
    );
    const audioProject = {
      ...fixture,
      duration: 3,
      scenes: audioScenes,
      audioTracks: [
        {
          id: "tone",
          name: "tone",
          clips: [
            {
              id: "tone-a",
              name: "tone",
              sceneId: "audio-0",
              start: 0,
              duration: 2,
              create: () => ({
                schedule(host) {
                  const source = new ConstantSourceNode(host.context, {
                    offset: 0.2,
                  });
                  source.connect(host.destination);
                  source.start(host.at(0));
                  source.stop(host.at(2));
                },
              }),
            },
          ],
        },
      ],
    };
    const audioBuffer = await renderAudio(audioProject, [], 30);
    const audioEnvelopeSamples = [0.5, 1.5, 2.5].map(
      (t) =>
        audioBuffer.getChannelData(0)[Math.round(t * audioBuffer.sampleRate)],
    );
    if (
      Math.abs(audioEnvelopeSamples[0] - 0.21356) > 0.005 ||
      Math.abs(audioEnvelopeSamples[1] - audioEnvelopeSamples[0] * 0.5) >
        0.005 ||
      Math.abs(audioEnvelopeSamples[2]) > 0.001
    )
      throw Error(`Audio crossfade PCM mismatch: ${audioEnvelopeSamples}`);
    const { Path } = await import("/src/authoring/index.ts");
    const morphProject = {
      ...fixture,
      scenes: [
        {
          ...fixture.scenes[0],
          create: () =>
            Stage(
              () =>
                Path(
                  [
                    ["M", 0, 0],
                    ["L", 100, 0],
                    ["L", 100, 100],
                    ["L", 0, 100],
                    ["Z"],
                  ],
                  {
                    width: 100,
                    height: 100,
                    fill: "#FF0000",
                    to: [
                      ["M", 50, 0],
                      ["L", 100, 50],
                      ["L", 50, 100],
                      ["L", 0, 50],
                      ["Z"],
                    ],
                    progress: { from: 0, to: 1, duration: 1, ease: "linear" },
                  },
                ),
              { designSize: [100, 100], background: "#FFFFFF" },
            ),
        },
      ],
    };
    const morphSource = await FrameSource.create(morphProject, {
      width: 100,
      height: 100,
      onError: (e) => errors.push(e),
    });
    try {
      const pixels = [];
      for (const time of [0, 1, 0.5, 0]) {
        const canvas = await morphSource.render(time),
          copy = new OffscreenCanvas(100, 100),
          ctx = copy.getContext("2d");
        ctx.drawImage(canvas, 0, 0);
        pixels.push([...ctx.getImageData(5, 5, 1, 1).data]);
      }
      if (
        JSON.stringify(pixels[0]) !== JSON.stringify([255, 0, 0, 255]) ||
        JSON.stringify(pixels[1]) !== JSON.stringify([255, 255, 255, 255]) ||
        JSON.stringify(pixels[0]) !== JSON.stringify(pixels[3])
      )
        throw Error(`Path morph pixel mismatch: ${JSON.stringify(pixels)}`);
    } finally {
      morphSource.dispose();
    }
    const transitionPixels = {};
    for (const type of ["crossfade", "wipe", "slide", "zoom", "custom"]) {
      const red = World(
        () => Box({ width: 100, height: 100, fill: "#FF0000" }),
        { size: [100, 100] },
      );
      const blue = World(
        () => Box({ width: 100, height: 100, fill: "#0000FF" }),
        { size: [100, 100] },
      );
      const transitionProject = {
        ...fixture,
        duration: 3,
        scenes: [
          Shot({
            id: "a",
            source: "fixture.ts",
            start: 0,
            duration: 2,
            world: red,
          }),
          Shot({
            id: "b",
            source: "fixture.ts",
            start: 1,
            duration: 2,
            world: blue,
            transition: {
              type,
              duration: 1,
              ...(type === "custom"
                ? {
                    shader: `fn transition(uv: vec2f, progress: f32) -> vec4f { return mix(textureSample(outgoing,samp,uv),textureSample(incoming,samp,uv),progress); }`,
                  }
                : {}),
            },
          }),
        ],
      };
      const src = await FrameSource.create(transitionProject, {
        width: 100,
        height: 100,
        onError: (e) => errors.push(e),
      });
      try {
        const samples = [];
        for (const time of [0, 1.5, 2, 1.5]) {
          const canvas = await src.render(time);
          const copy = new OffscreenCanvas(100, 100),
            p = copy.getContext("2d");
          p.drawImage(canvas, 0, 0);
          samples.push(
            [25, 75].map((x) => [...p.getImageData(x, 50, 1, 1).data]),
          );
        }
        transitionPixels[type] = samples;
      } finally {
        src.dispose();
      }
    }
    const overlayChecks = [];
    const overlayProject = {
      ...fixture,
      duration: 3,
      overlay: () =>
        Overlay(
          ({ localTime, progress }) =>
            ZStack(
              [
                Box({ width: 12, height: 8, fill: "#00FF00" }).offset(8, 10),
                Box({ width: 10, height: 10, fill: "#FFFFFF" })
                  .opacity(0.5)
                  .offset(40, 40),
                Box({ width: 8, height: 8, fill: "#FFFF00" }).offset(
                  localTime * 10,
                  80,
                ),
                Box({ width: 8, height: 8, fill: "#FF00FF" }).offset(
                  progress * 30,
                  65,
                ),
                Box({ width: 38, height: 18, fill: "#102030" }).offset(6, 20),
                Text("HUD", { size: 10, color: "#FFFFFF" }).offset(8, 22),
              ],
              { align: "start" },
            ),
          { designSize: [100, 100] },
        ),
      scenes: [0, 1].map((i) =>
        Shot({
          id: `overlay-${i}`,
          source: "fixture.ts",
          start: i,
          duration: 2,
          world: World(
            () =>
              Box({ width: 100, height: 100, fill: i ? "#0000FF" : "#FF0000" }),
            { size: [100, 100] },
          ),
          camera: { x: 40, y: 40, zoom: 1.3 },
          overlay: () =>
            Box({ width: 5, height: 5, fill: "#00FFFF" }).offset(85, 10),
          transition: i ? { type: "zoom", duration: 1 } : { type: "cut" },
        }),
      ),
    };
    for (const [width, height] of [
      [100, 100],
      [200, 100],
    ]) {
      const src = await FrameSource.create(overlayProject, {
        width,
        height,
        onError: (e) => errors.push(e),
      });
      try {
        const captures = [];
        for (const time of [0.5, 1.5, 2.5, 1.5]) {
          const canvas = await src.render(time);
          const copy = new OffscreenCanvas(width, height),
            p = copy.getContext("2d");
          p.drawImage(canvas, 0, 0);
          const ox = (width - 100) / 2;
          const pixel = (x, y) => [...p.getImageData(ox + x, y, 1, 1).data];
          captures.push({
            time,
            marker: pixel(12, 14),
            outside: pixel(6, 14),
            alpha: pixel(45, 45),
            clock: pixel(time * 10 + 3, 84),
            progress: pixel((time / 3) * 30 + 3, 69),
            shotOverlay: pixel(87, 12),
            hud: [...p.getImageData(ox + 8, 22, 30, 15).data],
          });
        }
        overlayChecks.push({ width, height, captures });
      } finally {
        src.dispose();
      }
    }
    const sharedProject = {
      ...fixture,
      duration: 3,
      scenes: [0, 1].map((i) =>
        Shot({
          id: `shared-${i}`,
          source: "fixture.ts",
          start: i,
          duration: 2,
          world: World(
            () =>
              Box({ width: 20, height: 20, fill: "#FF0000" })
                .id("hero")
                .offset(i * 60, 40),
            { size: [100, 100] },
          ),
          transition: i ? { type: "shared", duration: 1 } : { type: "cut" },
        }),
      ),
    };
    const sharedSource = await FrameSource.create(sharedProject, {
      width: 100,
      height: 100,
      onError: (e) => errors.push(e),
    });
    let sharedPixels;
    try {
      const captures = [];
      for (const t of [1.5, 2.5, 1.5]) {
        const canvas = await sharedSource.render(t),
          copy = new OffscreenCanvas(100, 100),
          ctx = copy.getContext("2d");
        ctx.drawImage(canvas, 0, 0);
        captures.push(
          [10, 40, 70].map((x) => [...ctx.getImageData(x, 50, 1, 1).data]),
        );
      }
      if (JSON.stringify(captures[0]) !== JSON.stringify(captures[2]))
        throw Error("Shared-element seeking changed pixels.");
      sharedPixels = captures[0];
    } finally {
      sharedSource.dispose();
    }
    const { project: compositionExample } =
      await import("/examples/composition/manifest.ts");
    const compositionSource = await FrameSource.create(compositionExample, {
      width: 960,
      height: 540,
      onError: (e) => errors.push(e),
    });
    try {
      const captures = [];
      for (const time of [4.999, 5, 6, 7, 6]) {
        const canvas = await compositionSource.render(time);
        captures.push(
          Array.from(
            new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer()),
          ),
        );
      }
      if (JSON.stringify(captures[0]) !== JSON.stringify(captures[1]))
        throw Error("Matching shots changed pixels at the cut boundary.");
      if (JSON.stringify(captures[2]) !== JSON.stringify(captures[4]))
        throw Error("Overlap backward seek changed pixels.");
    } finally {
      compositionSource.dispose();
    }
    const textProject = {
      ...fixture,
      scenes: [
        {
          ...fixture.scenes[0],
          create: () =>
            Stage(
              () =>
                Text("Tracking\nText", {
                  size: 16,
                  tracking: 2,
                  color: "#202B38",
                }).frame({ width: "fill", height: "fill" }),
              { designSize: [100, 100], debugBounds: true },
            ),
        },
      ],
    };
    const textSource = await FrameSource.create(textProject, {
      width: 200,
      height: 100,
      onError: (e) => errors.push(e),
    });
    let letterboxPixel;
    try {
      const canvas = await textSource.render(0);
      const copy = new OffscreenCanvas(200, 100),
        p = copy.getContext("2d");
      p.drawImage(canvas, 0, 0);
      letterboxPixel = [...p.getImageData(10, 50, 1, 1).data];
    } finally {
      textSource.dispose();
    }
    const mp4 = await exportMp4(
      {
        ...compositionExample,
        overlay: () =>
          Overlay(
            () => Box({ width: 24, height: 12, fill: "#00FF00" }).offset(8, 8),
            { designSize: [320, 180] },
          ),
      },
      {
        width: 320,
        height: 180,
        fps: 24,
      },
    );
    const video = document.createElement("video");
    video.muted = true;
    const url = URL.createObjectURL(mp4.blob);
    let playback;
    try {
      const loaded = new Promise((resolve, reject) => {
        video.onloadeddata = resolve;
        video.onerror = () =>
          reject(Error("Exported MP4 could not be played."));
      });
      video.src = url;
      await loaded;
      const sought = new Promise((resolve, reject) => {
        video.onseeked = resolve;
        video.onerror = reject;
      });
      video.currentTime = 6.1;
      await sought;
      const decoded = new OffscreenCanvas(320, 180),
        pixels = decoded.getContext("2d");
      pixels.drawImage(video, 0, 0);
      playback = {
        overlayPixel: [...pixels.getImageData(16, 14, 1, 1).data],
        width: video.videoWidth,
        height: video.videoHeight,
        duration: video.duration,
      };
    } finally {
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    }
    return {
      title,
      chart,
      cameraPixels,
      overlayChecks,
      compositionPixels,
      compositionAlpha,
      transitionPixels,
      sharedPixels,
      audioEnvelopeSamples,
      cameraShots: cameraShots.slice(0, 3),
      pixel,
      tree,
      letterboxPixel,
      playback,
      errors,
      mp4Bytes: mp4.blob.size,
    };
  });
  const stageTwo = await validateStageTwo(page);
  console.log("Stage two validation:", JSON.stringify(stageTwo));
  assert.deepEqual(report.errors, []);
  for (const check of report.overlayChecks) {
    assert.deepEqual(
      check.captures[1],
      check.captures[3],
      "Overlay backward seek must reproduce pixels",
    );
    const hud = check.captures[0].hud;
    for (const capture of check.captures) {
      assert.deepEqual(capture.marker, [0, 255, 0, 255]);
      assert.notDeepEqual(
        capture.outside,
        [0, 255, 0, 255],
        "Overlay bounds must not zoom",
      );
      assert.deepEqual(capture.clock, [255, 255, 0, 255]);
      assert.deepEqual(capture.progress, [255, 0, 255, 255]);
      assert.deepEqual(
        capture.hud,
        hud,
        "Text overlay must remain fixed through transition",
      );
    }
    const alpha = check.captures[1].alpha;
    assert.ok(
      Math.abs(alpha[0] - 192) <= 2 &&
        Math.abs(alpha[1] - 128) <= 2 &&
        Math.abs(alpha[2] - 192) <= 2,
      `Overlay alpha: ${alpha}`,
    );
    assert.deepEqual(check.captures[0].shotOverlay, [0, 255, 255, 255]);
    assert.notDeepEqual(
      check.captures[1].shotOverlay,
      [0, 255, 255, 255],
      "Shot overlay must retain full-frame transition behavior",
    );
  }
  assert.deepEqual(report.sharedPixels[1], [255, 0, 0, 255]);
  assert.notDeepEqual(report.sharedPixels[0], [255, 0, 0, 255]);
  assert.notDeepEqual(report.sharedPixels[2], [255, 0, 0, 255]);
  assert.equal(report.tree.commands.length, 2);
  // Per-primitive opacity: white → half red → half blue.
  for (const [i, expected] of [128, 64, 191, 255].entries())
    assert.ok(
      Math.abs(report.pixel[i] - expected) <= 3,
      `Unexpected overlap pixel: ${report.pixel}`,
    );
  assert.deepEqual(report.letterboxPixel, [244, 240, 231, 255]);
  assert.ok(
    report.playback.overlayPixel[1] > 220 &&
      report.playback.overlayPixel[0] < 35 &&
      report.playback.overlayPixel[2] < 35,
    `Exported overlay pixel: ${report.playback.overlayPixel}`,
  );
  assert.equal(report.playback.width, 320);
  assert.equal(report.playback.height, 180);
  assert.ok(Math.abs(report.playback.duration - 9) < 0.05);
  assert.deepEqual(report.cameraPixels[0], [
    [255, 0, 0, 255],
    [255, 255, 255, 255],
    [255, 0, 0, 255],
  ]);
  assert.deepEqual(report.cameraPixels[1], [
    [255, 255, 255, 255],
    [255, 0, 0, 255],
    [255, 255, 255, 255],
  ]);
  assert.deepEqual(report.cameraPixels[2], report.cameraPixels[0]);
  assert.deepEqual(report.compositionPixels, [
    [0, 255, 0, 255],
    [0, 0, 255, 255],
    [255, 0, 0, 255],
  ]);
  assert.ok(
    report.compositionAlpha[0] === 255 &&
      Math.abs(report.compositionAlpha[1] - 191) <= 1 &&
      Math.abs(report.compositionAlpha[2] - 191) <= 1,
  );
  for (const [type, samples] of Object.entries(report.transitionPixels)) {
    assert.deepEqual(samples[0], [
      [255, 0, 0, 255],
      [255, 0, 0, 255],
    ]);
    assert.deepEqual(samples[2], [
      [0, 0, 255, 255],
      [0, 0, 255, 255],
    ]);
    assert.deepEqual(
      samples[1],
      samples[3],
      `${type}: overlap seek is deterministic`,
    );
    if (type === "crossfade" || type === "zoom" || type === "custom")
      for (const pixel of samples[1]) {
        assert.ok(
          Math.abs(pixel[0] - 128) <= 1 && Math.abs(pixel[2] - 128) <= 1,
        );
      }
    else assert.notDeepEqual(samples[1][0], samples[1][1]);
  }
  assert.ok(report.mp4Bytes > 1000);
  await mkdir(`${root}artifacts/authoring`, { recursive: true });
  await writeFile(
    `${root}artifacts/authoring/title.png`,
    Buffer.from(report.title),
  );
  await writeFile(
    `${root}artifacts/authoring/chart.png`,
    Buffer.from(report.chart),
  );
  for (const [i, name] of ["close", "wide", "focus"].entries()) {
    await writeFile(
      `${root}artifacts/authoring/camera-${name}.png`,
      Buffer.from(report.cameraShots[i]),
    );
  }
  console.log(
    JSON.stringify(
      {
        ...report,
        title: report.title.length,
        chart: report.chart.length,
        tree: "validated",
        cameraShots: report.cameraShots.map((shot) => shot.length),
        overlayChecks: report.overlayChecks.map(({ width, height }) => ({
          width,
          height,
          passed: true,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.close();
}
