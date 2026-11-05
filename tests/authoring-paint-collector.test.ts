/**
 * Internal flat-Box paint collector on the actual `ViewRenderer`.
 *
 * Records are asserted against the uniforms the renderer really uploaded, never against a
 * second projection implementation: the fixture reads each command's 144-byte uniform block
 * and replays the vertex-shader placement over those float32 fields in binary64. That replay is
 * the ideal placement of the packed uniforms, not a model of GPU rounding.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ViewRenderer, type PaintRecord } from "../src/authoring/renderer";
import {
  Box,
  Camera,
  Group,
  Text,
  ZStack,
  evaluateCamera,
  evaluateView,
  type CameraState,
  type EvaluatedFrame,
  type ViewNode,
} from "../src/authoring/index";

const measure = (text: string) => text.length * 10;

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
    createElement: () => {
      const context = {
        font: "",
        letterSpacing: "",
        fillStyle: "",
        textBaseline: "",
        measureText: (text: string) => ({
          width: text.length * 10,
          fontBoundingBoxAscent: 16,
          fontBoundingBoxDescent: 4,
        }),
        scale() {},
        resetTransform() {},
        fillRect() {},
        clearRect() {},
        fillText() {},
        getImageData: () => ({ data: new Uint8ClampedArray([255, 0, 0, 255]) }),
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

const STRIDE_FLOATS = 256 / 4;
const UNIFORM_FLOATS = 36;

function createDevice() {
  const written: Float32Array[] = [];
  let draws = 0;
  const device = {
    createShaderModule: () => ({}),
    createRenderPipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createSampler: () => ({}),
    createBuffer: (descriptor: { size: number }) => ({
      size: descriptor.size,
      destroy() {},
    }),
    createBindGroup: () => ({}),
    queue: {
      writeTexture() {},
      writeBuffer(_buffer: unknown, _offset: number, data: Float32Array) {
        written.push(new Float32Array(data));
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
    countDraw: () => draws++,
    draws: () => draws,
    /** Per-command uniform blocks of the last upload, in draw order. */
    slices() {
      const write = written[written.length - 1];
      assert.equal(
        write.length % STRIDE_FLOATS,
        0,
        "one uniform block per draw",
      );
      return Array.from({ length: write.length / STRIDE_FLOATS }, (_, i) =>
        write.subarray(i * STRIDE_FLOATS, i * STRIDE_FLOATS + UNIFORM_FLOATS),
      );
    },
  };
}

interface RenderOptions {
  target?: readonly [number, number];
  design?: readonly [number, number];
  camera?: CameraState;
  sharedTransforms?: ReadonlyMap<string, readonly number[]>;
  debug?: boolean;
  collect?: boolean;
}

/** Runs one real `ViewRenderer.render` and returns its collector output plus drawn uniforms. */
async function renderOnce(view: ViewNode, options: RenderOptions = {}) {
  const target = options.target ?? ([100, 100] as const);
  const design = options.design ?? target;
  const gpu = createDevice();
  const renderer = new ViewRenderer();
  await renderer.setup({
    device: gpu.device,
    format: "bgra8unorm",
    resolution: target,
  });
  const evaluated = evaluateView(view, {
    time: 0,
    width: design[0],
    height: design[1],
    measureText: measure,
    inspection: true,
  });
  const frame: EvaluatedFrame = options.camera
    ? { ...evaluated, camera: options.camera }
    : evaluated;
  const records: PaintRecord[] = [];
  try {
    renderer.render(
      frame,
      {
        device: gpu.device,
        format: "bgra8unorm",
        resolution: target,
        target: { createView: () => ({}) } as unknown as GPUTexture,
        encoder: {
          beginRenderPass: () => ({
            setScissorRect() {},
            setPipeline() {},
            setBindGroup() {},
            draw: gpu.countDraw,
            end() {},
          }),
        } as unknown as GPUCommandEncoder,
        time: 0,
        localTime: 0,
        progress: 0,
        ...(options.sharedTransforms
          ? { sharedTransforms: options.sharedTransforms }
          : {}),
      },
      design,
      "#00000000",
      options.debug ?? false,
      1,
      true,
      new Map(),
      options.collect === false ? undefined : (record) => records.push(record),
    );
  } finally {
    renderer.dispose();
  }
  return { frame, records, draws: gpu.draws(), uniforms: gpu.slices() };
}

/**
 * The quad the shader places for one uploaded uniform block: rect × transform through the
 * camera rows. Read from the uniforms themselves, so a divergence in renderer composition
 * shows up as a mismatch instead of hiding in a duplicated projection. Arithmetic is binary64
 * over packed float32 fields; it is the ideal placement, not a GPU rounding model.
 */
function uniformQuad(block: Float32Array) {
  const [x, y, width, height] = block;
  const [sx, sy, tx, ty] = block.subarray(4, 8);
  const cameraX = block.subarray(24, 28);
  const cameraY = block.subarray(28, 32);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const u of [0, 1])
    for (const v of [0, 1]) {
      const worldX = (x + u * width) * sx + tx;
      const worldY = (y + v * height) * sy + ty;
      xs.push(cameraX[0] * worldX + cameraX[1] * worldY + cameraX[2]);
      ys.push(cameraY[0] * worldX + cameraY[1] * worldY + cameraY[2]);
    }
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  };
}

function assertQuad(
  actual: { x: number; y: number; width: number; height: number },
  block: Float32Array,
  label: string,
  tolerance = 1e-6,
) {
  const expected = uniformQuad(block);
  for (const key of ["x", "y", "width", "height"] as const)
    // Uploaded uniforms are f32; the record carries f64 geometry of the same composition.
    assert.ok(
      Math.abs(actual[key] - expected[key]) <=
        tolerance * Math.max(1, Math.abs(expected[key])),
      `${label}: ${key} ${actual[key]} must match the drawn uniform ${expected[key]}`,
    );
}

/**
 * The quad a command's own binary64 inputs imply, before the renderer packs them to float32.
 * Valid under the identity camera shorthands the packing tests use: target equals design with
 * no zoom, so the camera rows are exactly `1 0 0` / `0 1 0`.
 */
function inputQuad(command: EvaluatedFrame["commands"][number]) {
  const { x, y, width, height } = command.bounds;
  const [sx, sy, tx, ty] = command.transform;
  const xs = [x, x + width].map((px) => px * sx + tx);
  const ys = [y, y + height].map((py) => py * sy + ty);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

/** Narrows one record to recorded geometry; `accuracy: "unavailable"` carries none. */
function quadRecord(record: PaintRecord | undefined, label: string) {
  assert.ok(record, `${label}: expected a record`);
  if (record.accuracy === "unavailable")
    assert.fail(
      `${label}: expected a recorded quad, got: ${record.unsupported}`,
    );
  return record;
}

test("collector projects a scaled Box from the drawn uniforms, not from a second camera", async () => {
  await withGpuGlobals(async () => {
    const view = ZStack([
      Box({ width: 20, height: 10, fill: "#123456" })
        .scale(-2, 3, [0, 0])
        .id("mirrored"),
    ]);
    const { records, uniforms } = await renderOnce(view, {
      target: [100, 100],
      design: [100, 100],
    });
    assert.equal(records.length, 1);
    const record = quadRecord(records[0], "mirrored box");
    assert.equal(record.kind, "box");
    assert.equal(record.path, "root/mirrored/box");
    assert.equal(record.paintRole, "content");
    assert.equal(record.space, "scene-target-pixels");
    assert.deepEqual(record.resolution, [100, 100]);
    assert.equal(record.provenance, "projected-box-draw-quad");
    assert.equal(record.accuracy, "exact-rectangle");
    assert.equal(record.geometryVisible, true);
    assertQuad(record.bounds, uniforms[0], "mirrored box");
    assert.ok(
      record.bounds.x < 0,
      "negative scale flips the quad past its anchor",
    );
    assert.ok(record.bounds.width > 0 && record.bounds.height > 0);
  });
});

test("collector keeps letterbox and camera placement equal to the uploaded uniforms", async () => {
  await withGpuGlobals(async () => {
    const camera = evaluateCamera(Camera({ zoom: 2 }), 0, [100, 100]);
    const view = ZStack([Box({ width: 20, height: 10, fill: "#123456" })]);
    const { records, uniforms } = await renderOnce(view, {
      target: [200, 100],
      design: [100, 100],
      camera,
    });
    assert.equal(records.length, 1);
    const record = quadRecord(records[0], "letterboxed camera box");
    assertQuad(record.bounds, uniforms[0], "letterboxed camera box");
    // Design 100x100 into 200x100 gives scale 1 and ox 50; zoom 2 recenters, not rescales.
    assert.equal(record.bounds.width, 40);
    assert.equal(record.resolution[0], 200);

    const rotated = evaluateCamera(
      Camera({ zoom: 2, rotation: Math.PI / 4 }),
      0,
      [100, 100],
    );
    const turned = await renderOnce(view, {
      target: [200, 100],
      design: [100, 100],
      camera: rotated,
    });
    const rotatedRecord = quadRecord(turned.records[0], "rotated camera box");
    assertQuad(rotatedRecord.bounds, turned.uniforms[0], "rotated camera box");
    assert.equal(rotatedRecord.accuracy, "conservative");
  });
});

test("collector folds the shared correction into the same draw camera the uniform uses", async () => {
  await withGpuGlobals(async () => {
    const view = ZStack([
      Box({ width: 20, height: 10, fill: "#123456" }).id("hero"),
    ]);
    const plain = await renderOnce(view);
    const corrected = await renderOnce(view, {
      sharedTransforms: new Map([["hero", [2, 0, 0, 2, 10, 10]]]),
    });
    const plainRecord = quadRecord(plain.records[0], "uncorrected box");
    const correctedRecord = quadRecord(corrected.records[0], "corrected box");
    assertQuad(correctedRecord.bounds, corrected.uniforms[0], "corrected box");
    assert.notDeepEqual(correctedRecord.bounds, plainRecord.bounds);
    assert.deepEqual(correctedRecord.space, "scene-target-pixels");
  });
});

test("radius and stroke stay inside the recorded quad, and debug paint is never collected", async () => {
  await withGpuGlobals(async () => {
    const plain = ZStack([Box({ width: 20, height: 10, fill: "#123456" })]);
    const stroked = ZStack([
      Box({
        width: 20,
        height: 10,
        fill: "#123456",
        radius: 8,
        stroke: "#000000",
        strokeWidth: 4,
      }),
    ]);
    const plainRender = await renderOnce(plain);
    const strokedRender = await renderOnce(stroked, { debug: true });
    const plainRecord = quadRecord(plainRender.records[0], "plain box");
    const strokedRecord = quadRecord(strokedRender.records[0], "stroked box");
    // Rounded corners and an inner stroke add no extent the record can claim.
    assert.deepEqual(strokedRecord.bounds, plainRecord.bounds);
    assert.equal(strokedRecord.provenance, "projected-box-draw-quad");
    // Debug outlines are extra renderer commands, not frame paints.
    assert.equal(strokedRender.frame.commands.length, 1);
    assert.equal(strokedRender.records.length, 1);
  });
});

test("non-Box paints and surfaces report unsupported instead of forwarding into their trees", async () => {
  await withGpuGlobals(async () => {
    const view = ZStack([
      Box({ width: 20, height: 10, fill: "#123456" }),
      Group([Box({ width: 5, height: 5, fill: "#654321" }).id("nested")]).id(
        "surface",
      ),
      Text("hi").id("label"),
    ]);
    const { frame, records } = await renderOnce(view);
    assert.equal(records.length, frame.commands.length);
    const byPath = new Map(records.map((record) => [record.path, record]));
    const surface = byPath.get("root/surface");
    const label = byPath.get("root/label");
    assert.equal(surface?.accuracy, "unavailable");
    assert.equal(surface?.kind, "group");
    if (surface?.accuracy !== "unavailable")
      return assert.fail("expected a group");
    assert.match(surface.unsupported, /not collected/);
    assert.equal(label?.kind, "text");
    assert.equal(label?.accuracy, "unavailable");
    // The nested Box renders inside a forked renderer that receives no collector.
    assert.equal(byPath.has("root/surface/nested"), false);
    assert.equal(records.length, 3);
  });
});

test("background paint role is recorded while zero opacity keeps geometry but not visibility", async () => {
  await withGpuGlobals(async () => {
    const view = ZStack([
      Box({ width: 20, height: 10, fill: "#123456" })
        .background({ fill: "#abcdef" })
        .opacity(0)
        .id("card"),
    ]);
    const { frame, records } = await renderOnce(view);
    assert.equal(records.length, frame.commands.length);
    const background = quadRecord(
      records.find((record) => record.paintRole === "background"),
      "background paint",
    );
    const content = quadRecord(
      records.find((record) => record.paintRole === "content"),
      "content paint",
    );
    assert.deepEqual(background.bounds, content.bounds);
    assert.equal(content.geometryVisible, false);
    // Visibility is a geometry fact; the record still carries the projected quad.
    assert.ok(content.bounds.width > 0 && content.bounds.height > 0);
  });
});

test("without a collector the renderer still draws the same uniforms but records nothing", async () => {
  await withGpuGlobals(async () => {
    const view = ZStack([Box({ width: 20, height: 10, fill: "#123456" })]);
    const plain = await renderOnce(view, { collect: false });
    const collected = await renderOnce(view);
    assert.equal(plain.records.length, 0);
    assert.equal(plain.draws, plain.frame.commands.length);
    assert.equal(collected.draws, plain.draws);
    // Collecting reads the block after upload and must not change what the GPU receives.
    assert.deepEqual(plain.uniforms, collected.uniforms);
  });
});

test("a draw quad with overflowing camera uniforms reports unavailable geometry", async () => {
  await withGpuGlobals(async () => {
    const camera = evaluateCamera(Camera({ zoom: 1e200 }), 0, [100, 100]);
    const view = ZStack([
      Box({ width: 50, height: 50, fill: "#123456" }).scale(1e200),
    ]);
    const { frame, records } = await renderOnce(view, { camera });
    assert.equal(records.length, frame.commands.length);
    const [record] = records;
    assert.equal(record.accuracy, "unavailable");
    if (record.accuracy !== "unavailable") return;
    assert.match(record.unsupported, /not finite/);
  });
});

test("a 1e40 uniform overflows float32 and reports unavailable geometry", async () => {
  await withGpuGlobals(async () => {
    // 1e40 is finite in JavaScript but Infinity once packed into the uniform block.
    const view = ZStack([
      Box({ width: 20, height: 10, fill: "#123456" }).scale(1e40),
    ]);
    const { frame, records, uniforms } = await renderOnce(view);
    assert.ok(Number.isFinite(frame.commands[0].transform[0]));
    assert.equal(Number.isFinite(uniforms[0][4]), false);
    assert.equal(records.length, frame.commands.length);
    assert.equal(records[0].accuracy, "unavailable");
    if (records[0].accuracy !== "unavailable") return;
    assert.match(records[0].unsupported, /not finite/);
  });
});

test("recorded bounds follow the packed float32 uniforms, not the binary64 input", async () => {
  await withGpuGlobals(async () => {
    // 1.1 and 0.1 both round when packed, so uniform geometry differs from the input.
    const view = ZStack([
      Box({ width: 20, height: 10, fill: "#123456" })
        .scale(1.1, 1, [0, 0])
        .offset(0.1, 0),
    ]);
    const { frame, records, uniforms } = await renderOnce(view);
    const record = quadRecord(records[0], "rounded box");
    assertQuad(record.bounds, uniforms[0], "rounded box");
    assert.equal(record.bounds.width, 20 * Math.fround(1.1));
    assert.notEqual(record.bounds.width, 22);
    assert.equal(record.bounds.x, Math.fround(0.1));
    assert.notEqual(record.bounds.x, 0.1);
    assert.notDeepEqual(record.bounds, inputQuad(frame.commands[0]));
  });
});

test("a scale and an opacity that pack to zero keep uniform geometry but no visibility", async () => {
  await withGpuGlobals(async () => {
    // Below the smallest float32 denormal, so both fields upload as exact zero.
    const view = ZStack([
      Box({ width: 20, height: 10, fill: "#123456" })
        .scale(1e-50, 1e-50, [0, 0])
        .opacity(1e-50),
    ]);
    const { frame, records, uniforms } = await renderOnce(view);
    assert.equal(uniforms[0][4], 0);
    assert.equal(uniforms[0][20], 0);
    const record = quadRecord(records[0], "underflowed box");
    assertQuad(record.bounds, uniforms[0], "underflowed box");
    assert.equal(record.bounds.width, 0);
    assert.equal(record.bounds.height, 0);
    assert.equal(record.geometryVisible, false);
    // The binary64 input still has area, so this proves the record read the uniforms.
    assert.ok(inputQuad(frame.commands[0]).width > 0);
  });
});

test("finite uniforms whose vertex multiplication overflows float32 report unavailable", async () => {
  await withGpuGlobals(async () => {
    // Every uniform is finite; the rect × scale product is only finite in binary64.
    const view = ZStack([
      Box({ width: 20, height: 10, fill: "#123456" }).scale(1e38, 1e38, [0, 0]),
    ]);
    const { frame, records, uniforms } = await renderOnce(view);
    for (const field of [
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 20, 24, 25, 26, 28, 29, 30,
    ])
      assert.ok(
        Number.isFinite(uniforms[0][field]),
        `uniform field ${field} stayed finite`,
      );
    assert.ok(Number.isFinite(inputQuad(frame.commands[0]).width));
    assert.equal(records.length, frame.commands.length);
    assert.equal(records[0].accuracy, "unavailable");
    if (records[0].accuracy !== "unavailable") return;
    assert.match(records[0].unsupported, /overflows float32 vertex stages/);
  });
});

test("a camera product sum that leaves float32 before a cancelling constant reports unavailable", async () => {
  await withGpuGlobals(async () => {
    // Both products land near 3e38, so their float32 sum overflows; the -3.4e38 constant keeps
    // the unstaged binary64 total finite, so only the staged product sum proves this.
    const view = ZStack([
      Box({ width: 50, height: 50, fill: "#123456" }).id("hero"),
    ]);
    const { frame, records, uniforms } = await renderOnce(view, {
      sharedTransforms: new Map([["hero", [6e36, 0, 6e36, 1, -3.4e38, 0]]]),
    });
    const [x, y, width, height] = uniforms[0];
    const [cx, cy, constant] = uniforms[0].subarray(24, 27);
    // The (1, 1) corner: both camera components contribute, so only the staged sum overflows.
    const worldX = (x + width) * uniforms[0][4] + uniforms[0][6];
    const worldY = (y + height) * uniforms[0][5] + uniforms[0][7];
    assert.ok(Number.isFinite(Math.fround(cx * worldX)));
    assert.ok(Number.isFinite(Math.fround(cy * worldY)));
    assert.equal(
      Number.isFinite(Math.fround(cx * worldX + cy * worldY)),
      false,
    );
    assert.ok(Number.isFinite(cx * worldX + cy * worldY + constant));
    assert.equal(records.length, frame.commands.length);
    assert.equal(records[0].accuracy, "unavailable");
    if (records[0].accuracy !== "unavailable") return;
    assert.match(
      records[0].unsupported,
      /overflows float32 vertex stages: camera X/,
    );
  });
});

test("records snapshot inspection and resolution against later source mutation", async () => {
  await withGpuGlobals(async () => {
    const target: [number, number] = [100, 100];
    const view = ZStack([
      Box({ width: 20, height: 10, fill: "#123456" }),
      Group([Box({ width: 5, height: 5, fill: "#654321" })]).id("surface"),
    ]);
    const { frame, records } = await renderOnce(view, { target });
    const box = quadRecord(records[0], "box");
    const surface = records[1];
    const source = frame.commands[0].inspection as { id: number };
    assert.ok(source && box.inspection);
    source.id = -1;
    target[0] = 999;
    assert.notEqual(box.inspection.id, -1);
    assert.deepEqual(box.resolution, [100, 100]);
    assert.equal(surface.accuracy, "unavailable");
    assert.deepEqual(surface.resolution, [100, 100]);
    assert.equal(surface.inspection?.id >= 0, true);
  });
});
