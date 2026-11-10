import assert from "node:assert/strict";
import { test } from "node:test";
import { Renderer } from "../src/engine/render/renderer";
import { validateProject } from "../src/engine/timeline";
import type { Project, Scene, RenderContext } from "../src/engine/types";

function harness(overlay: Scene, overlap = false) {
  const events: string[] = [];
  const output = {} as GPUTexture;
  const targets = [0, 1].map(() => ({
    createView: () => ({}),
  })) as unknown as GPUTexture[];
  const scene = (id: string): Scene => ({
    setup() {},
    render({ target, time }) {
      assert.equal(
        target,
        overlap && time >= 1 && time < 2 ? targets[id === "a" ? 0 : 1] : output,
      );
      events.push(id);
    },
    dispose() {
      events.push(`dispose-${id}`);
    },
  });
  const a = scene("a"),
    b = scene("b");
  const project: Project = {
    name: "Overlay test",
    duration: 3,
    resolution: [100, 100],
    aspectRatio: [1, 1],
    overlay: () => overlay,
    scenes: overlap
      ? [
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
            transition: { type: "zoom", duration: 1 },
            create: () => b,
          },
        ]
      : [
          {
            id: "a",
            name: "A",
            source: "",
            start: 0,
            duration: 3,
            transition: { type: "cut" },
            create: () => a,
          },
        ],
  };
  const renderer = Object.create(Renderer.prototype) as Renderer;
  Object.assign(renderer, {
    project,
    overlay,
    scenes: new Map(
      overlap
        ? [
            ["a", a],
            ["b", b],
          ]
        : [["a", a]],
    ),
    disposed: false,
    configured: false,
    renderGeneration: 0,
    preparationQueue: Promise.resolve(),
    activeFrames: new Set(),
    device: {
      createCommandEncoder: () => ({
        beginRenderPass: () => ({ end() {} }),
        finish: () => ({}),
      }),
      queue: { submit: () => events.push("submit") },
      destroy: () => events.push("destroy"),
    },
    context: { getCurrentTexture: () => output },
    resolution: [100, 100],
    format: "rgba8unorm",
    transition: overlap
      ? { targets, render: () => events.push("transition"), dispose() {} }
      : undefined,
  });
  return { renderer, project, events, output };
}

test("overlay draws once after scene/compositor with a project clock and no shared corrections", () => {
  for (const overlap of [false, true]) {
    const contexts: RenderContext[] = [];
    const h = harness(
      {
        setup() {},
        render(c) {
          contexts.push(c);
          h.events.push("overlay");
        },
        dispose() {},
      },
      overlap,
    );
    validateProject(h.project);
    h.renderer.render(1.5);
    assert.deepEqual(
      h.events,
      overlap
        ? ["a", "b", "transition", "overlay", "submit"]
        : ["a", "overlay", "submit"],
    );
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].target, h.output);
    assert.equal(contexts[0].time, 1.5);
    assert.equal(contexts[0].localTime, 1.5);
    assert.equal(contexts[0].progress, 0.5);
    assert.equal(contexts[0].sharedTransforms, undefined);
    h.renderer.render(99);
    assert.equal(contexts[1].localTime, 3);
    assert.equal(contexts[1].progress, 1);
    h.renderer.dispose();
  }
});

test("async overlay uses project time, prevents sync render and cancels before submission", async () => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  let block = true;
  const h = harness({
    setup() {},
    async prepareFrame(c) {
      assert.equal(c.localTime, 1.5);
      assert.equal(c.progress, 0.5);
      h.events.push("prepare-overlay");
      started();
      if (block) await gate;
    },
    render() {
      h.events.push("overlay");
    },
    dispose() {
      h.events.push("dispose-overlay");
    },
  });
  assert.throws(() => h.renderer.render(1.5), /overlay.*renderAsync/);
  const controller = new AbortController();
  const pending = h.renderer.renderAsync(1.5, controller.signal);
  await began;
  controller.abort();
  release();
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(h.events, ["prepare-overlay"]);
  block = false;
  await h.renderer.renderAsync(1.5);
  assert.deepEqual(h.events.slice(1), [
    "prepare-overlay",
    "a",
    "overlay",
    "submit",
  ]);
  h.renderer.dispose();
  h.renderer.dispose();
  assert.equal(h.events.filter((e) => e === "dispose-overlay").length, 1);
});

test("overlay preparation errors leave the queue usable", async () => {
  let fail = true;
  const h = harness({
    setup() {},
    prepareFrame() {
      if (fail) throw Error("overlay failed");
    },
    render() {
      h.events.push("overlay");
    },
    dispose() {},
  });
  await assert.rejects(h.renderer.renderAsync(0), /overlay failed/);
  assert.deepEqual(h.events, []);
  fail = false;
  await h.renderer.renderAsync(0);
  assert.deepEqual(h.events, ["a", "overlay", "submit"]);
  h.renderer.dispose();
});

test("disposing during overlay preparation prevents late output", async () => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const h = harness({
    setup() {},
    async prepareFrame() {
      started();
      await gate;
    },
    render() {
      h.events.push("overlay");
    },
    dispose() {
      h.events.push("dispose-overlay");
    },
  });
  const pending = h.renderer.renderAsync(1);
  await began;
  h.renderer.dispose();
  release();
  await assert.rejects(pending, { name: "AbortError" });
  assert.ok(!h.events.includes("submit"));
  assert.ok(h.events.includes("dispose-overlay"));
});

test("overlay cleanup failures do not prevent device disposal; invalid factories fail validation", (t) => {
  t.mock.method(console, "error", () => {});
  const h = harness({
    setup() {},
    render() {},
    dispose() {
      throw Error("cleanup failed");
    },
  });
  h.renderer.dispose();
  assert.equal(h.events.at(-1), "destroy");
  assert.throws(
    () => validateProject({ ...h.project, overlay: {} as never }),
    /overlay must be a scene factory/,
  );
});

test("renderer owns overlay setup/disposal on success, failure, and cancelled initialization", async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  const usageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "GPUTextureUsage",
  );
  Object.defineProperty(globalThis, "GPUTextureUsage", {
    configurable: true,
    value: { RENDER_ATTACHMENT: 16, COPY_SRC: 1 },
  });
  try {
    for (const mode of ["success", "failure", "cancel"] as const) {
      const events: string[] = [];
      let release!: () => void, started!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const began = new Promise<void>((resolve) => {
        started = resolve;
      });
      const controller = new AbortController();
      let factoryCalls = 0;
      const overlay: Scene = {
        async setup(context) {
          events.push("setup-overlay");
          assert.deepEqual(context.compositionResolution, [100, 100]);
          started();
          if (mode === "failure") throw Error("overlay setup failed");
          if (mode === "cancel") await gate;
        },
        render() {},
        dispose() {
          events.push("dispose-overlay");
        },
      };
      const h = harness(overlay);
      h.project.overlay = () => {
        factoryCalls++;
        return overlay;
      };
      const device = {
        addEventListener() {},
        lost: new Promise(() => {}),
        pushErrorScope() {},
        async popErrorScope() {
          return null;
        },
        destroy() {
          events.push("destroy");
        },
      };
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
          gpu: {
            async requestAdapter() {
              return {
                async requestDevice() {
                  return device;
                },
              };
            },
            getPreferredCanvasFormat() {
              return "rgba8unorm";
            },
          },
        },
      });
      const canvas = {
        width: 100,
        height: 100,
        getContext() {
          return { configure() {}, unconfigure() {} };
        },
      } as unknown as HTMLCanvasElement;
      const pending = Renderer.create(
        canvas,
        h.project,
        undefined,
        controller.signal,
      );
      await began;
      if (mode === "cancel") controller.abort();
      if (mode === "success") {
        const renderer = await pending;
        renderer.dispose();
        renderer.dispose();
      } else
        await assert.rejects(
          pending,
          mode === "failure" ? /overlay setup failed/ : { name: "AbortError" },
        );
      release();
      await Promise.resolve();
      assert.equal(factoryCalls, 1);
      assert.equal(events.filter((e) => e === "dispose-overlay").length, 1);
      assert.equal(events.at(-1), "destroy");
    }
  } finally {
    if (navigatorDescriptor)
      Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, "navigator");
    if (usageDescriptor)
      Object.defineProperty(globalThis, "GPUTextureUsage", usageDescriptor);
    else Reflect.deleteProperty(globalThis, "GPUTextureUsage");
  }
});
