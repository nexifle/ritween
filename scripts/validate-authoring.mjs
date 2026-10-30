import assert from "node:assert/strict";
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
    const transitionPixels = {};
    for (const type of ["crossfade", "wipe", "slide", "zoom"]) {
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
            transition: { type, duration: 1 },
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
    const mp4 = await exportMp4(compositionExample, {
      width: 320,
      height: 180,
      fps: 24,
    });
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
      playback = {
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
      compositionPixels,
      compositionAlpha,
      transitionPixels,
      cameraShots: cameraShots.slice(0, 3),
      pixel,
      tree,
      letterboxPixel,
      playback,
      errors,
      mp4Bytes: mp4.blob.size,
    };
  });
  assert.deepEqual(report.errors, []);
  assert.equal(report.tree.commands.length, 2);
  // Per-primitive opacity: white → half red → half blue.
  for (const [i, expected] of [128, 64, 191, 255].entries())
    assert.ok(
      Math.abs(report.pixel[i] - expected) <= 3,
      `Unexpected overlap pixel: ${report.pixel}`,
    );
  assert.deepEqual(report.letterboxPixel, [244, 240, 231, 255]);
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
    if (type === "crossfade" || type === "zoom")
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
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.close();
}
