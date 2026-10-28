import assert from "node:assert/strict";
import test from "node:test";
import { parseOptions } from "../cli/options";
import { managedVideoScenes, videoClip } from "../src/engine/render/visual";

test("media activation is independent of byte loading for every CLI command", () => {
  for (const command of ["preview", "frame", "export"]) {
    assert.equal(parseOptions([command]).mediaActivation, "eager");
    for (const loading of ["full", "range"]) {
      const options = parseOptions([
        command,
        "--media-activation",
        "active-only",
        "--media-loading",
        loading,
      ]);
      assert.equal(options.mediaActivation, "active-only");
      assert.equal(options.mediaLoading, loading);
    }
    assert.throws(
      () => parseOptions([command, "--media-activation", "lazy"]),
      /media-activation/,
    );
  }
});

test("active-only setup owns lightweight GPU state without opening video", async () => {
  const globals = globalThis as typeof globalThis & {
    __ritweenMediaActivation?: string;
  };
  const previous = globals.__ritweenMediaActivation;
  const usage = Object.getOwnPropertyDescriptor(globalThis, "GPUBufferUsage");
  globals.__ritweenMediaActivation = "active-only";
  Object.defineProperty(globalThis, "GPUBufferUsage", {
    configurable: true,
    value: { UNIFORM: 1, COPY_DST: 2 },
  });
  let destroyed = 0;
  const scene = videoClip({
    id: "a",
    name: "A",
    source: "x",
    url: "/must-not-open.mp4",
    start: 0,
    trim: { in: 0, out: 1 },
  }).create();
  try {
    await scene.setup({
      device: {
        createShaderModule() {
          return {};
        },
        async createRenderPipelineAsync() {
          return {};
        },
        createBuffer() {
          return {
            destroy() {
              destroyed++;
            },
          };
        },
      } as unknown as GPUDevice,
      format: "rgba8unorm",
      resolution: [320, 180],
    });
    const owner = managedVideoScenes.get(scene);
    assert.ok(owner);
    owner.deactivate();
    owner.deactivate();
    assert.equal(destroyed, 0, "deactivation retains uniforms");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      scene.prepareFrame!({
        time: 0,
        localTime: 0,
        progress: 0,
        signal: controller.signal,
      }),
      { name: "AbortError" },
    );
    scene.dispose();
    scene.dispose();
    assert.equal(destroyed, 1);
  } finally {
    scene.dispose();
    globals.__ritweenMediaActivation = previous;
    if (usage) Object.defineProperty(globalThis, "GPUBufferUsage", usage);
    else delete (globalThis as { GPUBufferUsage?: unknown }).GPUBufferUsage;
  }
});
