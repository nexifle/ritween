/**
 * Group surface projection. Bounds are replayed from uploaded uniforms and the scissor formula
 * the renderer records, not from layout or a second camera.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ViewRenderer, type PaintRecord } from "../src/authoring/renderer";
import { computeFrameTransform } from "../src/authoring/frame-transform";
import {
  applyInspectionTarget,
  buildInspectionDocument,
  InspectionBudget,
  InspectionSerializationError,
  paintRecord,
} from "../src/engine/inspect/report";
import type { FrameInspection } from "../src/engine/render/renderer";
import {
  Box,
  Composition,
  Group,
  World,
  ZStack,
  evaluateView,
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
    GPUTextureUsage: Object.getOwnPropertyDescriptor(globalThis, "GPUTextureUsage"),
    GPUBufferUsage: Object.getOwnPropertyDescriptor(globalThis, "GPUBufferUsage"),
  };
  globals.GPUTextureUsage = {
    RENDER_ATTACHMENT: 1,
    COPY_SRC: 2,
    TEXTURE_BINDING: 4,
    COPY_DST: 8,
  };
  globals.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2, STORAGE: 4 };
  globals.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        font: "",
        letterSpacing: "",
        fillStyle: "",
        textBaseline: "",
        measureText: (text: string) => ({ width: text.length * 10 }),
        scale() {},
        resetTransform() {},
        fillRect() {},
        clearRect() {},
        fillText() {},
        getImageData: () => ({ data: new Uint8ClampedArray([255, 0, 0, 255]) }),
      }),
    }),
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

function createDevice() {
  const uniformWrites: Float32Array[] = [];
  const device = {
    createShaderModule: () => ({}),
    createRenderPipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createSampler: () => ({}),
    createBuffer: (descriptor: { usage?: number }) => ({
      usage: descriptor.usage ?? 0,
      destroy() {},
    }),
    createBindGroup: () => ({}),
    queue: {
      writeBuffer(buffer: { usage?: number }, _offset: number, data: Float32Array) {
        if ((buffer.usage ?? 0) & 1) uniformWrites.push(new Float32Array(data));
      },
      writeTexture() {},
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
  return { device, uniformWrites };
}

function slices(write: Float32Array) {
  const stride = 64;
  return Array.from({ length: write.length / stride }, (_, index) =>
    write.subarray(index * stride, index * stride + 36),
  );
}

function context(device: GPUDevice, target: readonly [number, number]) {
  return {
    device,
    format: "bgra8unorm" as const,
    resolution: target,
    target: { createView: () => ({}) } as unknown as GPUTexture,
    encoder: {
      beginRenderPass: () => ({
        setScissorRect() {},
        setPipeline() {},
        setBindGroup() {},
        draw() {},
        end() {},
      }),
    } as unknown as GPUCommandEncoder,
    time: 0,
    localTime: 0,
    progress: 0,
  };
}

async function renderOnce(
  view: ViewNode,
  options: {
    target?: readonly [number, number];
    design?: readonly [number, number];
    collect?: boolean;
    sharedTransforms?: ReadonlyMap<string, readonly number[]>;
    inspection?: boolean;
    frame?: EvaluatedFrame;
  } = {},
) {
  const target = options.target ?? ([100, 100] as const);
  const design = options.design ?? target;
  const gpu = createDevice();
  const renderer = new ViewRenderer();
  await renderer.setup({ device: gpu.device, format: "bgra8unorm", resolution: target });
  const frame =
    options.frame ??
    evaluateView(view, {
      time: 0,
      width: design[0],
      height: design[1],
      measureText: measure,
      inspection: options.inspection ?? true,
    });
  const records: PaintRecord[] = [];
  renderer.render(
    frame,
    {
      ...context(gpu.device, target),
      ...(options.sharedTransforms ? { sharedTransforms: options.sharedTransforms } : {}),
    },
    design,
    "#00000000",
    false,
    1,
    true,
    new Map(),
    options.collect === false ? undefined : (record) => records.push(record),
  );
  const traces = renderer.surfaceTraces();
  renderer.dispose();
  return { frame, records, traces, uniforms: gpu.uniformWrites.map(slices) };
}

function mul(a: readonly number[], b: readonly number[]) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function mappingFromUpload(block: Float32Array, childWidth: number, childHeight: number) {
  const camera = [block[24], block[28], block[25], block[29], block[26], block[30]];
  const command = [block[4], 0, 0, block[5], block[6], block[7]];
  return mul(
    camera,
    mul(command, mul([1, 0, 0, 1, block[0], block[1]], [block[2] / childWidth, 0, 0, block[3] / childHeight, 0, 0])),
  );
}

function geometry(record: PaintRecord | undefined, label: string) {
  assert.ok(record, label);
  assert.notEqual(record.accuracy, "unavailable", label);
  if (!record || record.accuracy === "unavailable") throw Error(label);
  return record;
}

function kinds(record: PaintRecord) {
  if (record.accuracy === "unavailable") return [];
  return record.surfaceProjection?.boundaries.map((boundary) => boundary.kind) ?? [];
}

test("group chains project descendants from uploaded uniforms, not a second leaf", async () => {
  await withGpuGlobals(async () => {
    const card = Box({ width: 8, height: 6, fill: "#111111" }).id("card");
    const cases = [
      Group([card]).id("root-group"),
      Group([card.clip().id("window")]).id("clip-in-group"),
      Group([card]).clip().id("group-in-clip"),
      Group([Group([card]).id("inner")]).id("two"),
      Group([Group([card.clip().id("window")]).clip().id("mid")]).id("deep"),
    ];
    const expected = [
      ["group"],
      ["clip", "group"],
      ["group", "clip"],
      ["group", "group"],
      ["clip", "group", "clip", "group"],
    ];
    for (const [index, view] of cases.entries()) {
      const rendered = await renderOnce(view);
      assert.equal(rendered.records.some((record) => record.kind === "group"), false, String(index));
      assert.equal(rendered.records.some((record) => record.kind === "composition"), false, String(index));
      const record = geometry(
        rendered.records.find((entry) => entry.path.includes("card")),
        `card ${index}`,
      );
      assert.deepEqual(kinds(record), expected[index], String(index));
      assert.equal(record.surfaceProjection?.coverage, "rect-clipped-draw-quad");
      assert.equal(record.inspection?.role, "content");
      assert.notEqual(record.inspection?.nodeId, rendered.traces[0]?.ownerNodeId);
      for (const trace of rendered.traces) {
        assert.equal(trace.projection.status, "mapped", trace.path);
        if (trace.projection.status !== "mapped") continue;
        const block = rendered.uniforms.flat().find((entry) => entry[20] === trace.uniform.opacity && entry[2] === trace.uniform.rect[2]);
        assert.ok(block, trace.path);
        assert.deepEqual(
          trace.projection.childPixelsToParent,
          mappingFromUpload(block, trace.childResolution[0], trace.childResolution[1]),
        );
      }
    }

    const masked = await renderOnce(
      Group([Box({ width: 8, height: 6, fill: "#111111" }).clip({ shape: "circle" }).id("card")]).id("mask"),
    );
    const circle = geometry(masked.records[0], "circle");
    assert.equal(circle.surfaceProjection?.coverage, "outer-clipped-draw-quad");
    assert.equal(circle.accuracy, "conservative");
    assert.deepEqual(kinds(circle), ["clip", "group"]);

    const outside = await renderOnce(
      Group([Box({ width: 30, height: 20, fill: "#111111" }).id("card")]).offset(-20, 4).id("shifted"),
      { design: [40, 40], target: [40, 40] },
    );
    const shifted = geometry(outside.records.find((record) => record.path.includes("card")), "outside");
    assert.ok(shifted.bounds.x >= 0);
    assert.ok(shifted.bounds.width < 30);
    assert.equal(shifted.geometryVisible, true);

    const world = await renderOnce(
      Composition(World(() => Group([Box({ width: 8, height: 8, fill: "#111" }).id("inside")]), { size: [40, 24] })).id("world"),
      { design: [40, 24], target: [40, 24] },
    );
    assert.equal(world.records.some((record) => record.path.includes("inside")), false);
    assert.equal(world.records.find((record) => record.kind === "composition")?.accuracy, "unavailable");
  });
});

test("ceil allocation and synthetic letterbox stay on the copied uniform", async () => {
  await withGpuGlobals(async () => {
    const rendered = await renderOnce(
      Group([Box({ width: 10.25, height: 5.25, fill: "#123456" }).id("card")]).id("surface"),
      { design: [10.25, 5.25], target: [20.5, 10.5] },
    );
    const trace = rendered.traces.find((entry) => entry.path.endsWith("surface"));
    assert.ok(trace && trace.surface.kind === "group");
    assert.deepEqual(trace.childResolution, [21, 11]);
    assert.equal(trace.uniform.rect[2], 10.25);
    assert.equal(trace.uniform.rect[3], 5.25);
    assert.equal(trace.uniform.rect[2] / trace.childResolution[0], 10.25 / 21);
    assert.equal(trace.uniform.rect[3] / trace.childResolution[1], 5.25 / 11);
    assert.notEqual(trace.childResolution[0], 10.25 * 2);
    const group = rendered.frame.commands[0];
    assert.equal(group.kind, "group");
    if (group.kind !== "group") return;
    const letterbox = computeFrameTransform(
      [group.bounds.width, group.bounds.height],
      trace.childResolution,
      group.frame.camera?.matrix,
    );
    assert.ok(letterbox.oy > 0);
    const child = rendered.uniforms[0][0];
    assert.equal(child[30], Math.fround(letterbox.matrix[5]));
    assert.notEqual(child[30], 0);
    const record = geometry(rendered.records[0], "allocated");
    assert.equal(record.surfaceProjection?.boundaries.length, 1);
    assert.equal(record.surfaceProjection?.boundaries[0].kind, "group");
  });
});

test("opacity, negative scale, and zero scale use each float32 opacity", async () => {
  await withGpuGlobals(async () => {
    const hidden = await renderOnce(
      Group([Box({ width: 8, height: 6, fill: "#111111" })]).opacity(-0).id("hidden"),
    );
    assert.equal(geometry(hidden.records[0], "-0").geometryVisible, false);
    const faint = await renderOnce(
      Group([Box({ width: 8, height: 6, fill: "#111111" }).opacity(1e-30)]).opacity(1e-30),
    );
    assert.equal(Math.fround(Math.fround(1e-30) * Math.fround(1e-30)), 0);
    assert.equal(geometry(faint.records[0], "underflow product").geometryVisible, true);
    const flippedBase = evaluateView(
      Group([Box({ width: 8, height: 6, fill: "#111111" }).id("card")]).id("flipped"),
      { time: 0, width: 100, height: 100, measureText: measure, inspection: true },
    );
    const flippedCommand = flippedBase.commands[0];
    assert.equal(flippedCommand.kind, "group");
    if (flippedCommand.kind !== "group") return;
    const flipped = await renderOnce(Group([Box({ width: 8, height: 6, fill: "#111111" })]), {
      frame: {
        ...flippedBase,
        commands: [{ ...flippedCommand, transform: [-2, 1, 40, 0] }],
      },
    });
    const negative = geometry(flipped.records[0], "negative");
    assert.equal(negative.accuracy, "exact-rectangle");
    assert.ok(negative.bounds.width > 0);
    assert.equal(flipped.traces[0].uniform.transform[0], -2);
    const collapsed = await renderOnce(Group([Box({ width: 8, height: 6, fill: "#111111" })]), {
      frame: {
        ...flippedBase,
        commands: [{ ...flippedCommand, transform: [0, 1, 4, 0] }],
      },
    });
    const zero = geometry(collapsed.records[0], "zero");
    assert.equal(zero.geometryVisible, false);
    assert.equal(zero.bounds.width, 0);
    assert.ok(Number.isFinite(zero.bounds.x));
  });
});

test("shared corrections and duplicate ids use the uploaded matrix once", async () => {
  await withGpuGlobals(async () => {
    const view = Group([
      Group([Box({ width: 8, height: 6, fill: "#111111" }).id("card")]).id("inner"),
    ]).id("outer");
    const outerOnly = [1, 0, 0, 1, 30, -4] as const;
    const innerOnly = [1, 0, 0, 1, 80, 9] as const;
    const unmatched = await renderOnce(view, {
      sharedTransforms: new Map([["inner", innerOnly]]),
    });
    const inner = unmatched.traces.find((trace) => trace.path.endsWith("inner"));
    const outer = unmatched.traces.find((trace) => trace.path.endsWith("outer"));
    assert.ok(inner && outer && inner.projection.status === "mapped");
    assert.notEqual(inner.uniform.cameraX[2], outer.uniform.cameraX[2]);
    assert.equal(inner.uniform.cameraX[2], Math.fround(inner.uniform.cameraX[2]));
    const both = await renderOnce(view, {
      sharedTransforms: new Map([
        ["outer", outerOnly],
        ["inner", innerOnly],
      ]),
    });
    const corrected = both.traces.find((trace) => trace.path.endsWith("outer"));
    const suppressed = both.traces.find((trace) => trace.path.endsWith("inner"));
    assert.ok(corrected && suppressed && corrected.projection.status === "mapped");
    assert.notEqual(suppressed.uniform.cameraX[2], Math.fround(80));
    const block = both.uniforms.at(-1)![0];
    assert.deepEqual(
      corrected.projection.childPixelsToParent,
      mappingFromUpload(block, corrected.childResolution[0], corrected.childResolution[1]),
    );
    const twice = mul(outerOnly, corrected.projection.childPixelsToParent);
    assert.notDeepEqual(corrected.projection.childPixelsToScene, twice);

    const duplicates = await renderOnce(
      Group([
        Group([Box({ width: 4, height: 4, fill: "#111" })]).id("same"),
      ]).id("same"),
    );
    assert.equal(duplicates.traces.length, 2);
    assert.equal(new Set(duplicates.traces.map((trace) => trace.occurrenceId)).size, 2);
    assert.equal(duplicates.records.length, 1);
    assert.equal(duplicates.records.some((record) => record.kind === "group"), false);
    assert.equal(duplicates.records[0].surfaceProjection?.boundaries.length, 2);
  });
});

test("inspection off stays flat, and failed renders clear group metadata", async () => {
  await withGpuGlobals(async () => {
    const view = Group([Box({ width: 8, height: 6, fill: "#111111" }).id("card")]).id("surface");
    const off = await renderOnce(view, { inspection: false });
    assert.equal(off.traces.length, 0);
    assert.equal(off.frame.commands[0].kind, "group");
    if (off.frame.commands[0].kind !== "group") return;
    assert.equal(off.frame.commands[0].inspectionSurface, undefined);
    assert.equal(off.records[0].kind, "group");
    assert.equal(off.records[0].accuracy, "unavailable");
    assert.equal(off.records.some((record) => record.path.includes("card")), false);
    const flat = await renderOnce(Box({ width: 8, height: 6, fill: "#111111" }).id("card"), {
      inspection: false,
    });
    const flatOn = await renderOnce(Box({ width: 8, height: 6, fill: "#111111" }).id("card"));
    assert.equal(flat.records[0].accuracy, "exact-rectangle");
    assert.equal(flatOn.records[0].accuracy, "exact-rectangle");
    if (flat.records[0].accuracy === "unavailable" || flatOn.records[0].accuracy === "unavailable") return;
    assert.deepEqual(flat.records[0].bounds, flatOn.records[0].bounds);
    assert.equal("surfaceProjection" in flatOn.records[0], false);

    const gpu = createDevice();
    const renderer = new ViewRenderer();
    await renderer.setup({ device: gpu.device, format: "bgra8unorm", resolution: [40, 40] });
    const good = evaluateView(view, {
      time: 0,
      width: 40,
      height: 40,
      measureText: measure,
      inspection: true,
    });
    const first: PaintRecord[] = [];
    const draw = context(gpu.device, [40, 40]);
    renderer.render(good, draw, [40, 40], "#00000000", false, 1, true, new Map(), (record) => first.push(record));
    const snapshot = JSON.parse(JSON.stringify(first));
    assert.equal(renderer.surfaceTraces().length > 0, true);
    const bad = evaluateView(
      ZStack([view, Box({ width: 4, height: 4, fill: "var(--nope)" })]),
      { time: 0, width: 40, height: 40, measureText: measure, inspection: true },
    );
    assert.throws(() =>
      renderer.render(bad, draw, [40, 40], "#00000000", false, 1, true, new Map(), () => {
        throw Error("collector ran");
      }),
    );
    assert.equal(renderer.surfaceTraces().length, 0);
    assert.deepEqual(first, snapshot);
    const again: PaintRecord[] = [];
    renderer.render(good, draw, [40, 40], "#00000000", false, 1, true, new Map(), (record) => again.push(record));
    assert.deepEqual(again, snapshot);
    renderer.render(good, draw, [40, 40], "#00000000", false, 1, true, new Map());
    assert.equal(renderer.surfaceTraces().length, 0);
    renderer.dispose();

    const blown = await renderOnce(view, {
      sharedTransforms: new Map([["surface", [1, 0, 0, 1, 1e40, 0]]]),
    });
    assert.equal(blown.records[0].accuracy, "unavailable");
    assert.equal("bounds" in blown.records[0], false);
    assert.equal("surfaceProjection" in blown.records[0], false);
  });
});

test("group ownership stays on the descendant and the parser fails before a late copy", () => {
  const raw = {
    kind: "box",
    path: "root/card",
    paintRole: "content",
    space: "scene-target-pixels",
    resolution: [20, 20],
    accuracy: "exact-rectangle",
    bounds: { x: 0, y: 0, width: 4, height: 4 },
    provenance: "projected-box-draw-quad",
    geometryVisible: true,
    inspection: { id: 3, nodeId: 4, role: "content" },
    surfaceProjection: {
      boundaries: [{ occurrenceId: 9, kind: "group" }],
      coverage: "rect-clipped-draw-quad",
    },
  };
  const tree = {
    path: "root",
    kind: "group",
    id: "surface",
    inspectionId: 1,
    bounds: { x: 0, y: 0, width: 8, height: 8 },
    transform: [1, 1, 0, 0],
    children: [
      {
        path: "root/card",
        kind: "box",
        id: "card",
        inspectionId: 4,
        bounds: { x: 0, y: 0, width: 4, height: 4 },
        transform: [1, 1, 0, 0],
        children: [],
      },
    ],
  };
  const frame = (node: typeof tree): FrameInspection => ({
    requestedTime: 0,
    effectiveTime: 0,
    scenes: [
      {
        id: "main",
        name: "Main",
        time: 0,
        localTime: 0,
        progress: 0,
        frame: { tree: node, commands: [], warnings: [], paintRecords: [raw] },
      },
    ],
  });
  const project = { name: "group", duration: 1, resolution: [20, 20] as const };
  const target = { scope: "scene:main", id: "card" };
  const full = buildInspectionDocument({ packageVersion: "0.0.0-test", project, frame: frame(tree) });
  const built = buildInspectionDocument({
    packageVersion: "0.0.0-test",
    project,
    frame: frame(tree),
    target,
  });
  assert.deepEqual(built.scenes[0].paintRecords, applyInspectionTarget(full, target).scenes[0].paintRecords);
  assert.equal(built.scenes[0].paintRecords?.length, 1);
  assert.equal(built.scenes[0].paintRecords?.[0].kind, "box");
  const twin = {
    ...tree,
    children: [tree.children[0], { ...tree.children[0], path: "root/other", id: "other" }],
  };
  const duplicate = buildInspectionDocument({
    packageVersion: "0.0.0-test",
    project,
    frame: frame(twin),
    target,
  });
  assert.equal(duplicate.scenes[0].paintRecords?.length, 0);

  let boundariesRead = 0;
  let afterStructure = 0;
  const probe = new InspectionBudget();
  assert.throws(() =>
    paintRecord(
      {
        ...raw,
        surfaceProjection: {
          get coverage() {
            afterStructure = probe.bytes;
            throw new InspectionSerializationError("stop before boundaries");
          },
          get boundaries() {
            boundariesRead++;
            return [];
          },
        },
      },
      "paint",
      probe,
    ),
  );
  assert.equal(boundariesRead, 0);
  assert.throws(
    () =>
      paintRecord(
        {
          ...raw,
          surfaceProjection: {
            get coverage() {
              return "rect-clipped-draw-quad";
            },
            get boundaries() {
              boundariesRead++;
              return [{ occurrenceId: 9, kind: "group" }];
            },
          },
        },
        "paint",
        new InspectionBudget(afterStructure),
      ),
    (error: unknown) =>
      error instanceof InspectionSerializationError && /bytes of UTF-8/.test(error.message),
  );
  assert.equal(boundariesRead, 0);
  assert.throws(
    () =>
      paintRecord(
        {
          ...raw,
          surfaceProjection: {
            boundaries: [{ occurrenceId: 1, kind: "mask" }],
            coverage: "rect-clipped-draw-quad",
          },
        },
        "paint",
      ),
    (error: unknown) => error instanceof InspectionSerializationError && /kind/.test(error.message),
  );
});
