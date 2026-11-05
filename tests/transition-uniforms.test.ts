import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateActive, validateProject } from "../src/engine/timeline";
import {
  TransitionRenderer,
  transitionUniform,
} from "../src/engine/render/transition";
import type { Project, SceneEntry, Transition } from "../src/engine/types";

const kind = {
  crossfade: 0,
  wipe: 1,
  slide: 2,
  zoom: 3,
  shared: 0,
  custom: 0,
} as const;
const directionVector = {
  left: [-1, 0],
  right: [1, 0],
  up: [0, -1],
  down: [0, 1],
} as const;
const types = [
  "crossfade",
  "wipe",
  "slide",
  "zoom",
  "shared",
  "custom",
] as const;
const directions = [undefined, "left", "right", "up", "down"] as const;

function scene(
  id: string,
  start: number,
  duration: number,
  transition: Transition,
): SceneEntry {
  return {
    id,
    name: id,
    source: "transition-uniforms.test.ts",
    start,
    duration,
    create: () => {
      throw Error("unused");
    },
    transition,
  };
}

function project(scenes: SceneEntry[]): Project {
  const last = scenes.at(-1)!;
  return {
    name: "Transition uniforms",
    resolution: [4, 3],
    aspectRatio: [4, 3],
    duration: last.start + last.duration,
    scenes,
  };
}

function f32(
  progress: number,
  type: keyof typeof kind,
  dx: number,
  dy: number,
) {
  return new Float32Array([progress, kind[type], dx, dy]);
}

test("transitionUniform packs the historical controls without clamping", () => {
  for (const type of types) {
    for (const direction of directions) {
      for (const progress of [0, 0.5, 1]) {
        const [dx, dy] = directionVector[direction ?? "left"];
        const packed = transitionUniform({
          type,
          duration: 1,
          progress,
          ...(direction ? { direction } : {}),
          ...(type === "custom" ? { shader: "fn transition() {}" } : {}),
        });
        assert.equal(packed.length, 4);
        assert.deepEqual(
          Array.from(packed),
          Array.from(f32(progress, type, dx, dy)),
        );
      }
    }
  }
  const wide = transitionUniform({
    type: "slide",
    duration: 1,
    direction: "down",
    progress: 2,
  });
  const narrow = transitionUniform({
    type: "wipe",
    duration: 1,
    direction: "up",
    progress: -0.25,
  });
  assert.deepEqual(Array.from(wide), [2, kind.slide, 0, 1]);
  assert.deepEqual(Array.from(narrow), [-0.25, kind.wipe, 0, -1]);
  const imprecise = transitionUniform({
    type: "zoom",
    duration: 1,
    progress: 0.1,
  });
  const view = new DataView(imprecise.buffer);
  assert.equal(view.getUint32(0, true), 0x3dcccccd);
  assert.equal(view.getUint32(4, true), 0x40400000);
  assert.equal(view.getUint32(8, true), 0xbf800000);
  assert.equal(view.getUint32(12, true), 0);
  assert.notEqual(imprecise[0], 0.1);
  const third = transitionUniform({
    type: "crossfade",
    duration: 1,
    progress: 1 / 3,
  });
  assert.equal(new DataView(third.buffer).getUint32(0, true), 0x3eaaaaab);
  assert.equal(third[1], kind.crossfade);
  const outside = transitionUniform({
    type: "shared",
    duration: 1,
    progress: 1.7,
  });
  assert.equal(new DataView(outside.buffer).getUint32(0, true), 0x3fd9999a);
  assert.notEqual(outside[0], 1);
  assert.equal(outside[1], kind.shared);
  const custom = transitionUniform({
    type: "custom",
    duration: 1,
    progress: 0.25,
    shader: "",
  });
  assert.equal(custom[1], kind.custom);
  assert.equal(custom[1], kind.crossfade);
});

test("invalid transitions stay on validateProject, and cut has no uniform", () => {
  const first = scene("a", 0, 2, { type: "cut" });
  assert.throws(
    () =>
      validateProject(
        project([
          first,
          scene("b", 1, 2, {
            type: "wipe",
            duration: 1,
            direction: "sideways" as "left",
          }),
        ]),
      ),
    /Invalid scene transition: b/,
  );
  assert.throws(
    () =>
      validateProject(
        project([
          first,
          scene("b", 1, 2, { type: "custom", duration: 1, shader: " " }),
        ]),
      ),
    /Invalid scene transition: b/,
  );
  const overlap = evaluateActive(
    {
      ...project([
        scene("a", 0, 2, { type: "cut" }),
        scene("b", 1, 2, { type: "cut" }),
      ]),
      duration: 3,
    },
    1.5,
  );
  assert.equal(overlap.active.length, 2);
  assert.equal(overlap.transition, undefined);
});

test("TransitionRenderer writes the packed uniform and keeps custom pipelines", async () => {
  const globals = globalThis as typeof globalThis & {
    GPUTextureUsage?: unknown;
    GPUBufferUsage?: unknown;
    GPUShaderStage?: unknown;
  };
  const saved = {
    GPUTextureUsage: Object.getOwnPropertyDescriptor(
      globalThis,
      "GPUTextureUsage",
    ),
    GPUBufferUsage: Object.getOwnPropertyDescriptor(
      globalThis,
      "GPUBufferUsage",
    ),
    GPUShaderStage: Object.getOwnPropertyDescriptor(
      globalThis,
      "GPUShaderStage",
    ),
  };
  globals.GPUTextureUsage = {
    RENDER_ATTACHMENT: 1,
    TEXTURE_BINDING: 2,
    COPY_SRC: 4,
    COPY_DST: 8,
  };
  globals.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  globals.GPUShaderStage = { FRAGMENT: 1 };
  const shaders: string[] = [];
  const builtin = { id: "builtin", getBindGroupLayout: () => ({}) };
  const customPipeline = { id: "custom" };
  const writes: Array<{
    buffer: { size: number };
    offset: number;
    data: Float32Array;
  }> = [];
  const used: unknown[] = [];
  const device = {
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createBuffer: (descriptor: { size: number }) => ({
      size: descriptor.size,
      destroy() {},
    }),
    createSampler: () => ({}),
    createShaderModule: ({ code }: { code: string }) => {
      shaders.push(code);
      return { getCompilationInfo: async () => ({ messages: [] }) };
    },
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createBindGroup: () => ({}),
    createRenderPipeline: () => builtin,
    createRenderPipelineAsync: async () => customPipeline,
    queue: {
      writeBuffer(
        buffer: { size: number },
        offset: number,
        data: Float32Array,
      ) {
        writes.push({ buffer, offset, data });
      },
    },
  };
  try {
    const renderer = new TransitionRenderer({
      device: device as unknown as GPUDevice,
      format: "rgba8unorm",
      resolution: [2, 2],
    });
    const shader =
      "fn transition(uv: vec2f, progress: f32) -> vec4f { return vec4f(1); }";
    await renderer.prepare([
      { type: "custom", duration: 1, shader },
      { type: "cut" },
    ]);
    assert.match(
      shaders[0],
      /struct Controls \{ progress: f32, kind: f32, dx: f32, dy: f32 \}/,
    );
    assert.match(shaders[0], /c\.kind>0\.5 && c\.kind<1\.5/);
    assert.match(shaders[0], /c\.kind>1\.5 && c\.kind<2\.5/);
    assert.match(shaders[0], /if\(c\.kind>2\.5\)/);
    assert.match(shaders[1], /fn transition\(uv: vec2f, progress: f32\)/);
    assert.match(shaders[1], /return transition\(i\.uv,c\.progress\)/);
    const context = {
      device,
      encoder: {
        beginRenderPass: () => ({
          setPipeline(pipeline: unknown) {
            used.push(pipeline);
          },
          setBindGroup() {},
          draw(count: number) {
            assert.equal(count, 3);
          },
          end() {},
        }),
      },
      target: { createView: () => ({}) },
    };
    const wipe = {
      type: "wipe" as const,
      duration: 1,
      direction: "right" as const,
      progress: 0.1,
    };
    const NativeFloat32Array = globalThis.Float32Array;
    let allocations = 0;
    class CountingFloat32Array extends NativeFloat32Array {
      constructor(...args: ConstructorParameters<Float32ArrayConstructor>) {
        super(...args);
        allocations++;
      }
    }
    globalThis.Float32Array = CountingFloat32Array;
    try {
      renderer.render(context as never, wipe);
    } finally {
      globalThis.Float32Array = NativeFloat32Array;
    }
    assert.equal(allocations, 1);
    assert.equal(writes[0].offset, 0);
    assert.equal(writes[0].buffer.size, 16);
    assert.equal(writes[0].data.byteLength, 16);
    assert.equal(
      new DataView(writes[0].data.buffer).getUint32(0, true),
      0x3dcccccd,
    );
    assert.deepEqual(Array.from(writes[0].data), [Math.fround(0.1), 1, 1, 0]);
    assert.deepEqual(
      Buffer.from(writes[0].data.buffer),
      Buffer.from(transitionUniform(wipe).buffer),
    );
    assert.equal(used[0], builtin);
    const custom = {
      type: "custom" as const,
      duration: 1,
      shader,
      progress: 0.25,
    };
    renderer.render(context as never, custom);
    assert.equal(used[1], customPipeline);
    assert.notEqual(used[1], builtin);
    assert.equal(writes[1].data[1], 0);
    assert.deepEqual(
      Buffer.from(
        writes[1].data.buffer,
        writes[1].data.byteOffset,
        writes[1].data.byteLength,
      ),
      Buffer.from(transitionUniform(custom).buffer),
    );
    renderer.render(context as never, {
      type: "shared",
      duration: 1,
      progress: 0.5,
    });
    assert.equal(used[2], builtin);
    assert.deepEqual(Array.from(writes[2].data), [0.5, 0, -1, 0]);
    renderer.dispose();
  } finally {
    for (const [name, descriptor] of Object.entries(saved))
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
  }
});
