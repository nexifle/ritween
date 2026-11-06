/**
 * Surface-projection transport. Expectations are replayed from the uniform blocks the mock
 * GPU actually uploaded, not from `childPixelsToParent`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ViewRenderer, type PaintRecord } from "../src/authoring/renderer";
import { mediaKey } from "../src/authoring/media-runtime";
import { computeFrameTransform } from "../src/authoring/frame-transform";
import { planSurface } from "../src/authoring/surface-plan";
import { inverse, multiply } from "../src/engine/render/shared-elements";
import {
  EMPTY_FRAME_OCCURRENCES,
  EMPTY_SURFACE_TRACES,
  NON_CLIP_PARENT_REASON,
  childPixelsToParent,
  projectRectClipChain,
  type FrameOccurrence,
  type SurfaceTrace,
} from "../src/authoring/surface-projection";
import {
  applyInspectionTarget,
  buildInspectionDocument,
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

interface BoundDraw {
  readonly buffer: object;
  readonly byteOffset: number;
}
/** A draw plus the leading uniform floats its own bind group addressed. */
interface DrawnCommand extends BoundDraw {
  readonly row: readonly number[];
}
interface UniformWrite {
  readonly buffer: object;
  readonly byteOffset: number;
  readonly data: Float32Array;
}

function createDevice() {
  const uniformWrites: Float32Array[] = [];
  const writes: UniformWrite[] = [];
  const passes: { draws: DrawnCommand[] }[] = [];
  let pending: BoundDraw | undefined;
  const device = {
    createShaderModule: () => ({}),
    createRenderPipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createSampler: () => ({}),
    createBuffer: (descriptor: { usage?: number }) => ({
      usage: descriptor.usage ?? 0,
      destroy() {},
    }),
    createBindGroup: (descriptor: {
      entries: readonly {
        binding: number;
        resource: { buffer?: object; offset?: number };
      }[];
    }) => {
      const uniform = descriptor.entries.find((entry) => entry.binding === 0);
      return {
        buffer: uniform?.resource.buffer,
        byteOffset: uniform?.resource.offset ?? 0,
      };
    },
    queue: {
      writeTexture() {},
      writeBuffer(
        buffer: { usage?: number },
        offset: number,
        data: Float32Array,
      ) {
        if ((buffer.usage ?? 0) & 1) {
          const copy = new Float32Array(data);
          uniformWrites.push(copy);
          writes.push({ buffer, byteOffset: offset, data: copy });
        }
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
  const encoder = {
    beginRenderPass: () => {
      const draws: DrawnCommand[] = [];
      passes.push({ draws });
      return {
        setScissorRect() {},
        setPipeline() {},
        setBindGroup(_slot: number, bind: BoundDraw) {
          pending = bind;
        },
        draw() {
          if (!pending?.buffer) throw Error("draw without a uniform bind");
          // The whole draw list is uploaded before the pass opens, so the row this bind group
          // addresses already holds the rect and transform that command packed: identity from
          // bytes, taken before any visit metadata exists.
          const block = blockAtDraw(writes, pending);
          draws.push({
            buffer: pending.buffer,
            byteOffset: pending.byteOffset,
            row: Array.from(block.subarray(0, 8)),
          });
        },
        end() {},
      };
    },
    finish: () => ({}),
  };
  return { device, encoder, uniformWrites, writes, passes };
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
    camera?: EvaluatedFrame["camera"];
    sharedTransforms?: ReadonlyMap<string, readonly number[]>;
    media?: ReadonlyMap<string, ImageTexture>;
    frame?: EvaluatedFrame;
    inspection?: boolean;
  } = {},
) {
  const target = options.target ?? ([100, 100] as const);
  const design = options.design ?? target;
  const gpu = createDevice();
  const renderer = new ViewRenderer();
  await renderer.setup({
    device: gpu.device,
    format: "bgra8unorm",
    resolution: target,
  });
  const evaluated =
    options.frame ??
    evaluateView(view, {
      time: 0,
      width: design[0],
      height: design[1],
      measureText: measure,
      inspection: options.inspection ?? true,
    });
  const frame = options.camera
    ? { ...evaluated, camera: options.camera }
    : evaluated;
  const records: PaintRecord[] = [];
  let thrown: unknown;
  try {
    renderer.render(
      frame,
      {
        device: gpu.device,
        format: "bgra8unorm",
        resolution: target,
        target: { createView: () => ({}) } as unknown as GPUTexture,
        encoder: gpu.encoder as unknown as GPUCommandEncoder,
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
      options.collect === false ? undefined : (record) => records.push(record),
    );
  } catch (error) {
    thrown = error;
  }
  const traces = renderer.surfaceTraces();
  const frames = renderer.frameOccurrences();
  const surfaces = renderer.surfaceOccurrences();
  renderer.dispose();
  if (thrown) throw thrown;
  return {
    frame,
    records,
    traces,
    frames,
    surfaces,
    uniforms: gpu.uniformWrites.map(slices),
    writes: gpu.writes,
    passes: gpu.passes,
  };
}

function postOrderFrames(frame: EvaluatedFrame): EvaluatedFrame[] {
  const found: EvaluatedFrame[] = [];
  for (const command of frame.commands) {
    if (command.kind !== "composition" && command.kind !== "group") continue;
    found.push(...postOrderFrames(command.frame));
    if (command.kind === "composition" && command.overlay)
      found.push(...postOrderFrames(command.overlay));
  }
  found.push(frame);
  return found;
}

/** The 36-float uniform row the draw's bind-group offset addresses. */
function blockAtDraw(
  writes: readonly { buffer: object; byteOffset: number; data: Float32Array }[],
  draw: BoundDraw,
) {
  const write = [...writes].reverse().find(
    (row) =>
      row.buffer === draw.buffer &&
      draw.byteOffset >= row.byteOffset &&
      draw.byteOffset + 144 <= row.byteOffset + row.data.byteLength,
  );
  assert.ok(write, "draw offset is not covered by that buffer's upload");
  assert.equal(draw.byteOffset % 4, 0);
  const start = (draw.byteOffset - write!.byteOffset) / 4;
  return write!.data.subarray(start, start + 36);
}

/** Camera rows from the uniform write the draw's bind-group offset actually addresses. */
function cameraAtDraw(
  writes: readonly { buffer: object; byteOffset: number; data: Float32Array }[],
  draw: BoundDraw,
) {
  return cameraRows(blockAtDraw(writes, draw));
}

function passForFrame(
  rendered: {
    frame: EvaluatedFrame;
    passes: readonly { draws: readonly BoundDraw[] }[];
  },
  source: EvaluatedFrame,
) {
  const post = postOrderFrames(rendered.frame);
  assert.equal(rendered.passes.length, post.length);
  const index = post.indexOf(source);
  assert.notEqual(index, -1);
  return rendered.passes[index];
}

function cameraRows(block: ArrayLike<number>) {
  return [block[24], block[28], block[25], block[29], block[26], block[30]];
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

/** The contract formula, read from one uploaded block. Not the production helper. */
function mappingFromUpload(
  block: Float32Array,
  childWidth: number,
  childHeight: number,
) {
  const camera = [
    block[24],
    block[28],
    block[25],
    block[29],
    block[26],
    block[30],
  ];
  const command = [block[4], 0, 0, block[5], block[6], block[7]];
  return mul(
    camera,
    mul(
      command,
      mul(
        [1, 0, 0, 1, block[0], block[1]],
        [block[2] / childWidth, 0, 0, block[3] / childHeight, 0, 0],
      ),
    ),
  );
}

function apply(matrix: readonly number[], x: number, y: number) {
  return [
    matrix[0] * x + matrix[2] * y + matrix[4],
    matrix[1] * x + matrix[3] * y + matrix[5],
  ];
}

function corners(matrix: readonly number[], width: number, height: number) {
  return [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height],
  ].map(([x, y]) => apply(matrix, x, y));
}

function mapped(trace: SurfaceTrace, label: string) {
  assert.equal(trace.projection.status, "mapped", label);
  if (trace.projection.status !== "mapped") throw Error(label);
  return trace.projection;
}

test("fractional clip allocation, letterbox, and nested corners follow the uploaded uniforms", async () => {
  await withGpuGlobals(async () => {
    const view = Box({ width: 4, height: 2, fill: "#111111" })
      .frame({ width: 4.2, height: 3.1, align: "start" })
      .clip({ shape: "rect" })
      .id("inner")
      .frame({ width: 10.2, height: 6.25, align: "start" })
      .clip({ shape: "rect" })
      .id("outer");
    const design = [100, 50] as const;
    const target = [160, 80] as const;
    const rendered = await renderOnce(view, { design, target });
    const scale = Math.min(target[0] / design[0], target[1] / design[1]);
    const outerCommand = rendered.frame.commands.find((command) =>
      command.path.endsWith("outer"),
    );
    assert.equal(outerCommand?.kind, "composition");
    if (outerCommand?.kind !== "composition") return;
    const outerAlloc = [
      Math.max(1, Math.ceil(outerCommand.bounds.width * scale)),
      Math.max(1, Math.ceil(outerCommand.bounds.height * scale)),
    ] as const;
    assert.notEqual(
      outerAlloc[0],
      Math.floor(outerCommand.bounds.width * scale),
      "fractional width must ceil",
    );
    const outer = rendered.traces.find((trace) => trace.path.endsWith("outer"));
    const inner = rendered.traces.find((trace) => trace.path.endsWith("inner"));
    assert.ok(outer && inner);
    assert.deepEqual(outer.childResolution, outerAlloc);
    assert.equal(outer.uniform.rect[2], rendered.uniforms.at(-1)![0][2]);
    assert.notEqual(
      outer.uniform.rect[2],
      outerCommand.bounds.width,
      "the trace keeps the packed float32 rect, not the layout number",
    );
    const parentBlock = rendered.uniforms.at(-1)![0];
    assert.equal(outer.uniform.resolution[0], parentBlock[8]);
    assert.equal(outer.uniform.resolution[1], parentBlock[9]);
    assert.deepEqual(outer.parentResolution, [parentBlock[8], parentBlock[9]]);
    const outerMap = mapped(outer, "outer");
    const expectedOuter = mappingFromUpload(
      parentBlock,
      outer.childResolution[0],
      outer.childResolution[1],
    );
    assert.deepEqual(outerMap.childPixelsToParent, expectedOuter);
    assert.deepEqual(
      corners(
        outerMap.childPixelsToParent,
        outer.childResolution[0],
        outer.childResolution[1],
      ),
      corners(
        expectedOuter,
        outer.childResolution[0],
        outer.childResolution[1],
      ),
    );
    const letterbox = computeFrameTransform(
      [outerCommand.bounds.width, outerCommand.bounds.height],
      outer.childResolution,
    );
    const innerBlock = rendered.uniforms.at(-2)![0];
    assert.equal(innerBlock[24], Math.fround(letterbox.matrix[0]));
    assert.equal(innerBlock[26], Math.fround(letterbox.matrix[4]));
    assert.notEqual(letterbox.ox, 0, "child render letterboxes");
    assert.notEqual(
      letterbox.scale,
      outer.childResolution[0] / outerCommand.bounds.width,
      "letterbox scale is not the allocation ratio",
    );
    const childSpace = planSurface(
      outerCommand.bounds,
      outerCommand.transform,
      scale,
      letterbox.matrix,
    ).childSpace;
    assert.notDeepEqual(outerMap.childPixelsToParent, childSpace);

    const innerCommand = outerCommand.frame.commands[0];
    assert.equal(innerCommand.kind, "composition");
    if (innerCommand.kind !== "composition") return;
    const innerScale = letterbox.scale;
    const innerAlloc = [
      Math.max(1, Math.ceil(innerCommand.bounds.width * innerScale)),
      Math.max(1, Math.ceil(innerCommand.bounds.height * innerScale)),
    ] as const;
    assert.deepEqual(inner.childResolution, innerAlloc);
    assert.equal(inner.parentOccurrenceId, outer.occurrenceId);
    assert.notEqual(inner.occurrenceId, outer.occurrenceId);
    const innerMap = mapped(inner, "inner");
    const expectedInner = mappingFromUpload(
      innerBlock,
      inner.childResolution[0],
      inner.childResolution[1],
    );
    assert.deepEqual(innerMap.childPixelsToParent, expectedInner);
    assert.deepEqual(innerMap.parentToScene, outerMap.childPixelsToScene);
    assert.notDeepEqual(innerMap.parentToScene, [1, 0, 0, 1, 0, 0]);
    const expectedScene = mul(outerMap.childPixelsToScene, expectedInner);
    assert.deepEqual(innerMap.childPixelsToScene, expectedScene);
    assert.deepEqual(
      corners(
        innerMap.childPixelsToScene,
        inner.childResolution[0],
        inner.childResolution[1],
      ),
      corners(
        expectedScene,
        inner.childResolution[0],
        inner.childResolution[1],
      ),
    );
  });
});

test("negative and zero transforms stay finite without an inverse, including negative zero", async () => {
  await withGpuGlobals(async () => {
    const view = Box({ width: 20, height: 10, fill: "#123456" })
      .clip()
      .scale(0, -2, [0, 0])
      .offset(5, -3)
      .id("degenerate");
    const camera = evaluateCamera(Camera({ x: 4, y: -2 }), 0, [100, 100]);
    const rendered = await renderOnce(view, { camera });
    const trace = rendered.traces[0];
    const projection = mapped(trace, "degenerate");
    assert.ok(projection.childPixelsToParent.every(Number.isFinite));
    assert.ok(projection.childPixelsToScene.every(Number.isFinite));
    assert.equal(trace.uniform.transform[0], 0);
    assert.equal(trace.uniform.transform[1], -2);
    assert.notEqual(trace.uniform.cameraX[2], 0);
    const block = rendered.uniforms.at(-1)![0];
    assert.deepEqual(
      projection.childPixelsToParent,
      mappingFromUpload(
        block,
        trace.childResolution[0],
        trace.childResolution[1],
      ),
    );

    const base = evaluateView(view, {
      time: 0,
      width: 100,
      height: 100,
      measureText: measure,
      inspection: true,
    });
    const command = base.commands[0];
    assert.equal(command.kind, "composition");
    if (command.kind !== "composition") return;
    const signed = await renderOnce(view, {
      frame: {
        ...base,
        commands: [{ ...command, transform: [-0, -0, -0, -0] }],
      },
    });
    const zero = signed.traces[0];
    assert.ok(Object.is(zero.uniform.transform[0], -0));
    assert.ok(Object.is(zero.uniform.transform[3], -0));
    const zeroMap = mapped(zero, "negative zero");
    assert.ok(
      zeroMap.childPixelsToParent.every((value) => Number.isFinite(value)),
    );
    assert.equal(
      zeroMap.childPixelsToParent.some((value) => !Number.isFinite(value)),
      false,
    );
  });
});

test("shared correction enters the uploaded camera once and is not applied again in the chain", async () => {
  await withGpuGlobals(async () => {
    const view = Box({ width: 8, height: 6, fill: "#111111" })
      .clip()
      .id("inner")
      .frame({ width: 20, height: 12, align: "start" })
      .clip()
      .id("outer");
    const correction = [1, 0, 0, 1, 30, -4];
    const rendered = await renderOnce(view, {
      sharedTransforms: new Map([
        ["outer", correction],
        ["inner", [1, 0, 0, 1, 80, 80]],
      ]),
    });
    const outer = rendered.traces.find((trace) => trace.path.endsWith("outer"));
    const inner = rendered.traces.find((trace) => trace.path.endsWith("inner"));
    assert.ok(outer && inner);
    const outerBlock = rendered.uniforms.at(-1)![0];
    const innerBlock = rendered.uniforms.at(-2)![0];
    assert.equal(outer.uniform.cameraX[2], outerBlock[26]);
    assert.notEqual(outerBlock[26], innerBlock[26]);
    const outerMap = mapped(outer, "corrected outer");
    assert.deepEqual(
      outerMap.childPixelsToParent,
      mappingFromUpload(
        outerBlock,
        outer.childResolution[0],
        outer.childResolution[1],
      ),
    );
    const twice = mul(correction, outerMap.childPixelsToParent);
    assert.notDeepEqual(outerMap.childPixelsToScene, twice);
    const innerMap = mapped(inner, "descendant");
    assert.deepEqual(innerMap.parentToScene, outerMap.childPixelsToScene);
    assert.equal(
      innerBlock[26],
      Math.fround(
        computeFrameTransform([20, 12], outer.childResolution).matrix[4],
      ),
    );
    assert.notEqual(innerBlock[26], Math.fround(80));
  });
});

test("duplicate semantic ids keep distinct occurrence traces", async () => {
  await withGpuGlobals(async () => {
    const view = Box({ width: 10, height: 8, fill: "#111111" })
      .clip()
      .id("same")
      .frame({ width: 24, height: 16, align: "start" })
      .clip()
      .id("same");
    const rendered = await renderOnce(view);
    assert.equal(rendered.traces.length, 2);
    assert.equal(
      new Set(rendered.traces.map((trace) => trace.occurrenceId)).size,
      2,
    );
    assert.equal(
      new Set(rendered.traces.map((trace) => trace.ownerNodeId)).size,
      2,
    );
    assert.deepEqual(
      rendered.traces.map((trace) => trace.surface),
      [
        { kind: "clip", shape: "rect" },
        { kind: "clip", shape: "rect" },
      ],
    );
    const commands = [
      rendered.frame.commands[0],
      rendered.frame.commands[0].kind === "composition"
        ? rendered.frame.commands[0].frame.commands[0]
        : undefined,
    ];
    assert.equal(commands[0]?.kind, "composition");
    assert.equal(commands[1]?.kind, "composition");
    if (
      commands[0]?.kind !== "composition" ||
      commands[1]?.kind !== "composition"
    )
      return;
    assert.equal(commands[0].sharedId, "same");
    assert.equal(commands[1].sharedId, "same");
    assert.notEqual(commands[0].inspection?.id, commands[1].inspection?.id);
  });
});

test("clip shapes are tagged from the spec and a composition is one surface", async () => {
  await withGpuGlobals(async () => {
    const mask = {
      kind: "image" as const,
      url: "/mask.png",
      style: { width: 1, height: 1 },
    };
    const view = ZStack([
      Box({ width: 12, height: 10, fill: "#123456" })
        .clip({ shape: "rect" })
        .id("plain"),
      Box({ width: 12, height: 10, fill: "#123456" })
        .clip({ shape: "rect", radius: 4 })
        .id("round"),
      Box({ width: 12, height: 10, fill: "#123456" })
        .clip({ shape: "circle" })
        .id("roundel"),
      Box({ width: 12, height: 10, fill: "#123456" })
        .clip({
          shape: "path",
          outline: [["M", 0, 0], ["L", 12, 0], ["L", 0, 10], ["Z"]],
          fillRule: "evenodd",
        })
        .id("outline"),
      Box({ width: 12, height: 10, fill: "#123456" })
        .clip({ shape: "image", url: "/mask.png", mode: "alpha" })
        .id("masked"),
      Composition(
        World(
          () =>
            Box({ width: 8, height: 8, fill: "#111111" }).clip().id("inside"),
          { size: [40, 24] },
        ),
        {
          size: [40, 24],
          overlay: () =>
            Box({ width: 6, height: 4, fill: "#222222" }).id("over"),
        },
      ).id("plain-world"),
    ]);
    const rendered = await renderOnce(view, {
      design: [120, 80],
      target: [120, 80],
      media: new Map([
        [
          mediaKey(mask),
          { texture: { createView: () => ({}) } } as unknown as ImageTexture,
        ],
      ]),
    });
    const tags = new Map(
      rendered.traces.map((trace) => [trace.path.split("/").at(-1), trace]),
    );
    assert.deepEqual(tags.get("plain")?.surface, { kind: "clip", shape: "rect" });
    assert.deepEqual(tags.get("round")?.surface, {
      kind: "clip",
      shape: "rounded",
    });
    assert.deepEqual(tags.get("roundel")?.surface, {
      kind: "clip",
      shape: "circle",
    });
    assert.deepEqual(tags.get("outline")?.surface, { kind: "clip", shape: "path" });
    assert.deepEqual(tags.get("masked")?.surface, { kind: "clip", shape: "image" });
    const world = rendered.frame.commands.find((command) =>
      command.path.endsWith("plain-world"),
    );
    assert.equal(world?.kind, "composition");
    if (world?.kind !== "composition") return;
    assert.deepEqual(world.inspectionSurface, { kind: "composition" });
    assert.equal(world.overlay !== undefined, true);
    assert.equal(
      rendered.records.some((record) => record.path.endsWith("plain-world")),
      false,
    );
    const insideRecord = rendered.records.find((record) =>
      record.path.includes("inside"),
    );
    const overRecord = rendered.records.find((record) => record.path === "over");
    assert.equal(insideRecord?.kind, "box");
    assert.equal(overRecord?.kind, "box");
    assert.equal(
      rendered.records.filter((record) => record.kind === "composition").length,
      0,
    );
    const compositionTrace = rendered.traces.find((trace) =>
      trace.path.endsWith("plain-world"),
    );
    const inside = rendered.traces.find((trace) =>
      trace.path.endsWith("inside"),
    );
    assert.ok(compositionTrace && inside);
    assert.equal(compositionTrace.surface.kind, "composition");
    assert.equal(inside.projection.status, "mapped");
    assert.equal(inside.parentOccurrenceId, compositionTrace.occurrenceId);
    const off = evaluateView(Box({ width: 4, height: 4 }).clip(), {
      time: 0,
      width: 20,
      height: 20,
      measureText: measure,
    });
    assert.equal(off.commands[0].kind, "composition");
    if (off.commands[0].kind !== "composition") return;
    assert.equal(off.commands[0].inspectionSurface, undefined);
  });
});

test("a failed render publishes no snapshot and flat records stay on the top-level baseline", async () => {
  await withGpuGlobals(async () => {
    const clip = Box({ width: 10, height: 10, fill: "#111111" })
      .clip()
      .id("window");
    const good = await renderOnce(clip);
    assert.equal(good.traces.length, 1);
    const failed = new ViewRenderer();
    await failed.setup({
      device: createDevice().device,
      format: "bgra8unorm",
      resolution: [100, 100],
    });
    const bad = evaluateView(
      ZStack([clip, Box({ width: 10, height: 10, fill: "var(--nope)" })]),
      {
        time: 0,
        width: 100,
        height: 100,
        measureText: measure,
        inspection: true,
      },
    );
    assert.throws(
      () =>
        failed.render(
          bad,
          {
            device: createDevice().device,
            format: "bgra8unorm",
            resolution: [100, 100],
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
          },
          [100, 100],
          "#00000000",
          false,
          1,
          true,
          new Map(),
          () => {},
        ),
      /explicit color/,
    );
    assert.equal(failed.surfaceTraces(), EMPTY_SURFACE_TRACES);
    assert.equal(failed.frameOccurrences(), EMPTY_FRAME_OCCURRENCES);
    assert.equal(failed.surfaceOccurrences(), EMPTY_SURFACE_TRACES);
    failed.dispose();
    const quiet = new ViewRenderer();
    assert.equal(quiet.surfaceTraces(), EMPTY_SURFACE_TRACES);
    const collectedOff = await renderOnce(clip, { collect: false });
    assert.equal(collectedOff.traces, EMPTY_SURFACE_TRACES);
    assert.equal(collectedOff.frames, EMPTY_FRAME_OCCURRENCES);
    assert.equal(collectedOff.surfaces, EMPTY_SURFACE_TRACES);
    assert.equal("frameOccurrences" in collectedOff.frame, false);
    assert.equal(collectedOff.records.length, 0);
    assert.deepEqual(collectedOff.uniforms.at(-1), good.uniforms.at(-1));

    const flat = ZStack([
      Box({ width: 20, height: 10, fill: "#123456" }).id("card"),
      Text("Hi").id("label"),
      Image({ url: "photo.png", width: 30, height: 16 }).id("photo"),
      Group([Box({ width: 6, height: 6, fill: "#654321" }).id("nested")]).id(
        "surface",
      ),
    ]);
    const photo = {
      kind: "image" as const,
      url: "photo.png",
      style: { width: 30, height: 16 },
    };
    const flatRender = await renderOnce(flat, {
      media: new Map([
        [
          mediaKey(photo),
          {
            texture: { createView: () => ({}) },
            width: 30,
            height: 16,
          } as unknown as ImageTexture,
        ],
      ]),
    });
    assert.equal(
      flatRender.traces.some((trace) => trace.surface.kind === "group"),
      true,
    );
    assert.equal(
      flatRender.records.some((record) => record.kind === "group"),
      false,
      "a group owner is not a second leaf",
    );
    assert.equal(
      flatRender.records.some((record) => record.path.includes("nested")),
      true,
    );
    const nested = flatRender.records.find((record) =>
      record.path.includes("nested"),
    );
    assert.equal(nested?.accuracy, "exact-rectangle");
    if (nested && nested.accuracy !== "unavailable")
      assert.equal(
        nested.surfaceProjection?.coverage,
        "rect-clipped-draw-quad",
      );

    const stage = Stage(
      () =>
        ZStack([
          Box({ width: 20, height: 10, fill: "#123456" }).id("card"),
          Text("Hi").id("label"),
          Box({ width: 12, height: 8, fill: "#abcdef" }).clip().id("window"),
        ]),
      { inspection: true },
    );
    const device = createDevice().device;
    try {
      await stage.setup({
        device,
        format: "rgba8unorm",
        resolution: [100, 100],
        compositionResolution: [100, 100],
      });
      await stage.prepareFrame!({ time: 0, localTime: 0, progress: 0 });
      stage.render({
        device,
        format: "rgba8unorm",
        resolution: [100, 100],
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
        time: 0,
        localTime: 0,
        progress: 0,
      });
      const inspected = stage.inspect();
      assert.ok(inspected?.paintRecords);
      assert.deepEqual(
        inspected.paintRecords.map((record) => record.kind),
        ["box", "text", "box"],
      );
      assert.equal(
        inspected.paintRecords.some((record) => record.kind === "composition"),
        false,
        "a rect clip must not publish a placeholder beside its projected leaf",
      );
      const documentFrame: FrameInspection = {
        requestedTime: 0,
        effectiveTime: 0,
        scenes: [
          {
            id: "main",
            name: "Main",
            time: 0,
            localTime: 0,
            progress: 0,
            frame: inspected,
          },
        ],
      };
      const project = {
        name: "clip-transport",
        duration: 1,
        resolution: [100, 100] as const,
      };
      const full = buildInspectionDocument({
        packageVersion: "0.0.0-test",
        project,
        frame: documentFrame,
      });
      const target = { scope: "scene:main", id: "window" };
      const built = buildInspectionDocument({
        packageVersion: "0.0.0-test",
        project,
        frame: documentFrame,
        target,
      });
      const second = applyInspectionTarget(full, target);
      assert.deepEqual(
        built.scenes[0].paintRecords,
        second.scenes[0].paintRecords,
      );
      assert.deepEqual(
        built.scenes[0].paintRecords?.map((record) => record.kind),
        ["box"],
      );
      assert.equal(
        built.scenes[0].paintRecords?.[0].accuracy === "unavailable"
          ? undefined
          : built.scenes[0].paintRecords?.[0].surfaceProjection?.coverage,
        "rect-clipped-draw-quad",
      );
      assert.equal(
        JSON.stringify(built.scenes[0]).includes("inspectionSurface"),
        false,
      );
      assert.equal(full.scenes[0].paintRecords?.length, 3);

      let fail = false;
      const failing = Stage(
        () => {
          if (fail)
            return Box({ width: 10, height: 10, fill: "var(--nope)" }).clip();
          return Box({ width: 10, height: 10, fill: "#111111" })
            .clip()
            .id("window");
        },
        { inspection: true },
      );
      await failing.setup({
        device,
        format: "rgba8unorm",
        resolution: [100, 100],
        compositionResolution: [100, 100],
      });
      await failing.prepareFrame!({ time: 0, localTime: 0, progress: 0 });
      failing.render({
        device,
        format: "rgba8unorm",
        resolution: [100, 100],
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
        time: 0,
        localTime: 0,
        progress: 0,
      });
      assert.ok(failing.inspect()?.paintRecords);
      fail = true;
      await failing.prepareFrame!({ time: 1, localTime: 1, progress: 1 });
      assert.throws(() =>
        failing.render({
          device,
          format: "rgba8unorm",
          resolution: [100, 100],
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
          time: 1,
          localTime: 1,
          progress: 1,
        }),
      );
      assert.equal(failing.inspect(), undefined);
      failing.dispose();
    } finally {
      stage.dispose();
    }
  });
});

test("nonfinite packed uniforms are unavailable and do not publish a matrix", async () => {
  await withGpuGlobals(async () => {
    const rendered = await renderOnce(
      Box({ width: 20, height: 10, fill: "#123456" })
        .clip()
        .scale(1e40)
        .id("blown"),
    );
    const trace = rendered.traces[0];
    assert.equal(trace.projection.status, "unavailable");
    if (trace.projection.status !== "unavailable") return;
    assert.match(trace.projection.reason, /not finite/);
    assert.equal("childPixelsToParent" in trace.projection, false);
    assert.equal(rendered.records[0].kind, "box");
    assert.equal(rendered.records[0].accuracy, "unavailable");
    if (rendered.records[0].accuracy !== "unavailable") return;
    assert.match(rendered.records[0].unsupported, /not finite/);
    assert.equal("bounds" in rendered.records[0], false);
    assert.equal(
      rendered.records.some((record) => record.kind === "composition"),
      false,
    );
  });
});

test("a successful root snapshot is dropped on not-ready, draw failure, and collector-off", async () => {
  await withGpuGlobals(async () => {
    const clip = Box({ width: 10, height: 10, fill: "#111111" })
      .clip()
      .id("window");
    const good = evaluateView(clip, {
      time: 0,
      width: 100,
      height: 100,
      measureText: measure,
      inspection: true,
    });
    const bad = evaluateView(
      ZStack([clip, Box({ width: 10, height: 10, fill: "var(--nope)" })]),
      {
        time: 0,
        width: 100,
        height: 100,
        measureText: measure,
        inspection: true,
      },
    );
    const gpu = createDevice();
    const renderer = new ViewRenderer();
    await renderer.setup({
      device: gpu.device,
      format: "bgra8unorm",
      resolution: [100, 100],
    });
    const context = {
      device: gpu.device,
      format: "bgra8unorm" as const,
      resolution: [100, 100] as const,
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
    const draw = (frame: EvaluatedFrame, collect: boolean) =>
      renderer.render(
        frame,
        context,
        [100, 100],
        "#00000000",
        false,
        1,
        true,
        new Map(),
        collect ? () => {} : undefined,
      );
    const publish = () => {
      draw(good, true);
      const traces = renderer.surfaceTraces();
      assert.equal(traces.length, 1);
      assert.equal(traces[0].path.endsWith("window"), true);
      return traces;
    };
    const dropped = (earlier: readonly SurfaceTrace[]) => {
      assert.equal(renderer.surfaceTraces(), EMPTY_SURFACE_TRACES);
      assert.notEqual(renderer.surfaceTraces(), earlier);
      assert.equal(earlier.length, 1);
      assert.equal(earlier[0].path.endsWith("window"), true);
    };
    const earlier = publish();
    assert.throws(() => draw(bad, true), /explicit color/);
    dropped(earlier);
    const beforeOff = publish();
    draw(good, false);
    dropped(beforeOff);
    const beforeReady = publish();
    // dispose() already clears; this hits the readiness guard with a live snapshot.
    const readiness = renderer as unknown as {
      disposed: boolean;
      pipeline?: object;
    };
    const pipeline = readiness.pipeline;
    readiness.pipeline = undefined;
    assert.throws(() => draw(good, true), /not ready/);
    dropped(beforeReady);
    readiness.pipeline = pipeline;
    const beforeDisposed = publish();
    readiness.disposed = true;
    assert.throws(() => draw(good, true), /not ready/);
    dropped(beforeDisposed);
    readiness.disposed = false;
    const beforeDispose = publish();
    renderer.dispose();
    dropped(beforeDispose);
    assert.throws(() => draw(good, true), /not ready/);
    dropped(beforeDispose);
  });
});

/** Same pose the leaf collector uses to overflow the staged camera sum, not the products. */
const CANCELLING_CAMERA = [6e36, 0, 6e36, 1, -3.4e38, 0] as const;

function uploadedBlock(
  uniforms: readonly (readonly Float32Array[])[],
  trace: SurfaceTrace,
) {
  const block = uniforms.flat().find(
    (entry) =>
      entry[0] === trace.uniform.rect[0] &&
      entry[2] === trace.uniform.rect[2] &&
      entry[4] === trace.uniform.transform[0] &&
      entry[6] === trace.uniform.transform[2] &&
      entry[24] === trace.uniform.cameraX[0] &&
      entry[25] === trace.uniform.cameraX[1] &&
      entry[26] === trace.uniform.cameraX[2] &&
      entry[28] === trace.uniform.cameraY[0] &&
      entry[30] === trace.uniform.cameraY[2],
  );
  assert.ok(block, trace.path);
  return block;
}

function unavailableReason(trace: SurfaceTrace) {
  assert.equal(trace.projection.status, "unavailable", trace.path);
  if (trace.projection.status !== "unavailable") throw Error(trace.path);
  assert.equal("childPixelsToParent" in trace.projection, false);
  return trace.projection.reason;
}

test("finite rounded clip uniforms that overflow a float32 vertex stage do not publish a matrix", async () => {
  await withGpuGlobals(async () => {
    const sharedTransforms = new Map<string, readonly number[]>([
      ["hero", CANCELLING_CAMERA],
    ]);
    const leaf = await renderOnce(
      Box({ width: 50, height: 50, fill: "#123456" }).id("hero"),
      { sharedTransforms },
    );
    assert.equal(leaf.records[0].accuracy, "unavailable");
    if (leaf.records[0].accuracy !== "unavailable") return;
    const leafStage = leaf.records[0].unsupported.split(": ").slice(1).join(": ");
    assert.match(leafStage, /camera X overflows float32/);

    const parent = await renderOnce(
      Box({ width: 50, height: 50, fill: "#123456" }).clip().id("hero"),
      { sharedTransforms },
    );
    const parentTrace = parent.traces[0];
    const parentBlock = uploadedBlock(parent.uniforms, parentTrace);
    for (const field of [0, 1, 2, 3, 4, 5, 6, 7, 24, 25, 26, 28, 29, 30]) {
      assert.equal(parentBlock[field], Math.fround(parentBlock[field]));
      assert.ok(Number.isFinite(parentBlock[field]), `field ${field}`);
    }
    assert.notEqual(parentBlock[24], CANCELLING_CAMERA[0]);
    assert.notEqual(parentBlock[26], CANCELLING_CAMERA[4]);
    const binary64 = mappingFromUpload(
      parentBlock,
      parentTrace.childResolution[0],
      parentTrace.childResolution[1],
    );
    assert.ok(binary64.every(Number.isFinite));
    const worldX = Math.fround(
      Math.fround(
        Math.fround(parentBlock[0] + parentBlock[2]) * parentBlock[4],
      ) + parentBlock[6],
    );
    const worldY = Math.fround(
      Math.fround(
        Math.fround(parentBlock[1] + parentBlock[3]) * parentBlock[5],
      ) + parentBlock[7],
    );
    const productX = Math.fround(parentBlock[24] * worldX);
    const productY = Math.fround(parentBlock[25] * worldY);
    assert.ok(Number.isFinite(productX) && Number.isFinite(productY));
    assert.equal(Number.isFinite(Math.fround(productX + productY)), false);
    assert.ok(
      Number.isFinite(
        parentBlock[24] * worldX +
          parentBlock[25] * worldY +
          parentBlock[26],
      ),
    );
    const reason = unavailableReason(parentTrace);
    assert.equal(reason.split(": ").slice(1).join(": "), leafStage);
    const box = parent.records.find((record) => record.kind === "box");
    assert.equal(box?.accuracy, "unavailable");
    if (box?.accuracy !== "unavailable") return;
    assert.equal(box.unsupported, reason);
    assert.equal("bounds" in box, false);
    assert.equal(
      parent.records.some((record) => record.accuracy !== "unavailable"),
      false,
    );

    const nested = await renderOnce(
      Box({ width: 50, height: 50, fill: "#123456" })
        .clip()
        .id("inner")
        .clip()
        .id("outer"),
      {
        sharedTransforms: new Map([["outer", CANCELLING_CAMERA]]),
      },
    );
    const outer = nested.traces.find((trace) => trace.path.endsWith("outer"));
    const inner = nested.traces.find((trace) => trace.path.endsWith("inner"));
    assert.ok(outer && inner);
    const outerBlock = uploadedBlock(nested.uniforms, outer);
    const innerBlock = uploadedBlock(nested.uniforms, inner);
    assert.ok(
      mappingFromUpload(
        outerBlock,
        outer.childResolution[0],
        outer.childResolution[1],
      ).every(Number.isFinite),
    );
    assert.ok(
      mappingFromUpload(
        innerBlock,
        inner.childResolution[0],
        inner.childResolution[1],
      ).every(Number.isFinite),
    );
    assert.ok(innerBlock[24] < 1e6, "inner camera is not the overflowing ancestor");
    const ancestor = unavailableReason(outer);
    assert.match(ancestor, /overflows float32 vertex stages/);
    assert.equal(unavailableReason(inner), ancestor);
    const nestedBox = nested.records.find((record) => record.kind === "box");
    assert.equal(nestedBox?.accuracy, "unavailable");
    if (nestedBox?.accuracy !== "unavailable") return;
    assert.equal(nestedBox.unsupported, ancestor);
    assert.equal("bounds" in nestedBox, false);
    assert.equal("surfaceProjection" in nestedBox, false);

    const rounded = await renderOnce(
      Box({ width: 50, height: 50, fill: "#123456" })
        .clip({ shape: "rect", radius: 4 })
        .id("hero"),
      { sharedTransforms },
    );
    assert.equal(rounded.records[0].accuracy, "unavailable");
    assert.equal("bounds" in rounded.records[0], false);
  });
});

test("non-rect chains reuse the outer quad bounds, including scissor and nonfinite failure", () => {
  const corners = [
    [0, 0],
    [20, 0],
    [20, 10],
    [0, 10],
  ] as const;
  const child = {
    resolution: [20, 10] as const,
    scissor: { x: 0, y: 0, width: 20, height: 10 },
  };
  const root = {
    resolution: [100, 100] as const,
    scissor: { x: 0, y: 0, width: 100, height: 100 },
  };
  const translated = [1, 0, 0, 1, 5, 7] as const;
  for (const shape of ["rounded", "circle", "path", "image"] as const) {
    const projected = projectRectClipChain(
      corners,
      1,
      [{ occurrenceId: 3, shape, opacity: 1, matrix: translated, child }],
      root,
    );
    assert.equal(projected.status, "bounds", shape);
    if (projected.status !== "bounds") continue;
    assert.deepEqual(projected.bounds, { x: 5, y: 7, width: 20, height: 10 });
    assert.equal(projected.axisAligned, true, shape);
    assert.equal(projected.geometryVisible, true, shape);
  }
  const scissored = projectRectClipChain(
    corners,
    1,
    [
      {
        occurrenceId: 3,
        shape: "circle",
        opacity: 1,
        matrix: translated,
        child,
      },
    ],
    {
      resolution: [100, 100],
      scissor: { x: 10, y: 8, width: 10, height: 6 },
    },
  );
  assert.equal(scissored.status, "bounds");
  if (scissored.status === "bounds")
    assert.deepEqual(scissored.bounds, { x: 10, y: 8, width: 10, height: 6 });

  const hidden = projectRectClipChain(
    corners,
    -0,
    [{ occurrenceId: 1, shape: "path", opacity: -0, matrix: translated, child }],
    root,
  );
  assert.equal(hidden.status, "bounds");
  if (hidden.status === "bounds") assert.equal(hidden.geometryVisible, false);
  const faint = projectRectClipChain(
    corners,
    1e-12,
    [{ occurrenceId: 1, shape: "image", opacity: 1, matrix: translated, child }],
    root,
  );
  assert.equal(faint.status, "bounds");
  if (faint.status === "bounds") assert.equal(faint.geometryVisible, true);

  const empty = projectRectClipChain(
    corners,
    1,
    [
      {
        occurrenceId: 1,
        shape: "rounded",
        opacity: 1,
        matrix: translated,
        child: {
          resolution: [20, 10],
          scissor: { x: 0, y: 0, width: 0, height: 10 },
        },
      },
    ],
    root,
  );
  assert.equal(empty.status, "bounds");
  if (empty.status === "bounds") {
    assert.equal(empty.geometryVisible, false);
    assert.equal(empty.bounds.width, 0);
    assert.ok(Number.isFinite(empty.bounds.x) && Number.isFinite(empty.bounds.y));
  }
  const blown = projectRectClipChain(
    corners,
    1,
    [
      {
        occurrenceId: 1,
        shape: "circle",
        opacity: 1,
        matrix: [1, 0, 0, 1, Number.POSITIVE_INFINITY, 7],
        child,
      },
    ],
    root,
  );
  assert.equal(blown.status, "unavailable");
  if (blown.status === "unavailable") {
    assert.match(blown.reason, /not finite/);
    assert.equal("bounds" in blown, false);
  }
});

function visitFrames(frame: EvaluatedFrame): EvaluatedFrame[] {
  const found = [frame];
  for (const command of frame.commands) {
    if (command.kind !== "composition" && command.kind !== "group") continue;
    found.push(...visitFrames(command.frame));
    if (command.kind === "composition" && command.overlay)
      found.push(...visitFrames(command.overlay));
  }
  return found;
}

test("frame and surface occurrences follow the renderer's own transforms and uploads", async () => {
  await withGpuGlobals(async () => {
    const view = Composition(
      World(
        () =>
          Group([
            Composition(
              World(
                () =>
                  Box({ width: 12, height: 8, fill: "#112233" })
                    .scale(-2, 1.5, [0, 0])
                    .offset(3.5, -1.25)
                    .id("leaf"),
                { size: [80, 50] },
              ),
              {
                size: [70, 40],
                camera: { x: 10.5, y: 3.25, zoom: 1.5, anchor: [0.2, 0.8] },
                overlay: () =>
                  Box({ width: 6, height: 5, fill: "#778899" })
                    .offset(1.5, 2.25)
                    .id("hud"),
              },
            )
              .id("nested")
              .offset(6.5, -4.25),
          ])
            .id("cluster")
            .clip()
            .id("window"),
        { size: [100, 80] },
      ),
      {
        size: [120, 90],
        camera: { x: 4.5, y: -2.25, zoom: 0.75, anchor: [0.1, 0.3] },
      },
    ).id("comp");
    const rendered = await renderOnce(view, {
      design: [120, 90],
      target: [200, 100],
    });
    const again = await renderOnce(view, {
      design: [120, 90],
      target: [200, 100],
    });
    assert.deepEqual(
      again.frames.map((frame) => frame.id),
      rendered.frames.map((frame) => frame.id),
    );
    assert.equal(rendered.frames[0]?.id, 0);
    const sources = visitFrames(rendered.frame);
    assert.equal(rendered.frames.length, sources.length);
    const boundCameras: number[][] = [];
    rendered.frames.forEach((occurrence, index) => {
      const source = sources[index];
      assert.equal(occurrence.layoutSpace.status, "known");
      if (occurrence.layoutSpace.status !== "known") return;
      assert.equal(occurrence.layoutSpace.id, source.frameLayoutSpaceId);
      const expected = computeFrameTransform(
        occurrence.designSize,
        occurrence.targetResolution,
        source.camera?.matrix,
      );
      assert.equal(occurrence.baseFrameTransform.status, "mapped");
      if (occurrence.baseFrameTransform.status !== "mapped") return;
      assert.deepEqual(occurrence.baseFrameTransform.matrix, expected.matrix);
      assert.equal(occurrence.baseFrameTransform.source, "computeFrameTransform");
      assert.equal(occurrence.baseFrameTransform.precision, "binary64");
      assert.deepEqual(occurrence.scissor, {
        x: Math.ceil(expected.ox),
        y: Math.ceil(expected.oy),
        width: Math.max(
          0,
          Math.floor(occurrence.targetResolution[0] - expected.ox) -
            Math.ceil(expected.ox),
        ),
        height: Math.max(
          0,
          Math.floor(occurrence.targetResolution[1] - expected.oy) -
            Math.ceil(expected.oy),
        ),
      });
      const pass = passForFrame(rendered, source);
      assert.equal(occurrence.drawCameras.length, source.commands.length);
      assert.equal(pass.draws.length, source.commands.length);
      occurrence.drawCameras.forEach((camera, commandIndex) => {
        assert.equal(camera.camera.status, "mapped");
        if (camera.camera.status !== "mapped") return;
        assert.equal(camera.camera.source, "uploaded-uniform");
        assert.equal(camera.camera.precision, "float32");
        const uploaded = cameraAtDraw(rendered.writes, pass.draws[commandIndex]);
        assert.deepEqual([...camera.camera.matrix], uploaded);
        boundCameras.push(uploaded);
        const swapped = pass.draws[(commandIndex + 1) % pass.draws.length];
        if (swapped !== pass.draws[commandIndex])
          assert.notDeepEqual(
            [...camera.camera.matrix],
            cameraAtDraw(rendered.writes, swapped),
          );
      });
    });
    // Two frames may upload the same camera (same design, same target, identity camera), so
    // uniqueness is not a property to assert. Bind equality above is exact per command; this
    // negative control proves the same binding would reject a swap between distinct uploads.
    const other = boundCameras.findIndex(
      (row, index) => index > 0 && row.join(",") !== boundCameras[0].join(","),
    );
    assert.ok(other > 0, "the fixture uploads at least two distinct cameras");
    const swapped = boundCameras.slice();
    [swapped[0], swapped[other]] = [swapped[other], swapped[0]];
    // Negative control: frame 0's recorded camera must not match the other frame's upload, so
    // a binding that crossed frames would fail rather than pass on a global list of matrices.
    const foreign = cameraAtDraw(
      rendered.writes,
      passForFrame(rendered, sources[other]).draws[0],
    ).join(",");
    const recordedFirst = rendered.frames[0].drawCameras[0]?.camera;
    assert.equal(recordedFirst?.status, "mapped");
    if (recordedFirst?.status === "mapped") {
      assert.equal([...recordedFirst.matrix].join(","), boundCameras[0].join(","));
      assert.notEqual([...recordedFirst.matrix].join(","), foreign);
      assert.notEqual([...recordedFirst.matrix].join(","), swapped[0].join(","));
    }
    const leaf = visitFrames(rendered.frame)
      .flatMap((frame) => frame.commands)
      .find((command) => command.path.includes("leaf"));
    assert.equal(leaf?.kind, "box");
    if (leaf?.kind === "box") {
      assert.ok(leaf.transform[0] < 0, "negative scale");
      assert.notEqual(leaf.transform[2], 0, "nonzero position");
      assert.notEqual(leaf.transform[3], 0);
    }
    const hud = visitFrames(rendered.frame)
      .flatMap((frame) => frame.commands)
      .find((command) => command.path.includes("hud"));
    assert.equal(hud?.kind, "box");
    const nested = rendered.surfaces.find((surface) =>
      surface.path.endsWith("nested"),
    );
    const cluster = rendered.surfaces.find((surface) =>
      surface.path.endsWith("cluster"),
    );
    const window = rendered.surfaces.find((surface) =>
      surface.path.endsWith("window"),
    );
    const outer = rendered.surfaces.find((surface) => surface.path.endsWith("comp"));
    assert.equal(nested?.surface.kind, "composition");
    assert.equal(cluster?.surface.kind, "group");
    assert.equal(window?.surface.kind, "clip");
    assert.equal(outer?.surface.kind, "composition");
    assert.equal(nested?.parentOccurrenceId, cluster?.occurrenceId);
    assert.equal(cluster?.parentOccurrenceId, window?.occurrenceId);
    assert.equal(window?.parentOccurrenceId, outer?.occurrenceId);
    assert.notEqual(nested?.parentOccurrenceId, window?.parentOccurrenceId);
    const world = rendered.frames.find(
      (frame) => frame.id === nested?.worldFrameOccurrenceId,
    );
    const overlay = rendered.frames.find(
      (frame) => frame.id === nested?.overlayFrameOccurrenceId,
    );
    assert.ok(world && overlay);
    assert.notEqual(world.id, overlay.id);
    assert.deepEqual(world.targetResolution, overlay.targetResolution);
    assert.deepEqual(world.parentSurface, overlay.parentSurface);
    assert.equal(world.parentSurface.status, "known");
    assert.equal(world.parentSurface.occurrenceId, nested?.occurrenceId);
    assert.notDeepEqual(world.baseFrameTransform, overlay.baseFrameTransform);
    assert.equal(world.baseFrameTransform.status, "mapped");
    if (world.baseFrameTransform.status === "mapped")
      assert.notEqual(world.baseFrameTransform.matrix[0], world.baseFrameTransform.matrix[4] && 1);
    const worldPass = passForFrame(rendered, sources[world.id]);
    const overlayPass = passForFrame(rendered, sources[overlay.id]);
    const worldCamera = cameraAtDraw(rendered.writes, worldPass.draws[0]);
    const overlayCamera = cameraAtDraw(rendered.writes, overlayPass.draws[0]);
    assert.notDeepEqual(worldCamera, overlayCamera);
    assert.deepEqual(
      world.drawCameras[0]?.camera.status === "mapped"
        ? [...world.drawCameras[0].camera.matrix]
        : undefined,
      worldCamera,
    );
    assert.notDeepEqual(
      overlay.drawCameras[0]?.camera.status === "mapped"
        ? [...overlay.drawCameras[0].camera.matrix]
        : undefined,
      worldCamera,
    );
    const composition = nested;
    assert.equal(composition?.occurrenceIdKind, "evaluation-command");
    assert.equal(composition?.worldFrameOccurrenceId, world.id);
    assert.equal(composition?.overlayFrameOccurrenceId, overlay.id);
    // The frame that drew the nested composition is the one visiting the cluster group, which
    // is not the clip frame that drew that group.
    const nestedVisit = sources.findIndex((source) =>
      source.commands.some(
        (command) =>
          command.kind === "composition" && command.path.endsWith("/nested"),
      ),
    );
    assert.notEqual(nestedVisit, -1);
    assert.equal(composition?.parentFrameOccurrenceId, nestedVisit);
    assert.notEqual(composition?.parentFrameOccurrenceId, cluster?.parentFrameOccurrenceId);
    assert.ok(composition?.childScissor);
    const outerWorld = rendered.frames.find(
      (frame) => frame.id === outer?.worldFrameOccurrenceId,
    );
    for (const surface of rendered.surfaces) {
      const local = childPixelsToParent(
        surface.uniform,
        surface.childResolution[0],
        surface.childResolution[1],
      );
      if (surface.projection.status === "mapped") {
        assert.equal(local.status, "mapped");
        if (local.status === "mapped")
          assert.deepEqual(surface.projection.childPixelsToParent, local.matrix);
      }
    }
    const worldSpace = rendered.frame.spaceProvenance?.find(
      (space) => space.kind === "world",
    );
    assert.equal(worldSpace?.worldToCompositionViewport?.status, "mapped");
    assert.notDeepEqual(
      worldSpace?.worldToCompositionViewport?.status === "mapped"
        ? worldSpace.worldToCompositionViewport.matrix
        : undefined,
      world?.baseFrameTransform.status === "mapped"
        ? world.baseFrameTransform.matrix
        : undefined,
    );
  });
});

test("shared correction stays on the matched command and is not applied twice", async () => {
  await withGpuGlobals(async () => {
    const view = Composition(
      World(
        () =>
          Box({ width: 8, height: 6, fill: "#112233" }).id("leaf"),
        { size: [40, 30] },
      ),
      { size: [40, 30] },
    ).id("comp");
    const plain = await renderOnce(view);
    const correction = [2, 0, 0, 3, 4, 5] as const;
    const matched = await renderOnce(view, {
      sharedTransforms: new Map([["comp", correction]]),
    });
    const fallback = await renderOnce(view, {
      sharedTransforms: new Map([["leaf", correction]]),
    });
    const cameraOf = (
      rendered: typeof plain,
      space: string,
      ownerPath: string,
    ) => {
      const frame = rendered.frames.find(
        (entry) =>
          entry.layoutSpace.status === "known" && entry.layoutSpace.id === space,
      );
      if (!frame) return undefined;
      const source = visitFrames(rendered.frame)[frame.id];
      const command = source.commands.find((entry) => entry.path === ownerPath);
      if (!command?.inspection) return undefined;
      const recorded = frame.drawCameras.find(
        (camera) => camera.commandId === command.inspection!.id,
      );
      // The record must describe the block this command's bind group actually uploads.
      const drawIndex = source.commands.indexOf(command);
      const bound = cameraAtDraw(
        rendered.writes,
        passForFrame(rendered, source).draws[drawIndex],
      );
      assert.equal(recorded?.camera.status, "mapped");
      if (recorded?.camera.status === "mapped")
        assert.deepEqual([...recorded.camera.matrix], bound);
      return recorded;
    };
    const plainComp = cameraOf(plain, "layout", "comp");
    const matchedComp = cameraOf(matched, "layout", "comp");
    const fallbackComp = cameraOf(fallback, "layout", "comp");
    const plainLeaf = cameraOf(plain, "comp/world", "leaf");
    const matchedLeaf = cameraOf(matched, "comp/world", "leaf");
    const fallbackLeaf = cameraOf(fallback, "comp/world", "leaf");
    assert.equal(matchedComp?.camera.status, "mapped");
    assert.notDeepEqual(matchedComp?.camera, plainComp?.camera);
    assert.deepEqual(matchedLeaf?.camera, plainLeaf?.camera);
    assert.deepEqual(fallbackComp?.camera, plainComp?.camera);
    assert.notDeepEqual(fallbackLeaf?.camera, plainLeaf?.camera);
    assert.equal(
      matched.frame.spaceProvenance?.find((space) => space.kind === "world")
        ?.worldToCompositionViewport?.status,
      "mapped",
    );
    assert.deepEqual(
      matched.frame.spaceProvenance?.find((space) => space.kind === "world")
        ?.worldToCompositionViewport,
      plain.frame.spaceProvenance?.find((space) => space.kind === "world")
        ?.worldToCompositionViewport,
    );
  });
});

test("zero scale stays mapped, and an untagged parent does not invent a scene chain", async () => {
  await withGpuGlobals(async () => {
    const zero = await renderOnce(
      Box({ width: 10, height: 8, fill: "#123456" }).clip().scale(0, 1, [0, 0]),
    );
    assert.equal(zero.surfaces[0]?.projection.status, "mapped");
    if (zero.surfaces[0]?.projection.status === "mapped")
      assert.ok(zero.surfaces[0].projection.childPixelsToParent.includes(0));
    const nested = evaluateView(
      Group([
        Box({ width: 8, height: 6, fill: "#123456" }).clip().id("inner"),
      ]).id("outer"),
      { time: 0, width: 40, height: 30, measureText: measure, inspection: true },
    );
    const outer = nested.commands[0];
    assert.equal(outer.kind, "group");
    if (outer.kind !== "group") return;
    const untagged = await renderOnce(Group([]), {
      frame: {
        ...nested,
        commands: [{ ...outer, inspectionSurface: undefined }],
      },
    });
    const inner = untagged.surfaces[0];
    assert.equal(inner?.projection.status, "unavailable");
    if (inner?.projection.status === "unavailable")
      assert.equal(inner.projection.reason, NON_CLIP_PARENT_REASON);
    assert.equal(inner?.parentOccurrenceId, undefined);
    assert.ok(
      untagged.frames.some(
        (frame) => frame.parentSurface.status === "unavailable",
      ),
    );
  });
});

test("each published draw camera is the upload its own draw's bind group addressed", async () => {
  await withGpuGlobals(async () => {
    // Different cameras per visit plus a shared correction, so a camera equal to *some* published
    // value is caught; both leaves share one camera, so their ids are swappable without any value
    // comparison noticing.
    const view = Composition(
      World(
        () =>
          ZStack(
            [
              Box({ width: 6, height: 4, fill: "#112233" }).id("first"),
              Box({ width: 6, height: 4, fill: "#445566" })
                .id("second")
                .offset(4, 3),
            ],
            { align: "start" },
          ),
        { size: [30, 20] },
      ),
      { size: [30, 20], camera: { x: 21, y: 11.5, zoom: 0.75 } },
    ).id("comp");
    const rendered = await renderOnce(view, {
      sharedTransforms: new Map([["comp", [1.5, 0, 0, 1.5, 2, 1]]]),
    });
    const visits = postOrderFrames(rendered.frame);
    assert.equal(visits.length, rendered.passes.length);
    // The mock keeps the packed rect and transform of the uniform row each draw's bind group
    // addressed. The renderer iterates `frame.commands` in order and draws that order in one pass,
    // so that row names the command that issued the draw: the drawn order read back from bytes,
    // never from `drawCameras`.
    const drawn = visits.map((visit, passIndex) => {
      const draws = rendered.passes[passIndex].draws;
      const packed = visit.commands.flatMap((command) =>
        command.inspection
          ? [
              {
                id: command.inspection.id,
                row: [
                  Math.fround(command.bounds.x),
                  Math.fround(command.bounds.y),
                  Math.fround(command.bounds.width),
                  Math.fround(command.bounds.height),
                  ...command.transform.map((value) => Math.fround(value)),
                ],
              },
            ]
          : [],
      );
      assert.equal(draws.length, packed.length, `pass ${passIndex} drew its commands`);
      return {
        pass: passIndex,
        draws,
        ids: draws.map((draw, index) => {
          const matches = packed.filter((entry) =>
            entry.row.every((value, position) => value === draw.row[position]),
          );
          assert.equal(matches.length, 1, `draw ${index} of pass ${passIndex} is one command`);
          return matches[0].id;
        }),
      };
    });
    // A pass is paired with a recorded visit by the command ids it holds — set membership only —
    // then the published *sequence* is compared with the drawn one. Swapped ids keep every set,
    // every camera value and the draw ledger identical, so only this comparison rejects them.
    const pairVisits = (frames: readonly FrameOccurrence[]) =>
      frames.map((recorded) => {
        const published = recorded.drawCameras.map((camera) => camera.commandId);
        const sorted = [...published].sort((a, b) => a - b);
        const matches = drawn.filter(
          (pass) =>
            pass.ids.length === sorted.length &&
            [...pass.ids].sort((a, b) => a - b).every((id, index) => id === sorted[index]),
        );
        assert.equal(matches.length, 1, `visit ${recorded.id} is one render pass`);
        assert.deepEqual(
          published,
          matches[0].ids,
          `visit ${recorded.id} publishes its command ids in the order drawn`,
        );
        return { recorded, pass: matches[0].pass, draws: matches[0].draws };
      });
    const paired = pairVisits(rendered.frames);
    // Two recorded visits may not be satisfied by the same render pass.
    const claimed = new Set<number>();
    let checked = 0;
    for (const { recorded, pass, draws } of paired) {
      assert.equal(claimed.has(pass), false, `visit ${recorded.id} reuses a pass`);
      claimed.add(pass);
      assert.equal(
        draws.length,
        recorded.drawCameras.length,
        `visit ${recorded.id} drew exactly its published commands`,
      );
      for (const [index, camera] of recorded.drawCameras.entries()) {
        assert.equal(camera.camera.status, "mapped", `visit ${recorded.id}`);
        assert.deepEqual(
          camera.camera.status === "mapped" ? [...camera.camera.matrix] : undefined,
          cameraAtDraw(rendered.writes, draws[index]),
          `visit ${recorded.id} command ${camera.commandId} is that draw's own upload`,
        );
        checked += 1;
      }
    }
    const published = rendered.frames.reduce(
      (total, entry) => total + entry.drawCameras.length,
      0,
    );
    assert.equal(checked, published, `checked ${checked} of ${published} draw cameras`);
    assert.ok(checked >= 3, "fixture publishes three draw cameras");
    // Negative control on identity alone: same cameras, swapped ids, no camera value touched.
    const matricesOf = (frame: FrameOccurrence) =>
      frame.drawCameras.map((camera) =>
        camera.camera.status === "mapped" ? camera.camera.matrix : undefined,
      );
    const identical = paired.find(({ recorded }) => {
      const [a, b] = matricesOf(recorded);
      return a !== undefined && b !== undefined && a.every((value, at) => value === b[at]);
    });
    assert.ok(identical, "fixture has a visit with two identical draw cameras");
    const [first, second] = identical.recorded.drawCameras;
    assert.notEqual(first.commandId, second.commandId);
    const swapped: FrameOccurrence = {
      ...identical.recorded,
      drawCameras: identical.recorded.drawCameras.map((camera) =>
        camera === first
          ? { ...camera, commandId: second.commandId }
          : camera === second
            ? { ...camera, commandId: first.commandId }
            : camera,
      ),
    };
    for (const [index, camera] of swapped.drawCameras.entries())
      assert.deepEqual(
        camera.camera.status === "mapped" ? [...camera.camera.matrix] : undefined,
        cameraAtDraw(rendered.writes, identical.draws[index]),
        "identical cameras survive the swap, so only the drawn order can reject it",
      );
    assert.throws(
      () =>
        pairVisits(
          rendered.frames.map((frame) => (frame.id === swapped.id ? swapped : frame)),
        ),
      /publishes its command ids in the order drawn/,
      "swapping ids between identical cameras must fail the drawn order",
    );
    // Negative control through the camera comparison. The root visit draws one command whose upload
    // is this render's frame matrix; the surface visit draws its leaves through another camera.
    const root = paired.find((e) => e.recorded.parentSurface.status === "unavailable");
    const inner = paired.find(
      (e) =>
        e.recorded.id !== root?.recorded.id &&
        e.recorded.parentSurface.status === "known",
    );
    assert.ok(root && inner, "fixture has a root visit and a surface visit");
    assert.equal(root.draws.length, root.recorded.drawCameras.length);
    const rootUpload = cameraAtDraw(rendered.writes, root.draws[0]);
    const reused = matricesOf(inner.recorded).some(
      (matrix) =>
        matrix !== undefined &&
        rootUpload.every(
          (value, position) => Math.fround(value) === Math.fround(matrix[position]),
        ),
    );
    assert.equal(reused, false, "a surface visit's camera is not the root's upload");
    assert.deepEqual(
      rootUpload,
      rendered.frames[0].drawCameras[0].camera.status === "mapped"
        ? rendered.frames[0].drawCameras[0].camera.matrix.map((value) =>
            Math.fround(value),
          )
        : undefined,
      "the root upload is the root visit's own published camera",
    );
  });
});

test("a nonfinite base transform is unavailable and carries no matrix", async () => {
  await withGpuGlobals(async () => {
    const evaluated = evaluateView(Box({ width: 4, height: 4, fill: "#123456" }), {
      time: 0,
      width: 20,
      height: 10,
      measureText: measure,
      inspection: true,
    });
    const rendered = await renderOnce(Box({ width: 1, height: 1 }), {
      frame: {
        ...evaluated,
        camera: {
          position: [0, 0],
          zoom: 1,
          rotation: 0,
          anchor: [0, 0],
          matrix: [Number.POSITIVE_INFINITY, 0, 0, 1, 0, 0],
          inverse: [0, 0, 0, 1, 0, 0],
        },
      },
    });
    assert.equal(rendered.frames[0]?.baseFrameTransform.status, "unavailable");
    assert.equal("matrix" in rendered.frames[0]!.baseFrameTransform, false);
    assert.equal(rendered.frames[0]?.drawCameras[0]?.camera.status, "unavailable");
    assert.equal("matrix" in (rendered.frames[0]?.drawCameras[0]?.camera ?? {}), false);
  });
});
