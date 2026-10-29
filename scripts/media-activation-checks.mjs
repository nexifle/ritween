// Browser checks shared by validate-media; uses real decoding and GPU resources.
export async function checkMediaActivation(engineRoot) {
  const { Renderer } = await import(`${engineRoot}/render/renderer.ts`);
  const { videoClip, managedVideoScenes } = await import(
    `${engineRoot}/render/visual.ts`
  );
  const { byteSourceUsage } = await import(
    `${engineRoot}/media/byte-source.ts`
  );
  const activeOnly = globalThis.__ritweenMediaActivation === "active-only";
  const assert = (condition, message) => {
    if (!condition) throw Error(message);
  };
  const textures = new Map();
  const decoders = new Set();
  const frames = new Set();
  let peakTextureBytes = 0;
  let textureBytes = 0;
  let opens = [];
  let submitted = 0;
  const originalFetch = globalThis.fetch;
  const createTexture = GPUDevice.prototype.createTexture;
  const destroyTexture = GPUTexture.prototype.destroy;
  const submit = GPUQueue.prototype.submit;
  const Decoder = globalThis.VideoDecoder;
  const closeFrame = VideoFrame.prototype.close;
  const cloneFrame = VideoFrame.prototype.clone;
  const baseline = byteSourceUsage();
  GPUDevice.prototype.createTexture = function (descriptor) {
    const texture = createTexture.call(this, descriptor);
    if (
      descriptor.format === "rgba8unorm" &&
      descriptor.usage & GPUTextureUsage.TEXTURE_BINDING
    ) {
      const size = descriptor.size;
      const bytes = (size.width ?? size[0]) * (size.height ?? size[1]) * 4;
      textures.set(texture, bytes);
      textureBytes += bytes;
      peakTextureBytes = Math.max(peakTextureBytes, textureBytes);
    }
    return texture;
  };
  GPUTexture.prototype.destroy = function () {
    textureBytes -= textures.get(this) ?? 0;
    textures.delete(this);
    return destroyTexture.call(this);
  };
  GPUQueue.prototype.submit = function (...args) {
    submitted++;
    return submit.apply(this, args);
  };
  globalThis.VideoDecoder = class extends Decoder {
    constructor(init) {
      super({
        ...init,
        output: (frame) => {
          frames.add(frame);
          init.output(frame);
        },
      });
      decoders.add(this);
    }
    close() {
      decoders.delete(this);
      return super.close();
    }
  };
  VideoFrame.prototype.close = function () {
    frames.delete(this);
    return closeFrame.call(this);
  };
  VideoFrame.prototype.clone = function () {
    const frame = cloneFrame.call(this);
    frames.add(frame);
    return frame;
  };
  let delayed;
  let fail = false;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("activation=")) {
      opens.push(String(url));
      if (fail) return new Response("failed", { status: 503 });
      if (delayed) {
        const current = delayed;
        delayed = undefined;
        current.started();
        await new Promise((resolve, reject) => {
          const abort = () => reject(options.signal.reason);
          options.signal.addEventListener("abort", abort, { once: true });
          current.release = () => {
            options.signal.removeEventListener("abort", abort);
            resolve();
          };
          if (options.signal.aborted) abort();
        });
      }
    }
    return originalFetch(url, options);
  };
  const make = () => ({
    name: "Activation lifecycle",
    resolution: [320, 180],
    aspectRatio: [16, 9],
    duration: 1.5,
    scenes: [0, 1, 2].map((i) =>
      videoClip({
        id: `a${i}`,
        name: `A${i}`,
        source: "manifest.ts",
        url: `/media/source.mp4?activation=${i}`,
        start: i * 0.5,
        trim: { in: i * 0.25, out: i * 0.25 + 0.5 },
        audio: { muted: true },
      }),
    ),
  });
  const idle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const balanced = () => {
    const usage = byteSourceUsage();
    assert(
      textureBytes === 0 && decoders.size === 0 && frames.size === 0,
      `Native ownership retained: textures=${textureBytes}, decoders=${decoders.size}, frames=${frames.size}`,
    );
    assert(
      JSON.stringify(usage) === JSON.stringify(baseline),
      `Encoded ownership retained: ${JSON.stringify(usage)}`,
    );
  };
  const rejected = async (work) => {
    let error;
    try {
      await work;
    } catch (e) {
      error = e;
    }
    assert(error, "Expected activation rejection");
    return error.name;
  };
  try {
    const cycles = [];
    for (let cycle = 0; cycle < 21; cycle++) {
      opens = [];
      const renderer = await Renderer.create(
        new OffscreenCanvas(320, 180),
        make(),
      );
      try {
        assert(
          opens.length === (activeOnly ? 0 : 3),
          "Unexpected setup video opens",
        );
        for (const [index, time] of [0, 0.5, 0, 1, 0.5, 0].entries()) {
          await renderer.renderAsync(time);
          await renderer.device.queue.onSubmittedWorkDone();
          assert(
            textures.size === (activeOnly ? 1 : 3),
            "Inactive scene retained a texture",
          );
          if (activeOnly && index === 0)
            assert(opens.length === 1, "Future video opened before needed");
        }
      } finally {
        renderer.dispose();
      }
      await idle();
      balanced();
      cycles.push({ cycle, opens: opens.length, retained: byteSourceUsage() });
    }
    const failures = [];
    if (activeOnly) {
      for (const action of [
        "failure",
        "abort",
        "dispose",
        "deactivate",
        "binding",
      ]) {
        const project = make();
        let target;
        const create = project.scenes[0].create;
        project.scenes[0].create = () => (target = create());
        const renderer = await Renderer.create(
          new OffscreenCanvas(320, 180),
          project,
        );
        const before = submitted;
        let release;
        const createBindGroup = GPUDevice.prototype.createBindGroup;
        try {
          const controller = new AbortController();
          let started;
          const loading = new Promise((resolve) => {
            started = resolve;
          });
          const gate = { started, release: () => {} };
          if (action === "failure") fail = true;
          else if (action === "binding")
            GPUDevice.prototype.createBindGroup = () => {
              throw Error("Injected binding failure");
            };
          else delayed = gate;
          const work = renderer.renderAsync(0, controller.signal);
          // Observe rejection before triggering cancellation.
          const outcome = rejected(work);
          if (action !== "failure" && action !== "binding") {
            await loading;
            release = gate.release;
            if (action === "abort") controller.abort();
            if (action === "dispose") renderer.dispose();
            if (action === "deactivate")
              managedVideoScenes.get(target).deactivate();
          }
          const name = await outcome;
          fail = false;
          GPUDevice.prototype.createBindGroup = createBindGroup;
          assert(submitted === before, "Failed activation submitted a frame");
          if (action !== "failure" && action !== "binding")
            assert(name === "AbortError", `Wrong cancellation: ${name}`);
          if (action !== "dispose") {
            await renderer.renderAsync(0);
            await renderer.device.queue.onSubmittedWorkDone();
          }
          failures.push({ action, name, recovered: action !== "dispose" });
        } finally {
          fail = false;
          GPUDevice.prototype.createBindGroup = createBindGroup;
          release?.();
          renderer.dispose();
        }
        await idle();
        balanced();
      }
    }
    const shared = make();
    for (const scene of shared.scenes) {
      const index = shared.scenes.indexOf(scene);
      shared.scenes[index] = videoClip({
        id: scene.id,
        name: scene.name,
        source: "manifest.ts",
        url: "/media/source.mp4",
        start: scene.start,
        trim: { in: index * 0.25, out: index * 0.25 + 0.5 },
        audio: { muted: true },
      });
    }
    const sharedRenderer = await Renderer.create(
      new OffscreenCanvas(320, 180),
      shared,
    );
    try {
      for (const time of [0, 0.5, 1, 0]) await sharedRenderer.renderAsync(time);
    } finally {
      sharedRenderer.dispose();
    }
    await idle();
    balanced();
    const { FrameSource } = await import(
      `${engineRoot}/render/frame-source.ts`
    );
    const offline = await FrameSource.create(make(), {
      width: 320,
      height: 180,
    });
    const hashes = [];
    try {
      for (let index = 0; index < 36; index++) {
        const canvas = await offline.render(index / 24);
        const copy = new OffscreenCanvas(320, 180);
        const context = copy.getContext("2d");
        context.drawImage(canvas, 0, 0);
        const hash = await crypto.subtle.digest(
          "SHA-256",
          context.getImageData(0, 0, 320, 180).data,
        );
        hashes.push(
          Array.from(new Uint8Array(hash), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join(""),
        );
      }
    } finally {
      offline.dispose();
    }
    const { exportMp4 } = await import(
      `${engineRoot}/export/formats/mp4/export-mp4.ts`
    );
    const controller = new AbortController();
    const cancellation = await rejected(
      exportMp4(make(), {
        width: 320,
        height: 180,
        fps: 24,
        signal: controller.signal,
        onProgress: (done) => {
          if (done >= 2) controller.abort();
        },
      }),
    );
    assert(cancellation === "AbortError", "Export cancellation failed");
    await idle();
    balanced();
    return {
      activeOnly,
      cycles,
      failures,
      offlineHashes: hashes,
      exportCancellation: cancellation,
      peakTextureBytes,
      retainedTextureBytes: textureBytes,
      retainedDecoders: decoders.size,
      retainedFrames: frames.size,
      encodedBaseline: baseline,
      encodedAfter: byteSourceUsage(),
    };
  } finally {
    globalThis.fetch = originalFetch;
    GPUDevice.prototype.createTexture = createTexture;
    GPUTexture.prototype.destroy = destroyTexture;
    GPUQueue.prototype.submit = submit;
    globalThis.VideoDecoder = Decoder;
    VideoFrame.prototype.close = closeFrame;
    VideoFrame.prototype.clone = cloneFrame;
  }
}
