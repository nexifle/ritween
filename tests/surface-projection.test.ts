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
import {
  EMPTY_SURFACE_TRACES,
  NON_CLIP_PARENT_REASON,
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
      writeBuffer(
        buffer: { usage?: number },
        _offset: number,
        data: Float32Array,
      ) {
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
      options.collect === false ? undefined : (record) => records.push(record),
    );
  } catch (error) {
    thrown = error;
  }
  const traces = renderer.surfaceTraces();
  renderer.dispose();
  if (thrown) throw thrown;
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
      rendered.traces.map((trace) => trace.shape),
      ["rect", "rect"],
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

test("clip shapes are tagged from the spec and a plain composition stays unsupported", async () => {
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
    assert.equal(tags.get("plain")?.shape, "rect");
    assert.equal(tags.get("round")?.shape, "rounded");
    assert.equal(tags.get("roundel")?.shape, "circle");
    assert.equal(tags.get("outline")?.shape, "path");
    assert.equal(tags.get("masked")?.shape, "image");
    const world = rendered.frame.commands.find((command) =>
      command.path.endsWith("plain-world"),
    );
    assert.equal(world?.kind, "composition");
    if (world?.kind !== "composition") return;
    assert.equal(world.inspectionSurface, undefined);
    assert.equal(world.overlay !== undefined, true);
    const worldRecord = rendered.records.find((record) =>
      record.path.endsWith("plain-world"),
    );
    assert.equal(worldRecord?.kind, "composition");
    assert.equal(worldRecord?.accuracy, "unavailable");
    if (worldRecord?.accuracy !== "unavailable") return;
    assert.match(worldRecord.unsupported, /composition paint is not collected/);
    assert.equal(
      rendered.records.some((record) => record.path.includes("inside")),
      false,
    );
    assert.equal(
      rendered.records.some((record) => record.path.includes("over")),
      false,
    );
    const inside = rendered.traces.find((trace) =>
      trace.path.endsWith("inside"),
    );
    assert.ok(inside);
    assert.equal(inside.projection.status, "unavailable");
    if (inside.projection.status !== "unavailable") return;
    assert.equal(inside.projection.reason, NON_CLIP_PARENT_REASON);
    assert.equal(inside.parentOccurrenceId, undefined);
    assert.equal("childPixelsToParent" in inside.projection, false);
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
    failed.dispose();
    const quiet = new ViewRenderer();
    assert.equal(quiet.surfaceTraces(), EMPTY_SURFACE_TRACES);
    const collectedOff = await renderOnce(clip, { collect: false });
    assert.equal(collectedOff.traces, EMPTY_SURFACE_TRACES);
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
    assert.equal(flatRender.traces, EMPTY_SURFACE_TRACES);
    assert.deepEqual(
      flatRender.records.map((record) => record.kind),
      ["box", "text", "media", "group"],
    );
    assert.equal(flatRender.records.length, flatRender.frame.commands.length);
    assert.equal(
      flatRender.records.some((record) => record.path.includes("nested")),
      false,
    );
    const group = flatRender.records[3];
    assert.equal(group.accuracy, "unavailable");
    if (group.accuracy === "unavailable")
      assert.match(group.unsupported, /group paint is not collected/);

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
          : built.scenes[0].paintRecords?.[0].clipProjection?.coverage,
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
    assert.equal("clipProjection" in nestedBox, false);
  });
});
