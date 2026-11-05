/**
 * G3.3 offered size / allocated slot opt-in metadata tests
 * (docs/plans/declarative-layout-hardening.md §9 and G3.3 specification).
 *
 * Covers:
 * - Default off: ordinary evaluation and Stage rendering omit offeredSize and allocatedSlot.
 * - Flex slot allocation vs fixed leaf overflow on both axes.
 * - Multi-level padding on both axes with insets applied to offer and slot at each level.
 * - Frame overflow with oversized leaf content.
 * - Actual Stage inspection opt-in plumbing via StageOptions and prepareFrame.
 * - Nested Composition world/overlay propagation.
 * - Whitelist serialization and finite number contracts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  Box,
  Circle,
  Composition,
  Group,
  HStack,
  Line,
  Spacer,
  Stage,
  Text,
  VStack,
  Video,
  World,
  evaluateView,
  type DrawCommand,
  type MeasureText,
  type ViewNode,
} from "../src/authoring/index";
import {
  buildInspectionDocument,
  serializeInspection,
  InspectionSerializationError,
} from "../src/engine/inspect/report";
import type { FrameInspection } from "../src/engine/render/renderer";
import type { SetupContext, RenderContext } from "../src/engine/types";

const measure: MeasureText = (text) => text.length * 10;

async function withStageEnvironment<T>(run: () => Promise<T>): Promise<T> {
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

function stageDevice() {
  return {
    createShaderModule: () => ({}),
    createRenderPipelineAsync: async () => ({
      getBindGroupLayout: () => ({}),
    }),
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createSampler: () => ({}),
    createBuffer: () => ({ destroy() {} }),
    createBindGroup: () => ({}),
    queue: {
      writeTexture() {},
      writeBuffer() {},
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
}

function stageMockContext() {
  const device = stageDevice();
  const target = { createView: () => ({}) } as unknown as GPUTexture;
  const encoder = {
    beginRenderPass: () => ({
      setScissorRect() {},
      setPipeline() {},
      setBindGroup() {},
      draw() {},
      end() {},
    }),
    finish: () => ({}),
  } as unknown as GPUCommandEncoder;
  const setup: SetupContext = {
    device,
    format: "bgra8unorm",
    resolution: [320, 240],
    compositionResolution: [320, 240],
  };
  const render: RenderContext = {
    ...setup,
    target,
    encoder,
    time: 0,
    localTime: 0,
    progress: 0,
  };
  return { setup, render };
}

test("G3.3: default-off leaves offeredSize and allocatedSlot absent across the layout tree", () => {
  const view = HStack([
    Box({ width: 50, height: 30 }).padding(10),
    Box({ width: 50, height: 30 }).flex(1),
  ]);
  const frame = evaluateView(view, {
    time: 0,
    width: 200,
    height: 100,
    measureText: measure,
  });

  function assertNoMetadata(node: { offeredSize?: unknown; allocatedSlot?: unknown; children: readonly any[] }) {
    assert.equal(node.offeredSize, undefined, "offeredSize must be absent by default");
    assert.equal(node.allocatedSlot, undefined, "allocatedSlot must be absent by default");
    assert.equal("offeredSize" in node, false, "offeredSize key must not exist on node");
    assert.equal("allocatedSlot" in node, false, "allocatedSlot key must not exist on node");
    for (const child of node.children) {
      assertNoMetadata(child);
    }
  }

  assertNoMetadata(frame.tree);
});

test("G3.3: opt-in records offeredSize and allocatedSlot on root and children", () => {
  const view = Box({ width: 60, height: 40 });
  const frame = evaluateView(view, {
    time: 0,
    width: 200,
    height: 100,
    measureText: measure,
    inspection: true,
  });

  assert.deepEqual(frame.tree.offeredSize, { width: 200, height: 100 });
  assert.deepEqual(frame.tree.allocatedSlot, { x: 0, y: 0, width: 200, height: 100 });
  assert.deepEqual(frame.tree.bounds, { x: 0, y: 0, width: 60, height: 40 });
});

test("G3.3: flex allocates main-axis slot by weight and records offeredSize and allocatedSlot on both axes", () => {
  // Horizontal stack: width 300, offered height 100.
  // flex(1) and flex(2) share main axis 300 -> slots 100 and 200. Content height is 20.
  const hView = HStack([
    Box({ width: 30, height: 20 }).flex(1),
    Box({ width: 30, height: 20 }).flex(2),
  ], { gap: 0 });
  const hFrame = evaluateView(hView, {
    time: 0,
    width: 300,
    height: 100,
    measureText: measure,
    inspection: true,
  });

  const hFlex1 = hFrame.tree.children[0];
  const hFlex2 = hFrame.tree.children[1];

  assert.deepEqual(hFlex1.offeredSize, { width: 100, height: 100 });
  assert.deepEqual(hFlex1.allocatedSlot, { x: 0, y: 0, width: 100, height: 20 });

  assert.deepEqual(hFlex2.offeredSize, { width: 200, height: 100 });
  assert.deepEqual(hFlex2.allocatedSlot, { x: 100, y: 0, width: 200, height: 20 });

  // Vertical stack: offered width 100, height 300.
  // flex(1) and flex(2) share main axis 300 -> slots 100 and 200. Content width is 20.
  const vView = VStack([
    Box({ width: 20, height: 30 }).flex(1),
    Box({ width: 20, height: 30 }).flex(2),
  ], { gap: 0 });
  const vFrame = evaluateView(vView, {
    time: 0,
    width: 100,
    height: 300,
    measureText: measure,
    inspection: true,
  });

  const vFlex1 = vFrame.tree.children[0];
  const vFlex2 = vFrame.tree.children[1];

  assert.deepEqual(vFlex1.offeredSize, { width: 100, height: 100 });
  assert.deepEqual(vFlex1.allocatedSlot, { x: 0, y: 0, width: 20, height: 100 });

  assert.deepEqual(vFlex2.offeredSize, { width: 100, height: 200 });
  assert.deepEqual(vFlex2.allocatedSlot, { x: 0, y: 100, width: 20, height: 200 });
});

test("G3.3: fixed leaf overflow inside flexible slot distinguishes slot from measured content bounds", () => {
  // HStack width 100: fixed child 60 reserves 60; flexible child gets slotMain = 40.
  // Leaf box inside flex has width 70, exceeding the 40 slot.
  const view = HStack([
    Box({ width: 60, height: 30 }),
    Box({ width: 70, height: 30 }).flex(1),
  ], { gap: 0 });
  const frame = evaluateView(view, {
    time: 0,
    width: 100,
    height: 80,
    measureText: measure,
    inspection: true,
  });

  const flexWrapper = frame.tree.children[1];
  assert.deepEqual(flexWrapper.offeredSize, { width: 40, height: 80 });
  assert.deepEqual(flexWrapper.allocatedSlot, { x: 60, y: 0, width: 40, height: 30 });

  const leafBox = flexWrapper.children[0];
  assert.deepEqual(leafBox.offeredSize, { width: 40, height: 80 });
  assert.deepEqual(leafBox.allocatedSlot, { x: 60, y: 0, width: 40, height: 30 });
  // Leaf measured content overflows: width 70 > slot 40
  assert.equal(leafBox.bounds.width, 70);
  assert.equal(leafBox.bounds.width > leafBox.allocatedSlot.width, true);
});

test("G3.3: fixed leaf overflow inside fixed frame on both axes", () => {
  // Frame 100x60 with an oversized Box 150x90.
  const view = Box({ width: 150, height: 90 }).frame({ width: 100, height: 60 });
  const frame = evaluateView(view, {
    time: 0,
    width: 200,
    height: 200,
    measureText: measure,
    inspection: true,
  });

  const frameNode = frame.tree;
  assert.deepEqual(frameNode.offeredSize, { width: 200, height: 200 });
  assert.deepEqual(frameNode.allocatedSlot, { x: 0, y: 0, width: 200, height: 200 });

  const leafBox = frameNode.children[0];
  assert.deepEqual(leafBox.offeredSize, { width: 100, height: 60 });
  assert.deepEqual(leafBox.allocatedSlot, { x: 0, y: 0, width: 100, height: 60 });
  // Leaf bounds overflow both axes
  assert.equal(leafBox.bounds.width, 150);
  assert.equal(leafBox.bounds.height, 90);
  assert.equal(leafBox.bounds.width > leafBox.allocatedSlot.width, true);
  assert.equal(leafBox.bounds.height > leafBox.allocatedSlot.height, true);
});

test("G3.3: multi-level padding per level on both axes updates offeredSize and allocatedSlot accurately", () => {
  // Outer padding: top 10, right 20, bottom 30, left 40 (horizontal insets 60, vertical insets 40)
  // Inner padding: top 5, right 5, bottom 15, left 15 (horizontal insets 20, vertical insets 20)
  // Content: Box 50x40 inside Frame 200x200 with align: "start"
  const view = Box({ width: 50, height: 40 })
    .padding({ top: 5, right: 5, bottom: 15, left: 15 })
    .padding({ top: 10, right: 20, bottom: 30, left: 40 })
    .frame({ width: 200, height: 200, align: "start" });

  const frame = evaluateView(view, {
    time: 0,
    width: 300,
    height: 300,
    measureText: measure,
    inspection: true,
  });

  const frameNode = frame.tree;
  assert.deepEqual(frameNode.offeredSize, { width: 300, height: 300 });

  // Outer padding
  const outerPad = frameNode.children[0];
  assert.deepEqual(outerPad.offeredSize, { width: 200, height: 200 });
  assert.deepEqual(outerPad.allocatedSlot, { x: 0, y: 0, width: 200, height: 200 });

  // Inner padding: proposal shrunk by left 40, right 20 -> 140; top 10, bottom 30 -> 160
  const innerPad = outerPad.children[0];
  assert.deepEqual(innerPad.offeredSize, { width: 140, height: 160 });
  assert.deepEqual(innerPad.allocatedSlot, { x: 40, y: 10, width: 140, height: 160 });

  // Leaf box: proposal shrunk further by left 15, right 5 -> 120; top 5, bottom 15 -> 140
  const leafBox = innerPad.children[0];
  assert.deepEqual(leafBox.offeredSize, { width: 120, height: 140 });
  assert.deepEqual(leafBox.allocatedSlot, { x: 55, y: 15, width: 120, height: 140 });
  assert.deepEqual(leafBox.bounds, { x: 55, y: 15, width: 50, height: 40 });
});

test("G3.3: padding inside flex vs flex inside padding (both orders) record identical slot budgets", () => {
  // Order A: padding inside flex
  const orderA = HStack([
    Box({ width: 20, height: 20 }).padding(10).flex(1),
  ], { gap: 0 });
  const frameA = evaluateView(orderA, {
    time: 0,
    width: 100,
    height: 50,
    measureText: measure,
    inspection: true,
  });

  const flexA = frameA.tree.children[0];
  assert.deepEqual(flexA.offeredSize, { width: 100, height: 50 });
  assert.deepEqual(flexA.allocatedSlot, { x: 0, y: 0, width: 100, height: 40 });

  const padA = flexA.children[0];
  assert.deepEqual(padA.offeredSize, { width: 100, height: 50 });
  assert.deepEqual(padA.allocatedSlot, { x: 0, y: 0, width: 100, height: 40 });

  const boxA = padA.children[0];
  assert.deepEqual(boxA.offeredSize, { width: 80, height: 30 });
  assert.deepEqual(boxA.allocatedSlot, { x: 10, y: 10, width: 80, height: 20 });

  // Order B: flex inside padding
  const orderB = HStack([
    Box({ width: 20, height: 20 }).flex(1).padding(10),
  ], { gap: 0 });
  const frameB = evaluateView(orderB, {
    time: 0,
    width: 100,
    height: 50,
    measureText: measure,
    inspection: true,
  });

  const padB = frameB.tree.children[0];
  assert.deepEqual(padB.offeredSize, { width: 100, height: 50 });
  assert.deepEqual(padB.allocatedSlot, { x: 0, y: 0, width: 100, height: 40 });

  const flexB = padB.children[0];
  assert.deepEqual(flexB.offeredSize, { width: 80, height: 30 });
  assert.deepEqual(flexB.allocatedSlot, { x: 10, y: 10, width: 80, height: 20 });

  const boxB = flexB.children[0];
  assert.deepEqual(boxB.offeredSize, { width: 80, height: 30 });
  assert.deepEqual(boxB.allocatedSlot, { x: 10, y: 10, width: 80, height: 20 });
});

test("G3.3: Stage inspection opt-in via StageOptions and prepareFrame publishes offeredSize/allocatedSlot", async () => {
  await withStageEnvironment(async () => {
    const { setup, render } = stageMockContext();

    // Test 1: Stage with default options and normal prepareFrame -> no offeredSize / allocatedSlot
    const defaultStage = Stage(() => Box({ width: 50, height: 30 }));
    try {
      await defaultStage.setup(setup);
      await defaultStage.prepareFrame!({ time: 0, localTime: 0, progress: 0 });
      defaultStage.render(render);
      const inspected = defaultStage.inspect();
      assert.ok(inspected);
      assert.equal(inspected.tree.offeredSize, undefined);
      assert.equal(inspected.tree.allocatedSlot, undefined);
    } finally {
      defaultStage.dispose();
    }

    // Test 2: Stage with StageOptions.inspection = true -> publishes metadata
    const optedStage = Stage(() => Box({ width: 50, height: 30 }), { inspection: true });
    try {
      await optedStage.setup(setup);
      await optedStage.prepareFrame!({ time: 0, localTime: 0, progress: 0 });
      optedStage.render(render);
      const inspected = optedStage.inspect();
      assert.ok(inspected);
      assert.deepEqual(inspected.tree.offeredSize, { width: 320, height: 240 });
      assert.deepEqual(inspected.tree.allocatedSlot, { x: 0, y: 0, width: 320, height: 240 });
    } finally {
      optedStage.dispose();
    }

    // Test 3: Stage with timing.inspection = true in prepareFrame -> publishes metadata
    const perFrameStage = Stage(() => Box({ width: 50, height: 30 }));
    try {
      await perFrameStage.setup(setup);
      await perFrameStage.prepareFrame!({ time: 0, localTime: 0, progress: 0, inspection: true });
      perFrameStage.render({ ...render, inspection: true });
      const inspected = perFrameStage.inspect();
      assert.ok(inspected);
      assert.deepEqual(inspected.tree.offeredSize, { width: 320, height: 240 });
      assert.deepEqual(inspected.tree.allocatedSlot, { x: 0, y: 0, width: 320, height: 240 });
    } finally {
      perFrameStage.dispose();
    }
  });
});

test("G3.3: nested Composition world and overlay propagate inspection opt-in", () => {
  const view = Composition(
    World(() => Box({ width: 100, height: 80 }), { size: [400, 300] }),
    {
      size: [200, 150],
      overlay: () => Box({ width: 60, height: 40 }),
    },
  );

  const frame = evaluateView(view, {
    time: 0,
    width: 200,
    height: 150,
    measureText: measure,
    inspection: true,
  });

  const worldNode = frame.tree.children.find((c) => c.space?.endsWith("world"));
  assert.ok(worldNode, "world tree must be present");
  assert.deepEqual(worldNode.offeredSize, { width: 400, height: 300 });
  assert.deepEqual(worldNode.allocatedSlot, { x: 0, y: 0, width: 400, height: 300 });

  const overlayNode = frame.tree.children.find((c) => c.space?.endsWith("overlay"));
  assert.ok(overlayNode, "overlay tree must be present");
  assert.deepEqual(overlayNode.offeredSize, { width: 200, height: 150 });
  assert.deepEqual(overlayNode.allocatedSlot, { x: 0, y: 0, width: 200, height: 150 });
});

test("G3.3: clip content carries a clip-local space while its geometry and paints stay put", () => {
  // Second column: the clip sits at a nonzero parent-space origin, its content at (0, 0).
  const view = HStack([
    Box({ width: 30, height: 20 }),
    Box({ width: 40, height: 30 }).clip().id("window"),
  ], { gap: 0 });
  const options = { time: 0, width: 200, height: 100, measureText: measure };
  const inspected = evaluateView(view, { ...options, inspection: true });
  const baseline = evaluateView(view, options);

  // Paint geometry is unchanged; only the tree identity gains the clip-local space.
  const flat = (list: readonly DrawCommand[]): unknown[] =>
    list.flatMap((command) => [
      [command.kind, command.path, command.bounds, command.transform],
      ...("frame" in command && command.frame
        ? flat(command.frame.commands)
        : []),
    ]);
  assert.deepEqual(
    flat(inspected.commands),
    flat(baseline.commands),
    "clip space must not move paints",
  );

  const clipNode = inspected.tree.children[1];
  assert.equal(clipNode.space, undefined, "the clip itself stays in the parent space");
  assert.deepEqual(clipNode.bounds, { x: 30, y: 0, width: 40, height: 30 });
  assert.deepEqual(clipNode.allocatedSlot, { x: 30, y: 0, width: 40, height: 30 });

  const content = clipNode.children[0];
  assert.equal(content.space, "root/window/clip");
  assert.deepEqual(content.bounds, { x: 0, y: 0, width: 40, height: 30 });
  // The slot is in the same space as the node's own bounds.
  assert.deepEqual(content.allocatedSlot, { x: 0, y: 0, width: 40, height: 30 });

  const surface = inspected.commands.find((entry) => entry.kind === "composition");
  assert.ok(surface && surface.kind === "composition");
  assert.deepEqual(
    surface.frame.tree,
    content,
    "the painted frame and the layout tree share the stamped child",
  );
});

test("G3.3: nested clips get distinct encoded clip-local spaces that plain descendants inherit", () => {
  const view = Box({ width: 10, height: 10 })
    .id("dot")
    .frame({ width: 30, height: 30 })
    .clip()
    .id("inner/slot%1")
    .frame({ width: 50, height: 50 })
    .clip()
    .id("outer/slot%2");
  const frame = evaluateView(view, {
    time: 0,
    width: 200,
    height: 200,
    measureText: measure,
  });

  const outerContent = frame.tree.children[0];
  assert.equal(outerContent.space, "outer%2Fslot%252/clip");

  const innerClip = outerContent.children[0];
  assert.equal(innerClip.id, "inner/slot%1");
  assert.equal(
    innerClip.space,
    "outer%2Fslot%252/clip",
    "the outer clip space is inherited, not replaced",
  );

  const innerContent = innerClip.children[0];
  assert.equal(innerContent.space, "outer%2Fslot%252/frame/inner%2Fslot%251/clip");
  assert.notEqual(innerContent.space, outerContent.space);

  const dot = innerContent.children[0];
  assert.equal(dot.id, "dot");
  assert.equal(dot.space, innerContent.space, "plain descendants inherit the inner clip space");
  assert.deepEqual(dot.bounds, { x: 10, y: 10, width: 10, height: 10 });
  assert.equal(innerContent.space, dot.space);
});

test("G3.3: compositions inside a clip keep their own world and overlay spaces", () => {
  const view = Composition(
    World(() => Box({ width: 20, height: 20 }).clip().id("clipInWorld"), {
      size: [100, 80],
    }),
    { size: [100, 80], overlay: () => Box({ width: 10, height: 10 }) },
  ).clip();
  const options = { time: 0, width: 100, height: 80, measureText: measure };
  const frame = evaluateView(view, options);
  const again = evaluateView(view, options);

  const composition = frame.tree.children[0];
  assert.equal(composition.space, "root/clip");
  const world = composition.children.find((child) => child.space?.endsWith("/world"));
  const overlay = composition.children.find((child) => child.space?.endsWith("/overlay"));
  assert.ok(world && overlay);
  assert.equal(world.space, "root/composition/world");
  assert.equal(overlay.space, "root/composition/overlay");

  // The clip inside the world adds its own segment instead of overwriting the world space.
  assert.equal(world.children[0].space, "root/composition/world/clipInWorld/clip");

  const spacesOf = (root: { space?: string; children: readonly any[] }) => {
    const found: (string | undefined)[] = [];
    const walk = (node: { space?: string; children: readonly any[] }) => {
      found.push(node.space);
      node.children.forEach(walk);
    };
    walk(root);
    return found;
  };
  assert.deepEqual(spacesOf(again.tree), spacesOf(frame.tree), "clip spaces stay stable");
});

test("G3.3: flex slots inside a clip stay correct on both axes and default off stays clean", () => {
  const horizontal = HStack([
    Box({ width: 20, height: 10 }).flex(1),
    Box({ width: 20, height: 10 }).flex(2),
  ], { gap: 0 }).frame({ width: 90, height: 40, align: "start" }).clip();
  const frameH = evaluateView(horizontal, {
    time: 0,
    width: 200,
    height: 200,
    measureText: measure,
    inspection: true,
  });
  const stackH = frameH.tree.children[0].children[0];
  const [hFlex1, hFlex2] = stackH.children;
  assert.equal(hFlex1.space, "root/clip");
  assert.deepEqual(hFlex1.offeredSize, { width: 30, height: 40 });
  assert.deepEqual(hFlex1.allocatedSlot, { x: 0, y: 0, width: 30, height: 10 });
  assert.deepEqual(hFlex2.offeredSize, { width: 60, height: 40 });
  assert.deepEqual(hFlex2.allocatedSlot, { x: 30, y: 0, width: 60, height: 10 });

  const vertical = VStack([
    Box({ width: 10, height: 20 }).flex(1),
    Box({ width: 10, height: 20 }).flex(2),
  ], { gap: 0 }).frame({ width: 40, height: 90, align: "start" }).clip();
  const frameV = evaluateView(vertical, {
    time: 0,
    width: 200,
    height: 200,
    measureText: measure,
    inspection: true,
  });
  const stackV = frameV.tree.children[0].children[0];
  const [vFlex1, vFlex2] = stackV.children;
  assert.deepEqual(vFlex1.offeredSize, { width: 40, height: 30 });
  assert.deepEqual(vFlex1.allocatedSlot, { x: 0, y: 0, width: 10, height: 30 });
  assert.deepEqual(vFlex2.offeredSize, { width: 40, height: 60 });
  assert.deepEqual(vFlex2.allocatedSlot, { x: 0, y: 30, width: 10, height: 60 });

  // Inspection off: no opt-in metadata anywhere, while the clip space still stamps identity.
  const plain = evaluateView(horizontal, {
    time: 0,
    width: 200,
    height: 200,
    measureText: measure,
  });
  const assertNoMetadata = (node: {
    offeredSize?: unknown;
    allocatedSlot?: unknown;
    children: readonly any[];
  }) => {
    assert.equal("offeredSize" in node, false);
    assert.equal("allocatedSlot" in node, false);
    node.children.forEach(assertNoMetadata);
  };
  assertNoMetadata(plain.tree);
  assert.equal(plain.tree.children[0].space, "root/clip");
});

test("G3.3: inspection report serializes offeredSize and allocatedSlot through safe whitelist and rejects non-finite", () => {
  const view = HStack([
    Box({ width: 40, height: 30 }).id("fixed"),
    Box({ width: 40, height: 30 }).flex(1).id("flexCard"),
  ], { gap: 0 });

  const frame = evaluateView(view, {
    time: 0,
    width: 200,
    height: 100,
    measureText: measure,
    inspection: true,
  });

  const doc = buildInspectionDocument({
    packageVersion: "0.0.0",
    project: { name: "Test", duration: 1, resolution: [200, 100] },
    frame: {
      requestedTime: 0,
      effectiveTime: 0,
      scenes: [{
        id: "main",
        name: "Main",
        time: 0,
        localTime: 0,
        progress: 0,
        frame: {
          tree: frame.tree,
          commands: frame.commands,
          warnings: frame.warnings,
        },
      }],
    } satisfies FrameInspection,
  });

  const json = serializeInspection(doc);
  const parsed = JSON.parse(json);
  const rootNode = parsed.scenes[0].tree;

  assert.deepEqual(rootNode.offeredSize, { width: 200, height: 100 });
  assert.deepEqual(rootNode.allocatedSlot, { x: 0, y: 0, width: 200, height: 100 });

  const flexNode = rootNode.children[1];
  assert.deepEqual(flexNode.offeredSize, { width: 160, height: 100 });
  assert.deepEqual(flexNode.allocatedSlot, { x: 40, y: 0, width: 160, height: 30 });

  // Non-finite offeredSize or allocatedSlot must be rejected by safe serializer
  const badFrame = {
    tree: {
      path: "root",
      kind: "box",
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      transform: [1, 0, 0, 1],
      children: [],
      offeredSize: { width: Infinity, height: 10 },
    },
    commands: [],
    warnings: [],
  };
  assert.throws(
    () => buildInspectionDocument({
      packageVersion: "0.0.0",
      project: { name: "Test", duration: 1, resolution: [200, 100] },
      frame: {
        requestedTime: 0,
        effectiveTime: 0,
        scenes: [{
          id: "main",
          name: "Main",
          time: 0,
          localTime: 0,
          progress: 0,
          frame: badFrame,
        }],
      } satisfies FrameInspection,
    }),
    InspectionSerializationError,
  );
});

/** Every final `(space, path)` pair with its occurrence count, so a diagnostic can be matched. */
function treeIdentities(
  root: { space?: string; path: string; children: readonly any[] },
): Map<string, number> {
  const found = new Map<string, number>();
  const walk = (node: { space?: string; path: string; children: readonly any[] }) => {
    const key = `${node.space ?? "layout"}|${node.path}`;
    found.set(key, (found.get(key) ?? 0) + 1);
    node.children.forEach(walk);
  };
  walk(root);
  return found;
}

test("G3.3: a diagnostic inside a clip keeps the clip-local space of the node it describes", () => {
  // Fixed columns wider than the clip's own box: both the clip and its content overflow.
  const view = HStack([
    Box({ width: 30, height: 20 }),
    HStack([
      Box({ width: 300, height: 20 }).id("wide"),
      Box({ width: 50, height: 20 }).id("narrow"),
    ], { gap: 10 }).id("row").clip().id("window"),
  ], { gap: 0 });
  const frame = evaluateView(view, {
    time: 0,
    width: 200,
    height: 100,
    measureText: measure,
  });
  const diagnostics = frame.diagnostics ?? [];
  assert.ok(diagnostics.length >= 3, "clip overflow must be diagnosable");

  const identities = treeIdentities(frame.tree);
  for (const entry of diagnostics) {
    const key = `${entry.space}|${entry.path}`;
    assert.equal(
      identities.get(key),
      1,
      `${key} must resolve to exactly one final node`,
    );
  }
  // The clip itself stays in the parent space; its content joins `${clip space}/clip`.
  const clipNode = frame.tree.children[1];
  assert.equal(clipNode.space, undefined);
  assert.ok(
    diagnostics.some(
      (entry) => entry.space === "layout" && entry.path === "root/window",
    ),
    "the clip's own overflow is reported in the parent space",
  );
  const contentSpace = "root/window/clip";
  assert.ok(
    diagnostics.some(
      (entry) =>
        entry.space === contentSpace &&
        entry.path === "root/window/row/wide",
    ),
    "overflow of the clip's content is reported in the clip-local space",
  );
  assert.ok(
    diagnostics.some(
      (entry) => entry.space === contentSpace && entry.path === "root/window/row",
    ),
    "the clip's child keeps its own diagnostic in the same space",
  );
});

test("G3.3: nested clip and Composition spaces stay single-prefixed on diagnostics", () => {
  const overflowing = (id: string) =>
    HStack([
      Box({ width: 300, height: 20 }),
      Box({ width: 50, height: 20 }),
    ], { gap: 10 }).clip().id(id).frame({ width: 60, height: 60 });
  const nested = Composition(
    World(() => overflowing("inWorldNested/slot%1"), { size: [40, 40] }),
    { size: [40, 40] },
  );
  const view = Composition(
    World(
      () =>
        nested
          .frame({ width: 60, height: 60 })
          .clip()
          .id("world/composition%1"),
      { size: [100, 80] },
    ),
    {
      size: [100, 80],
      overlay: () => overflowing("inOverlay/slot%2"),
    },
  )
    .clip()
    .id("outer/slot%3");

  const frame = evaluateView(view, {
    time: 0,
    width: 200,
    height: 200,
    measureText: measure,
  });
  const diagnostics = frame.diagnostics ?? [];
  assert.ok(diagnostics.length > 0, "the fixture must author diagnostics");

  const identities = treeIdentities(frame.tree);
  for (const entry of diagnostics) {
    const key = `${entry.space}|${entry.path}`;
    assert.equal(
      identities.get(key),
      1,
      `${key} must resolve to exactly one final node`,
    );
    assert.notEqual(entry.space, "layout", "nothing claims the outer frame space");
    assert.equal(
      entry.space.split("outer%2Fslot%253").length - 1,
      1,
      `the outer clip segment must appear once in ${entry.space}`,
    );
    assert.equal(
      entry.space.split("/").includes("inWorldNested"),
      false,
      "authored IDs with `/` stay encoded, never a second space separator",
    );
  }

  const world = "outer%2Fslot%253/composition/world";
  const nestedWorld = `${world}/world%2Fcomposition%251/frame/composition/world`;
  assert.ok(
    diagnostics.some((entry) => entry.space === nestedWorld),
    "a Composition inside the clip keeps its own world space exactly once",
  );
  assert.ok(
    diagnostics.some((entry) => entry.space === `${world}/world%2Fcomposition%251/frame/composition/world/root/inWorldNested%2Fslot%251/clip`),
    "the nested clip appends its encoded segment to that world space",
  );
  const overlay = "outer%2Fslot%253/composition/overlay";
  assert.ok(
    diagnostics.some(
      (entry) =>
        entry.space === `${overlay}/root/inOverlay%2Fslot%252/clip`,
    ),
    "a clip inside the overlay composition keeps the overlay prefix",
  );
});
/** G3.4a: run one fixture with inspection on, the only helper these tests share. */
const inspected = (view: ViewNode, extra: Record<string, unknown> = {}) =>
  evaluateView(view, {
    time: 0,
    width: 200,
    height: 100,
    measureText: measure,
    inspection: true,
    ...extra,
  });
/** `contentBounds` of each authored path, or `"absent"` when the node has none. */
const contentAt = (root: any, ...paths: string[]): unknown[] => {
  const found = new Map<string, any>();
  const walk = (node: any) => {
    if (paths.includes(node.path) && !found.has(node.path))
      found.set(node.path, node);
    node.children.forEach(walk);
  };
  walk(root);
  return paths.map((path) =>
    "contentBounds" in found.get(path)!
      ? found.get(path).contentBounds
      : "absent",
  );
};
const rect = (x: number, y: number, width: number, height: number) => ({
  x,
  y,
  width,
  height,
});

test("G3.4a: a padding/background wrapper aggregates the box, never the background paint", () => {
  const card = inspected(
    Box({ width: 20, height: 10 }).padding(5).background({ fill: "#000" }),
  );
  const only = rect(5, 5, 20, 10);
  assert.deepEqual(card.tree.contentBounds, only);
  assert.deepEqual(contentAt(card.tree, "root/padding", "root/padding/box"), [
    only,
    only,
  ]);
  // Role and paint of the background wrapper are untouched.
  const bg = card.commands.find((c) => c.paintRole === "background");
  assert.deepEqual(bg?.bounds, rect(0, 0, 30, 20));
  assert.deepEqual(card.tree.offeredSize, { width: 200, height: 100 });
});

test("G3.4a: an HStack unions children in layout space, so an offset never reflows it", () => {
  const row = inspected(
    HStack(
      [
        Box({ width: 20, height: 10 }),
        Box({ width: 10, height: 10 }).offset(7, 3),
      ],
      { gap: 5 },
    ),
  );
  assert.deepEqual(row.tree.contentBounds, rect(0, 0, 35, 10));
  assert.deepEqual(contentAt(row.tree, "root/offset[1]/box"), [
    rect(25, 0, 10, 10),
  ]);
});

test("G3.4a: a Group aggregates children in parent coordinates, not its surface paint extent", () => {
  const group = inspected(Group([Box({ width: 20, height: 10 })]).padding(5));
  const only = rect(5, 5, 20, 10);
  assert.deepEqual(group.tree.contentBounds, only);
  assert.deepEqual(contentAt(group.tree, "root/group", "root/group/box[0]"), [
    only,
    only,
  ]);
});

test("G3.4a: Clip content stays clip-local and nothing aggregates across that boundary", () => {
  const clip = inspected(Box({ width: 20, height: 10 }).clip().padding(5));
  assert.deepEqual(contentAt(clip.tree, "root/clip/box"), [rect(0, 0, 20, 10)]);
  assert.deepEqual(contentAt(clip.tree, "root", "root/clip"), [
    "absent",
    "absent",
  ]);
});

test("G3.4a: Composition world and overlay publish only their own scoped content bounds", () => {
  const frame = inspected(
    Composition(
      World(() => Box({ width: 20, height: 10 }), { size: [40, 20] }),
      {
        size: [40, 20],
        overlay: () => Box({ width: 10, height: 5 }),
      },
    ),
  );
  const [world, overlay] = frame.tree.children;
  assert.deepEqual(
    [world.space, world.contentBounds, overlay.space, overlay.contentBounds],
    ["root/world", rect(0, 0, 20, 10), "root/overlay", rect(0, 0, 10, 5)],
  );
  assert.equal(
    "contentBounds" in frame.tree,
    false,
    "no union across the two spaces",
  );
});

test("G3.4a: Text reports the measured line box, not glyph ink", () => {
  assert.deepEqual(
    inspected(Text("ab", { size: 10, lineHeight: 12 })).tree.contentBounds,
    rect(0, 0, 20, 12),
  );
});

test("G3.4a: stroke does not expand content and zero-area content is kept, not absent", () => {
  const stroke = Box({ width: 20, height: 10, stroke: "#000", strokeWidth: 4 });
  assert.deepEqual(inspected(stroke).tree.contentBounds, rect(0, 0, 20, 10));
  const zero = Box({ width: 0, height: 0 });
  assert.deepEqual(inspected(zero).tree.contentBounds, rect(0, 0, 0, 0));
});

test("G3.4a: Spacer, opacity zero, and unpainted shapes or inactive video emit no content", () => {
  // Opacity zero is not visibility, so the box behind it keeps its rectangle.
  const faded = Box({ width: 20, height: 10 })
    .background({ fill: "#000" })
    .opacity(0);
  const stack = inspected(VStack([Spacer(), faded]));
  assert.deepEqual(contentAt(stack.tree, "root/spacer[0]"), ["absent"]);
  assert.deepEqual(contentAt(stack.tree, "root/opacity[1]"), [
    rect(0, 90, 20, 10),
  ]);

  const unpainted = inspected(
    VStack([
      Circle({ radius: 0 }),
      Line({ from: [0, 0], to: [0, 0] }),
      Video(
        { id: "v", name: "v", url: "/v.mp4", start: 0, duration: 1 },
        { width: 40, height: 20 },
      ),
    ]),
    { time: 5 },
  );
  assert.equal(unpainted.commands.length, 0, "the fixture emitted no paint");
  assert.equal("contentBounds" in unpainted.tree, false);
});

test("G3.4a: inspection off allocates nothing and leaves every paint unchanged", () => {
  const view = Composition(
    World(
      () =>
        HStack([
          Box({ width: 20, height: 10 }).background({ fill: "#000" }),
          Box({ width: 10, height: 10 }).offset(7, 3),
        ]),
      { size: [60, 30] },
    ),
    {
      size: [60, 30],
      overlay: () => Group([Box({ width: 5, height: 5 })]).clip(),
    },
  );
  const plain = inspected(view, { inspection: false });
  const assertAbsent = (node: any): void => {
    assert.equal("contentBounds" in node, false);
    node.children.forEach(assertAbsent);
  };
  assertAbsent(plain.tree);
  const flat = (list: readonly DrawCommand[]): unknown[] =>
    list.flatMap((command) => [
      [command.kind, command.path, command.bounds, command.transform],
      ...("frame" in command && command.frame
        ? flat(command.frame.commands)
        : []),
      ...("overlay" in command && command.overlay
        ? flat(command.overlay.commands)
        : []),
    ]);
  assert.deepEqual(flat(inspected(view).commands), flat(plain.commands));
});

test("G3.4a: the report whitelists contentBounds on both tree paths and rejects malformed bounds", () => {
  const frame = inspected(
    HStack([
      Box({ width: 40, height: 30 }).id("fixed"),
      Box({ width: 20, height: 10 }).padding(5).id("card"),
    ]),
  );
  const build = (tree: unknown, target?: { scope: string; id: string }) =>
    buildInspectionDocument({
      packageVersion: "0.0.0",
      project: { name: "Test", duration: 1, resolution: [200, 100] },
      frame: {
        requestedTime: 0,
        effectiveTime: 0,
        scenes: [
          {
            id: "main",
            name: "Main",
            time: 0,
            localTime: 0,
            progress: 0,
            frame: { tree, commands: frame.commands, warnings: [] } as never,
          },
        ],
      } satisfies FrameInspection,
      ...(target ? { target } : {}),
    });
  const full = JSON.parse(serializeInspection(build(frame.tree)));
  assert.deepEqual(full.capability.geometry, {
    layout: "exact-rectangle",
    paint: "partial",
  });
  const card = full.scenes[0].tree.children[1];
  assert.deepEqual(card.contentBounds, rect(45, 10, 20, 10));
  assert.deepEqual(card.children[0].contentBounds, card.contentBounds);
  // The targeted path rebuilds ancestors, so their rectangle needs that second writer too.
  const targeted = JSON.parse(
    serializeInspection(build(frame.tree, { scope: "scene:main", id: "card" })),
  );
  assert.deepEqual(
    targeted.scenes[0].tree.contentBounds,
    full.scenes[0].tree.contentBounds,
  );
  assert.deepEqual(
    targeted.scenes[0].tree.children[0].contentBounds,
    card.contentBounds,
  );
  // A foreign key never reaches the report; contentBounds is whitelisted exactly as given.
  const dropped = JSON.parse(
    serializeInspection(
      build({
        ...frame.tree,
        foreignKey: "leak",
        contentBounds: rect(1, 2, 3, 4),
      }),
    ),
  );
  assert.equal("foreignKey" in dropped.scenes[0].tree, false);
  assert.deepEqual(dropped.scenes[0].tree.contentBounds, rect(1, 2, 3, 4));
  for (const bad of [
    rect(NaN, 0, 1, 1),
    { x: 0, y: 0, width: 1 },
    { x: 0, y: "1", width: 1, height: 1 },
    null,
  ])
    assert.throws(
      () => build({ ...frame.tree, contentBounds: bad }),
      InspectionSerializationError,
      `contentBounds ${JSON.stringify(bad)} must be rejected`,
    );
});

/** G3.4b: every command of a whole root evaluation, nested frames and overlays included. */
const allCommands = (list: readonly DrawCommand[]): DrawCommand[] =>
  list.flatMap((command) => [
    command,
    ...("frame" in command && command.frame
      ? allCommands(command.frame.commands)
      : []),
    ...("overlay" in command && command.overlay
      ? allCommands(command.overlay.commands)
      : []),
  ]);

/**
 * Every *logical* node of a root evaluation. A Group/Clip surface command references the same
 * tree the parent holds, and a Clip's scoped copy re-creates nodes at the clip-local origin, so
 * one logical node is reachable through several views. Those views are deduplicated by
 * `inspectionId` (by object identity when inspection is off) and must agree on path and kind — a
 * different node under the same ID would fail here, not be silently collapsed. `space` is *not*
 * compared: a Composition rebase re-stamps it on the same logical node.
 */
const allNodes = (frame: EvaluatedFrame): LayoutNode[] => {
  const byIdentity = new Map<unknown, LayoutNode>();
  const walk = (node: LayoutNode): void => {
    const key: unknown = node.inspectionId ?? node;
    const known = byIdentity.get(key);
    if (known) {
      assert.equal(known.path, node.path, `${node.path} keeps its path`);
      assert.equal(known.kind, node.kind, `${node.path} keeps its kind`);
      return;
    }
    byIdentity.set(key, node);
    node.children.forEach(walk);
  };
  walk(frame.tree);
  for (const command of allCommands(frame.commands))
    for (const nested of ["frame", "overlay"] as const) {
      const inner = (
        command as { frame?: EvaluatedFrame; overlay?: EvaluatedFrame }
      )[nested];
      if (inner) walk(inner.tree);
    }
  return [...byIdentity.values()];
};

/** Command and node IDs of one root evaluation, which share one counter. */
const allIdentityIds = (frame: EvaluatedFrame): number[] => [
  ...allCommands(frame.commands).map((command) => command.inspection!.id),
  ...allNodes(frame).map((node) => node.inspectionId!),
];

/** The role a node's own emissions must carry, derived from its kind alone. */
const expectedRole = (kind: string): "content" | "background" | "surface" =>
  kind === "group" || kind === "clip" || kind === "composition"
    ? "surface"
    : kind === "background"
      ? "background"
      : "content";

/** Command-only opt-in metadata: nothing else may differ between inspection off and on. */
const commandInspectionKeys = new Set(["inspection"]);
/** Tree metadata: the new identity plus the pre-existing layout metadata from G3.3/G3.4a. */
const treeInspectionKeys = new Set([
  "inspection",
  "inspectionId",
  "offeredSize",
  "allocatedSlot",
  "contentBounds",
]);
const withoutInspectionMetadata = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutInspectionMetadata);
  if (value === null || typeof value !== "object") return value;
  // A layout node is the only shape that carries `children`; a command never does.
  const keys = Array.isArray((value as { children?: unknown }).children)
    ? treeInspectionKeys
    : commandInspectionKeys;
  const stripped: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value))
    if (!keys.has(key)) stripped[key] = withoutInspectionMetadata(entry);
  return stripped;
};

/** One fixture that reaches every identity site: leaf paint pairs, background, Group, Clip,
 * Composition world/overlay, and a nested Composition. */
const identityFixture = (): ViewNode =>
  Composition(
    World(
      () =>
        VStack([
          Circle({
            radius: 8,
            fill: "#000",
            stroke: "#fff",
            strokeWidth: 2,
          }).id("dot"),
          Box({ width: 20, height: 10 })
            .background({ fill: "#111" })
            .id("card"),
          Group([Box({ width: 6, height: 6 }).id("chip")])
            .clip()
            .id("window"),
          Composition(
            World(() => Text("hi", { size: 10 }), { size: [30, 20] }),
            { size: [30, 20] },
          ).id("nested"),
        ]),
      { size: [100, 100] },
    ),
    {
      size: [100, 100],
      overlay: () => Box({ width: 4, height: 4 }).id("badge"),
    },
  );

test("G3.4b: two paints of one circle share the owner node but get distinct command IDs", () => {
  const frame = inspected(
    Circle({ radius: 10, fill: "#000", stroke: "#fff", strokeWidth: 2 }).id(
      "dot",
    ),
  );
  assert.equal(frame.commands.length, 2, "fill and stroke are two commands");
  const [fill, stroke] = frame.commands;
  assert.equal(fill.path, stroke.path, "both paints sit on the same path");
  assert.notEqual(fill.inspection!.id, stroke.inspection!.id);
  assert.equal(fill.inspection!.nodeId, stroke.inspection!.nodeId);
  assert.equal(fill.inspection!.nodeId, frame.tree.inspectionId);
  assert.deepEqual(
    [fill.inspection!.role, stroke.inspection!.role],
    ["content", "content"],
  );
});

test("G3.4b: a background wrapper owns its own paint and the content stays with the leaf", () => {
  const frame = inspected(
    Box({ width: 20, height: 10 }).background({ fill: "#000" }).id("card"),
  );
  const [background, content] = frame.commands;
  assert.equal(background.paintRole, "background");
  assert.equal(background.inspection!.role, "background");
  assert.equal(background.inspection!.nodeId, frame.tree.inspectionId);
  assert.equal(content.inspection!.role, "content");
  assert.equal(content.inspection!.nodeId, frame.tree.children[0].inspectionId);
  assert.notEqual(background.inspection!.nodeId, content.inspection!.nodeId);
});

test("G3.4b: Group and Clip own the surface command they emit, and so does their child", () => {
  const frame = inspected(
    Group([Box({ width: 20, height: 10 }).id("leaf")])
      .clip()
      .id("window"),
  );
  const [clipSurface] = frame.commands;
  assert.equal(clipSurface.kind, "composition");
  assert.equal(clipSurface.inspection!.role, "surface");
  assert.equal(clipSurface.inspection!.nodeId, frame.tree.inspectionId);

  const [groupSurface] = clipSurface.frame!.commands;
  assert.equal(groupSurface.kind, "group");
  assert.equal(groupSurface.inspection!.role, "surface");
  assert.equal(
    groupSurface.inspection!.nodeId,
    frame.tree.children[0].inspectionId,
  );

  const [leafContent] = groupSurface.frame!.commands;
  assert.equal(leafContent.inspection!.role, "content");
  assert.equal(
    leafContent.inspection!.nodeId,
    frame.tree.children[0].children[0].inspectionId,
  );
});

test("G3.4b: Composition world and overlay reuse one counter, and each scope keeps its owner", () => {
  const frame = inspected(
    Composition(
      World(
        () =>
          Box({ width: 20, height: 10 })
            .background({ fill: "#000" })
            .id("world"),
        { size: [40, 20] },
      ),
      {
        size: [40, 20],
        overlay: () => Box({ width: 10, height: 5 }).id("overlay"),
      },
    ),
  );
  const [surface] = frame.commands;
  assert.equal(surface.inspection!.role, "surface");
  assert.equal(surface.inspection!.nodeId, frame.tree.inspectionId);

  const [worldBackground, worldContent] = surface.frame!.commands;
  assert.deepEqual(
    [worldBackground.inspection!.role, worldContent.inspection!.role],
    ["background", "content"],
  );
  assert.equal(
    worldBackground.inspection!.nodeId,
    surface.frame!.tree.inspectionId,
  );
  assert.equal(
    worldContent.inspection!.nodeId,
    surface.frame!.tree.children[0].inspectionId,
  );

  const [overlayContent] = surface.overlay!.commands;
  assert.equal(overlayContent.inspection!.role, "content");
  assert.equal(
    overlayContent.inspection!.nodeId,
    surface.overlay!.tree.inspectionId,
  );

  const ids = allIdentityIds(frame);
  assert.equal(new Set(ids).size, ids.length, "one counter, no shared IDs");
});

test("G3.4b: a nested Composition keeps counting from the same root evaluation", () => {
  const inner = Composition(
    World(() => Box({ width: 10, height: 5 }).id("inner"), { size: [20, 20] }),
    { size: [20, 20] },
  );
  const frame = inspected(
    Composition(
      World(() => VStack([inner, Group([Box({ width: 4, height: 4 })])]), {
        size: [40, 40],
      }),
      { size: [40, 40] },
    ),
  );
  const [outerSurface] = frame.commands;
  const [innerSurface, groupSurface] = outerSurface.frame!.commands;
  assert.equal(innerSurface.kind, "composition");
  assert.equal(innerSurface.inspection!.role, "surface");
  assert.equal(groupSurface.kind, "group");

  const worldTree = outerSurface.frame!.tree;
  assert.equal(
    innerSurface.inspection!.nodeId,
    worldTree.children[0].inspectionId,
  );
  assert.equal(
    innerSurface.frame!.tree.inspectionId,
    worldTree.children[0].children[0].inspectionId,
    "the nested world keeps its own root node ID",
  );

  const ids = allIdentityIds(frame);
  assert.equal(
    new Set(ids).size,
    ids.length,
    "nested scopes draw from the same counter",
  );
});

test("G3.4b: IDs are scoped to one root evaluation, never promised across frames", () => {
  const view = identityFixture();
  const first = inspected(view);
  const second = inspected(view);
  const identities = (frame: EvaluatedFrame) => [
    allCommands(frame.commands).map((command) => command.inspection),
    allNodes(frame).map((node) => node.inspectionId),
  ];
  assert.deepEqual(identities(first), identities(second));
  // Two evaluations restart the counter, so the same numbers come back.
  assert.equal(first.tree.inspectionId, second.tree.inspectionId);
  // The counter is owned by the root evaluation, never by a caller-supplied object.
  const callerCounter = { next: 100 };
  const injected = inspected(view, { inspectionCounter: callerCounter });
  assert.equal(callerCounter.next, 100, "the public options drive no counter");
  assert.equal(
    injected.tree.inspectionId,
    first.tree.inspectionId,
    "each root restarts its own numbering",
  );
  assert.deepEqual(identities(injected), identities(first));
});

test("G3.4b: a tree reachable from a surface keeps its node IDs instead of renumbering", () => {
  const frame = inspected(Group([Box({ width: 20, height: 10 })]).id("g"));
  const [surface] = frame.commands;
  assert.equal(
    surface.frame!.tree,
    frame.tree,
    "the surface references the same tree object",
  );
  // The surface view and the tree it is reachable from are one logical node: two views,
  // one identity, so the shared counter never renumbers the copy.
  assert.equal(allNodes(frame).filter((node) => node === frame.tree).length, 1);
  assert.equal(
    allNodes(frame).length,
    2,
    "the Group and its Box are the only two logical nodes",
  );
});

test("G3.4b: every command is owned directly by the node of its own path with a matching role", () => {
  const frame = inspected(identityFixture());
  const nodes = allNodes(frame);
  const roles = new Set<string>();
  for (const command of allCommands(frame.commands)) {
    const identity = command.inspection!;
    const owners = nodes.filter(
      (node) => node.inspectionId === identity.nodeId,
    );
    assert.equal(
      owners.length,
      1,
      `${command.path} must have exactly one owning node`,
    );
    assert.equal(
      command.path,
      owners[0].path,
      `${command.path} is owned at emission, not inferred from the path`,
    );
    assert.equal(
      identity.role,
      expectedRole(owners[0].kind),
      `${command.path} role must match its owner's kind`,
    );
    roles.add(identity.role);
  }
  assert.deepEqual([...roles].sort(), ["background", "content", "surface"]);
  const ids = allIdentityIds(frame);
  assert.equal(new Set(ids).size, ids.length);
});

test("G3.4b: inspection off allocates no identity or role and changes no command field", () => {
  const view = identityFixture();
  const plain = inspected(view, { inspection: false });
  const on = inspected(view);

  for (const node of allNodes(plain))
    assert.equal(
      "inspectionId" in node,
      false,
      `${node.path} keeps no identity`,
    );
  for (const command of allCommands(plain.commands))
    assert.equal(
      "inspection" in command,
      false,
      `${command.path} keeps no role`,
    );

  // Every other field — kind, path, bounds, transform, opacity, sharedId, matchId,
  // correctionIds, masks, resources, uniforms and command order — must be identical.
  assert.deepEqual(
    withoutInspectionMetadata(on.commands),
    withoutInspectionMetadata(plain.commands),
  );
  assert.deepEqual(
    withoutInspectionMetadata(on.tree),
    withoutInspectionMetadata(plain.tree),
  );
});

test("G3.4b: the report publishes valid node and command identity and drops foreign fields", () => {
  const frame = inspected(identityFixture());
  const leakedTree = { ...frame.tree };
  Object.defineProperty(leakedTree, "foreignKey", {
    enumerable: true,
    get: () => {
      throw new Error("foreign tree field was read");
    },
  });
  const leakedCommands = frame.commands.map((command, index) => {
    if (index !== 0) return command;
    const leaked = { ...command };
    Object.defineProperty(leaked, "foreignKey", {
      enumerable: true,
      get: () => {
        throw new Error("foreign command field was read");
      },
    });
    return leaked;
  });
  const documentFor = (sceneFrame: unknown) =>
    buildInspectionDocument({
      packageVersion: "0.0.0",
      project: { name: "Test", duration: 1, resolution: [200, 100] },
      frame: {
        requestedTime: 0,
        effectiveTime: 0,
        scenes: [
          {
            id: "main",
            name: "Main",
            time: 0,
            localTime: 0,
            progress: 0,
            frame: sceneFrame as never,
          },
        ],
      } satisfies FrameInspection,
    });
  const published = JSON.parse(
    serializeInspection(
      documentFor({ ...frame, tree: leakedTree, commands: leakedCommands }),
    ),
  ) as {
    scenes: {
      tree: {
        inspectionId?: number;
        children: unknown[];
      };
      commands: {
        inspection?: { id: number; nodeId: number; role: string };
      }[];
    }[];
  };
  const walk = (
    source: { inspectionId?: number; children: readonly unknown[] },
    node: { inspectionId?: number; children: unknown[] },
  ) => {
    assert.equal(node.inspectionId, source.inspectionId);
    assert.equal(typeof node.inspectionId, "number");
    assert.equal("foreignKey" in node, false);
    assert.equal(node.children.length, source.children.length);
    source.children.forEach((child, index) =>
      walk(
        child as { inspectionId?: number; children: readonly unknown[] },
        node.children[index] as {
          inspectionId?: number;
          children: unknown[];
        },
      ),
    );
  };
  walk(frame.tree, published.scenes[0].tree);
  assert.ok(published.scenes[0].commands.length > 0);
  published.scenes[0].commands.forEach((command, index) => {
    assert.deepEqual(command.inspection, frame.commands[index].inspection);
    assert.equal(typeof command.inspection?.id, "number");
    assert.equal(typeof command.inspection?.nodeId, "number");
    assert.ok(
      command.inspection?.role === "content" ||
        command.inspection?.role === "background" ||
        command.inspection?.role === "surface",
    );
    assert.equal("foreignKey" in command, false);
  });
  assert.equal(
    serializeInspection(
      documentFor({ ...frame, tree: leakedTree, commands: leakedCommands }),
    ).includes("foreignKey"),
    false,
  );

  const off = serializeInspection(
    documentFor(inspected(identityFixture(), { inspection: false })),
  );
  for (const key of ["inspectionId", "nodeId", '"role"'])
    assert.equal(
      off.includes(key),
      false,
      `${key} stays out when inspection is off`,
    );
});
