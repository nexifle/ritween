import assert from "node:assert/strict";
import test from "node:test";
import { FrameSource } from "../src/engine/render/frame-source";
import { Renderer } from "../src/engine/render/renderer";
import type { Project, RenderContext, Scene } from "../src/engine/types";

test("offline frames wait for GPU completion, reuse the canvas and honor cancellation", async () => {
  const originalCreate = Renderer.create;
  const originalCanvas = globalThis.OffscreenCanvas;
  const times: number[] = [];
  let disposed = 0;
  let complete!: () => void;
  const gpuWork = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const controller = new AbortController();
  globalThis.OffscreenCanvas = class {
    constructor(
      readonly width: number,
      readonly height: number,
    ) {}
  } as typeof OffscreenCanvas;
  Renderer.create = async () =>
    ({
      renderAsync: async (time: number) => {
        times.push(time);
      },
      device: { queue: { onSubmittedWorkDone: () => gpuWork } },
      dispose: () => {
        disposed++;
      },
    }) as unknown as Renderer;
  try {
    const source = await FrameSource.create({} as Project, {
      width: 320,
      height: 240,
      signal: controller.signal,
    });
    try {
      let resolved = false;
      const first = source.render(0).then((canvas) => {
        resolved = true;
        return canvas;
      });
      await Promise.resolve();
      assert.equal(resolved, false);
      complete();
      const canvas = await first;
      assert.equal(canvas.width, 320);
      assert.equal(canvas.height, 240);
      assert.equal(await source.render(0.5), canvas);
      const reason = Error("cancelled");
      controller.abort(reason);
      await assert.rejects(source.render(1), (error) => error === reason);
      assert.deepEqual(times, [0, 0.5]);
    } finally {
      source.dispose();
    }
    assert.equal(disposed, 1);
  } finally {
    Renderer.create = originalCreate;
    if (originalCanvas === undefined)
      Reflect.deleteProperty(globalThis, "OffscreenCanvas");
    else globalThis.OffscreenCanvas = originalCanvas;
  }
});

import { managedVideoScenes } from "../src/engine/render/visual";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function createTestRenderer(scene: Scene) {
  const renderer = Object.create(Renderer.prototype) as Renderer;
  const project: Project = {
    name: "renderer test",
    resolution: [1920, 1080],
    aspectRatio: [16, 9],
    duration: 2,
    scenes: [
      {
        id: "scene",
        name: "test scene",
        source: "",
        start: 0,
        duration: 2,
        create: () => scene,
        transition: { type: "cut" },
      },
    ],
  };
  Object.assign(renderer, {
    scenes: new Map([["scene", scene]]),
    disposed: false,
    configured: false,
    renderGeneration: 0,
    preparationQueue: Promise.resolve(),
    activeFrames: new Set<AbortController>(),
    device: {
      createCommandEncoder: () => ({ finish: () => ({}) }),
      queue: { submit: () => {} },
      destroy: () => {},
    } as unknown as GPUDevice,
    context: { getCurrentTexture: () => ({}) } as unknown as GPUCanvasContext,
    project,
    resolution: [320, 240],
    format: "bgra8unorm",
  });
  return renderer;
}

function testScene(
  render: (context: RenderContext) => void,
  prepareFrame?: Scene["prepareFrame"],
  dispose: () => void = () => {},
): Scene {
  return {
    setup: () => {},
    render,
    prepareFrame,
    dispose,
  };
}

test("renderer serializes frame preparation and keeps concurrent requests ordered", async () => {
  const gate = deferred();
  const started = deferred();
  const prepared: number[] = [];
  const rendered: number[] = [];
  const scene = testScene(
    ({ time }) => rendered.push(time),
    async ({ time }) => {
      prepared.push(time);
      if (time === 0) {
        started.resolve();
        await gate.promise;
      }
    },
  );
  const renderer = createTestRenderer(scene);
  const first = renderer.renderAsync(0);
  await started.promise;
  const second = renderer.renderAsync(1);
  assert.deepEqual(prepared, [0]);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(prepared, [0, 1]);
  assert.deepEqual(rendered, [0, 1]);
  renderer.dispose();
});

test("renderer cancellation prevents a late submission", async () => {
  const gate = deferred();
  const started = deferred();
  const rendered: number[] = [];
  const scene = testScene(
    ({ time }) => rendered.push(time),
    async () => {
      started.resolve();
      await gate.promise;
    },
  );
  const renderer = createTestRenderer(scene);
  const controller = new AbortController();
  const frame = renderer.renderAsync(0, controller.signal);
  await started.promise;
  controller.abort();
  gate.resolve();
  await assert.rejects(frame, { name: "AbortError" });
  assert.deepEqual(rendered, []);
  renderer.dispose();
});

test("renderer forwards cancellation and prevents a cancelled frame submission", async () => {
  const gate = deferred();
  const started = deferred();
  const rendered: number[] = [];
  const scene = testScene(
    ({ time }) => rendered.push(time),
    async () => {
      started.resolve();
      await gate.promise;
    },
  );
  const renderer = createTestRenderer(scene);
  const controller = new AbortController();
  const reason = Error("cancelled frame");
  const frame = renderer.renderAsync(0, controller.signal);
  await started.promise;
  controller.abort(reason);
  gate.resolve();
  await assert.rejects(frame, (error) => error === reason);
  assert.deepEqual(rendered, []);
  renderer.dispose();
});

test("disposing during frame preparation prevents a late submission", async () => {
  const gate = deferred();
  const started = deferred();
  const rendered: number[] = [];
  let disposed = 0;
  const scene = testScene(
    ({ time }) => rendered.push(time),
    async () => {
      started.resolve();
      await gate.promise;
    },
    () => disposed++,
  );
  const renderer = createTestRenderer(scene);
  const frame = renderer.renderAsync(0);
  await started.promise;
  renderer.dispose();
  gate.resolve();
  await assert.rejects(frame, { name: "AbortError" });
  assert.deepEqual(rendered, []);
  assert.equal(disposed, 1);
});

test("sync rendering remains available but rejects async-preparation scenes", () => {
  const rendered: number[] = [];
  const asyncRenderer = createTestRenderer(
    testScene(
      ({ time }) => rendered.push(time),
      () => {},
    ),
  );
  assert.throws(
    () => asyncRenderer.render(0),
    /Use await renderer\.renderAsync/,
  );
  asyncRenderer.dispose();

  const compositionResolutions: unknown[] = [];
  const syncRenderer = createTestRenderer(
    testScene(({ time, compositionResolution }) => {
      rendered.push(time);
      compositionResolutions.push(compositionResolution);
    }),
  );
  syncRenderer.render(0.5);
  assert.deepEqual(rendered, [0.5]);
  assert.deepEqual(compositionResolutions, [[1920, 1080]]);
  syncRenderer.dispose();
});

test("renderer releases inactive managed media before preparation, never custom scenes", async () => {
  const events: string[] = [];
  const active = testScene(
    () => events.push("submit"),
    () => {
      events.push("prepare");
    },
  );
  const inactive = testScene(
    () => {},
    undefined,
    () => events.push("terminal"),
  );
  const custom = testScene(
    () => {},
    undefined,
    () => events.push("custom"),
  );
  managedVideoScenes.set(inactive, {
    deactivate: () => events.push("release"),
  });
  const renderer = createTestRenderer(active);
  (renderer as unknown as { scenes: Map<string, Scene> }).scenes
    .set("inactive", inactive)
    .set("custom", custom);
  await renderer.renderAsync(0);
  assert.deepEqual(events, ["release", "prepare", "submit"]);
  renderer.dispose();
});

test("preparation failures reject and leave the async render queue usable", async () => {
  const rendered: number[] = [];
  const failure = Error("frame preparation failed");
  let fail = true;
  const renderer = createTestRenderer(
    testScene(
      ({ time }) => rendered.push(time),
      () => {
        if (fail) throw failure;
      },
    ),
  );
  await assert.rejects(renderer.renderAsync(0), (error) => error === failure);
  fail = false;
  await renderer.renderAsync(1);
  assert.deepEqual(rendered, [1]);
  renderer.dispose();
});
