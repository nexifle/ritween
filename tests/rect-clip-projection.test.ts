/**
 * Nested rect-clip paint projection. Expectations are replayed from the uniform blocks the
 * stub GPU uploaded, including each clip parent, not from layout or `childSpace`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ViewRenderer, type PaintRecord } from "../src/authoring/renderer";
import { mediaKey } from "../src/authoring/media-runtime";
import { computeFrameTransform } from "../src/authoring/frame-transform";
import {
  applyInspectionTarget,
  buildInspectionDocument,
  MAX_INSPECTION_BYTES,
  measureInspection,
  paintRecord,
  serializeInspection,
  InspectionBudget,
  InspectionSerializationError,
} from "../src/engine/inspect/report";
import type { FrameInspection } from "../src/engine/render/renderer";
import type { ImageTexture } from "../src/engine/render/visual";
import {
  Box,
  Camera,
  Composition,
  Group,
  Image,
  Stage,
  Text,
  World,
  ZStack,
  evaluateCamera,
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
      writeTexture() {},
      writeBuffer(buffer: { usage?: number }, _offset: number, data: Float32Array) {
        if ((buffer.usage ?? 0) & 1) uniformWrites.push(new Float32Array(data));
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
  return { device, uniformWrites };
}

function slices(write: Float32Array) {
  const stride = 64;
  return Array.from({ length: write.length / stride }, (_, index) =>
    write.subarray(index * stride, index * stride + 36),
  );
}

async function renderOnce(
  view: ViewNode,
  options: {
    target?: readonly [number, number];
    design?: readonly [number, number];
    collect?: boolean;
    sharedTransforms?: ReadonlyMap<string, readonly number[]>;
    media?: ReadonlyMap<string, ImageTexture>;
    frame?: EvaluatedFrame;
    onRecord?: (record: PaintRecord) => void;
  } = {},
) {
  const target = options.target ?? ([100, 100] as const);
  const design = options.design ?? target;
  const gpu = createDevice();
  const renderer = new ViewRenderer();
  await renderer.setup({
    device: gpu.device,
    format: "bgra8unorm",
    resolution: [8, 8],
  });
  const evaluated =
    options.frame ??
    evaluateView(view, {
      time: 0,
      width: design[0],
      height: design[1],
      measureText: measure,
      inspection: true,
    });
  const records: PaintRecord[] = [];
  let calls = 0;
  renderer.render(
    evaluated,
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
          draw() {},
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
    false,
    1,
    true,
    options.media ?? new Map(),
    options.collect === false
      ? undefined
      : (record) => {
          calls++;
          records.push(record);
          options.onRecord?.(record);
        },
  );
  const traces = renderer.surfaceTraces();
  renderer.dispose();
  return {
    frame: evaluated,
    records,
    traces,
    calls,
    uniforms: gpu.uniformWrites.map(slices),
  };
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

function intersect(a: { x: number; y: number; width: number; height: number }, width: number, height: number) {
  const x = Math.max(a.x, 0);
  const y = Math.max(a.y, 0);
  const right = Math.min(a.x + a.width, width);
  const bottom = Math.min(a.y + a.height, height);
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

function geometry(record: PaintRecord, label: string) {
  assert.notEqual(record.accuracy, "unavailable", label);
  if (record.accuracy === "unavailable") throw Error(label);
  return record;
}

function imageTexture(width: number, height: number) {
  return {
    texture: { createView: () => ({}) },
    width,
    height,
  } as unknown as ImageTexture;
}

test("rect clip leaves follow uploaded corners, scissor, and root resolution", async () => {
  await withGpuGlobals(async () => {
    const photo = { kind: "image" as const, url: "photo.png", style: { width: 30, height: 16 } };
    const view = ZStack([
      Box({ width: 40, height: 20, fill: "#123456" }).padding(4).clip().id("padded"),
      Text("Hi").clip().id("label"),
      Image({ url: "photo.png", width: 30, height: 16 }).clip().id("photo"),
      Box({ width: 12, height: 8, fill: "#abcdef" })
        .clip()
        .id("inner")
        .frame({ width: 20, height: 16, align: "start" })
        .clip()
        .id("outer"),
    ]);
    const rendered = await renderOnce(view, {
      design: [100, 80],
      target: [160, 90],
      media: new Map([[mediaKey(photo), imageTexture(30, 16)]]),
    });
    assert.equal(rendered.records.some((record) => record.kind === "composition"), false);
    for (const record of rendered.records) {
      assert.deepEqual(record.resolution, [160, 90]);
      assert.notEqual(record.accuracy, "unavailable");
    }
    const padded = rendered.records.find((record) => record.path.includes("padded"));
    assert.ok(padded);
    const paddedGeometry = geometry(padded, "padded");
    assert.equal(paddedGeometry.clipProjection?.coverage, "rect-clipped-draw-quad");
    assert.equal(paddedGeometry.accuracy, "exact-rectangle");
    const paddedLeaf = rendered.uniforms.find((write) =>
      write.some((block) => block[2] > 0 && block[2] < 40),
    );
    assert.ok(paddedLeaf, "padded leaf upload");
    assert.ok(
      paddedGeometry.bounds.width <
        Math.max(...rendered.traces.filter((trace) => trace.path.endsWith("padded")).map((trace) => trace.uniform.rect[2])),
      "padding inset must be smaller than the clip rect",
    );
    const label = rendered.records.find((record) => record.kind === "text");
    const photoRecord = rendered.records.find((record) => record.kind === "media");
    assert.equal(geometry(label!, "text").provenance, "projected-text-draw-quad");
    assert.equal(photoRecord && geometry(photoRecord, "media").accuracy, "conservative");
    assert.equal(
      photoRecord && photoRecord.accuracy !== "unavailable"
        ? photoRecord.provenance
        : undefined,
      "projected-image-draw-quad",
    );

    const outer = rendered.traces.find((trace) => trace.path.endsWith("outer"));
    const inner = rendered.traces.find((trace) => trace.path.endsWith("inner"));
    assert.ok(outer && inner && outer.projection.status === "mapped" && inner.projection.status === "mapped");
    const leaf = rendered.uniforms[0]?.find((block) => block[2] > 0 && block[3] > 0);
    assert.ok(leaf, "a child upload must exist");
    const replay = leafCorners(leaf);
    assert.equal(replay.length, 4);
    const nested = rendered.records.find((record) => record.path.includes("inner"));
    assert.ok(nested && nested.accuracy !== "unavailable");
    assert.deepEqual(
      nested.clipProjection?.clipOccurrenceIds,
      [inner.occurrenceId, outer.occurrenceId],
    );
    assert.equal(typeof nested.inspection?.nodeId, "number");
    assert.notEqual(nested.inspection?.nodeId, inner.ownerNodeId);
    assert.notEqual(nested.inspection?.nodeId, outer.ownerNodeId);
  });
});

test("fractional ceil, overflow, scale, opacity, camera, and shared correction stay on the uniforms", async () => {
  await withGpuGlobals(async () => {
    const fractional = await renderOnce(
      Box({ width: 10.5, height: 8, fill: "#123456" }).clip().id("frac"),
      { design: [40, 30], target: [50, 40] },
    );
    const trace = fractional.traces[0];
    assert.equal(trace.childResolution[0], Math.max(1, Math.ceil(10.5 * Math.min(50 / 40, 40 / 30))));
    const child = fractional.uniforms[0][0];
    const parent = fractional.uniforms.at(-1)![0];
    assert.deepEqual(
      [parent[24], parent[28], parent[25], parent[29], parent[26], parent[30]].map((value) => Math.fround(value)),
      [parent[24], parent[28], parent[25], parent[29], parent[26], parent[30]],
    );
    const childTransform = computeFrameTransform(
      [parent[2], parent[3]],
      [trace.childResolution[0], trace.childResolution[1]],
    );
    const window = intersect(
      scissor(childTransform.ox, childTransform.oy, trace.childResolution[0], trace.childResolution[1]),
      trace.childResolution[0],
      trace.childResolution[1],
    );
    const rootTransform = computeFrameTransform([40, 30], [50, 40]);
    const rootWindow = intersect(
      scissor(rootTransform.ox, rootTransform.oy, 50, 40),
      50,
      40,
    );
    const mapped = mappingFromUpload(parent, trace.childResolution[0], trace.childResolution[1]);
    let polygon = clipPolygon(leafCorners(child), window).map((point) => apply(mapped, point[0], point[1]));
    polygon = clipPolygon(polygon, rootWindow);
    const record = geometry(fractional.records[0], "fractional");
    assert.deepEqual(record.bounds, boundsOf(polygon));
    assert.equal(record.resolution[0], 50);
    assert.notEqual(record.resolution[0], trace.childResolution[0]);
    assert.equal(
      record.geometryVisible,
      polygon.length > 2 && child[20] !== 0 && parent[20] !== 0,
      JSON.stringify({ bounds: record.bounds, opacity: [child[20], parent[20]], points: polygon.length }),
    );

    const outside = await renderOnce(
      Box({ width: 30, height: 10, fill: "#123456" })
        .frame({ width: 10, height: 10, align: "start" })
        .clip(),
      { design: [40, 40], target: [40, 40] },
    );
    const outsideRecord = geometry(outside.records[0], "outside");
    assert.ok(
      outsideRecord.bounds.width <= 10 + 1e-6,
      JSON.stringify({
        bounds: outsideRecord.bounds,
        child: outside.traces[0]?.childResolution,
        scissor: outside.traces[0] && "childScissor" in outside.traces[0],
      }),
    );

    const negative = await renderOnce(
      Box({ width: 10, height: 8, fill: "#123456" }).scale(-2, 3, [0, 0]).clip(),
    );
    const negativeRecord = geometry(negative.records[0], "negative");
    assert.equal(negativeRecord.accuracy, "exact-rectangle");
    assert.ok(negative.uniforms[0][0][4] < 0, "leaf uniform keeps the negative scale");
    assert.ok(negativeRecord.bounds.height > 0);
    assert.equal(negativeRecord.geometryVisible, negativeRecord.bounds.width > 0);

    const zero = await renderOnce(
      Box({ width: 10, height: 8, fill: "#123456" }).scale(0, 1, [0, 0]).clip(),
    );
    const zeroRecord = geometry(zero.records[0], "zero scale");
    assert.equal(zeroRecord.geometryVisible, false);
    assert.equal(zeroRecord.bounds.width, 0);
    assert.ok(Number.isFinite(zeroRecord.bounds.x));

    const hidden = await renderOnce(
      Box({ width: 10, height: 8, fill: "#123456" }).opacity(-0).clip(),
    );
    assert.equal(geometry(hidden.records[0], "-0").geometryVisible, false);
    const faint = await renderOnce(
      Box({ width: 10, height: 8, fill: "#123456" }).opacity(1e-12).clip(),
    );
    assert.equal(geometry(faint.records[0], "near zero").geometryVisible, true);
    const clipHidden = await renderOnce(
      Box({ width: 10, height: 8, fill: "#123456" }).clip().opacity(0),
    );
    assert.equal(geometry(clipHidden.records[0], "clip zero").geometryVisible, false);

    const camera = evaluateCamera(Camera({ zoom: 2, rotation: Math.PI / 2 }), 0, [80, 60]);
    const turned = await renderOnce(
      Box({ width: 10, height: 6, fill: "#123456" }).clip().id("turned"),
      { design: [80, 60], target: [80, 60], frame: { ...evaluateView(Box({ width: 10, height: 6, fill: "#123456" }).clip(), { time: 0, width: 80, height: 60, measureText: measure, inspection: true }), camera } },
    );
    const turnedRecord = geometry(turned.records[0], "quarter");
    // Math.cos(PI/2) is not 0, so this camera is not an exact quarter-turn matrix.
    assert.equal(turnedRecord.accuracy, "conservative");
    const turnedParent = turned.uniforms.at(-1)![0];
    const turnedChild = turned.uniforms[0][0];
    const turnedTrace = turned.traces[0];
    const turnedMap = mappingFromUpload(
      turnedParent,
      turnedTrace.childResolution[0],
      turnedTrace.childResolution[1],
    );
    const turnedChildFrame = computeFrameTransform(
      [turnedParent[2], turnedParent[3]],
      turnedTrace.childResolution,
    );
    const turnedChildWindow = intersect(
      scissor(
        turnedChildFrame.ox,
        turnedChildFrame.oy,
        turnedTrace.childResolution[0],
        turnedTrace.childResolution[1],
      ),
      turnedTrace.childResolution[0],
      turnedTrace.childResolution[1],
    );
    const turnedRoot = computeFrameTransform([80, 60], [80, 60], camera.matrix);
    const turnedRootWindow = intersect(
      scissor(turnedRoot.ox, turnedRoot.oy, 80, 60),
      80,
      60,
    );
    const turnedPolygon = clipPolygon(
      clipPolygon(leafCorners(turnedChild), turnedChildWindow).map((point) =>
        apply(turnedMap, point[0], point[1]),
      ),
      turnedRootWindow,
    );
    if (turnedPolygon.length === 0) {
      assert.equal(turnedRecord.geometryVisible, false);
      assert.equal(turnedRecord.bounds.width, 0);
      assert.equal(turnedRecord.bounds.height, 0);
      assert.ok(Number.isFinite(turnedRecord.bounds.x) && Number.isFinite(turnedRecord.bounds.y));
    } else {
      assert.deepEqual(turnedRecord.bounds, boundsOf(turnedPolygon));
      assert.equal(turnedRecord.geometryVisible, true);
    }

    const correction = [1, 0, 0, 1, 30, -4];
    const shared = await renderOnce(Box({ width: 8, height: 6, fill: "#111111" }).clip().id("window"), {
      sharedTransforms: new Map([["window", correction]]),
    });
    const sharedRecord = geometry(shared.records[0], "shared");
    const sharedParent = shared.uniforms.at(-1)![0];
    const sharedTrace = shared.traces[0];
    const sharedMap = mappingFromUpload(
      sharedParent,
      sharedTrace.childResolution[0],
      sharedTrace.childResolution[1],
    );
    const once = clipPolygon(
      leafCorners(shared.uniforms[0][0]).map((point) =>
        apply(sharedMap, point[0], point[1]),
      ),
      { x: 0, y: 0, width: 100, height: 100 },
    );
    assert.deepEqual(sharedRecord.bounds, boundsOf(once));
    const again = once.map((point) => apply(correction, point[0], point[1]));
    assert.notDeepEqual(boundsOf(once), boundsOf(again));
    assert.equal(sharedTrace.uniform.cameraX[2], sharedParent[26]);
  });
});

test("rotated and sheared quads do not claim AABB area, and unsupported boundaries stay explicit", async () => {
  await withGpuGlobals(async () => {
    const base = evaluateView(
      Box({ width: 1, height: 1, fill: "#123456" })
        .frame({ width: 100, height: 100, align: "start" })
        .clip()
        .id("shear"),
      { time: 0, width: 100, height: 100, measureText: measure, inspection: true },
    );
    const clip = base.commands[0];
    assert.equal(clip.kind, "composition");
    if (clip.kind !== "composition") return;
    const sheared = await renderOnce(Box({ width: 1, height: 1 }), {
      frame: {
        ...base,
        commands: [
          {
            ...clip,
            frame: {
              ...clip.frame,
              camera: { matrix: [10, 0, 205, -205, 5, 210] } as EvaluatedFrame["camera"],
            },
          },
        ],
      },
    });
    const corners = leafCorners(sheared.uniforms[0][0]);
    const xs = corners.map((point) => point[0]);
    const ys = corners.map((point) => point[1]);
    assert.ok(Math.min(...xs) < 100 && Math.max(...xs) > 0 && Math.min(...ys) < 100 && Math.max(...ys) > 0);
    assert.equal(clipPolygon(corners, { x: 0, y: 0, width: 100, height: 100 }).length, 0);
    const missed = geometry(sheared.records[0], "shear miss");
    assert.equal(missed.geometryVisible, false);
    assert.equal(missed.bounds.width, 0);
    assert.equal(missed.bounds.height, 0);
    assert.equal(missed.accuracy, "conservative");

    const hitBase = evaluateView(
      Box({ width: 10, height: 10, fill: "#123456" }).clip().id("spin"),
      { time: 0, width: 40, height: 40, measureText: measure, inspection: true },
    );
    const hitClip = hitBase.commands[0];
    assert.equal(hitClip.kind, "composition");
    if (hitClip.kind !== "composition") return;
    const hit = await renderOnce(Box({ width: 10, height: 10 }), {
      design: [40, 40],
      target: [40, 40],
      frame: {
        ...hitBase,
        commands: [
          {
            ...hitClip,
            frame: {
              ...hitClip.frame,
              camera: evaluateCamera(Camera({ rotation: Math.PI / 5, anchor: [0, 0] }), 0, [10, 10]),
            },
          },
        ],
      },
    });
    const hitRecord = geometry(hit.records[0], "rotated hit");
    assert.equal(hitRecord.accuracy, "conservative");
    assert.equal(hitRecord.geometryVisible, true);
    assert.ok(hitRecord.bounds.width > 0 && hitRecord.bounds.height > 0);

    const rounded = await renderOnce(
      Box({ width: 12, height: 10, fill: "#123456" }).clip({ shape: "rect", radius: 4 }),
    );
    assert.equal(rounded.records[0].accuracy, "unavailable");
    if (rounded.records[0].accuracy === "unavailable")
      assert.match(rounded.records[0].unsupported, /clip mask shape "rounded" is not projected/);
    assert.equal(rounded.records.some((record) => record.kind === "composition"), false);
    const circle = await renderOnce(Box({ width: 12, height: 10, fill: "#123456" }).clip({ shape: "circle" }));
    if (circle.records[0].accuracy === "unavailable")
      assert.match(circle.records[0].unsupported, /"circle"/);

    const grouped = await renderOnce(
      Group([Box({ width: 8, height: 8, fill: "#111111" }).id("inner")]).clip().id("window"),
    );
    assert.equal(grouped.records.some((record) => record.path.includes("inner")), false);
    const group = grouped.records.find((record) => record.kind === "group");
    assert.equal(group?.accuracy, "unavailable");
    if (group?.accuracy === "unavailable")
      assert.match(group.unsupported, /group paint is not collected/);

    const world = await renderOnce(
      Composition(World(() => Box({ width: 8, height: 8, fill: "#111111" }).id("inside"), { size: [40, 24] }), {
        size: [40, 24],
      }).id("plain"),
      { design: [40, 24], target: [40, 24] },
    );
    const composition = world.records.find((record) => record.kind === "composition");
    assert.equal(composition?.accuracy, "unavailable");
    if (composition?.accuracy === "unavailable")
      assert.match(composition.unsupported, /composition paint is not collected/);
    assert.equal(world.records.some((record) => record.path.includes("inside")), false);

    const blown = await renderOnce(
      Box({ width: 8, height: 8, fill: "#123456" }).scale(1e40, 1, [0, 0]).clip(),
    );
    assert.equal(blown.records[0].accuracy, "unavailable");
    if (blown.records[0].accuracy === "unavailable")
      assert.match(blown.records[0].unsupported, /overflows float32|not finite/);
    assert.equal("bounds" in blown.records[0], false);
  });
});

test("owners, snapshots, inspection-off, and failed renders do not double-count or publish partials", async () => {
  await withGpuGlobals(async () => {
    const quiet = await renderOnce(Box({ width: 8, height: 8, fill: "#111111" }).clip(), {
      collect: false,
    });
    assert.equal(quiet.records.length, 0);
    assert.equal(quiet.calls, 0);
    assert.equal(quiet.traces.length, 0);

    const gpu = createDevice();
    const renderer = new ViewRenderer();
    await renderer.setup({ device: gpu.device, format: "bgra8unorm", resolution: [20, 20] });
    const good = evaluateView(Box({ width: 8, height: 8, fill: "#111111" }).clip().id("window"), {
      time: 0,
      width: 20,
      height: 20,
      measureText: measure,
      inspection: true,
    });
    const first: PaintRecord[] = [];
    const context = {
      device: gpu.device,
      format: "bgra8unorm" as const,
      resolution: [20, 20] as const,
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
    renderer.render(good, context, [20, 20], "#00000000", false, 1, true, new Map(), (record) => first.push(record));
    const snapshot = JSON.parse(JSON.stringify(first));
    let partial = 0;
    const bad = evaluateView(
      ZStack([
        Box({ width: 8, height: 8, fill: "#111111" }).clip(),
        Box({ width: 8, height: 8, fill: "var(--nope)" }),
      ]),
      { time: 0, width: 20, height: 20, measureText: measure, inspection: true },
    );
    assert.throws(() =>
      renderer.render(bad, context, [20, 20], "#00000000", false, 1, true, new Map(), () => {
        partial++;
      }),
    );
    assert.equal(partial, 0);
    assert.deepEqual(first, snapshot);
    assert.equal(renderer.surfaceTraces().length, 0);
    renderer.dispose();

    const stage = Stage(() => Box({ width: 8, height: 8, fill: "#111111" }).clip().id("window"), {
      inspection: true,
    });
    try {
      await stage.setup({
        device: gpu.device,
        format: "rgba8unorm",
        resolution: [20, 20],
        compositionResolution: [20, 20],
      });
      await stage.prepareFrame!({ time: 0, localTime: 0, progress: 0 });
      stage.render(context);
      const inspected = stage.inspect();
      assert.equal(inspected?.paintRecords?.length, 1);
      assert.equal(inspected?.paintRecords?.[0].kind, "box");
      const owner = inspected?.paintRecords?.[0].inspection?.nodeId;
      assert.equal(typeof owner, "number");
      const documentFrame: FrameInspection = {
        requestedTime: 0,
        effectiveTime: 0,
        scenes: [{ id: "main", name: "Main", time: 0, localTime: 0, progress: 0, frame: inspected! }],
      };
      const project = { name: "owners", duration: 1, resolution: [20, 20] as const };
      const full = buildInspectionDocument({ packageVersion: "0.0.0-test", project, frame: documentFrame });
      const target = { scope: "scene:main", id: "window" };
      assert.deepEqual(
        buildInspectionDocument({ packageVersion: "0.0.0-test", project, frame: documentFrame, target }).scenes[0].paintRecords,
        applyInspectionTarget(full, target).scenes[0].paintRecords,
      );
    } finally {
      stage.dispose();
    }
  });
});

test("clipProjection is whitelisted, owned, and budgeted on both target paths without truncation", () => {
  const raw = {
    kind: "box",
    path: "card",
    paintRole: "content",
    space: "scene-target-pixels",
    resolution: [20, 20],
    accuracy: "exact-rectangle",
    bounds: { x: 0, y: 0, width: 4, height: 4 },
    provenance: "projected-box-draw-quad",
    geometryVisible: true,
    inspection: { id: 2, nodeId: 1, role: "content" },
    clipProjection: { clipOccurrenceIds: [7, 8], coverage: "rect-clipped-draw-quad" },
  };
  const budget = new InspectionBudget();
  const published = paintRecord(raw, "paint", budget);
  const bytes = new TextEncoder().encode(JSON.stringify(published)).length;
  assert.equal(budget.bytes, bytes);
  assert.equal(
    published.accuracy === "unavailable" ? undefined : published.clipProjection?.coverage,
    "rect-clipped-draw-quad",
  );
  assert.throws(
    () => paintRecord(raw, "paint", new InspectionBudget(bytes - 1)),
    (error: unknown) => error instanceof InspectionSerializationError && /bytes of UTF-8/.test(error.message),
  );
  assert.throws(
    () => paintRecord({ ...raw, clipProjection: { clipOccurrenceIds: [Number.NaN], coverage: "rect-clipped-draw-quad" } }, "paint"),
    (error: unknown) => error instanceof InspectionSerializationError,
  );
  assert.throws(
    () => paintRecord({ ...raw, clipProjection: { clipOccurrenceIds: [1], coverage: "pixels" } }, "paint"),
    (error: unknown) => error instanceof InspectionSerializationError && /coverage/.test(error.message),
  );

  const tree = {
    path: "root",
    kind: "clip",
    id: "window",
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
  const twin = {
    ...tree,
    children: [
      tree.children[0],
      {
        ...tree.children[0],
        path: "root/other",
        id: "other",
        inspectionId: 4,
      },
    ],
  };
  const owned = {
    ...raw,
    inspection: { id: 3, nodeId: 4, role: "content" as const },
  };
  const frame = (node: typeof tree, records = [raw]): FrameInspection => ({
    requestedTime: 0,
    effectiveTime: 0,
    scenes: [
      {
        id: "main",
        name: "Main",
        time: 0,
        localTime: 0,
        progress: 0,
        frame: { tree: node, commands: [], warnings: [], paintRecords: records },
      },
    ],
  });
  const project = { name: "a", duration: 1, resolution: [8, 8] as const };
  const target = { scope: "scene:main", id: "card" };
  const full = buildInspectionDocument({ packageVersion: "0.0.0-test", project, frame: frame(tree, [owned]) });
  const built = buildInspectionDocument({ packageVersion: "0.0.0-test", project, frame: frame(tree, [owned]), target });
  const second = applyInspectionTarget(full, target);
  assert.deepEqual(built.scenes[0].paintRecords, second.scenes[0].paintRecords);
  assert.equal(built.scenes[0].paintRecords?.length, 1);
  const duplicate = buildInspectionDocument({ packageVersion: "0.0.0-test", project, frame: frame(twin, [owned]), target });
  assert.deepEqual(duplicate.scenes[0].paintRecords, applyInspectionTarget(
    buildInspectionDocument({ packageVersion: "0.0.0-test", project, frame: frame(twin, [owned]) }),
    target,
  ).scenes[0].paintRecords);
  assert.equal(duplicate.scenes[0].paintRecords?.length, 0);

  const base = buildInspectionDocument({ packageVersion: "0.0.0-test", project, frame: frame(tree, [owned]) });
  const deficit = MAX_INSPECTION_BYTES - measureInspection(base);
  assert.ok(deficit > 0);
  const exact = buildInspectionDocument({
    packageVersion: "0.0.0-test",
    project: { ...project, name: "a".repeat(1 + deficit) },
    frame: frame(tree, [owned]),
  });
  assert.equal(measureInspection(exact), MAX_INSPECTION_BYTES);
  const json = serializeInspection(exact, MAX_INSPECTION_BYTES);
  assert.equal(new TextEncoder().encode(json).length, MAX_INSPECTION_BYTES);
  assert.throws(
    () => serializeInspection(exact, MAX_INSPECTION_BYTES - 1),
    (error: unknown) => error instanceof InspectionSerializationError && /over the/.test(error.message) && !/truncated/.test(String(error)),
  );
});
