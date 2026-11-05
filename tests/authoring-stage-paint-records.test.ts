/**
 * Internal paint-record transport through `Stage.render`.
 *
 * Records are read back from the uniforms the real `ViewRenderer` uploaded, and asserted against
 * the actual render context resolution rather than the setup or design resolution.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Box, Group, ZStack, Stage } from "../src/authoring/index";
import type { SetupContext, RenderContext } from "../src/engine/types";

const STRIDE_FLOATS = 256 / 4;

async function withGpuGlobals<T>(run: () => Promise<T>): Promise<T> {
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

/** GPU stubs that keep every uploaded uniform block, so records can be checked against them. */
function gpu() {
  const writes: Float32Array[] = [];
  const device = {
    createShaderModule: () => ({}),
    createRenderPipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createSampler: () => ({}),
    createBuffer: () => ({ destroy() {} }),
    createBindGroup: () => ({}),
    queue: {
      writeTexture() {},
      writeBuffer(_buffer: unknown, _offset: number, data: Float32Array) {
        writes.push(new Float32Array(data));
      },
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
  return {
    device,
    /** Per-command uniform blocks of the last upload, in draw order. */
    blocks() {
      const upload = writes
        .filter((w) => w.length % STRIDE_FLOATS === 0)
        .at(-1);
      assert.ok(upload, "expected a uniform upload");
      return Array.from({ length: upload.length / STRIDE_FLOATS }, (_, i) =>
        upload.subarray(i * STRIDE_FLOATS, i * STRIDE_FLOATS + 36),
      );
    },
  };
}

/** Setup resolution is distinct from the render resolution used by one test below. */
function stageSetup(device: GPUDevice): SetupContext {
  return {
    device,
    format: "rgba8unorm",
    resolution: [100, 100],
    compositionResolution: [100, 100],
  };
}

function renderStage(
  stage: ReturnType<typeof Stage>,
  setup: SetupContext,
  time: number,
  extras: Record<string, unknown> = {},
) {
  const context: RenderContext = {
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
  };
  stage.render(context);
}

test("Stage publishes paint records only in inspection mode, from the drawn uniforms", async () => {
  await withGpuGlobals(async () => {
    const off = gpu();
    const offStage = Stage(() =>
      Box({ width: 50, height: 30, fill: "#123456" }),
    );
    try {
      const setup = stageSetup(off.device);
      await offStage.setup(setup);
      await offStage.prepareFrame!({ time: 0, localTime: 0, progress: 0 });
      renderStage(offStage, setup, 0);
      const frame = offStage.inspect();
      assert.ok(frame);
      assert.equal(
        "paintRecords" in frame,
        false,
        "opt-out must not add a paintRecords key",
      );
    } finally {
      offStage.dispose();
    }

    const on = gpu();
    const stage = Stage(
      () =>
        ZStack([
          Box({ width: 50, height: 30, fill: "#123456" }),
          Group([Box({ width: 10, height: 10, fill: "#654321" })]),
        ]),
      { inspection: true },
    );
    try {
      const setup = stageSetup(on.device);
      await stage.setup(setup);
      await stage.prepareFrame!({ time: 0, localTime: 0, progress: 0 });
      // Output resolution differs from setup, so the record must carry the render context's.
      renderStage(stage, setup, 0, { resolution: [200, 100] });
      const frame = stage.inspect();
      assert.ok(frame?.paintRecords, "inspection mode must publish records");
      const records = frame.paintRecords;
      assert.equal(records.length, 2, "group owner is not a second leaf");
      const [box, nested] = records;
      assert.equal(box.kind, "box");
      assert.equal(box.accuracy, "exact-rectangle");
      assert.deepEqual(box.resolution, [200, 100]);
      assert.equal(nested.kind, "box");
      assert.equal(nested.accuracy, "exact-rectangle");
      assert.equal(records.some((record) => record.kind === "group"), false);

      // The record carries the resolution actually drawn to, read from the uploaded uniforms.
      const block = on.blocks()[0];
      assert.equal(block[8], 200);
      assert.equal(block[9], 100);
      assert.deepEqual([...box.resolution], [block[8], block[9]]);
    } finally {
      stage.dispose();
    }
  });
});

test("Stage keeps per-frame inspection overrides and the option fallback aligned with the prepared cache", async () => {
  await withGpuGlobals(async () => {
    const stage = Stage(() => Box({ width: 20, height: 10 }), {
      inspection: true,
    });
    try {
      const setup = stageSetup(gpu().device);
      await stage.setup(setup);
      // Option fallback: neither prepare nor render sets the per-frame flag.
      await stage.prepareFrame!({ time: 0, localTime: 0, progress: 0 });
      renderStage(stage, setup, 0);
      assert.ok(
        stage.inspect()?.paintRecords,
        "options.inspection must collect",
      );

      // A mode switch at the same time must refuse the prepared result instead of serving it.
      await stage.prepareFrame!({
        time: 0,
        localTime: 0,
        progress: 0,
        inspection: false,
      });
      assert.throws(
        () => renderStage(stage, setup, 0),
        /frame is not prepared/,
        "render in option mode must not consume a prepare-without-inspection result",
      );
      assert.equal(
        stage.inspect(),
        undefined,
        "a refused render must not publish a frame",
      );
    } finally {
      stage.dispose();
    }

    const override = Stage(() => Box({ width: 20, height: 10 }));
    try {
      const setup = stageSetup(gpu().device);
      await override.setup(setup);
      await override.prepareFrame!({
        time: 0,
        localTime: 0,
        progress: 0,
        inspection: true,
      });
      renderStage(override, setup, 0, { inspection: true });
      const frame = override.inspect();
      assert.ok(frame?.paintRecords, "per-frame inspection must collect");
      assert.equal(frame.paintRecords[0].kind, "box");
    } finally {
      override.dispose();
    }
  });
});

test("Stage clears stale snapshots and keeps published records immutable across renders", async () => {
  await withGpuGlobals(async () => {
    let fail = false;
    let badColor = false;
    const stage = Stage(
      ({ time }) => {
        if (fail) throw Error("view evaluation failed");
        return Box({
          width: 40 + time,
          height: 20,
          fill: badColor ? "var(--paint)" : "#123456",
        });
      },
      { inspection: true },
    );
    try {
      const setup = stageSetup(gpu().device);
      // Not ready yet: a render throws and nothing becomes inspectable.
      assert.throws(() => renderStage(stage, setup, 0), /not ready/);
      assert.equal(stage.inspect(), undefined);
      await stage.setup(setup);
      await stage.prepareFrame!({ time: 0, localTime: 0, progress: 0 });
      renderStage(stage, setup, 0);
      const first = stage.inspect();
      assert.ok(first?.paintRecords);
      const firstRecords = first.paintRecords;
      const firstKinds = firstRecords.map((r) => r.kind);

      await stage.prepareFrame!({ time: 1, localTime: 1, progress: 0.5 });
      renderStage(stage, setup, 1);
      const second = stage.inspect();
      assert.ok(second?.paintRecords);
      assert.notEqual(second, first, "each render publishes a new snapshot");
      assert.notEqual(second.paintRecords, firstRecords, "records are fresh");
      assert.equal(first.paintRecords, firstRecords);
      assert.deepEqual(
        first.paintRecords.map((r) => r.kind),
        firstKinds,
        "an older snapshot keeps its own records",
      );

      // A render that throws inside the renderer also publishes nothing.
      badColor = true;
      await stage.prepareFrame!({ time: 1, localTime: 1, progress: 0.5 });
      assert.throws(() => renderStage(stage, setup, 1), /explicit color/);
      assert.equal(
        stage.inspect(),
        undefined,
        "a failed render publishes nothing",
      );
      badColor = false;

      // A preparation failure removes the previous snapshot, records included.
      await stage.prepareFrame!({ time: 1, localTime: 1, progress: 0.5 });
      renderStage(stage, setup, 1);
      assert.ok(stage.inspect()?.paintRecords);
      fail = true;
      await assert.rejects(
        stage.prepareFrame!({ time: 2, localTime: 2, progress: 1 }),
        /view evaluation failed/,
      );
      assert.equal(stage.inspect(), undefined);
    } finally {
      stage.dispose();
      assert.equal(stage.inspect(), undefined, "dispose clears the frame");
    }
  });
});
