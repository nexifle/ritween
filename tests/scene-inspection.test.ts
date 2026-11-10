/**
 * G1a lifecycle optional inspection capability
 * (docs/plans/declarative-layout-hardening.md §7 Lifecycle integration).
 *
 * Covers the Scene-level structural capability, StageEntry/Shot forwarding, the
 * Stage stale-inspection invalidation bug (failing-first), and the renderer
 * snapshot across queued work, cancellation, failure, sync/async races, seeking,
 * disposal, and FrameSource GPU completion.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Renderer } from "../src/engine/render/renderer";
import { transitionUniform } from "../src/engine/render/transition";
import { FrameSource } from "../src/engine/render/frame-source";
import {
  Box,
  Stage,
  StageEntry,
  Shot,
  World,
  Overlay,
} from "../src/authoring/index";
import type { Project, Scene, SceneInspection } from "../src/engine/types";
import type { FrameInspection } from "../src/engine/render/renderer";
import { managedVideoScenes } from "../src/engine/render/visual";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

/** Scene stub whose inspected frame, preparation and rendering each test controls. */
interface ControlledScene extends Scene {
  inspect(): SceneInspection | undefined;
  setFrame(frame: SceneInspection | undefined): void;
  holdPrepare(began: () => void, gate: Promise<void>): void;
  failPrepare(message?: string): void;
  failRender(message?: string): void;
}

function controlledScene(id: string): ControlledScene {
  let inspected: SceneInspection | undefined;
  let prepareFailure: string | undefined;
  let renderFailure: string | undefined;
  let hold: { began: () => void; gate: Promise<void> } | undefined;
  return {
    setup() {},
    async prepareFrame({ time, localTime, progress }) {
      inspected = undefined;
      if (prepareFailure) throw Error(prepareFailure);
      if (hold) {
        const current = hold;
        hold = undefined;
        current.began();
        await current.gate;
      }
      inspected = {
        tree: { id, time, localTime, progress },
        commands: [],
        warnings: [],
      };
    },
    render({ time }) {
      if (renderFailure) throw Error(renderFailure);
      void time;
    },
    inspect: () => inspected,
    setFrame: (frame) => {
      inspected = frame;
    },
    holdPrepare(began, gate) {
      hold = { began, gate };
    },
    failPrepare(message) {
      prepareFailure = message;
    },
    failRender(message) {
      renderFailure = message;
    },
    dispose() {},
  };
}

/** Scene with no optional capabilities at all. */
function rawScene(): Scene {
  return { setup() {}, render() {}, dispose() {} };
}

/** Same Object.create harness pattern as tests/frame-source.test.ts and tests/project-overlay.test.ts. */
function harness(overlay?: Scene) {
  const output = {} as GPUTexture;
  const targets = [0, 1].map(() => ({
    createView: () => ({}),
  })) as unknown as GPUTexture[];
  const a = controlledScene("a");
  const b = controlledScene("b");
  const project: Project = {
    name: "Inspection test",
    duration: 3,
    resolution: [100, 100],
    aspectRatio: [1, 1],
    scenes: [
      {
        id: "a",
        name: "A",
        source: "",
        start: 0,
        duration: 2,
        transition: { type: "cut" },
        create: () => a,
      },
      {
        id: "b",
        name: "B",
        source: "",
        start: 1,
        duration: 2,
        transition: { type: "crossfade", duration: 1 },
        create: () => b,
      },
    ],
  };
  if (overlay) project.overlay = () => overlay;
  const renderer = Object.create(Renderer.prototype) as Renderer;
  Object.assign(renderer, {
    project,
    overlay,
    scenes: new Map<string, Scene>([
      ["a", a],
      ["b", b],
    ]),
    disposed: false,
    configured: false,
    renderGeneration: 0,
    attempt: 0,
    preparationQueue: Promise.resolve(),
    activeFrames: new Set<AbortController>(),
    inspectionEnabled: true,
    device: {
      createCommandEncoder: () => ({
        beginRenderPass: () => ({ end() {} }),
        finish: () => ({}),
      }),
      queue: { submit: () => {} },
      destroy: () => {},
    },
    context: { getCurrentTexture: () => output },
    resolution: [100, 100],
    format: "rgba8unorm",
    transition: {
      targets,
      render(
        _context: unknown,
        transition: Parameters<typeof transitionUniform>[0],
      ) {
        return transitionUniform(transition);
      },
      dispose() {},
    },
  });
  return {
    renderer,
    project,
    a,
    b,
    replace(id: string, scene: Scene) {
      (renderer as unknown as { scenes: Map<string, Scene> }).scenes.set(
        id,
        scene,
      );
    },
  };
}

function overlayScene(): ControlledScene {
  const scene = controlledScene("overlay");
  scene.prepareFrame = async ({ time, localTime, progress }) => {
    scene.setFrame({
      tree: { overlay: true, time, localTime, progress },
      commands: [],
      warnings: [],
    });
  };
  return scene;
}

/**
 * Minimal browser and GPU stubs so a real Stage can run its full setup, frame
 * preparation and render path in Node.
 */
async function withStageEnvironment<T>(run: () => Promise<T>): Promise<T> {
  const globals = globalThis as typeof globalThis & {
    document?: unknown;
    CSS?: unknown;
    GPUTextureUsage?: unknown;
    GPUBufferUsage?: unknown;
  };
  const saved = {
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    CSS: Object.getOwnPropertyDescriptor(globalThis, "CSS"),
    GPUTextureUsage: Object.getOwnPropertyDescriptor(
      globalThis,
      "GPUTextureUsage",
    ),
    GPUBufferUsage: Object.getOwnPropertyDescriptor(
      globalThis,
      "GPUBufferUsage",
    ),
  };
  globals.GPUTextureUsage = {
    RENDER_ATTACHMENT: 1,
    COPY_SRC: 2,
    TEXTURE_BINDING: 4,
    COPY_DST: 8,
  };
  globals.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2, STORAGE: 4 };
  globals.document = {
    fonts: {
      check: () => true,
      load: () => Promise.resolve(),
      ready: Promise.resolve(),
    },
    createElement: () => {
      const context = {
        font: "",
        letterSpacing: "",
        fillStyle: "",
        textBaseline: "",
        measureText: () => ({ width: 10 }),
        scale() {},
        resetTransform() {},
        fillRect() {},
        clearRect() {},
        fillText() {},
        getImageData: () => ({
          data: new Uint8ClampedArray([255, 255, 255, 255]),
        }),
      };
      return { width: 0, height: 0, getContext: () => context };
    },
  };
  globals.CSS = { supports: () => true };
  try {
    return await run();
  } finally {
    for (const [name, descriptor] of Object.entries(saved))
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
  }
}

function stageDevice() {
  return {
    createShaderModule: () => ({}),
    createRenderPipelineAsync: async () => ({
      getBindGroupLayout: () => ({}),
    }),
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createSampler: () => ({}),
    createBuffer: () => ({ destroy() {} }),
    createBindGroup: () => ({}),
    queue: {
      writeTexture() {},
      writeBuffer() {},
      copyExternalImageToTexture() {},
      submit() {},
    },
    limits: {
      minUniformBufferOffsetAlignment: 256,
      minStorageBufferOffsetAlignment: 256,
      maxBufferSize: 1 << 28,
      maxStorageBufferBindingSize: 1 << 28,
      maxTextureDimension2D: 8192,
    },
  } as unknown as GPUDevice;
}

function stageSetup() {
  return {
    device: stageDevice(),
    format: "rgba8unorm" as GPUTextureFormat,
    resolution: [100, 100] as const,
    compositionResolution: [100, 100] as const,
  };
}

function renderStageFrame(
  stage: ReturnType<typeof Stage>,
  time: number,
  setup: ReturnType<typeof stageSetup>,
  extras: Record<string, unknown> = {},
) {
  stage.render({
    ...setup,
    target: { createView: () => ({}) } as unknown as GPUTexture,
    encoder: {
      beginRenderPass: () => ({
        setScissorRect() {},
        setPipeline() {},
        setBindGroup() {},
        draw() {},
        end() {},
      }),
      finish: () => ({}),
    } as unknown as GPUCommandEncoder,
    time,
    localTime: time,
    progress: time / 2,
    ...extras,
  });
}

test("Stage drops the previous frame when a preparation fails to evaluate", async () => {
  await withStageEnvironment(async () => {
    const setup = stageSetup();
    const stage = Stage(({ time }) => {
      if (time >= 1.5) throw Error("view evaluation failed");
      return Box({ width: 10, height: 10 });
    });
    try {
      await stage.setup(setup);
      await stage.prepareFrame!({ time: 1, localTime: 1, progress: 0.5 });
      renderStageFrame(stage, 1, setup);
      assert.ok(stage.inspect(), "render must publish an inspectable frame");
      await assert.rejects(
        stage.prepareFrame!({ time: 2, localTime: 2, progress: 1 }),
        /view evaluation failed/,
      );
      assert.equal(
        stage.inspect(),
        undefined,
        "a failed preparation must not leave the previous frame inspectable",
      );
    } finally {
      stage.dispose();
    }
  });
});

test("Stage drops the previous frame when a preparation is cancelled", async () => {
  await withStageEnvironment(async () => {
    const setup = stageSetup();
    const stage = Stage(() => Box({ width: 10, height: 10 }));
    try {
      await stage.setup(setup);
      await stage.prepareFrame!({ time: 1, localTime: 1, progress: 0.5 });
      renderStageFrame(stage, 1, setup);
      assert.ok(stage.inspect());
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        stage.prepareFrame!({
          time: 1,
          localTime: 1,
          progress: 0.5,
          signal: controller.signal,
        }),
        { name: "AbortError" },
      );
      assert.equal(
        stage.inspect(),
        undefined,
        "a cancelled preparation must not leave the previous frame inspectable",
      );
    } finally {
      stage.dispose();
    }
  });
});

test("Stage invalidates a same-time prepared frame when the inspection mode flips", async () => {
  await withStageEnvironment(async () => {
    const setup = stageSetup();
    const stage = Stage(() => Box({ width: 10, height: 10 }));
    try {
      await stage.setup(setup);
      // Prepare without inspection, then render with it: the opt-out cache must not serve.
      await stage.prepareFrame!({ time: 1, localTime: 1, progress: 0.5 });
      assert.throws(
        () => renderStageFrame(stage, 1, setup, { inspection: true }),
        /frame is not prepared/,
        "render with inspection must not consume a prepare-without-inspection result",
      );
      // The reverse direction: prepare with inspection, render without it must also be refused.
      await stage.prepareFrame!({
        time: 1,
        localTime: 1,
        progress: 0.5,
        inspection: true,
      });
      assert.throws(
        () => renderStageFrame(stage, 1, setup),
        /frame is not prepared/,
        "render without inspection must not consume a prepare-with-inspection result",
      );
      // A same-time prepare/render pair in the same mode still serves, with metadata.
      await stage.prepareFrame!({
        time: 1,
        localTime: 1,
        progress: 0.5,
        inspection: true,
      });
      renderStageFrame(stage, 1, setup, { inspection: true });
      const frame = stage.inspect();
      assert.ok(frame, "matching-mode render must publish a frame");
      assert.ok(
        frame.tree.offeredSize,
        "a prepare-with-inspection result must carry inspection metadata",
      );
    } finally {
      stage.dispose();
    }
  });
});

test("StageEntry and Shot forward the inspect capability through entry.create()", () => {
  const entry = StageEntry({
    id: "entry",
    source: "fixture",
    start: 0,
    duration: 1,
    view: () => Box({ width: 10, height: 10 }),
  });
  const shot = Shot({
    id: "shot",
    source: "fixture",
    start: 0,
    duration: 1,
    world: World(() => Box({ width: 10, height: 10 }), { size: [100, 100] }),
  });
  const entryScene = entry.create();
  const shotScene = shot.create();
  try {
    assert.equal(typeof entryScene.inspect, "function");
    assert.equal(typeof shotScene.inspect, "function");
    assert.equal(entryScene.inspect!(), undefined);
    assert.equal(shotScene.inspect!(), undefined);
  } finally {
    entryScene.dispose();
    shotScene.dispose();
  }
});

test("inspectFrame keeps the submitted frame after the scene mutates", async () => {
  const h = harness();
  try {
    await h.renderer.renderAsync(1);
    const submitted = h.renderer.inspectFrame();
    assert.deepEqual(submitted.scenes[0].frame, {
      tree: { id: "a", time: 1, localTime: 1, progress: 0.5 },
      commands: [],
      warnings: [],
    });
    // A later preparation (or any other scene mutation) must not rewrite this frame.
    h.a.setFrame({
      tree: { id: "a", time: 99 },
      commands: [],
      warnings: [],
    });
    assert.deepEqual(h.renderer.inspectFrame(), submitted);
  } finally {
    h.renderer.dispose();
  }
});

test("inspectFrame reports both overlapping scenes and the overlay with distinct clocks", async () => {
  const overlay = overlayScene();
  const h = harness(overlay);
  try {
    await h.renderer.renderAsync(1.5);
    const inspection: FrameInspection = h.renderer.inspectFrame();
    assert.equal(inspection.requestedTime, 1.5);
    assert.equal(inspection.effectiveTime, 1.5);
    assert.deepEqual(
      inspection.scenes.map((scene) => scene.id),
      ["a", "b"],
      "overlapping scenes keep paint order",
    );
    assert.deepEqual(inspection.scenes[0], {
      id: "a",
      name: "A",
      time: 1.5,
      localTime: 1.5,
      progress: 0.75,
      frame: {
        tree: { id: "a", time: 1.5, localTime: 1.5, progress: 0.75 },
        commands: [],
        warnings: [],
      },
    });
    assert.deepEqual(inspection.scenes[1], {
      id: "b",
      name: "B",
      time: 1.5,
      localTime: 0.5,
      progress: 0.25,
      frame: {
        tree: { id: "b", time: 1.5, localTime: 0.5, progress: 0.25 },
        commands: [],
        warnings: [],
      },
    });
    assert.deepEqual(inspection.overlay, {
      time: 1.5,
      localTime: 1.5,
      progress: 0.5,
      frame: {
        tree: { overlay: true, time: 1.5, localTime: 1.5, progress: 0.5 },
        commands: [],
        warnings: [],
      },
    });
  } finally {
    h.renderer.dispose();
  }
});

test("inspectFrame reports requested and effective times when the request exceeds the duration", async () => {
  const h = harness();
  try {
    await h.renderer.renderAsync(99);
    const inspection = h.renderer.inspectFrame();
    assert.equal(inspection.requestedTime, 99);
    assert.equal(inspection.effectiveTime, 3);
    assert.deepEqual(
      inspection.scenes.map((scene) => scene.localTime),
      [2],
      "local time is measured from the last scene once the timeline clamps",
    );
  } finally {
    h.renderer.dispose();
  }
});

test("raw scenes and unaware inspect properties are reported unavailable", async () => {
  const h = harness();
  try {
    h.replace("b", rawScene());
    // A legacy scene may already own an unrelated `inspect` property; it must not throw.
    h.replace("a", {
      setup() {},
      render() {},
      dispose() {},
      inspect: 42,
    } as Scene);
    await h.renderer.renderAsync(1.5);
    const inspection = h.renderer.inspectFrame();
    for (const scene of inspection.scenes) {
      assert.equal(scene.frame, undefined);
      assert.match(scene.unavailable!, /inspect/);
    }
    assert.match(
      inspection.scenes[0].unavailable!,
      /not a function/,
      "an unrelated inspect property is reported, never called",
    );
    assert.match(
      inspection.scenes[1].unavailable!,
      /does not implement the optional inspect\(\) capability/,
    );
  } finally {
    h.renderer.dispose();
  }
});

test("an inspect capability that throws or returns non-frame data is unavailable", async () => {
  const h = harness();
  try {
    h.replace("a", {
      setup() {},
      render() {},
      dispose() {},
      inspect() {
        throw Error("inspect exploded");
      },
    });
    h.replace("b", {
      setup() {},
      render() {},
      dispose() {},
      inspect: () => ({ tree: "not a frame" }),
    });
    await h.renderer.renderAsync(1.5);
    const inspection = h.renderer.inspectFrame();
    assert.equal(inspection.scenes[0].frame, undefined);
    assert.match(inspection.scenes[0].unavailable!, /inspect exploded/);
    assert.equal(inspection.scenes[1].frame, undefined);
    assert.match(inspection.scenes[1].unavailable!, /not a scene inspection/);
  } finally {
    h.renderer.dispose();
  }
});

test("a throwing inspect getter or returned getter is unavailable, never a render rejection", async () => {
  const h = harness();
  try {
    // Reading `inspect` itself throws, before any call is attempted.
    h.replace("a", {
      setup() {},
      render() {},
      dispose() {},
      get inspect(): unknown {
        throw Error("inspect getter exploded");
      },
    } as unknown as Scene);
    // The returned value looks valid until a structural property is read.
    h.replace("b", {
      setup() {},
      render() {},
      dispose() {},
      inspect: () =>
        Object.defineProperties(
          {},
          {
            tree: { value: {}, enumerable: true },
            commands: {
              enumerable: true,
              get: () => {
                throw Error("commands getter exploded");
              },
            },
            warnings: { value: [], enumerable: true },
          },
        ),
    });
    await h.renderer.renderAsync(1.5);
    const inspection = h.renderer.inspectFrame();
    assert.equal(inspection.scenes[0].frame, undefined);
    assert.match(inspection.scenes[0].unavailable!, /inspect getter exploded/);
    assert.equal(inspection.scenes[1].frame, undefined);
    assert.match(inspection.scenes[1].unavailable!, /commands getter exploded/);
  } finally {
    h.renderer.dispose();
  }
});

test("a returned warnings getter that throws is unavailable", async () => {
  const h = harness();
  try {
    h.replace("a", {
      setup() {},
      render() {},
      dispose() {},
      inspect: () =>
        Object.defineProperties(
          {},
          {
            tree: { value: {}, enumerable: true },
            commands: { value: [], enumerable: true },
            warnings: {
              enumerable: true,
              get: () => {
                throw Error("warnings getter exploded");
              },
            },
          },
        ),
    });
    await h.renderer.renderAsync(1.5);
    assert.match(
      h.renderer.inspectFrame().scenes[0].unavailable!,
      /warnings getter exploded/,
    );
  } finally {
    h.renderer.dispose();
  }
});

test("an inspect capability returning undefined reports returned-no-frame", async () => {
  const h = harness();
  try {
    const silent = controlledScene("b");
    silent.prepareFrame = undefined;
    h.replace("b", silent);
    await h.renderer.renderAsync(1.5);
    assert.match(
      h.renderer.inspectFrame().scenes[1].unavailable!,
      /returned no frame for this time/,
    );
  } finally {
    h.renderer.dispose();
  }
});

test("an overlay without inspect is reported unavailable with the project clock", async () => {
  const h = harness(rawScene());
  try {
    await h.renderer.renderAsync(1.5);
    const inspection = h.renderer.inspectFrame();
    assert.deepEqual(
      inspection.overlay && {
        time: inspection.overlay.time,
        localTime: inspection.overlay.localTime,
        progress: inspection.overlay.progress,
      },
      { time: 1.5, localTime: 1.5, progress: 0.5 },
    );
    assert.equal(inspection.overlay!.frame, undefined);
    assert.match(
      inspection.overlay!.unavailable!,
      /does not implement the optional inspect\(\) capability/,
    );
  } finally {
    h.renderer.dispose();
  }
});

test("two queued async renders publish the later frame", async () => {
  const h = harness();
  try {
    const first = h.renderer.renderAsync(0.5);
    const second = h.renderer.renderAsync(1.5);
    await Promise.all([first, second]);
    const inspection = h.renderer.inspectFrame();
    assert.equal(inspection.requestedTime, 1.5);
    assert.deepEqual(
      inspection.scenes.map((scene) => scene.localTime),
      [1.5, 0.5],
    );
  } finally {
    h.renderer.dispose();
  }
});

test("a held queued preparation withholds inspection until it submits", async () => {
  const h = harness();
  const gate = deferred();
  const began = deferred();
  try {
    await h.renderer.renderAsync(0.5);
    assert.ok(h.renderer.inspectFrame());
    h.a.holdPrepare(began.resolve, gate.promise);
    const held = h.renderer.renderAsync(1.5);
    await began.promise;
    assert.throws(
      () => h.renderer.inspectFrame(),
      /No successful frame/,
      "a queued attempt must not keep the previous frame available",
    );
    gate.resolve();
    await held;
    assert.equal(h.renderer.inspectFrame().requestedTime, 1.5);
  } finally {
    gate.resolve();
    h.renderer.dispose();
  }
});

test("an older queued attempt cannot publish while a newer attempt is pending", async () => {
  const h = harness();
  const gate = deferred();
  const began = deferred();
  try {
    h.a.holdPrepare(began.resolve, gate.promise);
    const older = h.renderer.renderAsync(0.5);
    await began.promise;
    // The newer attempt owns publication, and it will fail.
    h.a.failPrepare("newer preparation failed");
    const newer = h.renderer.renderAsync(1.5);
    gate.resolve();
    await older;
    await assert.rejects(newer, /newer preparation failed/);
    assert.throws(
      () => h.renderer.inspectFrame(),
      /No successful frame/,
      "the superseded attempt must not publish over the newer attempt",
    );
  } finally {
    gate.resolve();
    h.renderer.dispose();
  }
});

test("failed scene preparation invalidates the snapshot and the queue recovers", async () => {
  const h = harness();
  try {
    await h.renderer.renderAsync(1);
    assert.ok(h.renderer.inspectFrame().scenes[0].frame);
    h.a.failPrepare("prepare failed");
    await assert.rejects(h.renderer.renderAsync(1.5), /prepare failed/);
    assert.throws(
      () => h.renderer.inspectFrame(),
      /No successful frame/,
      "a failed preparation must not expose the previous frame",
    );
    h.a.failPrepare(undefined); // clear the failure
    await h.renderer.renderAsync(1.5);
    assert.equal(h.renderer.inspectFrame().requestedTime, 1.5);
  } finally {
    h.renderer.dispose();
  }
});

test("failed submit leaves no inspectable frame and the queue recovers", async () => {
  const h = harness();
  try {
    await h.renderer.renderAsync(1);
    assert.ok(h.renderer.inspectFrame());
    h.a.failRender("render failed");
    await assert.rejects(h.renderer.renderAsync(1.5), /render failed/);
    assert.throws(() => h.renderer.inspectFrame(), /No successful frame/);
    h.a.failRender(undefined);
    await h.renderer.renderAsync(1.5);
    assert.equal(h.renderer.inspectFrame().requestedTime, 1.5);
  } finally {
    h.renderer.dispose();
  }
});

test("cancelled async preparation invalidates the snapshot before submission", async () => {
  const h = harness();
  const gate = deferred();
  const began = deferred();
  try {
    await h.renderer.renderAsync(1);
    assert.ok(h.renderer.inspectFrame());
    // Only the second attempt blocks, so the first render completes normally.
    h.a.holdPrepare(began.resolve, gate.promise);
    const controller = new AbortController();
    const pending = h.renderer.renderAsync(1.5, controller.signal);
    await began.promise;
    controller.abort();
    gate.resolve();
    await assert.rejects(pending, { name: "AbortError" });
    assert.throws(
      () => h.renderer.inspectFrame(),
      /No successful frame/,
      "a cancelled preparation must not expose the previously submitted frame",
    );
  } finally {
    gate.resolve();
    h.renderer.dispose();
  }
});

test("a superseded async attempt never clears the newer sync frame", async () => {
  const h = harness();
  const gate = deferred();
  const began = deferred();
  try {
    h.a.holdPrepare(began.resolve, gate.promise);
    const pending = h.renderer.renderAsync(1);
    await began.promise;
    const syncScene = controlledScene("a");
    syncScene.prepareFrame = undefined;
    h.replace("a", syncScene);
    h.renderer.render(0.25);
    assert.equal(h.renderer.inspectFrame().requestedTime, 0.25);
    gate.resolve();
    await assert.rejects(pending, { name: "AbortError" });
    const inspection = h.renderer.inspectFrame();
    assert.equal(
      inspection.requestedTime,
      0.25,
      "the rejected older attempt must not wipe the newer sync frame",
    );
    assert.equal(inspection.scenes[0].localTime, 0.25);
    assert.equal(
      inspection.scenes[0].frame,
      undefined,
      "the sync scene has no capability",
    );
  } finally {
    gate.resolve();
    h.renderer.dispose();
  }
});

test("invalid sync and pre-aborted async attempts invalidate the previous frame", async () => {
  const h = harness();
  try {
    await h.renderer.renderAsync(1);
    assert.ok(h.renderer.inspectFrame());
    assert.throws(() => h.renderer.render(NaN), /must be finite/);
    assert.throws(() => h.renderer.inspectFrame(), /No successful frame/);

    h.replace("a", controlledScene("a"));
    await h.renderer.renderAsync(1);
    assert.ok(h.renderer.inspectFrame());
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(h.renderer.renderAsync(1, controller.signal), {
      name: "AbortError",
    });
    assert.throws(() => h.renderer.inspectFrame(), /No successful frame/);

    await h.renderer.renderAsync(1);
    assert.ok(h.renderer.inspectFrame());
    assert.throws(
      () => h.renderer.render(1),
      /Use await renderer\.renderAsync/,
      "sync rendering cannot serve an async-preparing scene",
    );
    assert.throws(() => h.renderer.inspectFrame(), /No successful frame/);
  } finally {
    h.renderer.dispose();
  }
});

test("seeking A → B → A yields identical inspections and never a stale one", async () => {
  const h = harness();
  try {
    await h.renderer.renderAsync(0.5);
    const a1 = JSON.stringify(h.renderer.inspectFrame());
    await h.renderer.renderAsync(1.5);
    const b = JSON.stringify(h.renderer.inspectFrame());
    assert.notEqual(a1, b, "A and B must be distinct frames");
    await h.renderer.renderAsync(0.5);
    assert.equal(
      JSON.stringify(h.renderer.inspectFrame()),
      a1,
      "seeking back to A must reproduce the same inspection",
    );
  } finally {
    h.renderer.dispose();
  }
});

test("dispose invalidates inspection metadata", async () => {
  const h = harness();
  await h.renderer.renderAsync(1);
  assert.ok(h.renderer.inspectFrame());
  h.renderer.dispose();
  assert.throws(() => h.renderer.inspectFrame(), /disposed/);
});

test("inspectFrame throws before any successful frame", () => {
  const h = harness();
  try {
    assert.throws(() => h.renderer.inspectFrame(), /No successful frame/);
  } finally {
    h.renderer.dispose();
  }
});

test("inspection stays disabled unless the renderer opts in", async () => {
  const h = harness();
  try {
    Object.assign(h.renderer, { inspectionEnabled: false });
    await h.renderer.renderAsync(1);
    assert.throws(() => h.renderer.inspectFrame(), /inspection is disabled/);
  } finally {
    h.renderer.dispose();
  }
});

test("custom transition render contexts carry the inspection opt-in", async () => {
  const h = harness();
  const seen: boolean[] = [];
  try {
    for (const id of ["a", "b"]) {
      const scene = controlledScene(id);
      scene.render = (context) => {
        seen.push(context.inspection === true);
        void context.time;
      };
      h.replace(id, scene);
    }
    // Scenes a and b overlap at time 1.5 through the b crossfade transition.
    await h.renderer.renderAsync(1.5);
    assert.deepEqual(
      seen,
      [true, true],
      "both transition render contexts must propagate the inspection flag",
    );
  } finally {
    h.renderer.dispose();
  }
});

test("inactive managed media still deactivates on the inspected path", async () => {
  const h = harness();
  const events: string[] = [];
  const inactive = rawScene();
  managedVideoScenes.set(inactive, {
    deactivate: () => events.push("release"),
  });
  try {
    h.replace("inactive", inactive);
    await h.renderer.renderAsync(1);
    assert.deepEqual(events, ["release"]);
  } finally {
    managedVideoScenes.delete(inactive);
    h.renderer.dispose();
  }
});

test("Overlay factory produces an inspectable Stage scene", () => {
  const overlayStage = Overlay(() => Box({ width: 10, height: 10 }));
  try {
    assert.equal(typeof overlayStage.inspect, "function");
    assert.equal(overlayStage.inspect(), undefined);
  } finally {
    overlayStage.dispose();
  }
});

/** Offline renderer stub: GPU completion and per-frame inspection stay under test control. */
function installOfflineRenderer(inspection: boolean) {
  const originalCreate = Renderer.create;
  const canvasDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "OffscreenCanvas",
  );
  globalThis.OffscreenCanvas = class {
    constructor(
      readonly width: number,
      readonly height: number,
    ) {}
  } as typeof OffscreenCanvas;
  const gpuCompletions: Array<{
    resolve(): void;
    reject(error: unknown): void;
  }> = [];
  const state = { rendered: [] as number[], disposed: 0 };
  const renderer = {
    inspectionEnabled: inspection,
    device: {
      queue: {
        onSubmittedWorkDone: () =>
          new Promise<void>((resolve, reject) =>
            gpuCompletions.push({ resolve, reject }),
          ),
      },
    },
    renderAsync: async (time: number) => {
      state.rendered.push(time);
    },
    inspectFrame: (): FrameInspection => {
      if (!state.rendered.length) throw Error("No successful frame");
      const time = state.rendered[state.rendered.length - 1];
      return { requestedTime: time, effectiveTime: time, scenes: [] };
    },
    dispose: () => {
      state.disposed++;
    },
  };
  Renderer.create = async () => renderer as unknown as Renderer;
  return {
    state,
    gpuCompletions,
    restore() {
      Renderer.create = originalCreate;
      if (canvasDescriptor)
        Object.defineProperty(globalThis, "OffscreenCanvas", canvasDescriptor);
      else Reflect.deleteProperty(globalThis, "OffscreenCanvas");
    },
  };
}

test("FrameSource publishes only after GPU completion and a clean abort check", async () => {
  const fake = installOfflineRenderer(true);
  try {
    const source = await FrameSource.create({} as Project, {
      width: 320,
      height: 240,
      inspect: true,
    });
    try {
      const pending = source.render(0);
      await Promise.resolve();
      assert.equal(fake.gpuCompletions.length, 1);
      assert.throws(
        () => source.inspectFrame(),
        /No completed offline frame/,
        "a frame awaiting the GPU must not be inspectable",
      );
      fake.gpuCompletions[0].resolve();
      const canvas = await pending;
      assert.equal(canvas.width, 320);
      assert.equal(source.inspectFrame().requestedTime, 0);
    } finally {
      source.dispose();
    }
    assert.equal(fake.state.disposed, 1);
  } finally {
    fake.restore();
  }
});

test("FrameSource publishes nothing when GPU completion rejects", async () => {
  const fake = installOfflineRenderer(true);
  try {
    const source = await FrameSource.create({} as Project, {
      width: 32,
      height: 32,
      inspect: true,
    });
    try {
      const first = source.render(0);
      await Promise.resolve();
      fake.gpuCompletions[0].resolve();
      await first;
      assert.equal(source.inspectFrame().requestedTime, 0);
      const failure = Error("device lost");
      const rejected = source.render(1);
      await Promise.resolve();
      fake.gpuCompletions[1].reject(failure);
      await assert.rejects(rejected, (error) => error === failure);
      assert.throws(
        () => source.inspectFrame(),
        /No completed offline frame/,
        "a GPU-rejected frame must not fall back to the previous candidate",
      );
    } finally {
      source.dispose();
    }
  } finally {
    fake.restore();
  }
});

test("FrameSource publishes nothing when the abort signal fires during GPU work", async () => {
  const fake = installOfflineRenderer(true);
  const controller = new AbortController();
  try {
    const source = await FrameSource.create({} as Project, {
      width: 32,
      height: 32,
      inspect: true,
      signal: controller.signal,
    });
    try {
      const pending = source.render(0);
      await Promise.resolve();
      controller.abort();
      fake.gpuCompletions[0].resolve();
      await assert.rejects(pending, { name: "AbortError" });
      assert.throws(() => source.inspectFrame(), /No completed offline frame/);
    } finally {
      source.dispose();
    }
  } finally {
    fake.restore();
  }
});

test("FrameSource keeps the newer operation when an older GPU wait finishes last", async () => {
  const fake = installOfflineRenderer(true);
  try {
    const source = await FrameSource.create({} as Project, {
      width: 32,
      height: 32,
      inspect: true,
    });
    try {
      const older = source.render(0);
      await Promise.resolve();
      const newer = source.render(1);
      await Promise.resolve();
      assert.equal(fake.gpuCompletions.length, 2);
      fake.gpuCompletions[1].resolve();
      await newer;
      assert.equal(source.inspectFrame().requestedTime, 1);
      fake.gpuCompletions[0].resolve();
      await assert.rejects(older, { name: "AbortError" });
      assert.equal(
        source.inspectFrame().requestedTime,
        1,
        "an older operation must not republish over the newer frame",
      );
    } finally {
      source.dispose();
    }
  } finally {
    fake.restore();
  }
});

test("FrameSource drops the published frame when a later attempt is pre-aborted", async () => {
  const fake = installOfflineRenderer(true);
  const controller = new AbortController();
  try {
    const source = await FrameSource.create({} as Project, {
      width: 32,
      height: 32,
      inspect: true,
      signal: controller.signal,
    });
    try {
      const first = source.render(0);
      await Promise.resolve();
      fake.gpuCompletions[0].resolve();
      await first;
      assert.equal(source.inspectFrame().requestedTime, 0);
      controller.abort();
      await assert.rejects(source.render(1), { name: "AbortError" });
      assert.throws(
        () => source.inspectFrame(),
        /No completed offline frame/,
        "a pre-aborted attempt must invalidate the previous published frame",
      );
    } finally {
      source.dispose();
    }
  } finally {
    fake.restore();
  }
});

test("a pre-aborted attempt still denies a pending older operation its publication", async () => {
  const fake = installOfflineRenderer(true);
  const controller = new AbortController();
  try {
    const source = await FrameSource.create({} as Project, {
      width: 32,
      height: 32,
      inspect: true,
      signal: controller.signal,
    });
    try {
      const older = source.render(0);
      await Promise.resolve();
      controller.abort();
      await assert.rejects(source.render(1), { name: "AbortError" });
      fake.gpuCompletions[0].resolve();
      await assert.rejects(older, { name: "AbortError" });
      assert.throws(
        () => source.inspectFrame(),
        /No completed offline frame/,
        "the pre-aborted attempt owns the result, so the pending older operation publishes nothing",
      );
    } finally {
      source.dispose();
    }
  } finally {
    fake.restore();
  }
});

test("FrameSource inspection requires an explicit opt-in", async () => {
  const fake = installOfflineRenderer(false);
  try {
    const source = await FrameSource.create({} as Project, {
      width: 32,
      height: 32,
    });
    try {
      const pending = source.render(0);
      await Promise.resolve();
      fake.gpuCompletions[0].resolve();
      await pending;
      assert.throws(() => source.inspectFrame(), /inspection is disabled/);
    } finally {
      source.dispose();
    }
  } finally {
    fake.restore();
  }
});
