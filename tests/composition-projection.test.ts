/**
 * One Composition surface. World then Overlay share its texture, occurrence, and scissor.
 * Bounds are replayed from uploaded uniforms, not from world size or a second camera.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ViewRenderer, type PaintRecord } from "../src/authoring/renderer";
import { mediaKey } from "../src/authoring/media-runtime";
import { computeFrameTransform } from "../src/authoring/frame-transform";
import { evaluateCamera } from "../src/authoring/camera";
import {
  applyInspectionTarget,
  buildInspectionDocument,
  InspectionBudget,
  InspectionSerializationError,
  paintRecord,
} from "../src/engine/inspect/report";
import type { FrameInspection } from "../src/engine/render/renderer";
import type { ImageTexture } from "../src/engine/render/visual";
import {
  Box,
  Composition,
  Group,
  Image,
  Path,
  Text,
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
  let textures = 0;
  const device = {
    createShaderModule: () => ({}),
    createRenderPipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
    createTexture: () => {
      textures += 1;
      return { createView: () => ({}), destroy() {} };
    },
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
  return {
    device,
    uniformWrites,
    textureCount: () => textures,
  };
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
    media?: ReadonlyMap<string, ImageTexture>;
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
    options.media ?? new Map(),
    options.collect === false ? undefined : (record) => records.push(record),
  );
  const traces = renderer.surfaceTraces();
  const textures = gpu.textureCount();
  renderer.dispose();
  return { frame, records, traces, uniforms: gpu.uniformWrites.map(slices), textures };
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

function apply(matrix: readonly number[], x: number, y: number) {
  return [
    matrix[0] * x + matrix[2] * y + matrix[4],
    matrix[1] * x + matrix[3] * y + matrix[5],
  ];
}

function leafCorners(block: Float32Array) {
  const [x, y, width, height] = block;
  const [sx, sy, tx, ty] = block.subarray(4, 8);
  const cameraX = block.subarray(24, 27);
  const cameraY = block.subarray(28, 31);
  return (
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ] as const
  ).map(([u, v]) => {
    const worldX = (x + u * width) * sx + tx;
    const worldY = (y + v * height) * sy + ty;
    return [
      cameraX[0] * worldX + cameraX[1] * worldY + cameraX[2],
      cameraY[0] * worldX + cameraY[1] * worldY + cameraY[2],
    ];
  });
}

function scissor(ox: number, oy: number, width: number, height: number) {
  const x = Math.ceil(ox);
  const y = Math.ceil(oy);
  return {
    x,
    y,
    width: Math.max(0, Math.floor(width - ox) - x),
    height: Math.max(0, Math.floor(height - oy) - y),
  };
}

function intersect(
  rect: { x: number; y: number; width: number; height: number },
  width: number,
  height: number,
) {
  const x = Math.max(rect.x, 0);
  const y = Math.max(rect.y, 0);
  const right = Math.min(rect.x + rect.width, width);
  const bottom = Math.min(rect.y + rect.height, height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function clipPolygon(
  points: readonly (readonly number[])[],
  rect: { x: number; y: number; width: number; height: number },
) {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const edges: readonly [
    (point: readonly number[]) => boolean,
    (a: readonly number[], b: readonly number[]) => number[],
  ][] = [
    [(point) => point[0] >= rect.x, (a, b) => {
      const t = (rect.x - a[0]) / (b[0] - a[0]);
      return [rect.x, a[1] + t * (b[1] - a[1])];
    }],
    [(point) => point[0] <= right, (a, b) => {
      const t = (right - a[0]) / (b[0] - a[0]);
      return [right, a[1] + t * (b[1] - a[1])];
    }],
    [(point) => point[1] >= rect.y, (a, b) => {
      const t = (rect.y - a[1]) / (b[1] - a[1]);
      return [a[0] + t * (b[0] - a[0]), rect.y];
    }],
    [(point) => point[1] <= bottom, (a, b) => {
      const t = (bottom - a[1]) / (b[1] - a[1]);
      return [a[0] + t * (b[0] - a[0]), bottom];
    }],
  ];
  let poly = points.map((point) => [point[0], point[1]]);
  if (!(rect.width > 0) || !(rect.height > 0)) return [];
  for (const [inside, cross] of edges) {
    if (!poly.length) return [];
    const out: number[][] = [];
    let previous = poly[poly.length - 1];
    let previousIn = inside(previous);
    for (const point of poly) {
      const pointIn = inside(point);
      if (pointIn !== previousIn) out.push(cross(previous, point));
      if (pointIn) out.push(point);
      previous = point;
      previousIn = pointIn;
    }
    poly = out;
  }
  return poly;
}

function boundsOf(points: readonly (readonly number[])[]) {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

function geometry(record: PaintRecord | undefined, label: string) {
  assert.ok(record, label);
  assert.notEqual(record.accuracy, "unavailable", label);
  if (!record || record.accuracy === "unavailable") throw Error(label);
  return record;
}

function cameraRows(block: Float32Array) {
  return [block[24], block[25], block[26], block[28], block[29], block[30]];
}

function froundMatrix(matrix: readonly number[]) {
  return matrix.map((value) => Math.fround(value));
}

test("world camera and overlay share one ceil allocation, letterbox, and scissor", async () => {
  await withGpuGlobals(async () => {
    const viewport = [10.25, 5.25] as const;
    const target = [20.5, 10.5] as const;
    const worldSize = [40, 24] as const;
    const camera = { zoom: 1.5, rotation: 0.25, x: 4, y: 3 };
    const view = Composition(
      World(
        () => Box({ width: 3, height: 2, fill: "#111111" }).offset(2, 1).id("world-card"),
        { size: worldSize },
      ),
      {
        size: viewport,
        camera,
        overlay: () => Box({ width: 3, height: 2, fill: "#222222" }).offset(1, 1).id("overlay-card"),
      },
    ).id("comp");
    const rendered = await renderOnce(view, { design: viewport, target });
    assert.equal(rendered.textures, 2, "white plus one composition texture, not a world/overlay pair");
    const trace = rendered.traces.find((entry) => entry.path.endsWith("comp"));
    assert.ok(trace);
    assert.deepEqual(trace.surface, { kind: "composition" });
    assert.equal("shape" in trace.surface, false);
    const allocated = [
      Math.max(1, Math.ceil(viewport[0] * Math.min(target[0] / viewport[0], target[1] / viewport[1]))),
      Math.max(1, Math.ceil(viewport[1] * Math.min(target[0] / viewport[0], target[1] / viewport[1]))),
    ] as const;
    assert.deepEqual(allocated, [21, 11]);
    assert.deepEqual(trace.childResolution, allocated);
    assert.notDeepEqual([...trace.childResolution], [...worldSize]);
    assert.equal(trace.uniform.rect[2], viewport[0]);
    assert.equal(trace.uniform.rect[3], viewport[1]);
    const command = rendered.frame.commands[0];
    assert.equal(command.kind, "composition");
    if (command.kind !== "composition") return;
    assert.deepEqual(command.inspectionSurface, { kind: "composition" });
    assert.deepEqual([command.bounds.width, command.bounds.height], [...viewport]);
    assert.equal(trace.occurrenceId, command.inspection?.id);
    assert.equal(trace.ownerNodeId, command.inspection?.nodeId);
    assert.equal(rendered.traces.filter((entry) => entry.surface.kind === "composition").length, 1);

    const worldBlock = rendered.uniforms[0][0];
    const overlayBlock = rendered.uniforms[1][0];
    const parent = rendered.uniforms.at(-1)![0];
    assert.deepEqual([worldBlock[8], worldBlock[9]], [...allocated]);
    assert.deepEqual([overlayBlock[8], overlayBlock[9]], [...allocated]);
    assert.notDeepEqual([worldBlock[8], worldBlock[9]], [...worldSize]);
    const childSize = [command.bounds.width, command.bounds.height] as const;
    const worldPose = evaluateCamera(camera, 0, [...viewport]);
    const worldFrame = computeFrameTransform(childSize, allocated, worldPose.matrix);
    const overlayFrame = computeFrameTransform(childSize, allocated);
    assert.deepEqual(froundMatrix(cameraRows(worldBlock)), froundMatrix([
      worldFrame.matrix[0],
      worldFrame.matrix[2],
      worldFrame.matrix[4],
      worldFrame.matrix[1],
      worldFrame.matrix[3],
      worldFrame.matrix[5],
    ]));
    assert.deepEqual(froundMatrix(cameraRows(overlayBlock)), froundMatrix([
      overlayFrame.matrix[0],
      overlayFrame.matrix[2],
      overlayFrame.matrix[4],
      overlayFrame.matrix[1],
      overlayFrame.matrix[3],
      overlayFrame.matrix[5],
    ]));
    assert.notDeepEqual(cameraRows(worldBlock), cameraRows(overlayBlock));
    assert.notDeepEqual(cameraRows(parent), cameraRows(worldBlock));
    assert.deepEqual(
      trace.projection.status === "mapped" ? trace.projection.childPixelsToParent : undefined,
      mappingFromUpload(parent, allocated[0], allocated[1]),
    );
    assert.notDeepEqual(
      mappingFromUpload(parent, allocated[0], allocated[1]),
      mappingFromUpload(parent, worldSize[0], worldSize[1]),
    );
    // Camera does not move the letterbox, so both child frames set this same scissor.
    assert.equal(worldFrame.ox, overlayFrame.ox);
    assert.equal(worldFrame.oy, overlayFrame.oy);
    assert.ok(worldFrame.oy > 0);
    const childWindow = intersect(
      scissor(worldFrame.ox, worldFrame.oy, allocated[0], allocated[1]),
      allocated[0],
      allocated[1],
    );
    const overlayWindow = intersect(
      scissor(overlayFrame.ox, overlayFrame.oy, allocated[0], allocated[1]),
      allocated[0],
      allocated[1],
    );
    assert.deepEqual(childWindow, overlayWindow);
    const rootFrame = computeFrameTransform(viewport, target);
    const rootWindow = intersect(scissor(rootFrame.ox, rootFrame.oy, target[0], target[1]), target[0], target[1]);
    const mapped = mappingFromUpload(parent, allocated[0], allocated[1]);
    const replay = (block: Float32Array) => {
      let polygon = clipPolygon(leafCorners(block), childWindow).map((point) => apply(mapped, point[0], point[1]));
      polygon = clipPolygon(polygon, rootWindow);
      return boundsOf(polygon);
    };
    const world = geometry(rendered.records.find((record) => record.path.includes("world-card")), "world");
    const overlay = geometry(rendered.records.find((record) => record.path.includes("overlay-card")), "overlay");
    assert.deepEqual(
      rendered.records.map((record) => (record.path.includes("world-card") ? "world" : "overlay")),
      ["world", "overlay"],
    );
    assert.deepEqual(world.bounds, replay(worldBlock));
    assert.deepEqual(overlay.bounds, replay(overlayBlock));
    assert.notDeepEqual(world.bounds, overlay.bounds);
    assert.equal(world.accuracy, "conservative");
    assert.equal(overlay.accuracy, "exact-rectangle");
    assert.deepEqual(world.resolution, [...target]);
    assert.deepEqual(overlay.resolution, [...target]);
    assert.equal(world.space, "scene-target-pixels");
    assert.deepEqual(world.surfaceProjection, {
      boundaries: [{ occurrenceId: trace.occurrenceId, kind: "composition" }],
      coverage: "rect-clipped-draw-quad",
    });
    assert.equal("shape" in world.surfaceProjection.boundaries[0], false);
    assert.equal(rendered.records.some((record) => record.kind === "composition"), false);
    assert.notEqual(world.inspection?.nodeId, trace.ownerNodeId);
    assert.notEqual(overlay.inspection?.nodeId, world.inspection?.nodeId);
    assert.notEqual(world.inspection?.id, overlay.inspection?.id);
  });
});

test("nested composition, group, and clip keep leaf-first order without a second surface", async () => {
  await withGpuGlobals(async () => {
    const photo = { kind: "image" as const, url: "photo.png", style: { width: 6, height: 4 } };
    const view = Group([
      Composition(
        World(
          () =>
            Group([
              Box({ width: 8, height: 6, fill: "#111111" }).clip({ shape: "circle" }).id("in-clip"),
            ]).id("in-group"),
          { size: [30, 18] },
        ),
        {
          size: [16, 12],
          overlay: () =>
            ZStack([
              Composition(
                World(() => Text("deep").id("deep"), { size: [8, 8] }),
                {
                  size: [8, 8],
                  overlay: () =>
                    Image({ url: "photo.png", width: 6, height: 4 }).id("deep-over"),
                },
              ).id("inner-comp"),
              Path([["M", 0, 0], ["L", 4, 0], ["L", 0, 4], ["Z"]], {
                width: 4,
                height: 4,
                fill: "#333333",
              }).id("mark"),
            ]),
        },
      ).id("comp"),
      Box({ width: 5, height: 5, fill: "#444444" }).clip().id("out-clip"),
    ]).id("out-group");
    const rendered = await renderOnce(view, {
      design: [40, 30],
      target: [40, 30],
      media: new Map([[mediaKey(photo), { texture: { createView: () => ({}) }, width: 6, height: 4 } as unknown as ImageTexture]]),
    });
    const named = (record: PaintRecord) =>
      record.path.includes("in-clip")
        ? "in-clip"
        : record.path.includes("out-clip")
          ? "out-clip"
          : record.path.split("/").at(-1);
    assert.deepEqual(rendered.records.map(named), ["in-clip", "deep", "deep-over", "mark", "out-clip"]);
    assert.equal(rendered.records.some((record) => record.kind === "composition" || record.kind === "group"), false);
    const kinds = (id: string) => {
      const record = geometry(rendered.records.find((entry) => entry.path.includes(id)), id);
      return record.surfaceProjection?.boundaries.map((boundary) => boundary.kind);
    };
    assert.deepEqual(kinds("in-clip"), ["clip", "group", "composition", "group"]);
    assert.deepEqual(kinds("deep"), ["composition", "composition", "group"]);
    const label = geometry(rendered.records.find((record) => named(record) === "deep"), "text");
    assert.equal(label.kind, "text");
    assert.equal(label.provenance, "projected-text-draw-quad");
    assert.deepEqual(kinds("deep-over"), ["composition", "composition", "group"]);
    assert.deepEqual(kinds("out-clip"), ["clip", "group"]);
    const clipped = geometry(rendered.records.find((record) => record.path.includes("in-clip")), "circle");
    assert.equal(clipped.surfaceProjection?.coverage, "outer-clipped-draw-quad");
    assert.equal(clipped.accuracy, "conservative");
    const media = geometry(rendered.records.find((record) => record.path.includes("deep-over")), "media");
    assert.equal(media.kind, "media");
    assert.equal(media.accuracy, "conservative");
    assert.equal(media.surfaceProjection?.coverage, "rect-clipped-draw-quad");
    assert.equal(media.provenance, "projected-image-draw-quad");
    const mark = rendered.records.find((record) => record.path.includes("mark"));
    assert.equal(mark?.kind, "path");
    assert.equal(mark?.accuracy, "unavailable");
    if (mark?.accuracy === "unavailable") assert.match(mark.unsupported, /not collected/);
    const compositionIds = rendered.traces.filter((trace) => trace.surface.kind === "composition").map((trace) => trace.occurrenceId);
    assert.equal(compositionIds.length, 2);
    assert.equal(new Set(rendered.traces.map((trace) => trace.occurrenceId)).size, rendered.traces.length);
    assert.equal(rendered.traces.some((trace) => trace.path.endsWith("world") || trace.path.endsWith("overlay")), false);
    for (const record of rendered.records) {
      if (record.accuracy === "unavailable") {
        assert.equal("bounds" in record, false);
        assert.equal("surfaceProjection" in record, false);
        continue;
      }
      assert.equal(record.space, "scene-target-pixels");
      assert.deepEqual(record.resolution, [40, 30]);
      assert.equal(record.surfaceProjection?.boundaries.some((boundary) => "shape" in boundary && boundary.kind !== "clip"), false);
    }
  });
});

test("shared correction is applied once and suppresses both child frames", async () => {
  await withGpuGlobals(async () => {
    const view = Composition(
      World(
        () => Group([Box({ width: 8, height: 6, fill: "#111111" }).id("card")]).id("world-inner"),
        { size: [40, 24] },
      ),
      {
        size: [40, 24],
        overlay: () => Group([Box({ width: 8, height: 6, fill: "#222222" }).id("hud")]).id("overlay-inner"),
      },
    ).id("outer");
    const outerOnly = [1, 0, 0, 1, 30, -4] as const;
    const innerOnly = [1, 0, 0, 1, 80, 9] as const;
    const unmatched = await renderOnce(view, {
      design: [40, 24],
      target: [40, 24],
      sharedTransforms: new Map([["world-inner", innerOnly]]),
    });
    const worldInner = unmatched.traces.find((trace) => trace.path.endsWith("world-inner"));
    const overlayInner = unmatched.traces.find((trace) => trace.path.endsWith("overlay-inner"));
    const outer = unmatched.traces.find((trace) => trace.path.endsWith("outer"));
    assert.ok(worldInner && overlayInner && outer && worldInner.projection.status === "mapped");
    assert.equal(worldInner.uniform.cameraX[2], Math.fround(80));
    assert.notEqual(overlayInner.uniform.cameraX[2], Math.fround(80));
    assert.notEqual(worldInner.uniform.cameraX[2], outer.uniform.cameraX[2]);
    const both = await renderOnce(view, {
      design: [40, 24],
      target: [40, 24],
      sharedTransforms: new Map([
        ["outer", outerOnly],
        ["world-inner", innerOnly],
        ["overlay-inner", innerOnly],
      ]),
    });
    const corrected = both.traces.find((trace) => trace.path.endsWith("outer"));
    const suppressedWorld = both.traces.find((trace) => trace.path.endsWith("world-inner"));
    const suppressedOverlay = both.traces.find((trace) => trace.path.endsWith("overlay-inner"));
    assert.ok(corrected && suppressedWorld && suppressedOverlay && corrected.projection.status === "mapped");
    assert.notEqual(suppressedWorld.uniform.cameraX[2], Math.fround(80));
    assert.notEqual(suppressedOverlay.uniform.cameraX[2], Math.fround(80));
    const block = both.uniforms.at(-1)![0];
    assert.deepEqual(
      corrected.projection.childPixelsToParent,
      mappingFromUpload(block, corrected.childResolution[0], corrected.childResolution[1]),
    );
    assert.notDeepEqual(
      corrected.projection.childPixelsToScene,
      mul(outerOnly, corrected.projection.childPixelsToParent),
    );
  });
});

test("opacity, nonfinite ancestors, inspection off, and a failed render stay immutable", async () => {
  await withGpuGlobals(async () => {
    const hidden = await renderOnce(
      Composition(
        World(() => Box({ width: 8, height: 6, fill: "#111111" }), { size: [20, 12] }),
        { size: [20, 12] },
      ).opacity(-0),
    );
    assert.equal(Object.is(hidden.traces[0].uniform.opacity, -0) || hidden.traces[0].uniform.opacity === 0, true);
    assert.equal(geometry(hidden.records[0], "-0").geometryVisible, false);
    const leafHidden = await renderOnce(
      Composition(
        World(() => Box({ width: 8, height: 6, fill: "#111111" }).opacity(-0), { size: [20, 12] }),
        { size: [20, 12] },
      ),
    );
    assert.equal(geometry(leafHidden.records[0], "leaf -0").geometryVisible, false);
    const faint = await renderOnce(
      Composition(
        World(() => Box({ width: 8, height: 6, fill: "#111111" }).opacity(1e-30), { size: [20, 12] }),
        { size: [20, 12] },
      ).opacity(1e-30),
    );
    assert.equal(Math.fround(Math.fround(1e-30) * Math.fround(1e-30)), 0);
    assert.equal(geometry(faint.records[0], "underflow").geometryVisible, true);

    const base = evaluateView(
      Composition(World(() => Box({ width: 8, height: 6, fill: "#111111" }).id("card"), { size: [20, 12] }), {
        size: [20, 12],
      }).id("comp"),
      { time: 0, width: 20, height: 12, measureText: measure, inspection: true },
    );
    const command = base.commands[0];
    assert.equal(command.kind, "composition");
    if (command.kind !== "composition") return;
    const nonfinite = await renderOnce(Composition(World(() => Box({ width: 8, height: 6, fill: "#111" }), { size: [20, 12] })), {
      frame: { ...base, commands: [{ ...command, transform: [Number.NaN, 1, 0, 0] }] },
    });
    assert.equal(nonfinite.records[0].accuracy, "unavailable");
    assert.equal("bounds" in nonfinite.records[0], false);
    assert.equal("surfaceProjection" in nonfinite.records[0], false);
    const blown = await renderOnce(
      Composition(World(() => Box({ width: 8, height: 6, fill: "#111111" }).id("card"), { size: [20, 12] }), {
        size: [20, 12],
      }).id("comp"),
      { sharedTransforms: new Map([["comp", [1, 0, 0, 1, 1e40, 0]]]) },
    );
    assert.equal(blown.records[0].accuracy, "unavailable");
    assert.equal("bounds" in blown.records[0], false);

    const view = Composition(
      World(() => Box({ width: 8, height: 6, fill: "#111111" }).id("card"), { size: [20, 12] }),
      { size: [20, 12] },
    ).id("comp");
    const off = await renderOnce(view, { inspection: false, design: [20, 12], target: [20, 12] });
    const on = await renderOnce(view, { design: [20, 12], target: [20, 12] });
    assert.equal(off.traces.length, 0);
    assert.equal(off.frame.commands[0].kind, "composition");
    if (off.frame.commands[0].kind !== "composition") return;
    assert.equal(off.frame.commands[0].inspectionSurface, undefined);
    assert.equal(off.records[0].kind, "composition");
    assert.equal(off.records[0].accuracy, "unavailable");
    assert.equal(off.records.some((record) => record.path.includes("card")), false);
    assert.equal(off.textures, on.textures);
    const flat = await renderOnce(Box({ width: 8, height: 6, fill: "#111111" }).id("card"), {
      inspection: false,
    });
    assert.equal(flat.records[0].accuracy, "exact-rectangle");
    if (flat.records[0].accuracy !== "unavailable") assert.equal("surfaceProjection" in flat.records[0], false);

    const gpu = createDevice();
    const renderer = new ViewRenderer();
    await renderer.setup({ device: gpu.device, format: "bgra8unorm", resolution: [20, 12] });
    const good = evaluateView(view, {
      time: 0,
      width: 20,
      height: 12,
      measureText: measure,
      inspection: true,
    });
    const first: PaintRecord[] = [];
    const draw = context(gpu.device, [20, 12]);
    renderer.render(good, draw, [20, 12], "#00000000", false, 1, true, new Map(), (record) => first.push(record));
    const snapshot = JSON.parse(JSON.stringify(first));
    assert.equal(renderer.surfaceTraces().length > 0, true);
    const bad = evaluateView(
      ZStack([view, Box({ width: 4, height: 4, fill: "var(--nope)" })]),
      { time: 0, width: 20, height: 12, measureText: measure, inspection: true },
    );
    assert.throws(() =>
      renderer.render(bad, draw, [20, 12], "#00000000", false, 1, true, new Map(), () => {
        throw Error("collector ran");
      }),
    );
    assert.equal(renderer.surfaceTraces().length, 0);
    assert.deepEqual(first, snapshot);
    const again: PaintRecord[] = [];
    renderer.render(good, draw, [20, 12], "#00000000", false, 1, true, new Map(), (record) => again.push(record));
    assert.deepEqual(again, snapshot);
    renderer.render(good, draw, [20, 12], "#00000000", false, 1, true, new Map());
    assert.equal(renderer.surfaceTraces().length, 0);
    renderer.dispose();
  });
});

test("report accepts a composition pair, charges no shape, and targets leaf ids", async () => {
  const raw = {
    kind: "box",
    path: "root/world/card",
    paintRole: "content",
    space: "scene-target-pixels",
    resolution: [20, 20],
    accuracy: "exact-rectangle",
    bounds: { x: 0, y: 0, width: 4, height: 4 },
    provenance: "projected-box-draw-quad",
    geometryVisible: true,
    inspection: { id: 3, nodeId: 4, role: "content" },
    surfaceProjection: {
      boundaries: [{ occurrenceId: 9, kind: "composition" }],
      coverage: "rect-clipped-draw-quad",
    },
  };
  const published = paintRecord(raw, "paint");
  assert.equal(published.accuracy === "unavailable" ? undefined : published.surfaceProjection?.boundaries[0].kind, "composition");
  if (published.accuracy !== "unavailable")
    assert.equal("shape" in published.surfaceProjection!.boundaries[0], false);
  assert.throws(
    () =>
      paintRecord(
        {
          ...raw,
          surfaceProjection: {
            boundaries: [{ occurrenceId: 9, kind: "composition", shape: "rect" }],
            coverage: "rect-clipped-draw-quad",
          },
        },
        "paint",
      ),
    /shape must be absent when kind is "composition"/,
  );
  assert.throws(
    () =>
      paintRecord(
        {
          ...raw,
          surfaceProjection: {
            boundaries: [{ occurrenceId: 9, kind: "world" }],
            coverage: "rect-clipped-draw-quad",
          },
        },
        "paint",
      ),
    /kind/,
  );
  assert.throws(
    () =>
      paintRecord(
        {
          ...raw,
          surfaceProjection: {
            boundaries: [{ occurrenceId: 9, kind: "overlay" }],
            coverage: "rect-clipped-draw-quad",
          },
        },
        "paint",
      ),
    /kind/,
  );
  const compositionBudget = new InspectionBudget();
  const groupBudget = new InspectionBudget();
  const clipBudget = new InspectionBudget();
  paintRecord(raw, "paint", compositionBudget);
  paintRecord(
    {
      ...raw,
      surfaceProjection: {
        boundaries: [{ occurrenceId: 9, kind: "group" }],
        coverage: "rect-clipped-draw-quad",
      },
    },
    "paint",
    groupBudget,
  );
  paintRecord(
    {
      ...raw,
      surfaceProjection: {
        boundaries: [{ occurrenceId: 9, kind: "clip", shape: "rect" }],
        coverage: "rect-clipped-draw-quad",
      },
    },
    "paint",
    clipBudget,
  );
  assert.equal(compositionBudget.bytes - groupBudget.bytes, "composition".length - "group".length);
  assert.equal(
    clipBudget.bytes - compositionBudget.bytes,
    11 + "rect".length - ("composition".length - "clip".length),
  );
  let shapeReads = 0;
  let shapeBytes = 0;
  const probe = new InspectionBudget();
  assert.throws(() =>
    paintRecord(
      {
        ...raw,
        surfaceProjection: {
          boundaries: [
            {
              occurrenceId: 9,
              kind: "composition",
              get shape() {
                shapeReads += 1;
                shapeBytes = probe.bytes;
                throw new InspectionSerializationError("shape read");
              },
            },
          ],
          coverage: "rect-clipped-draw-quad",
        },
      },
      "paint",
      probe,
    ),
  );
  assert.equal(shapeReads, 1);
  shapeReads = 0;
  assert.throws(
    () =>
      paintRecord(
        {
          ...raw,
          surfaceProjection: {
            boundaries: [
              {
                occurrenceId: 9,
                kind: "composition",
                get shape() {
                  shapeReads += 1;
                  return "rect";
                },
              },
            ],
            coverage: "rect-clipped-draw-quad",
          },
        },
        "paint",
        new InspectionBudget(shapeBytes - 1),
      ),
    /bytes of UTF-8/,
  );
  assert.equal(shapeReads, 0);
  let foreign = 0;
  const forbidden = () => {
    foreign += 1;
    throw Error("foreign mask data was read");
  };
  paintRecord(
    {
      ...raw,
      surfaceProjection: Object.defineProperties(
        {
          boundaries: [{ occurrenceId: 9, kind: "composition" }],
          coverage: "rect-clipped-draw-quad",
        },
        {
          outline: { enumerable: true, get: forbidden },
          mask: { enumerable: true, get: forbidden },
        },
      ),
    },
    "paint",
  );
  assert.equal(foreign, 0);

  const circle = paintRecord(
    {
      ...raw,
      accuracy: "conservative",
      surfaceProjection: {
        boundaries: [
          { occurrenceId: 4, kind: "clip", shape: "circle" },
          { occurrenceId: 9, kind: "composition" },
        ],
        coverage: "outer-clipped-draw-quad",
      },
    },
    "paint",
  );
  if (circle.accuracy === "unavailable") throw Error("circle");
  assert.equal(circle.surfaceProjection?.coverage, "outer-clipped-draw-quad");
  assert.equal(circle.inspection?.role, "content");
});

test("direct target keeps world and overlay ids on both routes", async () => {
  await withGpuGlobals(async () => {
    const rendered = await renderOnce(
      Composition(
        World(() => Box({ width: 8, height: 6, fill: "#111111" }).id("world-card"), { size: [20, 12] }),
        {
          size: [20, 12],
          overlay: () => Box({ width: 8, height: 6, fill: "#222222" }).id("overlay-card"),
        },
      ).id("comp"),
      { design: [20, 12], target: [20, 12] },
    );
    const world = geometry(rendered.records.find((record) => record.path.endsWith("world-card")), "world");
    const overlay = geometry(rendered.records.find((record) => record.path.endsWith("overlay-card")), "overlay");
    const owner = rendered.traces[0].ownerNodeId;
    const node = (
      id: string,
      path: string,
      inspectionId: number,
    ) => ({
      path,
      kind: "box",
      id,
      inspectionId,
      bounds: { x: 0, y: 0, width: 8, height: 6 },
      transform: [1, 1, 0, 0] as const,
      children: [],
    });
    const tree = {
      path: "root",
      kind: "composition",
      id: "comp",
      inspectionId: owner,
      bounds: { x: 0, y: 0, width: 20, height: 12 },
      transform: [1, 1, 0, 0] as const,
      children: [
        node("world-card", world.path, world.inspection!.nodeId),
        node("overlay-card", overlay.path, overlay.inspection!.nodeId),
        node("decoy", world.path, world.inspection!.nodeId + 100),
      ],
    };
    const project = { name: "composition", duration: 1, resolution: [20, 12] as const };
    const frame = (targetTree: typeof tree): FrameInspection => ({
      requestedTime: 0,
      effectiveTime: 0,
      scenes: [
        {
          id: "main",
          name: "Main",
          time: 0,
          localTime: 0,
          progress: 0,
          frame: { tree: targetTree, commands: [], warnings: [], paintRecords: rendered.records },
        },
      ],
    });
    for (const id of ["world-card", "overlay-card"] as const) {
      const target = { scope: "scene:main", id };
      const full = buildInspectionDocument({ packageVersion: "0.0.0-test", project, frame: frame(tree) });
      const built = buildInspectionDocument({
        packageVersion: "0.0.0-test",
        project,
        frame: frame(tree),
        target,
      });
      assert.deepEqual(built.scenes[0].paintRecords, applyInspectionTarget(full, target).scenes[0].paintRecords);
      assert.equal(built.scenes[0].paintRecords?.length, 1);
      assert.equal(built.scenes[0].paintRecords?.[0].inspection?.nodeId, id === "world-card" ? world.inspection?.nodeId : overlay.inspection?.nodeId);
    }
    const decoy = buildInspectionDocument({
      packageVersion: "0.0.0-test",
      project,
      frame: frame(tree),
      target: { scope: "scene:main", id: "decoy" },
    });
    assert.equal(decoy.scenes[0].paintRecords?.length, 0);
  });
});
