/**
 * G3b-1 cut/crossfade/shared, plus G3b-2 slide/zoom/wipe recorded-leaf projection.
 * Custom stays unavailable. This is not completed G3.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Renderer } from "../src/engine/render/renderer";
import type { FrameInspection, TransitionDraw } from "../src/engine/render/renderer";
import {
  TransitionRenderer,
  transitionUniform,
} from "../src/engine/render/transition";
import {
  InspectionBudget,
  InspectionSerializationError,
  applyInspectionTarget,
  buildInspectionDocument,
  measureInspection,
} from "../src/engine/inspect/report";
import type { Project, Scene } from "../src/engine/types";

const project = {
  name: "Projection fixture",
  duration: 4,
  resolution: [100, 100] as const,
};
const output = [100, 100] as const;

function node(id: string, inspectionId: number, path = "root") {
  return {
    path,
    kind: "box",
    id,
    inspectionId,
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    transform: [1, 0, 0, 1],
    children: [] as unknown[],
  };
}

function paint(
  bounds: { x: number; y: number; width: number; height: number },
  patch: Record<string, unknown> = {},
) {
  return {
    kind: "box",
    path: "root",
    paintRole: "content",
    space: "scene-target-pixels",
    resolution: [100, 100],
    accuracy: "exact-rectangle",
    bounds,
    provenance: "projected-box-draw-quad",
    geometryVisible: true,
    inspection: { id: 1, nodeId: 1, role: "content" },
    ...patch,
  };
}

function layer(
  id: string,
  records?: readonly unknown[],
  tree = node("card", 1),
) {
  return {
    id,
    name: id.toUpperCase(),
    time: 1,
    localTime: 0.25,
    progress: 0.25,
    frame: {
      tree,
      commands: [],
      warnings: [],
      ...(records === undefined ? {} : { paintRecords: records }),
    },
  };
}

function frame(
  scenes: FrameInspection["scenes"],
  draw?: TransitionDraw,
  overlay?: FrameInspection["overlay"],
): FrameInspection {
  return {
    requestedTime: 1,
    effectiveTime: 1,
    scenes,
    ...(overlay === undefined ? {} : { overlay }),
    ...(draw === undefined ? {} : { transitionDraw: draw }),
  };
}

function build(source: FrameInspection, target?: { scope: string; id: string }) {
  return buildInspectionDocument({
    packageVersion: "0.0.0-test",
    project,
    frame: source,
    ...(target === undefined ? {} : { target }),
  });
}

function weights(source: FrameInspection) {
  return build(source).scenes.map((scene) => ({
    id: scene.id,
    weight: scene.finalPaintRecords?.map((record) => record.sceneWeight),
    bounds: scene.finalPaintRecords?.map((record) =>
      record.accuracy === "unavailable" ? undefined : record.bounds,
    ),
    visible: scene.finalPaintRecords?.map((record) =>
      record.accuracy === "unavailable" ? false : record.geometryVisible,
    ),
    status: scene.finalProjection.status,
  }));
}

test("direct cut clips identity to the output viewport with weight 1", () => {
  const inside = paint({ x: 10, y: 20, width: 30, height: 40 });
  const crossing = paint(
    { x: 90, y: 90, width: 20, height: 20 },
    { inspection: { id: 2, nodeId: 1, role: "content" } },
  );
  const built = build(
    frame([layer("main", [inside, crossing])], {
      kind: "direct",
      output,
    }),
  );
  assert.equal(built.capability.transitions.projection, "partial");
  assert.match(built.capability.transitions.reason, /not full visibility/);
  assert.match(built.capability.transitions.reason, /G3 is not complete/);
  assert.doesNotMatch(built.capability.transitions.reason, /G3 is complete/);
  const [kept, clipped] = built.scenes[0].finalPaintRecords!;
  assert.equal(kept.space, "output-pixels");
  assert.deepEqual(kept.resolution, [100, 100]);
  assert.equal(kept.sceneWeight, 1);
  assert.deepEqual(kept.accuracy === "unavailable" ? undefined : kept.bounds, {
    x: 10,
    y: 20,
    width: 30,
    height: 40,
  });
  assert.equal(kept.accuracy, "exact-rectangle");
  assert.equal(kept.provenance, "projected-box-draw-quad");
  assert.deepEqual(
    clipped.accuracy === "unavailable" ? undefined : clipped.bounds,
    { x: 90, y: 90, width: 10, height: 10 },
  );
  assert.equal(clipped.geometryVisible, true);
  assert.equal(built.scenes[0].paintRecords?.[0].space, "scene-target-pixels");
});

test("crossfade weights follow the uploaded float32, including a nonrepresentable progress", () => {
  const uploaded = transitionUniform({
    type: "crossfade",
    duration: 1,
    progress: 0.1,
  });
  const draw: TransitionDraw = {
    kind: "crossfade",
    output,
    uniform: [uploaded[0], uploaded[1], uploaded[2], uploaded[3]],
    outgoingId: "a",
    incomingId: "b",
  };
  assert.notEqual(draw.uniform[0], 0.1);
  assert.equal(draw.uniform[1], 0);
  const built = build(
    frame(
      [
        layer("a", [paint({ x: 1, y: 2, width: 3, height: 4 })]),
        layer("b", [paint({ x: 5, y: 6, width: 7, height: 8 })]),
      ],
      draw,
    ),
  );
  const [outgoing, incoming] = built.scenes;
  assert.equal(outgoing.finalPaintRecords?.[0].sceneWeight, Math.fround(1 - uploaded[0]));
  assert.equal(incoming.finalPaintRecords?.[0].sceneWeight, uploaded[0]);
  assert.notEqual(incoming.finalPaintRecords?.[0].sceneWeight, 0.1);
  assert.deepEqual(
    outgoing.finalPaintRecords?.[0].accuracy === "unavailable"
      ? undefined
      : outgoing.finalPaintRecords?.[0].bounds,
    { x: 1, y: 2, width: 3, height: 4 },
  );
  const quarter = transitionUniform({
    type: "crossfade",
    duration: 1,
    progress: 0.25,
  });
  const at = (progress: number) =>
    weights(
      frame(
        [
          layer("a", [paint({ x: 10, y: 20, width: 30, height: 40 })]),
          layer("b", [paint({ x: 10, y: 20, width: 30, height: 40 })]),
        ],
        {
          kind: "crossfade",
          output,
          uniform: [Math.fround(progress), quarter[1], quarter[2], quarter[3]],
          outgoingId: "a",
          incomingId: "b",
        },
      ),
    );
  assert.deepEqual(
    at(0.25).map((scene) => scene.weight),
    [[0.75], [0.25]],
  );
  const ends = at(0);
  assert.deepEqual(ends[0].visible, [true]);
  assert.deepEqual(ends[1].visible, [false]);
  assert.deepEqual(ends[1].weight, [0]);
  const full = at(1);
  assert.deepEqual(full[0].visible, [false]);
  assert.deepEqual(full[1].visible, [true]);
  const tiny = Math.fround(1e-7);
  const kept = at(tiny);
  assert.equal(kept[1].weight?.[0], tiny);
  assert.notEqual(kept[1].weight?.[0], 0);
  assert.deepEqual(kept[1].visible, [true]);
});

test("shared kind 0 reuses corrected leaf bounds and does not project them again", () => {
  const corrected = { x: 12, y: 8, width: 5, height: 5 };
  const uploaded = transitionUniform({
    type: "shared",
    duration: 1,
    progress: 0.25,
  });
  assert.equal(uploaded[1], 0);
  const draw: TransitionDraw = {
    kind: "shared",
    output,
    uniform: [uploaded[0], uploaded[1], uploaded[2], uploaded[3]],
    outgoingId: "a",
    incomingId: "b",
  };
  const built = build(
    frame(
      [
        layer("a", [paint(corrected)]),
        layer("b", [paint(corrected)]),
      ],
      draw,
    ),
  );
  assert.equal(built.scenes[0].finalPaintRecords?.[0].sceneWeight, 0.75);
  assert.equal(built.scenes[1].finalPaintRecords?.[0].sceneWeight, 0.25);
  for (const scene of built.scenes)
    assert.deepEqual(
      scene.finalPaintRecords?.[0].accuracy === "unavailable"
        ? undefined
        : scene.finalPaintRecords?.[0].bounds,
      corrected,
    );
});

test("crossfade and shared stay unavailable unless the uploaded kind is the identity branch", () => {
  for (const kind of ["crossfade", "shared"] as const) {
    const uploaded = transitionUniform({ type: kind, duration: 1, progress: 0.25 });
    assert.equal(uploaded[1], 0);
    for (const control of [1, 2, 3]) {
      const source = frame(
        [
          layer("a", [paint({ x: 1, y: 1, width: 2, height: 2 })]),
          layer("outsider", [paint({ x: 5, y: 5, width: 2, height: 2 })]),
          layer("b", [paint({ x: 3, y: 3, width: 2, height: 2 })]),
        ],
        {
          kind,
          output,
          uniform: [0.25, control, -1, 0],
          outgoingId: "a",
          incomingId: "b",
        },
        overlayLayer(),
      );
      const built = build(source);
      for (const scene of built.scenes.filter((entry) => entry.scope !== "overlay")) {
        assert.equal(scene.finalProjection.status, "unavailable", `${kind} ${control} ${scene.id}`);
        assert.equal("finalPaintRecords" in scene, false, `${kind} ${control} ${scene.id}`);
        assert.equal(scene.paintRecords?.length, 1);
        if (scene.finalProjection.status === "unavailable")
          assert.match(scene.finalProjection.reason, /branch/);
      }
      const overlay = built.scenes.find((scene) => scene.scope === "overlay")!;
      assert.equal(overlay.finalProjection.status, "available");
      assert.equal(overlay.finalPaintRecords?.[0].sceneWeight, 1);
      assert.deepEqual(
        overlay.finalPaintRecords?.[0].accuracy === "unavailable"
          ? undefined
          : overlay.finalPaintRecords?.[0].bounds,
        { x: 0, y: 0, width: 8, height: 8 },
      );
      const sceneRoute = sameTargetRoutes(source, { scope: "scene:a", id: "card" });
      assert.equal(sceneRoute.applied.capability.transitions.projection, "unavailable");
      assert.equal("finalPaintRecords" in sceneRoute.applied.scenes[0], false);
      assert.equal(sceneRoute.applied.scenes[0].paintRecords?.length, 1);
      const overlayRoute = sameTargetRoutes(source, { scope: "overlay", id: "hud" });
      assert.equal(overlayRoute.applied.capability.transitions.projection, "partial");
      assert.equal(overlayRoute.applied.scenes[0].finalPaintRecords?.[0].sceneWeight, 1);
      assert.deepEqual(overlayRoute.applied.capability, overlayRoute.built.capability);
      assert.deepEqual(overlayRoute.applied.target, overlayRoute.built.target);
    }
  }
});

test("custom keeps pre-transition records and does not publish final geometry", () => {
  let shaderReads = 0;
  const raw = paint({ x: 1, y: 1, width: 2, height: 2 });
  Object.defineProperty(raw, "shader", {
    enumerable: true,
    get() {
      shaderReads++;
      throw Error("shader was read");
    },
  });
  const draw = Object.defineProperty(
    {
      kind: "custom" as const,
      output,
      uniform: [0.25, 0, -1, 0] as const,
    },
    "shader",
    {
      enumerable: true,
      get() {
        shaderReads++;
        throw Error("draw shader was read");
      },
    },
  );
  const built = build(frame([layer("main", [raw])], draw as TransitionDraw));
  assert.equal(shaderReads, 0);
  assert.equal(built.scenes[0].paintRecords?.length, 1);
  assert.equal("finalPaintRecords" in built.scenes[0], false);
  assert.equal(built.scenes[0].finalProjection.status, "unavailable");
  if (built.scenes[0].finalProjection.status === "unavailable")
    assert.match(built.scenes[0].finalProjection.reason, /Custom transition/);
  assert.equal(built.capability.transitions.projection, "unavailable");
  assert.equal(JSON.stringify(built).includes("shader"), false);
  for (const kind of ["slide", "zoom", "wipe"] as const) {
    const missing = build(
      frame([layer("main", [paint({ x: 1, y: 1, width: 2, height: 2 })])], {
        kind,
        output,
        uniform: [0.25, 1, -1, 0],
      } as TransitionDraw),
    );
    assert.equal(missing.scenes[0].finalProjection.status, "unavailable");
    if (missing.scenes[0].finalProjection.status === "unavailable")
      assert.match(missing.scenes[0].finalProjection.reason, /endpoint/);
    assert.equal("finalPaintRecords" in missing.scenes[0], false);
    assert.equal(missing.scenes[0].paintRecords?.length, 1);
  }
});

test("project overlay is identity on the project clock and ignores the scene mix", () => {
  const draw: TransitionDraw = {
    kind: "crossfade",
    output,
    uniform: [0.25, 0, -1, 0],
    outgoingId: "a",
    incomingId: "b",
  };
  const built = build(
    frame(
      [layer("a", [paint({ x: 1, y: 1, width: 4, height: 4 })])],
      draw,
      {
        time: 1.5,
        localTime: 1.5,
        progress: 1.5 / 4,
        frame: {
          tree: node("hud", 7, "hud"),
          commands: [],
          warnings: [],
          paintRecords: [
            paint(
              { x: 0, y: 0, width: 8, height: 8 },
              { inspection: { id: 7, nodeId: 7, role: "content" }, path: "hud" },
            ),
          ],
        },
      },
    ),
  );
  const overlay = built.scenes.find((scene) => scene.scope === "overlay")!;
  assert.deepEqual(overlay.clock, {
    time: 1.5,
    localTime: 1.5,
    progress: 1.5 / 4,
  });
  assert.equal(overlay.finalPaintRecords?.[0].sceneWeight, 1);
  assert.notEqual(overlay.finalPaintRecords?.[0].sceneWeight, 0.25);
  assert.equal(overlay.finalProjection.status, "available");
  const absent = build(
    frame([layer("a")], draw, {
      time: 1.5,
      localTime: 1.5,
      progress: 0.375,
      frame: { tree: node("hud", 7, "hud"), commands: [], warnings: [] },
    }),
  ).scenes.find((scene) => scene.scope === "overlay")!;
  assert.equal("paintRecords" in absent, false);
  assert.equal("finalPaintRecords" in absent, false);
  assert.notEqual(absent.finalPaintRecords, []);
  const empty = build(
    frame([layer("a", [])], { kind: "direct", output }),
  ).scenes[0];
  assert.deepEqual(empty.paintRecords, []);
  assert.deepEqual(empty.finalPaintRecords, []);
});

test("raw scenes, hidden leaves, conservative clips, and non-finite controls stay out of JSON", () => {
  const raw = build(
    frame(
      [
        {
          id: "raw",
          name: "RAW",
          time: 1,
          localTime: 1,
          progress: 1,
          unavailable: "RAW does not implement the optional inspect() capability.",
        },
      ],
      { kind: "direct", output },
    ),
  );
  assert.equal(raw.scenes[0].inspection, "unavailable");
  assert.equal(raw.scenes[0].finalProjection.status, "unavailable");
  assert.equal("finalPaintRecords" in raw.scenes[0], false);
  assert.equal(raw.capability.transitions.projection, "unavailable");

  const hidden = paint(
    { x: 10, y: 10, width: 10, height: 10 },
    { geometryVisible: false },
  );
  const outside = paint({ x: 120, y: 120, width: 5, height: 5 });
  const conservative = paint(
    { x: 90, y: 0, width: 20, height: 4 },
    { accuracy: "conservative" },
  );
  const visible = build(
    frame([layer("main", [hidden, outside, conservative])], {
      kind: "direct",
      output,
    }),
  ).scenes[0].finalPaintRecords!;
  assert.equal(visible[0].geometryVisible, false);
  assert.equal(visible[1].geometryVisible, false);
  assert.equal(visible[1].accuracy === "unavailable" ? -1 : visible[1].bounds.width, 0);
  assert.equal(visible[2].accuracy, "conservative");
  assert.deepEqual(
    visible[2].accuracy === "unavailable" ? undefined : visible[2].bounds,
    { x: 90, y: 0, width: 10, height: 4 },
  );

  const nonFinite = build(
    frame([layer("main", [paint({ x: 1, y: 1, width: 1, height: 1 })])], {
      kind: "crossfade",
      output,
      uniform: [Number.NaN, 0, -1, 0],
      outgoingId: "main",
      incomingId: "other",
    }),
  );
  assert.equal(nonFinite.scenes[0].paintRecords?.length, 1);
  assert.equal(nonFinite.scenes[0].finalProjection.status, "unavailable");
  assert.equal(JSON.stringify(nonFinite).includes("NaN"), false);
  assert.throws(
    () =>
      build(
        frame([
          layer("main", [
            paint({ x: Number.NaN, y: 0, width: 1, height: 1 }),
          ]),
        ]),
      ),
    (error: unknown) => error instanceof InspectionSerializationError,
  );
});

test("finite inputs that overflow float32 stay unavailable instead of a null sceneWeight", () => {
  assert.equal(Number.isFinite(1e100), true);
  assert.equal(Number.isFinite(Math.fround(1e100)), false);
  assert.equal(Number.isFinite(Math.fround(-1e100)), false);
  for (const kind of ["crossfade", "shared"] as const) {
    for (const slot of [0, 1, 2, 3]) {
      for (const magnitude of [1e100, -1e100]) {
        const uniform = [0.25, 0, -1, 0];
        uniform[slot] = magnitude;
        const built = build(
          frame(
            [
              layer("a", [paint({ x: 1, y: 1, width: 2, height: 2 })]),
              layer("b", [
                paint(
                  { x: 3, y: 3, width: 2, height: 2 },
                  { inspection: { id: 2, nodeId: 2, role: "content" } },
                ),
              ]),
            ],
            {
              kind,
              output,
              uniform: [uniform[0], uniform[1], uniform[2], uniform[3]],
              outgoingId: "a",
              incomingId: "b",
            },
          ),
        );
        assert.equal(built.scenes[0].finalProjection.status, "unavailable");
        assert.equal("finalPaintRecords" in built.scenes[0], false);
        assert.equal("finalPaintRecords" in built.scenes[1], false);
        const json = JSON.stringify(built);
        assert.equal(json.includes("Infinity"), false);
        assert.equal(json.includes("NaN"), false);
        assert.equal(json.includes('"sceneWeight":null'), false);
        if (built.scenes[0].finalProjection.status === "unavailable")
          assert.match(built.scenes[0].finalProjection.reason, /not finite/);
      }
    }
  }
  const finite = build(
    frame(
      [
        layer("a", [paint({ x: 1, y: 1, width: 2, height: 2 })]),
        layer("b", [paint({ x: 3, y: 3, width: 2, height: 2 })]),
      ],
      {
        kind: "crossfade",
        output,
        uniform: [1e20, 0, -1, 0],
        outgoingId: "a",
        incomingId: "b",
      },
    ),
  );
  assert.equal(
    finite.scenes[1].finalPaintRecords?.[0].sceneWeight,
    Math.fround(1e20),
  );
  assert.equal(
    Number.isFinite(finite.scenes[1].finalPaintRecords?.[0].sceneWeight),
    true,
  );
});

function overlayLayer() {
  return {
    time: 1.5,
    localTime: 1.5,
    progress: 1.5 / 4,
    frame: {
      tree: node("hud", 7, "hud"),
      commands: [],
      warnings: [],
      paintRecords: [
        paint(
          { x: 0, y: 0, width: 8, height: 8 },
          { inspection: { id: 7, nodeId: 7, role: "content" }, path: "hud" },
        ),
      ],
    },
  };
}

function sameTargetRoutes(
  source: FrameInspection,
  target: { scope: string; id: string },
) {
  const full = build(source);
  const built = build(source, target);
  const applied = applyInspectionTarget(full, target);
  assert.deepEqual(applied.capability, built.capability);
  assert.deepEqual(applied.scenes, built.scenes);
  assert.deepEqual(applied.target, built.target);
  assert.equal(applied.scenes.length, 1);
  assert.equal(applied.scenes[0].scope, target.scope);
  assert.equal(applyInspectionTarget(full, undefined), full);
  return { full, built, applied };
}

test("target routes share capability from retained scenes, not the full report", () => {
  const custom = frame(
    [layer("main", [paint({ x: 1, y: 1, width: 2, height: 2 })])],
    { kind: "custom", output, uniform: [0.25, 0, -1, 0] },
    overlayLayer(),
  );
  const customScene = sameTargetRoutes(custom, {
    scope: "scene:main",
    id: "card",
  });
  assert.equal(customScene.full.capability.transitions.projection, "partial");
  assert.equal(
    customScene.applied.capability.transitions.projection,
    "unavailable",
  );
  assert.equal(
    JSON.stringify(customScene.applied).includes('"scope":"overlay"'),
    false,
  );
  const customOverlay = sameTargetRoutes(custom, {
    scope: "overlay",
    id: "hud",
  });
  assert.equal(
    customOverlay.applied.capability.transitions.projection,
    "partial",
  );
  assert.equal(customOverlay.applied.scenes[0].scope, "overlay");

  const direct = frame(
    [layer("main", [paint({ x: 1, y: 1, width: 2, height: 2 })])],
    { kind: "direct", output },
    overlayLayer(),
  );
  for (const target of [
    { scope: "scene:main", id: "card" },
    { scope: "overlay", id: "hud" },
  ]) {
    const routed = sameTargetRoutes(direct, target);
    assert.equal(routed.full.capability.transitions.projection, "partial");
    assert.equal(routed.applied.capability.transitions.projection, "partial");
  }

  for (const kind of ["crossfade", "shared"] as const) {
    const mixed = frame(
      [
        layer("a", [paint({ x: 1, y: 1, width: 2, height: 2 })]),
        layer("b", [paint({ x: 3, y: 3, width: 2, height: 2 })]),
        layer("c", [paint({ x: 5, y: 5, width: 2, height: 2 })]),
      ],
      {
        kind,
        output,
        uniform: [0.25, 0, -1, 0],
        outgoingId: "a",
        incomingId: "b",
      },
      overlayLayer(),
    );
    const endpoint = sameTargetRoutes(mixed, { scope: "scene:a", id: "card" });
    assert.equal(endpoint.full.capability.transitions.projection, "partial");
    assert.equal(endpoint.applied.capability.transitions.projection, "partial");
    const outsider = sameTargetRoutes(mixed, { scope: "scene:c", id: "card" });
    assert.equal(outsider.full.capability.transitions.projection, "partial");
    assert.equal(
      outsider.applied.capability.transitions.projection,
      "unavailable",
    );
    assert.equal(
      JSON.stringify(outsider.applied).includes('"scope":"overlay"'),
      false,
    );
    assert.equal(
      JSON.stringify(outsider.applied).includes('"scope":"scene:a"'),
      false,
    );
  }
});

test("both target routes filter owners on pre-transition and final records and charge both arrays", () => {
  const tree = {
    path: "root",
    kind: "group",
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    transform: [1, 0, 0, 1],
    children: [
      node("card", 1, "root/card"),
      node("twin", 1, "root/twin"),
      node("other", 2, "root/other"),
    ],
  };
  const kept = paint(
    { x: 1, y: 1, width: 2, height: 2 },
    { path: "root/other", inspection: { id: 2, nodeId: 2, role: "content" } },
  );
  const duplicate = paint(
    { x: 3, y: 3, width: 2, height: 2 },
    { path: "root/card", inspection: { id: 1, nodeId: 1, role: "content" } },
  );
  const orphan = paint(
    { x: 4, y: 4, width: 2, height: 2 },
    { path: "root/missing", inspection: { id: 9, nodeId: 9, role: "content" } },
  );
  let foreign = 0;
  const forbidden = () => {
    foreign++;
    throw Error("foreign field was read");
  };
  Object.defineProperties(kept, {
    shader: { enumerable: true, get: forbidden },
    opacity: { enumerable: true, get: forbidden },
    outline: { enumerable: true, get: forbidden },
  });
  const source = frame(
    [layer("main", [kept, duplicate, orphan], tree)],
    { kind: "direct", output },
  );
  const full = build(source);
  assert.equal(foreign, 0);
  assert.equal(full.scenes[0].paintRecords?.length, 3);
  assert.equal(full.scenes[0].finalPaintRecords?.length, 3);
  const target = { scope: "scene:main", id: "other" };
  const targeted = build(source, target);
  const applied = applyInspectionTarget(full, target);
  assert.deepEqual(
    targeted.scenes[0].finalPaintRecords,
    applied.scenes[0].finalPaintRecords,
  );
  assert.deepEqual(
    targeted.scenes[0].paintRecords?.map((record) => record.inspection?.nodeId),
    [2],
  );
  assert.deepEqual(
    applied.scenes[0].finalPaintRecords?.map((record) => record.inspection?.nodeId),
    [2],
  );
  assert.equal(
    applied.scenes[0].finalPaintRecords?.some((record) => record.inspection?.nodeId === 9),
    false,
  );

  const one = frame([layer("main", [paint({ x: 1, y: 1, width: 2, height: 2 })])], {
    kind: "direct",
    output,
  });
  const plain = frame([layer("main", [paint({ x: 1, y: 1, width: 2, height: 2 })])]);
  const bytes = measureInspection(build(one)) - measureInspection(build(plain));
  const limit = (sourceFrame: FrameInspection) => {
    let low = 0;
    let high = 1 << 20;
    while (low < high) {
      const mid = (low + high) >> 1;
      try {
        buildInspectionDocument({
          packageVersion: "0.0.0-test",
          project,
          frame: sourceFrame,
          limit: mid,
        });
        high = mid;
      } catch {
        low = mid + 1;
      }
    }
    return low;
  };
  assert.equal(limit(one) - limit(plain), bytes);
  assert.throws(
    () =>
      buildInspectionDocument({
        packageVersion: "0.0.0-test",
        project,
        frame: one,
        limit: limit(one) - 1,
      }),
    (error: unknown) => error instanceof InspectionSerializationError,
  );
  const record = paint({ x: 1, y: 1, width: 2, height: 2 });
  const budget = new InspectionBudget();
  const published = build(
    frame([layer("main", [record])], { kind: "direct", output }),
  ).scenes[0].finalPaintRecords![0];
  budget.charge(new TextEncoder().encode(JSON.stringify(published)).length);
  assert.equal(
    budget.bytes,
    new TextEncoder().encode(JSON.stringify(published)).length,
  );
});

function gpuGlobals() {
  const globals = globalThis as typeof globalThis & {
    GPUTextureUsage?: unknown;
    GPUBufferUsage?: unknown;
    GPUShaderStage?: unknown;
  };
  const saved = {
    GPUTextureUsage: Object.getOwnPropertyDescriptor(globalThis, "GPUTextureUsage"),
    GPUBufferUsage: Object.getOwnPropertyDescriptor(globalThis, "GPUBufferUsage"),
    GPUShaderStage: Object.getOwnPropertyDescriptor(globalThis, "GPUShaderStage"),
  };
  globals.GPUTextureUsage = {
    RENDER_ATTACHMENT: 1,
    TEXTURE_BINDING: 2,
    COPY_SRC: 4,
    COPY_DST: 8,
  };
  globals.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  globals.GPUShaderStage = { FRAGMENT: 1 };
  return () => {
    for (const [name, descriptor] of Object.entries(saved))
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
  };
}

function mockDevice(writes: Float32Array[]) {
  return {
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createBuffer: () => ({ destroy() {} }),
    createSampler: () => ({}),
    createShaderModule: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createBindGroup: () => ({}),
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createCommandEncoder: () => ({
      beginRenderPass: () => ({
        setPipeline() {},
        setBindGroup() {},
        draw() {},
        end() {},
      }),
      finish: () => ({}),
    }),
    queue: {
      submit() {},
      writeBuffer(_buffer: unknown, _offset: number, data: Float32Array) {
        writes.push(data);
      },
    },
    destroy() {},
  };
}

test("the submitted frame copies the one uploaded float32 array and does not publish early", () => {
  const restore = gpuGlobals();
  const writes: Float32Array[] = [];
  const device = mockDevice(writes);
  const transition = new TransitionRenderer({
    device: device as unknown as GPUDevice,
    format: "rgba8unorm",
    resolution: [100, 100],
  });
  const seen: string[] = [];
  const scene = (id: string, bounds: { x: number; y: number; width: number; height: number }): Scene => ({
    setup() {},
    render() {
      seen.push(id);
    },
    inspect: () => ({
      tree: node("card", 1),
      commands: [],
      warnings: [],
      paintRecords: [paint(bounds, { path: id })],
    }),
    dispose() {},
  });
  const a = scene("a", { x: 10, y: 20, width: 30, height: 40 });
  const b = scene("b", { x: 4, y: 4, width: 6, height: 6 });
  const projectScenes: Project = {
    name: "upload",
    duration: 3,
    resolution: [100, 100],
    aspectRatio: [1, 1],
    scenes: [
      {
        id: "a",
        name: "A",
        source: "",
        start: 0,
        duration: 2,
        transition: { type: "cut" },
        create: () => a,
      },
      {
        id: "b",
        name: "B",
        source: "",
        start: 1,
        duration: 2,
        transition: { type: "crossfade", duration: 1 },
        create: () => b,
      },
    ],
  };
  const renderer = Object.create(Renderer.prototype) as Renderer;
  let duringSubmit = true;
  Object.assign(renderer, {
    project: projectScenes,
    scenes: new Map<string, Scene>([
      ["a", a],
      ["b", b],
    ]),
    disposed: false,
    configured: false,
    renderGeneration: 0,
    attempt: 0,
    preparationQueue: Promise.resolve(),
    activeFrames: new Set(),
    inspectionEnabled: true,
    device: {
      ...device,
      queue: {
        ...device.queue,
        submit() {
          assert.throws(() => renderer.inspectFrame(), /No successful frame/);
          duringSubmit = false;
        },
      },
    },
    context: { getCurrentTexture: () => ({}) },
    resolution: [100, 100],
    format: "rgba8unorm",
    transition,
  });
  (
    renderer as unknown as { context: { getCurrentTexture: () => { createView: () => object } } }
  ).context = { getCurrentTexture: () => ({ createView: () => ({}) }) };
  try {
    renderer.render(1.1);
    assert.equal(duringSubmit, false);
    assert.equal(writes.length, 1);
    const snapshot = renderer.inspectFrame();
    assert.equal(snapshot.transitionDraw?.kind, "crossfade");
    if (snapshot.transitionDraw?.kind !== "crossfade") return;
    assert.equal(snapshot.transitionDraw.outgoingId, "a");
    assert.equal(snapshot.transitionDraw.incomingId, "b");
    assert.deepEqual(snapshot.transitionDraw.uniform, [
      writes[0][0],
      writes[0][1],
      writes[0][2],
      writes[0][3],
    ]);
    assert.notEqual(snapshot.transitionDraw.uniform, writes[0]);
    assert.equal(writes[0][0], Math.fround(0.1));
    assert.equal(writes[0][1], 0);
    assert.equal("shader" in snapshot.transitionDraw, false);
    const built = build(snapshot);
    assert.equal(built.scenes[1].finalPaintRecords?.[0].sceneWeight, writes[0][0]);
    assert.equal(
      built.scenes[0].finalPaintRecords?.[0].sceneWeight,
      Math.fround(1 - writes[0][0]),
    );
    assert.deepEqual(seen, ["a", "b"]);
    const direct = JSON.stringify(renderer.inspectFrame());
    renderer.render(0.4);
    const cut = JSON.stringify(renderer.inspectFrame());
    assert.equal(renderer.inspectFrame().transitionDraw?.kind, "direct");
    renderer.render(1.1);
    assert.equal(renderer.inspectFrame().transitionDraw?.kind, "crossfade");
    renderer.render(0.4);
    assert.equal(JSON.stringify(renderer.inspectFrame()), cut);
    assert.notEqual(cut, direct);
    (
      renderer as unknown as {
        device: { queue: { submit: () => void } };
      }
    ).device.queue.submit = () => {
      throw Error("queue rejected");
    };
    assert.throws(() => renderer.render(1.1), /queue rejected/);
    assert.throws(() => renderer.inspectFrame(), /No successful frame/);
  } finally {
    transition.dispose();
    restore();
  }
});

test("inspection off does not read the upload or scene inspect, and a stale attempt does not publish", async () => {
  const renderer = Object.create(Renderer.prototype) as Renderer;
  let reads = 0;
  const upload = new Proxy(new Float32Array([0.25, 0, -1, 0]), {
    get() {
      reads++;
      throw Error("inspection off read the upload");
    },
  });
  let inspected = 0;
  const scene: Scene = {
    setup() {},
    render() {},
    inspect: () => {
      inspected++;
      return { tree: node("card", 1), commands: [], warnings: [] };
    },
    dispose() {},
  };
  const cut: Project = {
    name: "off",
    duration: 2,
    resolution: [100, 100],
    aspectRatio: [1, 1],
    scenes: [
      {
        id: "a",
        name: "A",
        source: "",
        start: 0,
        duration: 2,
        transition: { type: "cut" },
        create: () => scene,
      },
    ],
  };
  Object.assign(renderer, {
    project: cut,
    scenes: new Map([["a", scene]]),
    disposed: false,
    configured: false,
    renderGeneration: 0,
    attempt: 0,
    preparationQueue: Promise.resolve(),
    activeFrames: new Set(),
    inspectionEnabled: false,
    device: {
      createCommandEncoder: () => ({
        beginRenderPass: () => ({ end() {} }),
        finish: () => ({}),
      }),
      queue: { submit() {} },
      destroy() {},
    },
    context: { getCurrentTexture: () => ({}) },
    resolution: [100, 100],
    format: "rgba8unorm",
    transition: { render: () => upload, dispose() {} },
  });
  renderer.render(0.5);
  assert.equal(reads, 0);
  assert.equal(inspected, 0);
  assert.throws(() => renderer.inspectFrame(), /inspection is disabled/);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held: Scene = {
    setup() {},
    async prepareFrame() {
      started?.();
      await gate;
    },
    render() {},
    inspect: () => ({
      tree: node("card", 1),
      commands: [],
      warnings: [],
    }),
    dispose() {},
  };
  const overlap: Project = {
    name: "race",
    duration: 3,
    resolution: [100, 100],
    aspectRatio: [1, 1],
    scenes: [
      {
        id: "a",
        name: "A",
        source: "",
        start: 0,
        duration: 2,
        transition: { type: "cut" },
        create: () => held,
      },
      {
        id: "b",
        name: "B",
        source: "",
        start: 1,
        duration: 2,
        transition: { type: "crossfade", duration: 1 },
        create: () => held,
      },
    ],
  };
  const racing = Object.create(Renderer.prototype) as Renderer;
  Object.assign(racing, {
    project: overlap,
    scenes: new Map<string, Scene>([
      ["a", held],
      ["b", held],
    ]),
    disposed: false,
    configured: false,
    renderGeneration: 0,
    attempt: 0,
    preparationQueue: Promise.resolve(),
    activeFrames: new Set(),
    inspectionEnabled: true,
    device: {
      createCommandEncoder: () => ({
        beginRenderPass: () => ({ end() {} }),
        finish: () => ({}),
      }),
      queue: { submit() {} },
      destroy() {},
    },
    context: { getCurrentTexture: () => ({}) },
    resolution: [100, 100],
    format: "rgba8unorm",
    transition: {
      targets: [{ createView: () => ({}) }, { createView: () => ({}) }],
      render(_context: unknown, transition: { progress: number }) {
        return transitionUniform({
          type: "crossfade",
          duration: 1,
          progress: transition.progress,
        });
      },
      dispose() {},
    },
  });
  const older = racing.renderAsync(1.2);
  await waiting;
  const newer = racing.renderAsync(0.4);
  release();
  await older;
  await newer;
  const published = racing.inspectFrame();
  assert.equal(published.requestedTime, 0.4);
  assert.equal(published.transitionDraw?.kind, "direct");
  if (published.transitionDraw?.kind === "crossfade")
    assert.notEqual(published.transitionDraw.uniform[0], Math.fround(0.2));
});

const wide = [100, 80] as const;
const sourceRect = { x: 10, y: 20, width: 30, height: 20 };
const directions = {
  left: [-1, 0],
  right: [1, 0],
  up: [0, -1],
  down: [0, 1],
} as const;

type LeafExpect = {
  weight: number;
  visible: boolean;
  width: number;
  height: number;
  x?: number;
  y?: number;
};

function builtinFrame(
  kind: "slide" | "zoom" | "wipe",
  progress: number,
  dx: number,
  dy: number,
  records: readonly unknown[] = [paint(sourceRect)],
  output: readonly [number, number] = wide,
) {
  const kindIndex = kind === "wipe" ? 1 : kind === "slide" ? 2 : 3;
  return frame(
    [
      layer("b", records),
      layer("outsider", [paint({ x: 1, y: 1, width: 2, height: 2 })]),
      layer("a", records),
    ],
    {
      kind,
      output,
      uniform: [progress, kindIndex, dx, dy],
      outgoingId: "a",
      incomingId: "b",
    },
    overlayLayer(),
  );
}

function leaf(scene: { finalPaintRecords?: readonly { accuracy: string; sceneWeight: number; geometryVisible?: boolean; bounds?: { x: number; y: number; width: number; height: number } }[] }) {
  const record = scene.finalPaintRecords?.[0];
  if (!record || record.accuracy === "unavailable" || !record.bounds) return undefined;
  return {
    weight: record.sceneWeight,
    visible: record.geometryVisible === true,
    x: record.bounds.x,
    y: record.bounds.y,
    width: record.bounds.width,
    height: record.bounds.height,
  };
}

function assertLeaf(
  actual: ReturnType<typeof leaf>,
  expected: LeafExpect,
  label: string,
) {
  assert.ok(actual, label);
  assert.equal(actual.weight, expected.weight, `${label} weight`);
  assert.equal(actual.visible, expected.visible, `${label} visible`);
  assert.equal(actual.width, expected.width, `${label} width`);
  assert.equal(actual.height, expected.height, `${label} height`);
  if (expected.x !== undefined) assert.equal(actual.x, expected.x, `${label} x`);
  if (expected.y !== undefined) assert.equal(actual.y, expected.y, `${label} y`);
}

test("slide, zoom, and wipe project captured endpoints, not scene order", () => {
  const zoomA: Record<string, LeafExpect> = {
    "0": { x: 10, y: 20, width: 30, height: 20, weight: 1, visible: true },
    "0.25": { x: 0, y: 15, width: 37.5, height: 25, weight: 0.75, visible: true },
    "0.5": { x: 0, y: 10, width: 35, height: 30, weight: 0.5, visible: true },
    "0.75": { x: 0, y: 5, width: 32.5, height: 35, weight: 0.25, visible: true },
    "1": { x: 0, y: 0, width: 30, height: 40, weight: 0, visible: false },
  };
  const zoomB: Record<string, LeafExpect> = {
    "0": { x: 30, y: 30, width: 15, height: 10, weight: 0, visible: false },
    "0.25": { x: 25, y: 27.5, width: 18.75, height: 12.5, weight: 0.25, visible: true },
    "0.5": { x: 20, y: 25, width: 22.5, height: 15, weight: 0.5, visible: true },
    "0.75": { x: 15, y: 22.5, width: 26.25, height: 17.5, weight: 0.75, visible: true },
    "1": { x: 10, y: 20, width: 30, height: 20, weight: 1, visible: true },
  };
  const on: LeafExpect = { x: 10, y: 20, width: 30, height: 20, weight: 1, visible: true };
  const off: LeafExpect = { weight: 0, visible: false, width: 0, height: 0 };
  const slide: Record<string, Record<string, { A: LeafExpect; B: LeafExpect }>> = {
    left: {
      "0": { A: on, B: off },
      "0.25": {
        A: { x: 0, y: 20, width: 15, height: 20, weight: 1, visible: true },
        B: { x: 85, y: 20, width: 15, height: 20, weight: 1, visible: true },
      },
      "0.5": { A: off, B: { x: 60, y: 20, width: 30, height: 20, weight: 1, visible: true } },
      "0.75": { A: off, B: { x: 35, y: 20, width: 30, height: 20, weight: 1, visible: true } },
      "1": { A: off, B: on },
    },
    right: {
      "0": { A: on, B: off },
      "0.25": { A: { x: 35, y: 20, width: 30, height: 20, weight: 1, visible: true }, B: off },
      "0.5": { A: { x: 60, y: 20, width: 30, height: 20, weight: 1, visible: true }, B: off },
      "0.75": {
        A: { x: 85, y: 20, width: 15, height: 20, weight: 1, visible: true },
        B: { x: 0, y: 20, width: 15, height: 20, weight: 1, visible: true },
      },
      "1": { A: off, B: on },
    },
    up: {
      "0": { A: on, B: off },
      "0.25": { A: { x: 10, y: 0, width: 30, height: 20, weight: 1, visible: true }, B: off },
      "0.5": { A: off, B: { x: 10, y: 60, width: 30, height: 20, weight: 1, visible: true } },
      "0.75": { A: off, B: { x: 10, y: 40, width: 30, height: 20, weight: 1, visible: true } },
      "1": { A: off, B: on },
    },
    down: {
      "0": { A: on, B: off },
      "0.25": { A: { x: 10, y: 40, width: 30, height: 20, weight: 1, visible: true }, B: off },
      "0.5": { A: { x: 10, y: 60, width: 30, height: 20, weight: 1, visible: true }, B: off },
      "0.75": { A: off, B: { x: 10, y: 0, width: 30, height: 20, weight: 1, visible: true } },
      "1": { A: off, B: on },
    },
  };
  const wipe: Record<string, Record<string, { A: LeafExpect; B: LeafExpect }>> = {
    left: {
      "0": { A: on, B: off },
      "0.25": { A: on, B: off },
      "0.5": { A: on, B: off },
      "0.75": {
        A: { x: 10, y: 20, width: 15, height: 20, weight: 1, visible: true },
        B: { x: 25, y: 20, width: 15, height: 20, weight: 1, visible: true },
      },
      "1": { A: off, B: on },
    },
    right: {
      "0": { A: on, B: off },
      "0.25": {
        A: { x: 25, y: 20, width: 15, height: 20, weight: 1, visible: true },
        B: { x: 10, y: 20, width: 15, height: 20, weight: 1, visible: true },
      },
      "0.5": { A: off, B: on },
      "0.75": { A: off, B: on },
      "1": { A: off, B: on },
    },
    up: {
      "0": { A: on, B: off },
      "0.25": { A: on, B: off },
      "0.5": { A: on, B: off },
      "0.75": { A: off, B: on },
      "1": { A: off, B: on },
    },
    down: {
      "0": { A: on, B: off },
      "0.25": { A: on, B: off },
      "0.5": { A: off, B: on },
      "0.75": { A: off, B: on },
      "1": { A: off, B: on },
    },
  };
  for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
    const zoomed = build(builtinFrame("zoom", progress, 1, 0));
    assert.equal(zoomed.scenes[0].id, "b");
    assert.equal(zoomed.scenes[2].id, "a");
    assertLeaf(leaf(zoomed.scenes[2]), zoomA[String(progress)], `zoom A ${progress}`);
    assertLeaf(leaf(zoomed.scenes[0]), zoomB[String(progress)], `zoom B ${progress}`);
    assert.equal(zoomed.scenes[1].finalProjection.status, "unavailable");
    assert.equal(zoomed.scenes[0].finalPaintRecords?.[0].sceneWeight === progress || progress === 0, true);
    const overlay = zoomed.scenes.find((scene) => scene.scope === "overlay")!;
    assert.equal(overlay.finalPaintRecords?.[0].sceneWeight, 1);
    assert.deepEqual(
      overlay.finalPaintRecords?.[0].accuracy === "unavailable"
        ? undefined
        : overlay.finalPaintRecords?.[0].bounds,
      { x: 0, y: 0, width: 8, height: 8 },
    );
    assert.match(zoomed.capability.transitions.reason, /All built-ins are covered at recorded-leaf level/);
    assert.match(zoomed.capability.transitions.reason, /not the crossfade or zoom mix factor/);
    assert.match(zoomed.capability.transitions.reason, /G3 is not complete/);
    assert.doesNotMatch(zoomed.capability.transitions.reason, /G3 is complete/);
    assert.equal(zoomed.capability.transitions.projection, "partial");
    for (const [name, vector] of Object.entries(directions)) {
      for (const kind of ["slide", "wipe"] as const) {
        const built = build(builtinFrame(kind, progress, vector[0], vector[1]));
        const table = kind === "slide" ? slide : wipe;
        assertLeaf(leaf(built.scenes[2]), table[name][String(progress)].A, `${kind} ${name} A ${progress}`);
        assertLeaf(leaf(built.scenes[0]), table[name][String(progress)].B, `${kind} ${name} B ${progress}`);
        assert.notEqual(built.scenes[2].finalPaintRecords?.[0].sceneWeight, progress === 0 ? 0 : progress);
        if (built.scenes[1].finalProjection.status === "unavailable")
          assert.match(built.scenes[1].finalProjection.reason, /endpoint/);
        assert.equal("finalPaintRecords" in built.scenes[1], false);
      }
    }
  }
  assert.equal(zoomA["0.5"].width, 35);
  assert.notEqual(zoomA["0.5"].width, 45);
  assert.equal(zoomA["0.75"].width, 32.5);
  assert.equal(zoomB["0.75"].width, 26.25);
  const contracted = build(builtinFrame("zoom", 0.75, 1, 0));
  assert.equal(contracted.scenes[2].finalPaintRecords?.[0].accuracy, "exact-rectangle");
  assert.match(contracted.capability.transitions.reason, /ideal projected recorded draw quad/);
  assert.match(contracted.capability.transitions.reason, /exact-rectangle names only that ideal quad/);
  assert.match(contracted.capability.transitions.reason, /Clamp-to-edge sampling can contribute outside/);
  assert.match(contracted.capability.transitions.reason, /do not include that raster coverage/);
  assert.doesNotMatch(contracted.capability.transitions.reason, /not a larger leaf/);
  assert.doesNotMatch(contracted.capability.transitions.reason, /stays exact under these clips/);
  const half = build(builtinFrame("zoom", 0.5, 0, 1));
  assert.equal(
    half.scenes[2].finalPaintRecords?.[0].accuracy === "unavailable"
      ? 0
      : half.scenes[2].finalPaintRecords?.[0].bounds.width,
    35,
  );
  const wiped = build(builtinFrame("wipe", 0, 1, 0));
  assert.equal(leaf(wiped.scenes[0])?.width, 0);
  assert.equal(leaf(build(builtinFrame("zoom", 0, 1, 0)).scenes[0])?.width, 15);
});

test("wipe edges on the cutoff stay zero area and both target routes keep endpoint roles", () => {
  const cutoff = build(
    frame(
      [
        layer("b", [paint({ x: 25, y: 20, width: 10, height: 20 })]),
        layer("a", [paint({ x: 10, y: 20, width: 15, height: 20 })]),
      ],
      {
        kind: "wipe",
        output: wide,
        uniform: [0.25, 1, 1, 0],
        outgoingId: "a",
        incomingId: "b",
      },
    ),
  );
  assertLeaf(leaf(cutoff.scenes[1]), { weight: 0, visible: false, width: 0, height: 0 }, "A has only the threshold line");
  assertLeaf(leaf(cutoff.scenes[0]), { weight: 0, visible: false, width: 0, height: 0 }, "B misses the open edge");
  const vertical = build(builtinFrame("wipe", 0.25, 0.5, 1));
  assertLeaf(leaf(vertical.scenes[2]), { x: 10, y: 20, width: 30, height: 20, weight: 1, visible: true }, "dx 0.5 is vertical");
  assertLeaf(leaf(vertical.scenes[0]), { weight: 0, visible: false, width: 0, height: 0 }, "vertical B empty");
  const outside = build(builtinFrame("wipe", 1.5, 1, 0));
  assertLeaf(leaf(outside.scenes[0]), { x: 10, y: 20, width: 30, height: 20, weight: 1, visible: true }, "p>1 B");
  assertLeaf(leaf(outside.scenes[2]), { weight: 0, visible: false, width: 0, height: 0 }, "p>1 A");
  const negative = build(builtinFrame("wipe", -0.25, 1, 0));
  assertLeaf(leaf(negative.scenes[2]), { x: 10, y: 20, width: 30, height: 20, weight: 1, visible: true }, "p<0 A");
  assertLeaf(leaf(negative.scenes[0]), { weight: 0, visible: false, width: 0, height: 0 }, "p<0 B");
  const sliver = build(
    frame(
      [layer("b", [paint({ x: 1, y: 1, width: 1e-7, height: 1e-7 })])],
      {
        kind: "wipe",
        output: wide,
        uniform: [1, 1, 1, 0],
        outgoingId: "a",
        incomingId: "b",
      },
    ),
  );
  const sliverBounds = sliver.scenes[0].finalPaintRecords?.[0];
  assert.equal(sliverBounds?.geometryVisible, true);
  assert.equal(sliverBounds?.sceneWeight, 1);
  assert.ok(
    sliverBounds?.accuracy !== "unavailable" &&
      sliverBounds.bounds.width > 0 &&
      sliverBounds.bounds.width < 1e-6,
  );
  const routed = sameTargetRoutes(builtinFrame("slide", 0.25, -1, 0), {
    scope: "scene:a",
    id: "card",
  });
  assert.equal(routed.applied.capability.transitions.projection, "partial");
  assert.deepEqual(routed.applied.scenes[0].finalPaintRecords, routed.built.scenes[0].finalPaintRecords);
  const outsider = sameTargetRoutes(builtinFrame("wipe", 0.25, 1, 0), {
    scope: "scene:outsider",
    id: "card",
  });
  assert.equal(outsider.applied.capability.transitions.projection, "unavailable");
  assert.equal(outsider.applied.scenes[0].finalProjection.status, "unavailable");
  const overlay = sameTargetRoutes(builtinFrame("zoom", 0.25, 1, 0), {
    scope: "overlay",
    id: "hud",
  });
  assert.equal(overlay.applied.capability.transitions.projection, "partial");
  assert.equal(overlay.applied.scenes[0].finalPaintRecords?.[0].sceneWeight, 1);
});

test("zoom consumes uploaded float32, and malformed or overflowing controls stay unpublished", () => {
  const imprecise = build(builtinFrame("zoom", 0.1, 1, 0));
  const outgoing = imprecise.scenes.find((scene) => scene.id === "a")!.finalPaintRecords![0];
  const incoming = imprecise.scenes.find((scene) => scene.id === "b")!.finalPaintRecords![0];
  assert.equal(incoming.sceneWeight, Math.fround(0.1));
  assert.notEqual(incoming.sceneWeight, 0.1);
  assert.equal(outgoing.sceneWeight, Math.fround(1 - Math.fround(0.1)));
  assert.deepEqual(outgoing.accuracy === "unavailable" ? undefined : outgoing.bounds, {
    x: 5.999999284744263,
    y: 17.999999523162842,
    width: 33.00000071525574,
    height: 22.000000476837158,
  });
  assert.notEqual(outgoing.accuracy === "unavailable" ? 0 : outgoing.bounds.x, 6);
  assert.deepEqual(incoming.accuracy === "unavailable" ? undefined : incoming.bounds, {
    x: 28.00000011920929,
    y: 29.00000023841858,
    width: 16.50000035762787,
    height: 11.000000238418579,
  });
  const tiny = Math.fround(1e-7);
  assert.equal(build(builtinFrame("zoom", tiny, 0, 1)).scenes.find((scene) => scene.id === "b")!.finalPaintRecords?.[0].sceneWeight, tiny);
  assert.equal(build(builtinFrame("zoom", tiny, 0, 1)).scenes.find((scene) => scene.id === "b")!.finalPaintRecords?.[0].geometryVisible, true);
  const underflow = build(builtinFrame("zoom", 1e-50, 0, 1));
  assert.equal(underflow.scenes.find((scene) => scene.id === "b")!.finalPaintRecords?.[0].sceneWeight, 0);
  assert.equal(underflow.scenes.find((scene) => scene.id === "b")!.finalPaintRecords?.[0].geometryVisible, false);
  for (const kind of ["slide", "zoom", "wipe"] as const) {
    for (const slot of [0, 1, 2, 3]) {
      const uniform = [0.25, kind === "wipe" ? 1 : kind === "slide" ? 2 : 3, 1, 0];
      uniform[slot] = 1e100;
      const built = build(
        frame([layer("a", [paint(sourceRect)]), layer("b", [paint(sourceRect)])], {
          kind,
          output: wide,
          uniform: [uniform[0], uniform[1], uniform[2], uniform[3]],
          outgoingId: "a",
          incomingId: "b",
        }),
      );
      assert.equal(built.scenes[0].finalProjection.status, "unavailable");
      assert.equal("finalPaintRecords" in built.scenes[0], false);
      assert.equal(built.scenes[0].paintRecords?.length, 1);
      const json = JSON.stringify(built);
      assert.equal(json.includes("Infinity"), false);
      assert.equal(json.includes("NaN"), false);
      assert.equal(json.includes('"sceneWeight":null'), false);
    }
  }
  const grown = build(
    frame(
      [layer("a", [paint({ x: 1e308, y: 0, width: 1, height: 1 })])],
      {
        kind: "zoom",
        output: wide,
        uniform: [1, 3, 0, 1],
        outgoingId: "a",
        incomingId: "b",
      },
    ),
  );
  assert.equal(grown.scenes[0].finalProjection.status, "unavailable");
  if (grown.scenes[0].finalProjection.status === "unavailable")
    assert.match(grown.scenes[0].finalProjection.reason, /not finite/);
  assert.equal(grown.scenes[0].paintRecords?.length, 1);
  assert.equal(JSON.stringify(grown).includes("Infinity"), false);
  const shifted = build(
    frame([layer("a", [paint(sourceRect)])], {
      kind: "slide",
      output: [1e308, 80],
      uniform: [1, 2, 1, 0],
      outgoingId: "a",
      incomingId: "b",
    }),
  );
  assert.equal(shifted.scenes[0].finalProjection.status, "unavailable");
  assert.equal(JSON.stringify(shifted).includes("Infinity"), false);
  const flat = build(builtinFrame("wipe", 0.25, 1, 0, [paint(sourceRect)], [0, 80]));
  assert.equal(flat.scenes[2].finalPaintRecords?.[0].geometryVisible, false);
  assert.equal(flat.scenes[2].finalPaintRecords?.[0].sceneWeight, 0);
  assert.equal(JSON.stringify(flat).includes("NaN"), false);
  const mismatched = build(
    frame([layer("a", [paint(sourceRect)])], {
      kind: "slide",
      output: wide,
      uniform: [0.25, 1, -1, 0],
      outgoingId: "a",
      incomingId: "b",
    }, overlayLayer()),
  );
  assert.equal(mismatched.scenes[0].finalProjection.status, "unavailable");
  if (mismatched.scenes[0].finalProjection.status === "unavailable")
    assert.match(mismatched.scenes[0].finalProjection.reason, /branch/);
  assert.equal(mismatched.scenes.find((scene) => scene.scope === "overlay")!.finalPaintRecords?.[0].sceneWeight, 1);
  const diagonal = build(builtinFrame("slide", 0.25, 1, 1));
  assert.equal(diagonal.scenes[2].finalProjection.status, "unavailable");
  if (diagonal.scenes[2].finalProjection.status === "unavailable")
    assert.match(diagonal.scenes[2].finalProjection.reason, /branch/);
  assert.equal("finalPaintRecords" in diagonal.scenes[2], false);
});

test("slide keeps accuracy, hidden leaves, and absent collections distinct from empty ones", () => {
  let shaderReads = 0;
  const hidden = paint(sourceRect, { geometryVisible: false, accuracy: "conservative" });
  const text = paint(sourceRect, {
    kind: "text",
    provenance: "projected-text-draw-quad",
    inspection: { id: 2, nodeId: 2, role: "content" },
  });
  const media = paint(
    { x: 90, y: 70, width: 20, height: 20 },
    {
      kind: "media",
      provenance: "projected-image-draw-quad",
      accuracy: "conservative",
      inspection: { id: 3, nodeId: 3, role: "content" },
    },
  );
  const unavailable = Object.defineProperty(
    {
      kind: "spark",
      path: "root",
      paintRole: "content",
      space: "scene-target-pixels",
      resolution: [100, 80],
      accuracy: "unavailable",
      unsupported: "spark",
      inspection: { id: 4, nodeId: 4, role: "content" },
    },
    "bounds",
    { enumerable: true, get() { shaderReads++; throw Error("bounds"); } },
  );
  const draw = Object.defineProperty(
    {
      kind: "slide" as const,
      output: wide,
      uniform: [0, 2, 1, 0] as const,
      outgoingId: "a",
      incomingId: "b",
    },
    "shader",
    { enumerable: true, get() { shaderReads++; throw Error("shader"); } },
  );
  const built = build(frame([layer("a", [hidden, text, media, unavailable])], draw));
  assert.equal(shaderReads, 0);
  const [keptHidden, keptText, keptMedia, keptMissing] = built.scenes[0].finalPaintRecords!;
  assert.equal(keptHidden.accuracy, "conservative");
  assert.equal(keptHidden.geometryVisible, false);
  assert.equal(keptHidden.sceneWeight, 1);
  assert.equal(keptText.accuracy, "exact-rectangle");
  assert.equal(keptText.provenance, "projected-text-draw-quad");
  assert.equal(keptMedia.accuracy, "conservative");
  assert.equal(keptMedia.provenance, "projected-image-draw-quad");
  assert.equal(
    keptMedia.accuracy === "unavailable" ? -1 : keptMedia.bounds.width,
    10,
  );
  assert.equal(keptMissing.accuracy, "unavailable");
  assert.equal(keptMissing.geometryVisible, false);
  assert.equal(keptMissing.sceneWeight, 0);
  const absent = build(
    frame([layer("a")], {
      kind: "wipe",
      output: wide,
      uniform: [0.5, 1, 1, 0],
      outgoingId: "a",
      incomingId: "b",
    }),
  ).scenes[0];
  const empty = build(
    frame([layer("a", [])], {
      kind: "wipe",
      output: wide,
      uniform: [0.5, 1, 1, 0],
      outgoingId: "a",
      incomingId: "b",
    }),
  ).scenes[0];
  assert.equal("paintRecords" in absent, false);
  assert.equal("finalPaintRecords" in absent, false);
  assert.deepEqual(empty.paintRecords, []);
  assert.deepEqual(empty.finalPaintRecords, []);
});

test("slide, zoom, and wipe capture copies the uploaded array and its own endpoint ids", () => {
  const restore = gpuGlobals();
  const writes: Float32Array[] = [];
  const device = mockDevice(writes);
  const transition = new TransitionRenderer({
    device: device as unknown as GPUDevice,
    format: "rgba8unorm",
    resolution: [100, 80],
  });
  try {
    for (const type of ["slide", "zoom", "wipe"] as const) {
      const scene = (id: string): Scene => ({
        setup() {},
        render() {},
        inspect: () => ({
          tree: node("card", 1),
          commands: [],
          warnings: [],
          paintRecords: [paint(sourceRect)],
        }),
        dispose() {},
      });
      const a = scene("a");
      const b = scene("b");
      const projectScenes: Project = {
        name: "upload",
        duration: 3,
        resolution: [100, 80],
        aspectRatio: [5, 4],
        scenes: [
          {
            id: "a",
            name: "A",
            source: "",
            start: 0,
            duration: 2,
            transition: { type: "cut" },
            create: () => a,
          },
          {
            id: "b",
            name: "B",
            source: "",
            start: 1,
            duration: 2,
            transition: { type, duration: 1, direction: "down" },
            create: () => b,
          },
        ],
      };
      const renderer = Object.create(Renderer.prototype) as Renderer;
      Object.assign(renderer, {
        project: projectScenes,
        scenes: new Map<string, Scene>([["a", a], ["b", b]]),
        disposed: false,
        configured: false,
        renderGeneration: 0,
        attempt: 0,
        preparationQueue: Promise.resolve(),
        activeFrames: new Set(),
        inspectionEnabled: true,
        device,
        context: { getCurrentTexture: () => ({ createView: () => ({}) }) },
        resolution: [100, 80],
        format: "rgba8unorm",
        transition,
      });
      const before = writes.length;
      renderer.render(1.1);
      assert.equal(writes.length, before + 1);
      const uploaded = writes[writes.length - 1];
      const snapshot = renderer.inspectFrame();
      assert.equal(snapshot.transitionDraw?.kind, type);
      if (!snapshot.transitionDraw || snapshot.transitionDraw.kind === "direct" || snapshot.transitionDraw.kind === "custom")
        assert.fail(type);
      assert.equal(snapshot.transitionDraw.outgoingId, "a");
      assert.equal(snapshot.transitionDraw.incomingId, "b");
      assert.deepEqual(snapshot.transitionDraw.uniform, [
        uploaded[0],
        uploaded[1],
        uploaded[2],
        uploaded[3],
      ]);
      assert.notEqual(snapshot.transitionDraw.uniform, uploaded);
      uploaded[0] = 99;
      assert.notEqual(snapshot.transitionDraw.uniform[0], 99);
      const writesBeforeProjection = writes.length;
      const built = build(snapshot);
      assert.equal(writes.length, writesBeforeProjection);
      if (type === "wipe" || type === "slide") {
        assert.notEqual(built.scenes[1].finalPaintRecords?.[0].sceneWeight, uploaded[0]);
        assert.equal(built.scenes[1].finalPaintRecords?.[0].sceneWeight === 0 || built.scenes[1].finalPaintRecords?.[0].sceneWeight === 1, true);
      } else {
        assert.equal(built.scenes[1].finalPaintRecords?.[0].sceneWeight, snapshot.transitionDraw.uniform[0]);
      }
    }
  } finally {
    transition.dispose();
    restore();
  }
});
