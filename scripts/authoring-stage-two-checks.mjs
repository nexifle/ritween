import assert from "node:assert/strict";

/** Real GPU/media checks shared by the authoring browser validator. */
export async function validateStageTwo(page) {
  const assets = await page.evaluate(async () => {
    const { exportMp4, Stage, Box } = await import("/src/index.ts");
    const image = new OffscreenCanvas(100, 50);
    const p = image.getContext("2d");
    p.fillStyle = "#00FF00";
    p.fillRect(0, 0, 50, 50);
    p.fillStyle = "#FFFF00";
    p.fillRect(50, 0, 50, 50);
    const video = await exportMp4(
      {
        name: "Stage two footage",
        resolution: [100, 100],
        aspectRatio: [1, 1],
        duration: 2,
        scenes: [
          {
            id: "source",
            name: "Source",
            source: "fixture",
            start: 0,
            duration: 2,
            transition: { type: "cut" },
            create: () =>
              Stage(({ localTime }) =>
                Box({
                  width: 100,
                  height: 100,
                  fill: localTime < 1 ? "#FF0000" : "#0000FF",
                }),
              ),
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
                    const oscillator = host.context.createOscillator();
                    const gain = host.context.createGain();
                    gain.gain.value = 0.1;
                    oscillator.connect(gain).connect(host.destination);
                    oscillator.start(host.at(0));
                    oscillator.stop(host.at(host.duration));
                  },
                }),
              },
            ],
          },
        ],
      },
      { width: 100, height: 100, fps: 24 },
    );
    return {
      image: [
        ...new Uint8Array(await (await image.convertToBlob()).arrayBuffer()),
      ],
      video: [...new Uint8Array(await video.blob.arrayBuffer())],
    };
  });
  await page.route("**/__authoring-image.png", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(assets.image),
    }),
  );
  await page.route("**/__authoring-video.mp4", (route) =>
    route.fulfill({
      contentType: "video/mp4",
      body: Buffer.from(assets.video),
    }),
  );
  const report = await page.evaluate(async () => {
    const {
      Stage,
      Overlay,
      FrameSource,
      Box,
      Circle,
      Line,
      Image,
      Video,
      Group,
      ForEach,
      HStack,
      World,
      Composition,
      Shot,
      Motion,
      videoResource,
      resolveMediaProject,
      exportMp4,
    } = await import("/src/index.ts");
    const { renderAudio } = await import("/src/engine/render/audio.ts");
    const errors = [];
    const entry = (create) => ({
      id: "fixture",
      name: "Fixture",
      source: "fixture",
      start: 0,
      duration: 2,
      transition: { type: "cut" },
      create,
    });
    const project = (scene) => ({
      name: "Stage two",
      resolution: [100, 100],
      aspectRatio: [1, 1],
      duration: 2,
      scenes: [scene],
    });
    const pixels = (canvas, points) => {
      const copy = new OffscreenCanvas(canvas.width, canvas.height);
      const p = copy.getContext("2d");
      p.drawImage(canvas, 0, 0);
      return points.map(([x, y]) => [...p.getImageData(x, y, 1, 1).data]);
    };
    const draw = async (p, times, points) => {
      const source = await FrameSource.create(p, {
        width: 100,
        height: 100,
        onError: (e) => errors.push(e),
      });
      try {
        const captures = [];
        for (const t of times)
          captures.push(pixels(await source.render(t), points));
        return captures;
      } finally {
        source.dispose();
      }
    };
    const shapes = await draw(
      project(
        entry(() =>
          Stage(
            () =>
              Group([
                Circle({
                  radius: 40,
                  stroke: "#FF0000",
                  strokeWidth: 10,
                  trim: [0, { from: 0, to: 0.5, duration: 1, ease: "linear" }],
                }).offset(10, 10),
                Line({
                  from: [0, 0],
                  to: [60, 0],
                  width: 6,
                  color: "#0000FF",
                  progress: { from: 0, to: 1, duration: 1 },
                }).offset(20, 47),
              ]),
            { background: "#FFFFFF" },
          ),
        ),
      ),
      [0, 1, 0.5, 1],
      [
        [85, 50],
        [15, 50],
        [50, 50],
        [30, 50],
      ],
    );
    const images = {};
    for (const fit of ["contain", "cover"]) {
      images[fit] = await draw(
        project(
          entry(() =>
            Stage(
              () =>
                Image({
                  url: "/__authoring-image.png",
                  width: 100,
                  height: 100,
                  fit,
                }),
              { background: "#FFFFFF" },
            ),
          ),
        ),
        [0, 1, 0],
        [
          [10, 10],
          [10, 50],
          [90, 50],
        ],
      );
    }
    let evaluations = 0;
    const clip = videoResource({
      id: "footage",
      name: "Footage",
      url: "/__authoring-video.mp4",
      start: 0,
      duration: 2,
    });
    const world = World(
      () => {
        evaluations++;
        return Group([
          Video(clip, { width: 100, height: 100 }),
          HStack(
            ForEach(
              ["left", "right"],
              (id) => id,
              () =>
                Circle({ radius: 5, fill: "#00FF00" }).opacity(
                  Motion.fade({ duration: 0.2 }),
                ),
            ),
            { gap: 10 },
          ).offset(10, 10),
        ]);
      },
      { size: [100, 100] },
    );
    const shot = Shot({
      id: "shot",
      source: "fixture",
      start: 0,
      duration: 2,
      world,
      mediaClips: [clip],
    });
    const videos = {};
    for (const mode of ["eager", "active-only"]) {
      globalThis.__ritweenMediaActivation = mode;
      const p = {
        ...project(shot),
        overlay: () =>
          Overlay(() =>
            Box({ width: 5, height: 5, fill: "#FFFF00" }).offset(90, 90),
          ),
      };
      const source = await FrameSource.create(p, {
        width: 100,
        height: 100,
        onError: (e) => errors.push(e),
      });
      try {
        const captures = [];
        evaluations = 0;
        for (const time of [0.5, 1.5, 0.5])
          captures.push(
            pixels(await source.render(time), [
              [50, 50],
              [15, 15],
              [92, 92],
            ]),
          );
        videos[mode] = { captures, evaluations };
      } finally {
        source.dispose();
      }
    }
    const shifted = videoResource({ ...clip, id: "second-footage", start: 1 });
    const overlapProject = {
      ...project(shot),
      duration: 3,
      scenes: [
        shot,
        Shot({
          id: "second",
          source: "fixture",
          start: 1,
          duration: 2,
          transition: { type: "crossfade", duration: 1 },
          mediaClips: [shifted],
          world: World(() => Video(shifted, { width: 100, height: 100 }), {
            size: [100, 100],
          }),
        }),
      ],
    };
    const overlap = await draw(
      overlapProject,
      [1.5, 2.5, 0.5, 1.5],
      [[50, 50]],
    );
    // The remapped World clock must not remap the clip's project-clock video/audio.
    const frozen = project(
      entry(() =>
        Stage(() => Composition(world, { rate: 0, offset: 20 }), {
          mediaClips: [clip],
        }),
      ),
    );
    const frozenVideo = await draw(frozen, [0.5, 1.5, 0.5], [[50, 50]]);
    const p = project(shot);
    const resolved = resolveMediaProject(p);
    const audio = await renderAudio(p, [], 24);
    const pcm = audio.getChannelData(0);
    const rms = Math.sqrt(
      pcm.reduce((sum, value) => sum + value * value, 0) / pcm.length,
    );
    const exported = await exportMp4(p, { width: 100, height: 100, fps: 24 });
    const lateImage = await draw(
      project(
        entry(() =>
          Stage(
            ({ localTime }) =>
              localTime < 1
                ? Box({ width: 1, height: 1 })
                : Image({
                    url: "/__authoring-image.png",
                    width: 100,
                    height: 100,
                  }),
            { images: ["/__authoring-image.png"] },
          ),
        ),
      ),
      [0, 1.5, 0, 1.5],
      [[10, 50]],
    );
    delete globalThis.__ritweenMediaActivation;
    return {
      shapes,
      images,
      videos,
      frozenVideo,
      overlap,
      lateImage,
      audio: { rms, sceneId: resolved.audioTracks[0].clips[0].sceneId },
      exportedBytes: exported.blob.size,
      errors,
    };
  });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.shapes[0], Array(4).fill([255, 255, 255, 255]));
  assert.deepEqual(report.shapes[1], [
    [255, 0, 0, 255],
    [255, 255, 255, 255],
    [0, 0, 255, 255],
    [0, 0, 255, 255],
  ]);
  assert.deepEqual(report.shapes[1], report.shapes[3]);
  assert.deepEqual(report.images.contain[0], [
    [255, 255, 255, 255],
    [0, 255, 0, 255],
    [255, 255, 0, 255],
  ]);
  assert.deepEqual(report.images.cover[0], [
    [0, 255, 0, 255],
    [0, 255, 0, 255],
    [255, 255, 0, 255],
  ]);
  for (const result of Object.values(report.videos)) {
    assert.equal(
      result.evaluations,
      3,
      "One tree evaluation per prepared frame",
    );
    assert.deepEqual(result.captures[0], result.captures[2]);
    for (const [i, capture] of result.captures.entries()) {
      assert.ok(
        capture[0][i === 1 ? 2 : 0] > 235,
        `Video frame: ${capture[0]}`,
      );
      assert.deepEqual(capture[1], [0, 255, 0, 255]);
      assert.deepEqual(capture[2], [255, 255, 0, 255]);
    }
  }
  assert.deepEqual(report.overlap[0], report.overlap[3]);
  assert.ok(
    Math.abs(report.overlap[0][0][0] - 128) < 5 &&
      Math.abs(report.overlap[0][0][2] - 128) < 5,
  );
  assert.deepEqual(report.frozenVideo[0], report.frozenVideo[2]);
  assert.ok(report.frozenVideo[0][0][0] > 235);
  assert.ok(report.frozenVideo[1][0][2] > 235);
  assert.deepEqual(report.lateImage[1], report.lateImage[3]);
  assert.deepEqual(report.lateImage[1][0], [0, 255, 0, 255]);
  assert.ok(report.audio.rms > 0.01);
  assert.equal(report.audio.sceneId, "shot");
  assert.ok(report.exportedBytes > 1000);
  return report;
}
