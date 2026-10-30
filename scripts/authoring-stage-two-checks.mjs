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
    const png = async (draw) => {
      const canvas = new OffscreenCanvas(100, 100);
      draw(canvas.getContext("2d"));
      return [
        ...new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer()),
      ];
    };
    return {
      image: [
        ...new Uint8Array(await (await image.convertToBlob()).arrayBuffer()),
      ],
      video: [...new Uint8Array(await video.blob.arrayBuffer())],
      alphaMask: await png((p) => {
        p.clearRect(0, 0, 100, 100);
        p.fillStyle = "#FFFFFF";
        p.fillRect(0, 0, 50, 100);
      }),
      lumaMask: await png((p) => {
        p.fillStyle = "#FFFFFF";
        p.fillRect(0, 0, 50, 100);
        p.fillStyle = "#000000";
        p.fillRect(50, 0, 50, 100);
      }),
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
  await page.route("**/__authoring-alpha-mask.png", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(assets.alphaMask),
    }),
  );
  await page.route("**/__authoring-luma-mask.png", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(assets.lumaMask),
    }),
  );
  const report = await page.evaluate(async () => {
    const {
      Stage,
      StageEntry,
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
    const groupOpacity = await draw(
      project(
        entry(() =>
          Stage(
            ({ localTime }) =>
              Group([
                Box({ width: 60, height: 60, fill: "#FF0000" }),
                Box({ width: 60, height: 60, fill: "#0000FF" }).offset(20, 0),
              ])
                .offset(10, 20)
                .opacity({ from: 0, to: 1, duration: 2, ease: "linear" }),
            { background: "#FFFFFF" },
          ),
        ),
      ),
      [1, 0, 2, 1],
      [
        [15, 40],
        [40, 40],
        [85, 40],
        [95, 40],
      ],
    );
    const nestedGroupOpacity = await draw(
      project(
        entry(() =>
          Stage(
            () =>
              Group([
                Box({ width: 60, height: 60, fill: "#FF0000" }),
                Group([
                  Box({ width: 60, height: 60, fill: "#0000FF" }).opacity(0.5),
                ])
                  .opacity(0.5)
                  .offset(20, 0),
              ])
                .opacity(0.5)
                .scale(-1, 1, [0, 0])
                .offset(90, 20),
            { background: "#FFFFFF" },
          ),
        ),
      ),
      [0, 1, 0],
      [
        [80, 40],
        [50, 40],
        [20, 40],
        [5, 40],
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
    const clipping = {};
    for (const shape of [
      { shape: "rect", radius: 20 },
      { shape: "circle" },
      {
        shape: "path",
        outline: [["M", 50, 0], ["L", 100, 100], ["L", 0, 100], ["Z"]],
      },
    ]) {
      clipping[shape.shape] = await draw(
        project(
          entry(() =>
            Stage(
              () =>
                Box({ width: 150, height: 150, fill: "#FF0000" })
                  .frame({ width: 100, height: 100 })
                  .clip(shape),
              { background: "#FFFFFF" },
            ),
          ),
        ),
        [1, 0, 1],
        [
          [1, 1],
          [50, 50],
          [98, 50],
        ],
      );
    }
    const imageMasks = {};
    for (const [name, shape] of [
      ["alpha", { shape: "image", url: "/__authoring-alpha-mask.png" }],
      [
        "luminance",
        {
          shape: "image",
          url: "/__authoring-luma-mask.png",
          mode: "luminance",
        },
      ],
      ["opaqueAlpha", { shape: "image", url: "/__authoring-luma-mask.png" }],
    ]) {
      imageMasks[name] = await draw(
        project(
          entry(() =>
            Stage(
              () =>
                Box({ width: 100, height: 100, fill: "#FF0000" }).clip(shape),
              { background: "#00FFFF" },
            ),
          ),
        ),
        [1.5, 0, 1.5],
        [
          [10, 50],
          [90, 50],
        ],
      );
    }
    const lateMask = await draw(
      project(
        entry(() =>
          Stage(
            ({ localTime }) =>
              localTime < 1
                ? Box({ width: 100, height: 100, fill: "#FF0000" })
                : Box({ width: 100, height: 100, fill: "#FF0000" }).clip({
                    shape: "image",
                    url: "/__authoring-alpha-mask.png",
                  }),
            { background: "#00FFFF" },
          ),
        ),
      ),
      [1.5, 0, 1.5],
      [
        [10, 50],
        [90, 50],
      ],
    );
    const cropped = await draw(
      project(
        entry(() =>
          Stage(() =>
            Image({
              url: "/__authoring-image.png",
              width: 100,
              height: 100,
              crop: { x: 0.9, zoom: 2 },
            }),
          ),
        ),
      ),
      [0, 1, 0],
      [
        [10, 50],
        [90, 50],
      ],
    );
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
    const shot = StageEntry({
      id: "shot",
      source: "fixture",
      start: 0,
      duration: 2,
      view: world.view,
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
    const overlap = {};
    const preparations = { outgoing: 0, incoming: 0 };
    const makeOverlap = (type) => {
      const start = type === "cut" ? 2 : 1;
      const outgoing = videoResource({ ...clip, id: "outgoing", volume: 0.5 });
      const incoming = videoResource({ ...clip, id: "incoming", start, volume: 0.8 });
      const scene = (resource, id, transition) => Shot({
        id,
        source: "fixture",
        start: resource.start,
        duration: 2,
        transition,
        mediaClips: [resource],
        world: World(() => {
          preparations[id]++;
          return Video(resource, { width: 100, height: 100 });
        }, {
          size: [100, 100],
        }),
      });
      return {
        ...project(shot),
        duration: start + 2,
        scenes: [
          scene(outgoing, "outgoing", { type: "cut" }),
          scene(incoming, "incoming", type === "cut"
            ? { type: "cut" }
            : { type, duration: 1, direction: "left" }),
        ],
      };
    };
    const points = [[25, 50], [75, 50]];
    for (const mode of ["eager", "active-only"]) {
      globalThis.__ritweenMediaActivation = mode;
      overlap[mode] = {};
      for (const type of ["crossfade", "wipe", "slide", "cut"]) {
        const p = makeOverlap(type);
        const times = type === "cut" ? [0.5, 2, 2.5, 3, 4] : [0.5, 1, 1.5, 2, 3];
        const sequential = await draw(p, [...times, ...times.slice().reverse()], points);
        const direct = [];
        for (const time of times) direct.push((await draw(p, [time], points))[0]);
        let prepared;
        if (type !== "cut") {
          const source = await FrameSource.create(p, { width: 100, height: 100, onError: (e) => errors.push(e) });
          try {
            const before = { ...preparations };
            await source.render(1.5);
            prepared = Object.fromEntries(Object.keys(before).map((id) => [id, preparations[id] - before[id]]));
          } finally {
            source.dispose();
          }
        }
        overlap[mode][type] = { times, sequential, direct, prepared };
      }
    }
    const overlapAudioProject = makeOverlap("crossfade");
    const overlapResolved = resolveMediaProject(overlapAudioProject);
    const trackIds = overlapResolved.audioTracks.map((track) => track.id);
    const audioBuffers = await Promise.all([
      renderAudio(overlapAudioProject, [], 24),
      renderAudio(overlapAudioProject, [trackIds[1]], 24),
      renderAudio(overlapAudioProject, [trackIds[0]], 24),
    ]);
    const audioTimes = [0.5, 1, 1.5, 1.99, 2.5];
    const overlapAudio = {
      tracks: overlapResolved.audioTracks.map((track) => ({
        id: track.id,
        clips: track.clips.map(({ id, sceneId }) => ({ id, sceneId })),
      })),
      rms: audioBuffers.map((buffer) => audioTimes.map((time) => {
        const pcm = buffer.getChannelData(0);
        const start = Math.round(time * buffer.sampleRate);
        const length = Math.round(0.005 * buffer.sampleRate);
        return Math.sqrt(pcm.slice(start, start + length).reduce((sum, x) => sum + x * x, 0) / length);
      })),
    };
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
          Stage(({ localTime }) =>
            localTime < 1
              ? Box({ width: 1, height: 1 })
              : Image({
                  url: "/__authoring-image.png",
                  width: 100,
                  height: 100,
                }),
          ),
        ),
      ),
      [1.5, 0, 1.5, 0, 1.5],
      [[10, 50]],
    );
    delete globalThis.__ritweenMediaActivation;
    return {
      shapes,
      clipping,
      imageMasks,
      lateMask,
      cropped,
      groupOpacity,
      nestedGroupOpacity,
      images,
      videos,
      frozenVideo,
      overlap,
      overlapAudio,
      lateImage,
      audio: { rms, sceneId: resolved.audioTracks[0].clips[0].sceneId },
      exportedBytes: exported.blob.size,
      errors,
    };
  });
  assert.deepEqual(report.errors, []);
  for (const captures of Object.values(report.clipping)) {
    assert.deepEqual(captures[0], captures[2]);
    assert.deepEqual(captures[0][0], [255, 255, 255, 255]);
    assert.deepEqual(captures[0][1], [255, 0, 0, 255]);
  }
  assert.deepEqual(report.imageMasks.alpha[0], report.imageMasks.alpha[2]);
  assert.deepEqual(report.imageMasks.alpha[0], [
    [255, 0, 0, 255],
    [0, 255, 255, 255],
  ]);
  assert.deepEqual(report.imageMasks.luminance[0], report.imageMasks.alpha[0]);
  assert.deepEqual(report.imageMasks.opaqueAlpha[0], [
    [255, 0, 0, 255],
    [255, 0, 0, 255],
  ]);
  assert.deepEqual(report.lateMask[0], report.lateMask[2]);
  assert.deepEqual(report.lateMask[0], report.imageMasks.alpha[0]);
  assert.deepEqual(report.lateMask[1], [
    [255, 0, 0, 255],
    [255, 0, 0, 255],
  ]);
  assert.deepEqual(report.cropped[0], [
    [255, 255, 0, 255],
    [255, 255, 0, 255],
  ]);
  assert.deepEqual(report.shapes[0], Array(4).fill([255, 255, 255, 255]));
  assert.deepEqual(report.shapes[1], [
    [255, 0, 0, 255],
    [255, 255, 255, 255],
    [0, 0, 255, 255],
    [0, 0, 255, 255],
  ]);
  assert.deepEqual(report.shapes[1], report.shapes[3]);
  const near = (actual, expected) =>
    expected.forEach((value, i) =>
      assert.ok(Math.abs(actual[i] - value) <= 2, `${actual} != ${expected}`),
    );
  assert.deepEqual(report.groupOpacity[0], report.groupOpacity[3]);
  near(report.groupOpacity[0][0], [255, 128, 128, 255]);
  near(report.groupOpacity[0][1], [128, 128, 255, 255]);
  near(report.groupOpacity[0][2], [128, 128, 255, 255]);
  assert.deepEqual(report.groupOpacity[0][3], [255, 255, 255, 255]);
  assert.deepEqual(report.groupOpacity[1], Array(4).fill([255, 255, 255, 255]));
  assert.deepEqual(report.groupOpacity[2][1], [0, 0, 255, 255]);
  assert.deepEqual(report.nestedGroupOpacity[0], report.nestedGroupOpacity[2]);
  near(report.nestedGroupOpacity[0][0], [255, 128, 128, 255]);
  near(report.nestedGroupOpacity[0][1], [223, 128, 159, 255]);
  near(report.nestedGroupOpacity[0][2], [223, 223, 255, 255]);
  assert.deepEqual(report.nestedGroupOpacity[0][3], [255, 255, 255, 255]);
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
  const color = (pixel, expected) => expected.forEach((value, i) =>
    assert.ok(Math.abs(pixel[i] - value) < 12, `${pixel} != ${expected}`),
  );
  const red = [255, 0, 0, 255], blue = [0, 0, 255, 255];
  for (const [mode, transitions] of Object.entries(report.overlap)) {
    for (const [type, result] of Object.entries(transitions)) {
      const { sequential, direct } = result;
      if (type !== "cut") assert.deepEqual(result.prepared, { outgoing: 1, incoming: 1 }, `${mode}/${type} prepares both videos`);
      assert.deepEqual(sequential.slice(0, 5), direct, `${mode}/${type} direct`);
      assert.deepEqual(sequential.slice(5).reverse(), direct, `${mode}/${type} backwards`);
      const expected = type === "cut"
        ? [[red, red], [red, red], [red, red], [blue, blue], [blue, blue]]
        : [[red, red], [blue, blue],
          type === "crossfade" ? [[128, 0, 128, 255], [128, 0, 128, 255]] : [blue, red],
          [blue, blue], [blue, blue]];
      direct.forEach((capture, i) => capture.forEach((pixel, j) => color(pixel, expected[i][j])));
    }
  }
  assert.deepEqual(report.overlapAudio.tracks.map((track) => track.clips), [
    [{ id: "outgoing", sceneId: "outgoing" }],
    [{ id: "incoming", sceneId: "incoming" }],
  ]);
  const [mixed, outgoingAudio, incomingAudio] = report.overlapAudio.rms;
  assert.ok(outgoingAudio[0] > 0.01 && incomingAudio[4] > 0.01);
  assert.ok(Math.abs(outgoingAudio[0] / report.audio.rms - 0.5) < 0.04);
  assert.ok(Math.abs(incomingAudio[4] / report.audio.rms - 0.8) < 0.04);
  assert.ok(incomingAudio[1] < 0.001 && outgoingAudio[4] < 0.001);
  assert.ok(Math.abs(outgoingAudio[2] / outgoingAudio[0] - 0.5) < 0.06);
  assert.ok(Math.abs(incomingAudio[2] / incomingAudio[4] - 0.5) < 0.06);
  assert.ok(outgoingAudio[3] < outgoingAudio[0] * 0.03);
  assert.ok(Math.abs(incomingAudio[3] / incomingAudio[4] - 1) < 0.06);
  // Both clips use the same encoded tone, so their in-phase PCM adds at the midpoint.
  assert.ok(Math.abs(mixed[2] - outgoingAudio[2] - incomingAudio[2]) < 0.002);
  assert.deepEqual(report.frozenVideo[0], report.frozenVideo[2]);
  assert.ok(report.frozenVideo[0][0][0] > 235);
  assert.ok(report.frozenVideo[1][0][2] > 235);
  assert.deepEqual(report.lateImage[0], report.lateImage[2]);
  assert.deepEqual(report.lateImage[0], report.lateImage[4]);
  assert.deepEqual(report.lateImage[0][0], [0, 255, 0, 255]);
  assert.notDeepEqual(report.lateImage[0], report.lateImage[1]);
  assert.ok(report.audio.rms > 0.01);
  assert.equal(report.audio.sceneId, "shot");
  assert.ok(report.exportedBytes > 1000);
  return report;
}
