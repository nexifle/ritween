/**
 * G1b safe inspection serializer
 * (docs/plans/declarative-layout-hardening.md §7 "Diagnostics contract" and
 * "CLI contract").
 *
 * The document is built from untrusted scene metadata, so these tests cover the
 * whitelist (no media sources, draw outlines or private objects), non-finite
 * geometry rejection, hostile getters, the byte budget, scoped IDs, exact
 * targeting, and the diagnostics that authoring frames emit beside the legacy
 * warning strings.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { FrameInspection } from "../src/engine/render/renderer";
import {
  MAX_INSPECTION_BYTES,
  InspectionReadError,
  InspectionSerializationError,
  InspectionTargetError,
  applyInspectionTarget,
  buildInspectionDocument,
  InspectionBudget,
  paintRecord,
  measureInspection,
  parseInspectionTarget,
  serializeInspection,
  type InspectionDocument,
} from "../src/engine/inspect/report";
import {
  Box,
  Composition,
  Text,
  HStack,
  Spacer,
  VStack,
  World,
  evaluateView,
} from "../src/authoring/index";
import type { EvaluatedFrame, MeasureText } from "../src/authoring/index";

const project = {
  name: "Inspection fixture",
  duration: 4,
  resolution: [320, 180] as const,
};

/** Deterministic measurer: 10 units per character, so widths are recognizable. */
const measure: MeasureText = (text) => Array.from(text).length * 10;

function authoredFrame(view = Box({ width: 20, height: 10 }), time = 1) {
  return evaluateView(view, {
    time,
    width: 320,
    height: 180,
    measureText: measure,
  });
}

function clock(time: number) {
  return { time, localTime: time, progress: time / 4 };
}

function inspection(
  layers: readonly {
    id: string;
    time?: number;
    localTime?: number;
    progress?: number;
    frame?: unknown;
    unavailable?: string;
  }[],
  overlay?: { frame?: unknown; unavailable?: string },
): FrameInspection {
  return {
    requestedTime: 1,
    effectiveTime: 1,
    scenes: layers.map((layer) => ({
      id: layer.id,
      name: layer.id.toUpperCase(),
      ...clock(layer.time ?? 1),
      ...(layer.unavailable === undefined
        ? { frame: (layer.frame ?? authoredFrame()) as EvaluatedFrame }
        : { unavailable: layer.unavailable }),
      ...(layer.localTime === undefined ? {} : { localTime: layer.localTime }),
      ...(layer.progress === undefined ? {} : { progress: layer.progress }),
    })) as FrameInspection["scenes"],
    ...(overlay === undefined
      ? {}
      : {
          overlay: {
            ...clock(1),
            ...(overlay.unavailable === undefined
              ? { frame: (overlay.frame ?? authoredFrame()) as EvaluatedFrame }
              : { unavailable: overlay.unavailable }),
          },
        }),
  };
}

function document(frame: FrameInspection) {
  return buildInspectionDocument({
    packageVersion: "0.0.0-test",
    project,
    frame,
  });
}

test("inspection publishes schema, package, project and clock identities", () => {
  const built = document(
    inspection([{ id: "main", localTime: 0.25, progress: 0.1 }]),
  );
  assert.equal(built.schemaVersion, 1);
  assert.equal(built.packageVersion, "0.0.0-test");
  assert.deepEqual(built.project, {
    name: "Inspection fixture",
    duration: 4,
    resolution: [320, 180],
  });
  assert.deepEqual(built.time, { requested: 1, effective: 1 });
  assert.equal(built.scenes[0].scope, "scene:main");
  assert.equal(built.scenes[0].id, "main");
  assert.deepEqual(built.scenes[0].clock, {
    time: 1,
    localTime: 0.25,
    progress: 0.1,
  });
  assert.equal(built.scenes[0].inspection, "available");
  assert.deepEqual(built.scenes[0].spaces, ["layout"]);
  assert.equal(built.scenes[0].tree!.kind, "box");
});

test("capability states exact layout geometry and the pending paint/transition limits", () => {
  const { capability } = document(inspection([{ id: "main" }]));
  assert.deepEqual(capability.geometry, {
    layout: "exact-rectangle",
    paint: "partial",
  });
  assert.equal(capability.transitions.projection, "unavailable");
  assert.match(capability.transitions.reason, /Text draw quads/);
  assert.match(capability.transitions.reason, /Media texture quads/);
  assert.match(capability.transitions.reason, /stays conservative/);
  assert.match(capability.transitions.reason, /G3 is not complete/);
  assert.doesNotMatch(capability.transitions.reason, /clip, media, path/);
  assert.equal(capability.geometry.paint, "partial");
});

test("a raw scene is unavailable with its reason, never an empty tree", () => {
  const built = document(
    inspection([
      {
        id: "raw",
        unavailable:
          "RAW does not implement the optional inspect() capability.",
      },
    ]),
  );
  const scene = built.scenes[0];
  assert.equal(scene.inspection, "unavailable");
  assert.equal(scene.tree, undefined);
  assert.match(scene.unavailable!, /does not implement/);
  assert.deepEqual(built.diagnostics, [
    {
      code: "unavailable-inspection",
      severity: "warning",
      scope: "scene:raw",
      path: ".",
      clock: { local: 1, project: 1 },
      space: "layout",
      message: scene.unavailable,
    },
  ]);
});

test("the project overlay is its own scope with the project clock", () => {
  const built = document(
    inspection([{ id: "main" }], { frame: authoredFrame() }),
  );
  assert.equal(built.scenes.length, 2);
  assert.deepEqual(
    built.scenes.map((scene) => scene.scope),
    ["scene:main", "overlay"],
  );
  assert.equal(built.scenes[1].name, "Project overlay");
  assert.deepEqual(built.scenes[1].clock, {
    time: 1,
    localTime: 1,
    progress: 0.25,
  });
});

test("repeated node IDs stay scoped per scene instance instead of merging", () => {
  const view = Box({ width: 20, height: 10 }).id("card");
  const built = document(
    inspection([
      { id: "first", frame: authoredFrame(view) },
      { id: "second", frame: authoredFrame(view) },
    ]),
  );
  const ids = built.scenes.map((scene) => [scene.scope, scene.tree!.path]);
  assert.deepEqual(ids, [
    ["scene:first", "card"],
    ["scene:second", "card"],
  ]);
  // Legacy tree.path keeps the authored per-frame path; qualification is separate.
  assert.ok(!built.scenes[0].tree!.path.includes("scene:"));
});

test("legacy warnings survive verbatim and in order beside structured diagnostics", () => {
  const frame = authoredFrame(
    HStack([Box({ width: 100, height: 10 }), Spacer()]).frame({ width: 40 }),
  );
  assert.match(frame.warnings[0], /content exceeds offered bounds/);
  const built = document(inspection([{ id: "main", frame }]));
  assert.deepEqual(built.scenes[0].warnings, frame.warnings);
  const overflow = built.diagnostics.filter(
    (entry) => entry.code === "offered-size-overflow",
  );
  assert.ok(overflow.length >= 1);
});

test("offered-size overflow carries bounds, excess and both clocks", () => {
  const frame = authoredFrame(
    Box({ width: 100, height: 10 }).id("wide").frame({ width: 40 }),
  );
  const built = document(inspection([{ id: "main", frame, localTime: 0.5 }]));
  const overflow = built.diagnostics.find(
    (entry) => entry.code === "offered-size-overflow",
  )!;
  assert.equal(overflow.severity, "warning");
  assert.equal(overflow.scope, "scene:main");
  assert.equal(overflow.space, "layout");
  assert.equal(overflow.clock.project, 1);
  assert.equal(overflow.clock.local, 1);
  assert.deepEqual(overflow.bounds, { x: 0, y: 0, width: 40, height: 180 });
  assert.ok(overflow.excess!.width > 59);
  assert.equal(overflow.excess!.height, 0);
});

test("fixed-allocation deficit is authored, not parsed out of a warning string", () => {
  const frame = authoredFrame(
    HStack([
      Box({ width: 60, height: 10 }),
      Box({ width: 60, height: 10 }),
      Spacer(),
    ])
      .id("row")
      .frame({ width: 80 }),
  );
  const built = document(inspection([{ id: "main", frame }]));
  const deficit = built.diagnostics.find(
    (entry) => entry.code === "fixed-allocation-deficit",
  )!;
  assert.equal(deficit.severity, "error");
  assert.equal(deficit.id, "row");
  assert.equal(deficit.deficit, 40);
  assert.deepEqual(deficit.bounds, { x: 0, y: 0, width: 80, height: 180 });
  // The legacy warning text is unchanged by the new structured entry.
  assert.ok(frame.warnings.every((warning) => typeof warning === "string"));
});

test("an isolated surface publishes its scope once and suppresses it inside", () => {
  // A clip paints as one corrected unit; its contents must not re-apply the same pose, which
  // the report shows as an explicit empty candidate list rather than a missing field.
  const view = Box({ width: 20, height: 20 })
    .id("hero")
    .padding({ left: 10, right: 10 })
    .background({ fill: "#FF0000" })
    .clip();
  const built = document(
    inspection([{ id: "main", frame: authoredFrame(view) }]),
  );
  const commands = built.scenes[0].commands!;
  assert.equal(
    commands.length,
    1,
    "the clip emits one isolated surface command",
  );
  const surface = commands[0];
  assert.equal(surface.kind, "composition");
  assert.deepEqual(surface.correctionIds, ["hero"]);
  const json = serializeInspection(built);
  assert.match(json, /"correctionIds":\["hero"\]/);
});

test("draw commands publish paint metadata only, never media or private objects", () => {
  const built = document(
    inspection([
      {
        id: "main",
        frame: {
          tree: {
            path: "root",
            kind: "media",
            bounds: { x: 0, y: 0, width: 10, height: 10 },
            transform: [1, 1, 0, 0],
            children: [],
          },
          commands: [
            {
              kind: "media",
              path: "root",
              bounds: { x: 0, y: 0, width: 10, height: 10 },
              transform: [1, 1, 0, 0],
              opacity: 1,
              sharedId: "logo",
              source: { kind: "image", url: "https://example.test/secret.png" },
              time: 3,
            },
          ],
          warnings: [],
        },
      },
    ]),
  );
  assert.deepEqual(built.scenes[0].commands, [
    {
      kind: "media",
      path: "root",
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      transform: [1, 1, 0, 0],
      opacity: 1,
      sharedId: "logo",
    },
  ]);
  const json = serializeInspection(built);
  assert.ok(!json.includes("secret.png"));
  assert.ok(!json.includes('"source"'));
  assert.ok(!json.includes('"time":3'));
});

test("non-finite geometry is rejected instead of serialized", () => {
  const NaNBounds = {
    tree: {
      path: "root",
      kind: "box",
      bounds: { x: 0, y: 0, width: Number.NaN, height: 10 },
      transform: [1, 1, 0, 0],
      children: [],
    },
    commands: [],
    warnings: [],
  };
  assert.throws(
    () => document(inspection([{ id: "main", frame: NaNBounds }])),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /bounds\.width must be a finite number/.test(error.message),
  );
  for (const bad of [Number.POSITIVE_INFINITY, "12", null]) {
    const frame = authoredFrame();
    assert.throws(
      () =>
        document(
          inspection([
            {
              id: "main",
              frame: {
                ...frame,
                commands: [
                  {
                    kind: "box",
                    path: "root",
                    bounds: { x: 0, y: 0, width: 1, height: 1 },
                    transform: [1, 1, 0, bad],
                    opacity: 1,
                  },
                ],
              },
            },
          ]),
        ),
      InspectionSerializationError,
    );
  }
});

test("a hostile getter degrades its scope to unavailable instead of throwing", () => {
  const hostile = Object.defineProperties(
    {},
    {
      tree: { value: authoredFrame().tree, enumerable: true },
      commands: {
        enumerable: true,
        get: () => {
          throw Error("commands getter exploded");
        },
      },
      warnings: { value: [], enumerable: true },
    },
  );
  const built = document(inspection([{ id: "hostile", frame: hostile }]));
  assert.equal(built.scenes[0].inspection, "unavailable");
  assert.match(built.scenes[0].unavailable!, /commands getter exploded/);
  assert.equal(built.diagnostics[0].code, "unavailable-inspection");
  // A well-formed sibling scope is still published.
  const both = document(
    inspection([{ id: "hostile", frame: hostile }, { id: "fine" }]),
  );
  assert.equal(both.scenes[1].inspection, "available");
});

test("a malformed tree shape is a serialization error, not a read error", () => {
  assert.throws(
    () =>
      document(
        inspection([
          {
            id: "main",
            frame: {
              tree: { path: "root", kind: "box", children: [] },
              commands: [],
              warnings: [],
            },
          },
        ]),
      ),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /bounds could not be read|bounds must be an object|must be a finite number/.test(
        (error as Error).message,
      ),
  );
  assert.ok(
    !(new InspectionReadError("x") instanceof InspectionSerializationError),
  );
});

test("output over the byte budget fails with narrowing advice and no truncation", () => {
  const built = document(inspection([{ id: "main" }]));
  assert.throws(
    () => serializeInspection(built, 16),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /bytes of UTF-8, over the 16-byte/.test(error.message) &&
      /--target SCOPE#ID/.test(error.message),
  );
  assert.ok(MAX_INSPECTION_BYTES > 2 ** 20);
  const json = serializeInspection(built);
  assert.deepEqual(
    JSON.parse(json),
    built,
    "the budget never alters the payload",
  );
});

test("target syntax accepts scoped IDs and rejects malformed input", () => {
  assert.deepEqual(parseInspectionTarget("scene:main#card"), {
    scope: "scene:main",
    id: "card",
  });
  assert.deepEqual(parseInspectionTarget("overlay#hud"), {
    scope: "overlay",
    id: "hud",
  });
  for (const bad of [
    "main#card",
    "scene:#card",
    "scene:main#",
    "scene:main",
    "other#x",
    "scene:main#a b",
  ])
    assert.throws(() => parseInspectionTarget(bad), InspectionTargetError, bad);
});

test("an exact target keeps ancestors, clock, spaces and matching diagnostics only", () => {
  const frame = evaluateView(
    HStack([
      Box({ width: 10, height: 10 }).id("left"),
      Box({ width: 200, height: 10 }).id("too-wide"),
    ]).id("row"),
    { time: 2, width: 100, height: 60, measureText: measure },
  );
  const built = document(inspection([{ id: "main", frame }, { id: "other" }]));
  const targeted = applyInspectionTarget(built, {
    scope: "scene:main",
    id: "too-wide",
  });
  assert.equal(targeted.scenes.length, 1);
  assert.deepEqual(targeted.scenes[0].clock, built.scenes[0].clock);
  assert.deepEqual(targeted.scenes[0].spaces, ["layout"]);
  assert.equal(
    targeted.scenes[0].tree!.path,
    "row",
    "ancestors stay in the tree",
  );
  assert.deepEqual(
    targeted.scenes[0].tree!.children.map((child) =>
      child.path.split("/").at(-1),
    ),
    ["too-wide"],
    "sibling branches are dropped",
  );
  assert.deepEqual(targeted.target, {
    scope: "scene:main",
    id: "too-wide",
    path: "row/too-wide",
    matches: 1,
  });
  assert.deepEqual(targeted.time, built.time);
  assert.ok(
    targeted.diagnostics.every((entry) => entry.scope === "scene:main"),
    "diagnostics from other scopes are dropped",
  );
});

test("the target keeps the matched node's own subtree", () => {
  const frame = authoredFrame(
    HStack([
      Box({ width: 10, height: 10 }).id("a"),
      Box({ width: 10, height: 10 }).id("b"),
    ]).id("row"),
  );
  const targeted = applyInspectionTarget(
    document(inspection([{ id: "main", frame }])),
    {
      scope: "scene:main",
      id: "row",
    },
  );
  assert.deepEqual(
    targeted.scenes[0].tree!.children.map((child) =>
      child.path.split("/").at(-1),
    ),
    ["a", "b"],
  );
});

test("a missing or ambiguous target fails with actionable text", () => {
  const built = document(inspection([{ id: "main" }]));
  assert.throws(
    () => applyInspectionTarget(built, { scope: "scene:main", id: "absent" }),
    (error: unknown) =>
      error instanceof InspectionTargetError &&
      /No node has ID "absent"/.test(error.message) &&
      /authored ViewNode\.id\(\)/.test(error.message),
  );
  assert.throws(
    () => applyInspectionTarget(built, { scope: "scene:absent", id: "x" }),
    (error: unknown) =>
      error instanceof InspectionTargetError &&
      /scene:main/.test(error.message),
  );
  const duplicate = document(
    inspection([
      {
        id: "main",
        frame: authoredFrame(
          // Sibling IDs are rejected at measure time, so repetition needs two stacks.
          HStack([
            HStack([Box({ width: 1, height: 1 }).id("same")]).id("left"),
            HStack([Box({ width: 1, height: 1 }).id("same")]).id("right"),
          ]),
        ),
      },
    ]),
  );
  assert.throws(
    () => applyInspectionTarget(duplicate, { scope: "scene:main", id: "same" }),
    (error: unknown) =>
      error instanceof InspectionTargetError &&
      /2 nodes have ID/.test(error.message),
  );
  assert.throws(
    () =>
      applyInspectionTarget(
        document(inspection([{ id: "raw", unavailable: "no capability" }])),
        { scope: "scene:raw", id: "x" },
      ),
    (error: unknown) =>
      error instanceof InspectionTargetError &&
      /no layout tree/.test(error.message),
  );
});

test("an overlay target resolves against the overlay scope", () => {
  const built = document(
    inspection([{ id: "main" }], {
      frame: authoredFrame(Text("hud", { size: 12 }).id("hud")),
    }),
  );
  const targeted = applyInspectionTarget(built, {
    scope: "overlay",
    id: "hud",
  });
  assert.equal(targeted.scenes[0].scope, "overlay");
  assert.equal(targeted.target!.path, "hud");
});

test("documents are plain JSON with no class instances or cycles", () => {
  const built: InspectionDocument = document(
    inspection([{ id: "main" }, { id: "raw", unavailable: "no capability" }], {
      frame: authoredFrame(),
    }),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(built)), built);
});

test("the incremental size measure matches the real encoding exactly", () => {
  const awkward = document(
    inspection([
      {
        id: "esc",
        frame: {
          tree: {
            path: 'root/"quoted"\\path\nsplit\ttab\u0001ctrl',
            kind: 'box"quote\\',
            bounds: { x: 0, y: 0, width: 1, height: 1 },
            transform: [1, 1, 0, 0],
            children: [],
          },
          commands: [],
          warnings: ["ok", "emoji 😀 and CJK 漢", "unpaired \ud800 half"],
        },
      },
    ]),
  );
  const json = JSON.stringify(awkward);
  assert.equal(
    measureInspection(awkward),
    new TextEncoder().encode(json).length,
    "the walker must agree with JSON.stringify byte for byte",
  );
});

test("the size limit applies during traversal, not after a full allocation", () => {
  // Measure with no limit, then with a limit one byte below it: it must throw with
  // the traversed byte count rather than reporting the encoded length.
  const built = document(inspection([{ id: "main" }]));
  const total = measureInspection(built);
  assert.throws(
    () => measureInspection(built, total - 1),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /over the \d+-byte/.test(error.message),
  );
  assert.equal(
    measureInspection(built, total),
    total,
    "the exact limit is allowed",
  );
});

test("a throwing array length, index or iterator makes only that scope unavailable", () => {
  // A proxy is how untrusted scene data actually throws on length or index access.
  const hostileLength = () =>
    new Proxy([{ kind: "box" }], {
      get(target, property, receiver) {
        if (property === "length") throw Error("length getter exploded");
        return Reflect.get(target, property, receiver);
      },
    });
  const hostileIndex = () =>
    new Proxy([{ kind: "box" }], {
      get(target, property, receiver) {
        if (property === "0") throw Error("index getter exploded");
        return Reflect.get(target, property, receiver);
      },
    });
  const base = authoredFrame();
  for (const [label, commands] of [
    ["length getter exploded", hostileLength()],
    ["index getter exploded", hostileIndex()],
  ] as const) {
    const built = document(
      inspection([
        { id: "hostile", frame: { ...base, commands } },
        { id: "fine" },
      ]),
    );
    assert.equal(built.scenes[0].inspection, "unavailable", label);
    assert.match(built.scenes[0].unavailable!, new RegExp(label));
    assert.equal(
      built.scenes[1].inspection,
      "available",
      "siblings still publish",
    );
  }
});

test("a cyclic tree is rejected via cycle detection instead of overflowing the stack", () => {
  const cyclic: Record<string, unknown> = {
    path: "root",
    kind: "box",
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    transform: [1, 1, 0, 0],
    children: [],
  };
  (cyclic.children as unknown[]).push(cyclic);
  assert.throws(
    () =>
      document(
        inspection([
          { id: "cyclic", frame: { tree: cyclic, commands: [], warnings: [] } },
        ]),
      ),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /cycle/.test(error.message),
  );
});

test("deep ordinary layout tree (1500 nodes) builds and serializes cleanly both untargeted and targeted", () => {
  let deep: Record<string, unknown> = {
    path: "leaf",
    id: "target-leaf",
    kind: "box",
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    transform: [1, 1, 0, 0],
    children: [],
  };
  // 1500 levels deep: builds and serializes without call-stack recursion limits
  for (let index = 0; index < 1500; index++)
    deep = {
      path: `n${index}`,
      kind: "box",
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      transform: [1, 1, 0, 0],
      children: [deep],
    };

  const baseInspection = (target?: { scope: string; id: string }) =>
    buildInspectionDocument({
      packageVersion: "1.0.0",
      project: { name: "test", duration: 1, resolution: [100, 100] },
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
            frame: { tree: deep, commands: [], warnings: [] },
          },
        ],
      },
      target,
    });

  // Untargeted: build AND serialize all 1500 nodes
  const untargetedDoc = baseInspection();
  const untargetedJson = serializeInspection(untargetedDoc);
  assert.ok(untargetedJson.length > 0);
  const untargetedParsed = JSON.parse(untargetedJson);
  assert.equal(untargetedParsed.scenes[0].inspection, "available");

  // Targeted: build AND serialize targeted at leaf node
  const targetedDoc = baseInspection({
    scope: "scene:main",
    id: "target-leaf",
  });
  const targetedJson = serializeInspection(targetedDoc);
  assert.ok(targetedJson.length > 0);
  const targetedParsed = JSON.parse(targetedJson);
  assert.equal(targetedParsed.target.id, "target-leaf");
});

test("applying a missing target option returns the document unchanged", () => {
  const built = document(inspection([{ id: "main" }, { id: "other" }]));
  assert.equal(applyInspectionTarget(built, undefined), built);
});

test("the byte budget message reports exact bytes and the actual limit", () => {
  const built = document(inspection([{ id: "main" }]));
  const bytes = new TextEncoder().encode(JSON.stringify(built)).length;
  assert.throws(
    () => serializeInspection(built, bytes - 1),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      error.message.includes(`${bytes} bytes of UTF-8`) &&
      error.message.includes(`${bytes - 1}-byte`),
  );
  assert.equal(
    serializeInspection(built, bytes).length,
    JSON.stringify(built).length,
  );
});

test("a target drops sibling commands so the narrowed output is genuinely smaller", () => {
  const view = HStack([
    Box({ width: 10, height: 10 }).id("small"),
    Box({ width: 90, height: 10 }).id("large"),
  ]).id("row");
  const frame = authoredFrame(view);
  assert.ok(frame.commands.length >= 2, "fixture needs sibling draw commands");
  const built = document(inspection([{ id: "main", frame }]));
  const targeted = applyInspectionTarget(built, {
    scope: "scene:main",
    id: "small",
  });
  assert.deepEqual(
    targeted.scenes[0].commands!.map((entry) => entry.path),
    ["row/small"],
    "only the target's own commands survive",
  );
  assert.ok(
    targeted.scenes[0].commands!.length < built.scenes[0].commands!.length,
  );
  assert.deepEqual(
    targeted.scenes[0].tree!.children.map((child) => child.path),
    ["row/small"],
  );
});

test("a target keeps wiring that belongs to descendant nodes", () => {
  // The frame overflows only through the retained child, so the diagnostic must survive.
  const view = HStack([
    Box({ width: 10, height: 10 }).id("small"),
    Box({ width: 400, height: 10 }).id("overflowing"),
  ]).id("row");
  const built = document(
    inspection([{ id: "main", frame: authoredFrame(view) }]),
  );
  const targeted = applyInspectionTarget(built, {
    scope: "scene:main",
    id: "overflowing",
  });
  assert.ok(
    targeted.scenes[0].warnings!.some((warning) =>
      warning.includes("overflowing"),
    ),
    `warnings for retained nodes must survive, got ${JSON.stringify(targeted.scenes[0].warnings)}`,
  );
  assert.ok(
    !targeted.scenes[0].warnings!.some((warning) => warning.includes("small")),
    "sibling warnings are dropped",
  );
});

test("a target keeps errors in the retained subtree so --fail-on cannot miss them", () => {
  // A fixed-allocation deficit is an error diagnostic inside the targeted subtree.
  const view = HStack([
    Box({ width: 96, height: 12 }).id("chip-a"),
    Box({ width: 96, height: 12 }).id("chip-b"),
    Box({ width: 96, height: 12 }).id("chip-c"),
    Spacer(),
  ])
    .id("chips")
    .frame({ width: 260 });
  const built = document(
    inspection([{ id: "main", frame: authoredFrame(view) }]),
  );
  const errors = built.diagnostics.filter(
    (entry) => entry.severity === "error",
  );
  assert.ok(errors.length >= 1, "fixture must author an error diagnostic");
  const targeted = applyInspectionTarget(built, {
    scope: "scene:main",
    id: "chips",
  });
  assert.deepEqual(
    targeted.diagnostics.filter((entry) => entry.severity === "error"),
    errors,
    "the targeted scope still reports the errors it renders",
  );
  // Ancestors stay in the tree for context, so their diagnostics belong too.
  const leaf = applyInspectionTarget(built, {
    scope: "scene:main",
    id: "chip-a",
  });
  assert.equal(
    leaf.diagnostics.filter((entry) => entry.severity === "error").length,
    1,
    "a retained ancestor still reports the error it renders",
  );
  // A sibling outside the retained chain contributes nothing.
  const other = document(
    inspection([
      {
        id: "main",
        frame: authoredFrame(view),
      },
      {
        id: "sibling",
        frame: authoredFrame(
          HStack([
            Box({ width: 96, height: 12 }).id("x"),
            Box({ width: 96, height: 12 }).id("y"),
            Spacer(),
          ])
            .id("other-chips")
            .frame({ width: 100 }),
        ),
      },
    ]),
  );
  const scoped = applyInspectionTarget(other, {
    scope: "scene:main",
    id: "chips",
  });
  assert.ok(
    scoped.diagnostics.every((entry) => entry.scope === "scene:main"),
    "other scopes are dropped entirely",
  );
});

test("target matching uses the authored ID, never a synthetic path segment", () => {
  // Anonymous siblings get synthetic segments like `box[0]`; they are not IDs.
  const built = document(
    inspection([
      {
        id: "main",
        frame: authoredFrame(HStack([Box({ width: 5, height: 5 })])),
      },
    ]),
  );
  assert.match(built.scenes[0].tree!.children[0].path, /box\[0\]/);
  assert.equal(built.scenes[0].tree!.children[0].id, undefined);
  assert.throws(
    () => applyInspectionTarget(built, { scope: "scene:main", id: "box[0]" }),
    (error: unknown) =>
      error instanceof InspectionTargetError &&
      /anonymous nodes cannot be targeted/.test(error.message),
  );
});

test("an ID containing a slash is matched literally, not treated as a path", () => {
  const built = document(
    inspection([
      {
        id: "main",
        frame: authoredFrame(
          HStack([
            Box({ width: 5, height: 5 }).id("group/card"),
            Box({ width: 5, height: 5 }).id("card"),
          ]),
        ),
      },
    ]),
  );
  const targeted = applyInspectionTarget(built, {
    scope: "scene:main",
    id: "group/card",
  });
  assert.equal(targeted.target!.id, "group/card");
  assert.deepEqual(
    targeted.scenes[0].tree!.children.map((child) => child.id),
    ["group/card"],
    "only the slash-named node matches; `card` alone stays untouched",
  );
});

test("budget is enforced while reading metadata before full allocations, stopping early with a counter", () => {
  let accessed = 0;
  const hugeCommands = new Proxy(new Array(50_000), {
    get(target, prop, receiver) {
      if (prop === "length") return 50_000;
      if (typeof prop === "string" && !Number.isNaN(Number(prop))) {
        accessed++;
        return {
          kind: "box",
          path: `cmd-${prop}`,
          bounds: { x: 0, y: 0, width: 10, height: 10 },
          transform: [1, 1, 0, 0],
          opacity: 1,
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const base = authoredFrame();
  assert.throws(
    () =>
      buildInspectionDocument({
        packageVersion: "1.0.0",
        project: { name: "test", duration: 1, resolution: [100, 100] },
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
              frame: { ...base, commands: hugeCommands },
            },
          ],
        },
        limit: 2_000,
      }),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /over the 2000-byte/.test(error.message),
  );

  assert.ok(accessed > 0, "must have started reading items");
  assert.ok(accessed < 100, `early stop: visited ${accessed} out of 50000`);
});

test("targeted inspection prefilters commands and does not allocate unneeded payload", () => {
  const commands = [
    ...Array.from({ length: 500 }, (_, i) => ({
      kind: "box",
      path: `other-${i}`,
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      transform: [1, 1, 0, 0],
      opacity: 1,
    })),
    {
      kind: "box",
      path: "card",
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      transform: [1, 1, 0, 0],
      opacity: 1,
    },
  ];

  const view = Box({ width: 10, height: 10 }).id("card");
  const base = authoredFrame(view);
  const doc = buildInspectionDocument({
    packageVersion: "1.0.0",
    project: { name: "test", duration: 1, resolution: [100, 100] },
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
          frame: { ...base, commands },
        },
      ],
    },
    target: { scope: "scene:main", id: "card" },
  });

  assert.equal(doc.scenes[0].commands!.length, 1);
  assert.equal(doc.scenes[0].commands![0].path, "card");
});

test("nested target starts traversal in layout space, preserving ancestor layout errors and isolating same path in different spaces", () => {
  const tree: InspectionLayoutNode = {
    path: "root",
    kind: "stack",
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    transform: [1, 1, 0, 0],
    children: [
      {
        path: "root/ancestor",
        id: "ancestor",
        kind: "box",
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        transform: [1, 1, 0, 0],
        children: [
          {
            path: "root/comp",
            id: "comp",
            kind: "composition",
            bounds: { x: 0, y: 0, width: 50, height: 50 },
            transform: [1, 1, 0, 0],
            children: [
              {
                path: "root/ancestor",
                id: "nested-target",
                space: "comp/world",
                kind: "box",
                bounds: { x: 0, y: 0, width: 20, height: 20 },
                transform: [1, 1, 0, 0],
                children: [],
              },
            ],
          },
        ],
      },
    ],
  };

  const commands: InspectionCommand[] = [
    {
      kind: "box",
      path: "root/ancestor",
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      transform: [1, 1, 0, 0],
      opacity: 1,
    },
    {
      kind: "box",
      path: "root/ancestor",
      space: "comp/world",
      bounds: { x: 0, y: 0, width: 20, height: 20 },
      transform: [1, 1, 0, 0],
      opacity: 1,
    },
  ];

  const diagnostics: InspectionDiagnostic[] = [
    {
      code: "fixed-allocation-deficit",
      severity: "error",
      scope: "scene:main",
      path: "root/ancestor",
      space: "layout",
      message: "ancestor layout overflow",
      localTime: 0,
    },
    {
      code: "content-overflow",
      severity: "error",
      scope: "scene:main",
      path: "root/ancestor",
      space: "comp/world",
      message: "nested content overflow",
      localTime: 0,
    },
  ];

  const doc = buildInspectionDocument({
    packageVersion: "1.0.0",
    project: { name: "test", duration: 1, resolution: [100, 100] },
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
          frame: { tree, commands, warnings: [], diagnostics },
        },
      ],
    },
    target: { scope: "scene:main", id: "nested-target" },
  });

  assert.equal(doc.diagnostics.length, 2);
  const layoutDiag = doc.diagnostics.find((d) => d.space === "layout");
  const nestedDiag = doc.diagnostics.find((d) => d.space === "comp/world");
  assert.ok(layoutDiag, "ancestor layout error must be preserved");
  assert.ok(nestedDiag, "nested target error must be preserved");

  assert.equal(doc.scenes[0].commands!.length, 2);
  const layoutCmd = doc.scenes[0].commands!.find(
    (c) => c.space === undefined || c.space === "layout",
  );
  const nestedCmd = doc.scenes[0].commands!.find(
    (c) => c.space === "comp/world",
  );
  assert.ok(layoutCmd, "ancestor layout command must be preserved");
  assert.ok(nestedCmd, "nested world command must be preserved");
});

test("exact warning attribution drops sibling warnings even with common root ancestor", () => {
  const view = HStack([
    Box({ width: 400, height: 10 }).id("sibling-a"),
    Box({ width: 400, height: 10 }).id("sibling-b"),
  ]).id("root");

  const built = document(
    inspection([
      {
        id: "main",
        frame: {
          ...authoredFrame(view),
          warnings: [
            "root/sibling-a: content exceeds offered bounds at localTime=0",
            "root/sibling-b: content exceeds offered bounds at localTime=0",
            "Unattributable general warning without path",
          ],
        },
      },
    ]),
  );

  const targeted = applyInspectionTarget(built, {
    scope: "scene:main",
    id: "sibling-a",
  });

  const keptWarnings = targeted.scenes[0].warnings!;
  assert.ok(
    keptWarnings.some((w) => w.includes("sibling-a")),
    "targeted sibling-a warning must be kept",
  );
  assert.ok(
    !keptWarnings.some((w) => w.includes("sibling-b")),
    "discarded sibling-b warning must be dropped despite common root ancestor",
  );
  assert.ok(
    keptWarnings.some((w) => w.includes("Unattributable")),
    "unattributable warning must be kept",
  );
});

test("a small target in a huge sibling tree succeeds within a tight budget", () => {
  // Tree with 10,000 siblings. Untargeted, this would require >1 MiB.
  const siblings: Record<string, unknown>[] = Array.from(
    { length: 10_000 },
    (_, i) => ({
      path: `root/s${i}`,
      kind: "box",
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      transform: [1, 1, 0, 0],
      children: [],
    }),
  );
  // Insert the target node among the siblings
  siblings[42] = {
    path: "root/target-card",
    id: "target-card",
    kind: "box",
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    transform: [1, 1, 0, 0],
    children: [],
  };

  const tree = {
    path: "root",
    kind: "stack",
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    transform: [1, 1, 0, 0],
    children: siblings,
  };

  // Targeting target-card with budget of 5,000 bytes succeeds because discarded siblings
  // are never constructed or budgeted!
  const doc = buildInspectionDocument({
    packageVersion: "1.0.0",
    project: { name: "test", duration: 1, resolution: [100, 100] },
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
          frame: { tree, commands: [], warnings: [] },
        },
      ],
    },
    target: { scope: "scene:main", id: "target-card" },
    limit: 5_000,
  });

  assert.equal(doc.scenes[0].tree!.children.length, 1);
  assert.equal(doc.scenes[0].tree!.children[0].id, "target-card");

  // Ambiguous ID detection on the raw tree without full construction
  siblings[100] = {
    path: "root/target-card-dup",
    id: "target-card",
    kind: "box",
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    transform: [1, 1, 0, 0],
    children: [],
  };

  assert.throws(
    () =>
      buildInspectionDocument({
        packageVersion: "1.0.0",
        project: { name: "test", duration: 1, resolution: [100, 100] },
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
              frame: { tree, commands: [], warnings: [] },
            },
          ],
        },
        target: { scope: "scene:main", id: "target-card" },
      }),
    (error: unknown) =>
      error instanceof InspectionTargetError &&
      /2 nodes have ID "target-card"/.test(error.message),
  );
});

test("giant warning on discarded sibling is discarded without unbounded allocation before budget", () => {
  const tree = {
    path: "root",
    kind: "stack",
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    transform: [1, 1, 0, 0],
    children: [
      {
        path: "root/card",
        id: "card",
        kind: "box",
        bounds: { x: 0, y: 0, width: 10, height: 10 },
        transform: [1, 1, 0, 0],
        children: [],
      },
      {
        path: "root/other",
        id: "other",
        kind: "box",
        bounds: { x: 0, y: 0, width: 10, height: 10 },
        transform: [1, 1, 0, 0],
        children: [],
      },
    ],
  };

  // Warnings: a 5MB warning on discarded sibling, a late colon warning, and a valid multibyte warning on target
  const warnings = [
    "root/other: " + "X".repeat(5_000_000),
    "root/late-" + "Y".repeat(100_000) + ": late colon",
    "root/card: valid target warning 🎯",
  ];

  const doc = buildInspectionDocument({
    packageVersion: "1.0.0",
    project: { name: "test", duration: 1, resolution: [100, 100] },
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
          frame: { tree, commands: [], warnings },
        },
      ],
    },
    target: { scope: "scene:main", id: "card" },
    limit: 10_000,
  });

  // The 5MB warning on discarded sibling was discarded without charging budget or allocating huge string!
  assert.equal(doc.scenes[0].warnings!.length, 1);
  assert.equal(
    doc.scenes[0].warnings![0],
    "root/card: valid target warning 🎯",
  );
});

test("targeted nested warnings with slash and percent composition IDs are retained exactly while sibling warnings are dropped", () => {
  // Nested composition with slash and percent in ID: "comp%1/2"
  const tree = {
    path: "root",
    kind: "stack",
    bounds: { x: 0, y: 0, width: 200, height: 200 },
    transform: [1, 1, 0, 0],
    children: [
      {
        path: "root/comp%1/2",
        id: "comp%1/2",
        kind: "composition",
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        transform: [1, 1, 0, 0],
        children: [
          {
            path: "target-node",
            id: "target-node",
            space: "comp%251%2F2/world",
            warningPrefix: "root/comp%1/2/world",
            kind: "box",
            bounds: { x: 0, y: 0, width: 20, height: 20 },
            transform: [1, 1, 0, 0],
            children: [],
          },
          {
            path: "sibling-node",
            id: "sibling-node",
            space: "comp%251%2F2/world",
            warningPrefix: "root/comp%1/2/world",
            kind: "box",
            bounds: { x: 0, y: 0, width: 20, height: 20 },
            transform: [1, 1, 0, 0],
            children: [],
          },
        ],
      },
    ],
  };

  const warnings = [
    "root/comp%1/2/world/target-node: target content exceeds bounds",
    "root/comp%1/2/world/sibling-node: sibling content exceeds bounds",
  ];

  const doc = buildInspectionDocument({
    packageVersion: "1.0.0",
    project: { name: "test", duration: 1, resolution: [100, 100] },
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
          frame: { tree, commands: [], warnings },
        },
      ],
    },
    target: { scope: "scene:main", id: "target-node" },
  });

  // Exactly target warning is kept; sibling is dropped!
  assert.equal(doc.scenes[0].warnings!.length, 1);
  assert.equal(
    doc.scenes[0].warnings![0],
    "root/comp%1/2/world/target-node: target content exceeds bounds",
  );
});

test("actual evaluateView on nested compositions with slash and percent IDs retains warnings exactly", () => {
  const innermost = World(
    () =>
      HStack([
        Box({ width: 200, height: 20 }).id("target-card"),
        Box({ width: 200, height: 20 }).id("sibling-card"),
      ]).id("inner-stack"),
    { size: [100, 50] },
  );

  const middle = World(() => Composition(innermost).id("mid%1/2"), {
    size: [100, 50],
  });

  const outerView = Composition(middle).id("out%3/4");

  const result = evaluateView(outerView, {
    time: 0,
    width: 100,
    height: 50,
    measureText: (t) => t.length * 10,
  });

  assert.ok(result.warnings.length >= 1, "must have warnings");
  const nestedWarning = result.warnings[0];
  assert.match(
    nestedWarning,
    /out%3\/4\/world\/mid%1\/2\/world\/inner-stack\/target-card:/,
  );
  assert.doesNotMatch(nestedWarning, /mid%1\/2\/world.*mid%1\/2\/world/);

  const doc = buildInspectionDocument({
    packageVersion: "1.0.0",
    project: { name: "test", duration: 1, resolution: [100, 50] },
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
          frame: result,
        },
      ],
    },
    target: { scope: "scene:main", id: "target-card" },
  });

  assert.ok(
    doc.scenes[0].warnings!.some((w) =>
      w.includes("out%3/4/world/mid%1/2/world/inner-stack/target-card"),
    ),
    `warning must be retained for actual nested compositions, got: ${JSON.stringify(doc.scenes[0].warnings)}`,
  );
});

test("huge warningPrefix on raw tree is charged to budget before persist/concat", () => {
  const hugePrefix = "a".repeat(100_000);
  const tree = {
    path: "root",
    id: "target",
    kind: "box",
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    transform: [1, 1, 0, 0],
    warningPrefix: hugePrefix,
    children: [],
  };

  assert.throws(
    () =>
      buildInspectionDocument({
        packageVersion: "1.0.0",
        project: { name: "test", duration: 1, resolution: [100, 100] },
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
              frame: { tree, commands: [], warnings: [] },
            },
          ],
        },
        target: { scope: "scene:main", id: "target" },
        limit: 10_000,
      }),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /over the 10000-byte/.test(error.message),
  );
});

test("warning attribution preserves JS and Unicode whitespace with >64 spaces and multibyte paths", () => {
  const tree = {
    path: "root",
    kind: "stack",
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    transform: [1, 1, 0, 0],
    children: [
      {
        path: "root/card-🎯",
        id: "card",
        kind: "box",
        bounds: { x: 0, y: 0, width: 10, height: 10 },
        transform: [1, 1, 0, 0],
        children: [],
      },
    ],
  };

  const asciiSpacesWarning =
    " ".repeat(100) + "root/card-🎯" + " ".repeat(100) + ": 100 spaces warning";
  const unicodeWhitespaceWarning =
    "\u3000\u00A0root/card-🎯\u3000 : unicode whitespace warning";
  const siblingWarning = " ".repeat(100) + "root/sibling: sibling warning";

  const doc = buildInspectionDocument({
    packageVersion: "1.0.0",
    project: { name: "test", duration: 1, resolution: [100, 100] },
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
          frame: {
            tree,
            commands: [],
            warnings: [
              asciiSpacesWarning,
              unicodeWhitespaceWarning,
              siblingWarning,
            ],
          },
        },
      ],
    },
    target: { scope: "scene:main", id: "card" },
  });

  assert.equal(doc.scenes[0].warnings!.length, 2);
  assert.ok(doc.scenes[0].warnings!.includes(asciiSpacesWarning));
  assert.ok(doc.scenes[0].warnings!.includes(unicodeWhitespaceWarning));
  assert.ok(!doc.scenes[0].warnings!.includes(siblingWarning));
});

test("shared references in a DAG pass measurement and serialization while actual cycles fail", () => {
  const shared = { name: "shared-box", count: 42 };
  const dagDoc = {
    schemaVersion: 1,
    packageVersion: "1.0.0",
    project: { name: "dag", duration: 1, resolution: [100, 100] as const },
    time: { requested: 0, effective: 0 },
    capability: {
      inspection: "structural-snapshot" as const,
      geometry: {
        layout: "exact-rectangle" as const,
        paint: "unavailable" as const,
      },
      transitions: { projection: "unavailable" as const, reason: "none" },
    },
    scenes: [
      {
        scope: "scene:main",
        id: "main",
        name: "Main",
        clock: { time: 0, localTime: 0, progress: 0 },
        inspection: "available" as const,
        spaces: ["layout"],
        tree: {
          path: "root",
          kind: "box",
          bounds: { x: 0, y: 0, width: 10, height: 10 },
          transform: [1, 1, 0, 0],
          children: [],
        },
        metaA: shared,
        metaB: shared,
        commands: [],
        warnings: [],
      },
    ],
    diagnostics: [],
  };

  const measured = measureInspection(dagDoc as never);
  const serialized = serializeInspection(dagDoc as never);
  assert.equal(new TextEncoder().encode(serialized).length, measured);
  const parsed = JSON.parse(serialized);
  assert.deepEqual(parsed.scenes[0].metaA, shared);
  assert.deepEqual(parsed.scenes[0].metaB, shared);

  const cyclic: Record<string, unknown> = {
    ...dagDoc,
  };
  const cyclicObj: Record<string, unknown> = { name: "cyclic" };
  cyclicObj.self = cyclicObj;
  cyclic.scenes = [{ ...dagDoc.scenes[0], cyclicObj }];

  assert.throws(
    () => measureInspection(cyclic as never),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /cycle/.test(error.message),
  );
  assert.throws(
    () => serializeInspection(cyclic as never),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /cycle/.test(error.message),
  );
});

test("actual evaluateView retains warning on ancestor inside nested composition through both initial and second targeting", () => {
  const innermost = World(
    () =>
      VStack([
        HStack([
          Box({ width: 200, height: 20 }).id("target-child"),
          Box({ width: 200, height: 20 }).id("sibling-child"),
        ]).id("ancestor-row"),
        Box({ width: 200, height: 20 }).id("sibling-row"),
      ]).id("inner-vbox"),
    { size: [100, 50] },
  );

  const middle = World(() => Composition(innermost).id("mid%1/2"), {
    size: [100, 50],
  });

  const outerView = Composition(middle).id("out%3/4");

  const result = evaluateView(outerView, {
    time: 0,
    width: 100,
    height: 50,
    measureText: (t) => t.length * 10,
  });

  assert.ok(result.warnings.length >= 1);
  assert.ok(
    result.warnings.some((w) =>
      w.includes("out%3/4/world/mid%1/2/world/inner-vbox/ancestor-row"),
    ),
    `ancestor warning must be present in evaluateView warnings, got ${JSON.stringify(result.warnings)}`,
  );

  // 1. Initial targeting through buildInspectionDocument
  const doc = buildInspectionDocument({
    packageVersion: "1.0.0",
    project: { name: "test", duration: 1, resolution: [100, 50] },
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
          frame: result,
        },
      ],
    },
    target: { scope: "scene:main", id: "target-child" },
  });

  assert.ok(
    doc.scenes[0].warnings!.some((w) =>
      w.includes("out%3/4/world/mid%1/2/world/inner-vbox/ancestor-row"),
    ),
    "ancestor warning must survive buildInspectionDocument targeting",
  );
  assert.ok(
    !doc.scenes[0].warnings!.some((w) => w.includes("sibling-row")),
    "sibling-row warning must be dropped",
  );

  // 2. Manual applyInspectionTarget second pass on untargeted document
  const untargetedDoc = buildInspectionDocument({
    packageVersion: "1.0.0",
    project: { name: "test", duration: 1, resolution: [100, 50] },
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
          frame: result,
        },
      ],
    },
  });

  const manuallyTargeted = applyInspectionTarget(untargetedDoc, {
    scope: "scene:main",
    id: "target-child",
  });

  assert.ok(
    manuallyTargeted.scenes[0].warnings!.some((w) =>
      w.includes("out%3/4/world/mid%1/2/world/inner-vbox/ancestor-row"),
    ),
    "ancestor warning must survive manual applyInspectionTarget second-pass pruning",
  );
  assert.ok(
    !manuallyTargeted.scenes[0].warnings!.some((w) =>
      w.includes("sibling-row"),
    ),
    "sibling-row warning must be dropped in manual applyInspectionTarget",
  );
});

test("a real background publishes its paint role so targets can exclude it", () => {
  const view = Box({ width: 40, height: 20, fill: "#0000FF" })
    .padding({ left: 8 })
    .background({ fill: "#FF0000", radius: 4 })
    .id("card");
  const built = document(
    inspection([{ id: "main", frame: authoredFrame(view) }]),
  );
  const commands = built.scenes[0].commands!;
  assert.deepEqual(
    commands.map((command) => [command.kind, command.paintRole]),
    [
      ["box", "background"],
      ["box", undefined],
    ],
    "the background paint is first and labeled; the child paint stays plain content",
  );
  assert.deepEqual(commands[0].bounds, { x: 0, y: 0, width: 48, height: 20 });
  assert.deepEqual(commands[1].bounds, { x: 8, y: 0, width: 40, height: 20 });
  // The wrapper's authored ID stays exactly one semantic target: the background paint
  // publishes it as `matchId`, and the child's paint keeps `sharedId` for leaf IDs only.
  assert.equal(commands[0].matchId, "card");
  assert.equal(commands[0].sharedId, undefined);
  assert.deepEqual(
    commands.map((command) => command.sharedId),
    [undefined, undefined],
    "no paint borrows the ID as a child identity, so nothing is duplicated",
  );
  // The renderer's paint-correction scope is published too, so the report explains which
  // candidate pose each paint actually followed.
  assert.deepEqual(
    commands.map((command) => command.correctionIds),
    [["card"], ["card"]],
    "both paints of the declared chain publish the same ordered scope",
  );
  const json = serializeInspection(built);
  assert.match(json, /"paintRole":"background"/);
  assert.match(json, /"matchId":"card"/);
  assert.match(json, /"correctionIds":\["card"\]/);
  assert.equal(
    (json.match(/"paintRole"/g) ?? []).length,
    1,
    "content paints omit the field instead of publishing paintRole: undefined",
  );
  assert.equal(
    (json.match(/"matchId"/g) ?? []).length,
    1,
    "only the wrapper paint publishes the wrapper-declared target",
  );
  assert.equal(
    (json.match(/"correctionIds"/g) ?? []).length,
    2,
    "the correction scope is published per paint, not once per chain",
  );
});

test("targeted nested clip ancestors republish offeredSize and allocatedSlot exactly like the full report", () => {
  const view = Composition(
    World(
      () =>
        HStack([
          Box({ width: 40, height: 20 }).id("sibling"),
          Box({ width: 30, height: 20 }).id("target"),
        ])
          .clip()
          .id("window"),
      { size: [100, 80] },
    ),
    { size: [100, 80], overlay: () => Box({ width: 10, height: 10 }) },
  ).id("viewport");

  const frame = evaluateView(view, {
    time: 0,
    width: 100,
    height: 80,
    measureText: measure,
    inspection: true,
  });
  const layers = inspection([{ id: "main", frame }]);
  const full = document(layers);
  const targeted = buildInspectionDocument({
    packageVersion: "0.0.0-test",
    project,
    frame: layers,
    target: { scope: "scene:main", id: "target" },
  });

  type Node = {
    path: string;
    space?: string;
    offeredSize?: unknown;
    allocatedSlot?: unknown;
    bounds: unknown;
    children: readonly Node[];
  };
  const keyed = (root: Node) => {
    const map = new Map<string, Node>();
    const walk = (node: Node) => {
      map.set(`${node.space ?? "layout"}|${node.path}`, node);
      node.children.forEach(walk);
    };
    walk(root);
    return map;
  };
  const fullNodes = keyed(full.scenes[0].tree as unknown as Node);
  const targetedNodes = keyed(targeted.scenes[0].tree as unknown as Node);
  assert.ok(
    targetedNodes.size < fullNodes.size,
    "the target drops the sibling branch",
  );
  for (const [key, node] of targetedNodes) {
    const twin = fullNodes.get(key);
    assert.ok(twin, `${key} must also exist in the full report`);
    assert.deepEqual(node.bounds, twin.bounds, key);
    assert.deepEqual(node.offeredSize, twin.offeredSize, key);
    assert.deepEqual(node.allocatedSlot, twin.allocatedSlot, key);
  }
  // Ancestors are rebuilt outside the target's own subtree, so their metadata is the fix.
  const ancestors = [...targetedNodes.values()].filter(
    (node) => node.children.length === 1,
  );
  assert.ok(
    ancestors.length >= 2 &&
      ancestors.every(
        (node) =>
          node.offeredSize !== undefined && node.allocatedSlot !== undefined,
      ),
    "every rebuilt ancestor keeps its inspection metadata",
  );
  assert.ok(
    [...targetedNodes.keys()].some((key) => key.includes("/clip|")),
    "the retained chain crosses the clip-local space",
  );
  assert.match(serializeInspection(targeted), /"offeredSize":/);
});

/**
 * Clip content lives in `${clip space}/clip`, so a clip diagnostic only survives exact
 * `(space, path)` filtering when it claims the clip-local space. Both target paths must
 * agree, and a nested scope must not lose or double its prefix.
 */
const clipScopeFixture = () => {
  const row = (chipId?: string) =>
    HStack(
      [
        chipId
          ? Box({ width: 96, height: 12 }).id(chipId)
          : Box({ width: 96, height: 12 }),
        Box({ width: 96, height: 12 }),
        Box({ width: 96, height: 12 }),
        Spacer(),
      ],
      { gap: 0 },
    )
      .id("chips")
      .frame({ width: 260 });
  const view = Composition(
    World(
      () =>
        row("world-chip")
          .clip()
          .id("inner/slot%1")
          .frame({ width: 200, height: 60 }),
      { size: [200, 120] },
    ),
    {
      size: [200, 120],
      overlay: () =>
        Composition(
          World(() => row(), { size: [200, 120] }),
          {
            size: [200, 120],
          },
        )
          .clip()
          .id("overlay-room%2"),
    },
  )
    .clip()
    .id("stage-window%3");
  return evaluateView(view, {
    time: 0,
    width: 400,
    height: 240,
    measureText: measure,
  });
};

test("clip diagnostics keep their clip-local space so both target paths retain them", () => {
  const layers = inspection([{ id: "main", frame: clipScopeFixture() }]);
  const full = document(layers);
  // The fixture puts the same authored paths in the world and overlay spaces, so a loose
  // path-only filter would wrongly merge two rooms.
  const worldSpace = "stage-window%253/composition/world";
  const overlaySpace = "stage-window%253/composition/overlay";
  assert.ok(
    full.diagnostics.some((entry) => entry.space.startsWith(`${worldSpace}/`)),
    "the world clip must report diagnostics",
  );
  assert.ok(
    full.diagnostics.some((entry) => entry.space.startsWith(overlaySpace)),
    "the overlay clip must report diagnostics",
  );
  const identities = new Set(
    full.diagnostics.map((entry) => `${entry.space}|${entry.path}`),
  );

  for (const id of ["world-chip", "inner/slot%1", "overlay-room%2"]) {
    const target = { scope: "scene:main", id };
    const initial = buildInspectionDocument({
      packageVersion: "0.0.0-test",
      project,
      frame: layers,
      target,
    });
    const secondPass = applyInspectionTarget(full, target);
    assert.deepEqual(
      initial.diagnostics,
      secondPass.diagnostics,
      `${id}: initial targeting must match a second pass over the full report`,
    );
    assert.deepEqual(initial.scenes[0].tree, secondPass.scenes[0].tree, id);
    assert.deepEqual(
      initial.scenes[0].warnings,
      secondPass.scenes[0].warnings,
      `${id}: legacy warning attribution must agree on both paths`,
    );
    assert.ok(
      initial.diagnostics.length > 0,
      `${id}: diagnostics must survive`,
    );
    for (const entry of initial.diagnostics) {
      assert.ok(
        identities.has(`${entry.space}|${entry.path}`),
        `${id}: ${entry.space}|${entry.path} must come from the full report`,
      );
      assert.equal(
        entry.space.split("stage-window%253").length - 1,
        1,
        `${id}: the outer clip prefix appears once in ${entry.space}`,
      );
    }
    // A discarded sibling room keeps neither its diagnostics nor its legacy warnings.
    assert.ok(
      initial.scenes[0].warnings!.length < full.scenes[0].warnings!.length,
      `${id}: sibling warnings are dropped from the narrowed report`,
    );
    // The sibling room in the other coordinate space is dropped, not merged.
    if (id !== "overlay-room%2")
      assert.ok(
        initial.diagnostics.every(
          (entry) => !entry.space.startsWith(overlaySpace),
        ),
        `${id}: the overlay room must be dropped`,
      );
    else
      assert.ok(
        initial.diagnostics.every((entry) =>
          entry.space.startsWith(overlaySpace),
        ),
        `${id}: the world room must be dropped`,
      );
  }
});

test("a clip target drops the same path in another room's coordinate space", () => {
  // Both rooms build the identical authored tree, so only `space` separates them.
  const room = (chipId?: string) =>
    HStack(
      [
        chipId
          ? Box({ width: 96, height: 12 }).id(chipId)
          : Box({ width: 96, height: 12 }),
        Box({ width: 96, height: 12 }),
        Box({ width: 96, height: 12 }),
        Spacer(),
      ],
      { gap: 0 },
    )
      .frame({ width: 260 })
      .clip();
  const frame = evaluateView(
    Composition(
      World(() => room("world-chip"), { size: [200, 120] }),
      {
        size: [200, 120],
        overlay: () => room(),
      },
    ),
    { time: 0, width: 400, height: 240, measureText: measure },
  );
  const layers = inspection([{ id: "main", frame }]);
  const full = document(layers);

  const worldPaths = full.diagnostics
    .filter((entry) => entry.space.startsWith("root/world"))
    .map((entry) => entry.path);
  const overlayPaths = full.diagnostics
    .filter((entry) => entry.space.startsWith("root/overlay"))
    .map((entry) => entry.path);
  assert.ok(worldPaths.length > 0 && overlayPaths.length > 0);
  assert.deepEqual(
    worldPaths,
    overlayPaths,
    "both rooms must author identical paths, so only the space distinguishes them",
  );

  const target = { scope: "scene:main", id: "world-chip" };
  const initial = buildInspectionDocument({
    packageVersion: "0.0.0-test",
    project,
    frame: layers,
    target,
  });
  assert.deepEqual(
    initial.diagnostics,
    applyInspectionTarget(full, target).diagnostics,
    "both target paths keep the same diagnostics",
  );
  assert.equal(
    initial.diagnostics.length,
    worldPaths.length,
    "every world diagnostic survives",
  );
  assert.ok(
    initial.diagnostics.every((entry) => entry.space.startsWith("root/world")),
    "the overlay room's identical paths are excluded by space",
  );
});

test("clip diagnostics keep their error severity through targeting so --fail-on error still fails", () => {
  const layers = inspection([
    {
      id: "main",
      frame: clipScopeFixture(),
    },
    // An unrelated scene with the same authored paths contributes no retained error.
    {
      id: "sibling",
      frame: evaluateView(
        HStack(
          [
            Box({ width: 96, height: 12 }),
            Box({ width: 96, height: 12 }),
            Box({ width: 96, height: 12 }),
            Spacer(),
          ],
          { gap: 0 },
        )
          .id("chips")
          .frame({ width: 100 }),
        { time: 0, width: 400, height: 120, measureText: measure },
      ),
    },
  ]);
  const full = document(layers);
  const errors = (entries: readonly { severity: string }[]) =>
    entries.filter((entry) => entry.severity === "error").length;
  assert.ok(
    errors(full.diagnostics) >= 2,
    "both clip rooms must author errors",
  );

  for (const id of ["world-chip", "inner/slot%1", "overlay-room%2"]) {
    const target = { scope: "scene:main", id };
    const initial = buildInspectionDocument({
      packageVersion: "0.0.0-test",
      project,
      frame: layers,
      target,
    });
    assert.ok(
      errors(initial.diagnostics) >= 1,
      `${id}: a targeted clip keeps its error, so --fail-on error still exits 1`,
    );
    assert.deepEqual(
      initial.diagnostics,
      applyInspectionTarget(full, target).diagnostics,
      id,
    );
    assert.ok(
      initial.diagnostics.every((entry) => entry.scope === "scene:main"),
      `${id}: other scopes are dropped entirely`,
    );
  }
});

test("paint records are whitelisted field by field and never read private objects", () => {
  const forbidden = () => {
    throw Error("non-whitelisted field was read");
  };
  const record = (fields: Record<string, unknown>) =>
    Object.defineProperties(
      {},
      Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [
          key,
          { value, enumerable: true },
        ]),
      ),
    );
  const raw = Object.defineProperties(
    record({
      kind: "box",
      path: "card",
      inspection: { id: 3, nodeId: 4, role: "surface" },
      paintRole: "content",
      space: "scene-target-pixels",
      resolution: [320, 180],
      accuracy: "conservative",
      bounds: { x: 1.5, y: 2, width: 3, height: 4 },
      provenance: "projected-box-draw-quad",
      geometryVisible: true,
    }),
    { fill: { get: forbidden, enumerable: true } },
  );
  assert.deepEqual(paintRecord(raw, "paint"), {
    kind: "box",
    path: "card",
    inspection: { id: 3, nodeId: 4, role: "surface" },
    paintRole: "content",
    space: "scene-target-pixels",
    resolution: [320, 180],
    accuracy: "conservative",
    bounds: { x: 1.5, y: 2, width: 3, height: 4 },
    provenance: "projected-box-draw-quad",
    geometryVisible: true,
  });
  // `unavailable` publishes the reason and never reads or claims bounds.
  const unavailable = Object.defineProperties(
    record({
      kind: "text",
      path: "card",
      paintRole: "content",
      space: "scene-target-pixels",
      resolution: [320, 180],
      accuracy: "unavailable",
      unsupported: "text paint is not collected.",
    }),
    { bounds: { get: forbidden, enumerable: true } },
  );
  const whitelisted = paintRecord(unavailable, "paint");
  assert.equal(whitelisted.accuracy, "unavailable");
  assert.equal(whitelisted.unsupported, "text paint is not collected.");
  assert.ok(!("bounds" in whitelisted), "unavailable carries no bounds");
  // A Text quad publishes the line-box bounds and never reads the raw text run.
  const textQuad = Object.defineProperties(
    record({
      kind: "text",
      path: "label",
      paintRole: "content",
      space: "scene-target-pixels",
      resolution: [320, 180],
      accuracy: "exact-rectangle",
      bounds: { x: 1, y: 2, width: 20, height: 50 },
      provenance: "projected-text-draw-quad",
      geometryVisible: true,
    }),
    { text: { get: forbidden, enumerable: true } },
  );
  assert.deepEqual(paintRecord(textQuad, "paint"), {
    kind: "text",
    path: "label",
    paintRole: "content",
    space: "scene-target-pixels",
    resolution: [320, 180],
    accuracy: "exact-rectangle",
    bounds: { x: 1, y: 2, width: 20, height: 50 },
    provenance: "projected-text-draw-quad",
    geometryVisible: true,
  });
});

test("malformed paint record values and unreadable getters keep their own error kinds", () => {
  const base = {
    kind: "box",
    path: "card",
    paintRole: "background",
    space: "scene-target-pixels",
    resolution: [320, 180] as const,
    accuracy: "exact-rectangle",
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    provenance: "projected-box-draw-quad",
    geometryVisible: false,
  };
  const rejected = (patch: Record<string, unknown>, pattern: RegExp) =>
    assert.throws(
      () => paintRecord({ ...base, ...patch }, "paint"),
      (error: unknown) =>
        error instanceof InspectionSerializationError &&
        pattern.test(error.message),
      pattern.source,
    );
  rejected(
    { bounds: { ...base.bounds, width: Number.NaN } },
    /bounds\.width must be a finite number/,
  );
  rejected({ resolution: [320, 180, 1] }, /must have 2 entries/);
  rejected({ resolution: [320, Number.POSITIVE_INFINITY] }, /resolution\[1\]/);
  rejected(
    { inspection: { id: 1.5, nodeId: 0, role: "content" } },
    /id must be a non-negative safe integer/,
  );
  rejected(
    { inspection: { id: 0, nodeId: -1, role: "content" } },
    /nodeId must be a non-negative safe integer/,
  );
  rejected(
    { inspection: { id: 0, nodeId: 0, role: "paint" } },
    /must be "content" or "background" or "surface"/,
  );
  rejected(
    { paintRole: "surface" },
    /paintRole must be "content" or "background"/,
  );
  rejected({ space: "layout" }, /space must be "scene-target-pixels"/);
  rejected({ accuracy: "exact" }, /accuracy must be/);
  rejected(
    { provenance: "layout-box" },
    /provenance must be "projected-box-draw-quad"/,
  );
  rejected(
    { provenance: "projected-text-draw-quad" },
    /provenance must be "projected-box-draw-quad"/,
  );
  rejected(
    { kind: "text", provenance: "projected-box-draw-quad" },
    /provenance must be "projected-text-draw-quad"/,
  );
  rejected(
    {
      kind: "text",
      provenance: "projected-text-draw-quad",
      bounds: { x: 0, y: 0, width: Number.NaN, height: 10 },
    },
    /bounds\.width must be a finite number/,
  );
  rejected({ geometryVisible: "yes" }, /geometryVisible must be a boolean/);
  rejected(
    { kind: "media", accuracy: "exact-rectangle" },
    /accuracy must be "conservative" when kind is "media"/,
  );
  rejected(
    {
      kind: "media",
      accuracy: "conservative",
      provenance: "projected-box-draw-quad",
    },
    /provenance must be "projected-image-draw-quad" or "projected-video-draw-quad"/,
  );
  rejected(
    {
      kind: "media",
      accuracy: "conservative",
      provenance: "projected-text-draw-quad",
    },
    /provenance must be "projected-image-draw-quad" or "projected-video-draw-quad"/,
  );
  rejected(
    { provenance: "projected-image-draw-quad" },
    /provenance must be "projected-box-draw-quad"/,
  );
  rejected(
    { kind: "text", provenance: "projected-video-draw-quad" },
    /provenance must be "projected-text-draw-quad"/,
  );
  rejected({ kind: "group" }, /kind must be "box" or "text" or "media"/);

  assert.throws(
    () =>
      paintRecord(
        Object.defineProperties(
          { ...base },
          {
            path: {
              enumerable: true,
              get: () => {
                throw Error("path getter exploded");
              },
            },
          },
        ),
        "paint",
      ),
    (error: unknown) =>
      error instanceof InspectionReadError &&
      /path getter exploded/.test(error.message),
  );

  assert.throws(
    () => paintRecord(base, "paint", new InspectionBudget(40)),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /over the 40-byte/.test(error.message),
  );
});

/** Raw geometry-branch paint record; each boundary test overrides exactly the field it rejects. */
function paintFields(patch: Record<string, unknown> = {}) {
  return {
    kind: "box",
    path: "card",
    paintRole: "content",
    space: "scene-target-pixels",
    resolution: [320, 180],
    accuracy: "exact-rectangle",
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    provenance: "projected-box-draw-quad",
    geometryVisible: false,
    ...patch,
  };
}

test("paint record budget covers every published field before the record is built", () => {
  const identity = { id: 3, nodeId: 4, role: "surface" };
  const branches = {
    "geometry without identity": paintFields(),
    "geometry with identity": paintFields({ inspection: identity }),
    "text geometry without identity": paintFields({
      kind: "text",
      provenance: "projected-text-draw-quad",
    }),
    "text geometry with identity": paintFields({
      kind: "text",
      provenance: "projected-text-draw-quad",
      inspection: identity,
    }),
    "image media geometry": paintFields({
      kind: "media",
      accuracy: "conservative",
      provenance: "projected-image-draw-quad",
    }),
    "video media geometry with identity": paintFields({
      kind: "media",
      accuracy: "conservative",
      provenance: "projected-video-draw-quad",
      inspection: identity,
    }),
    "unavailable without identity": paintFields({
      kind: "text",
      accuracy: "unavailable",
      unsupported: "text paint is not collected.",
    }),
    "unavailable with identity": paintFields({
      kind: "text",
      inspection: identity,
      accuracy: "unavailable",
      unsupported: "text paint is not collected.",
    }),
  };
  for (const [label, raw] of Object.entries(branches)) {
    const budget = new InspectionBudget();
    const published = paintRecord(raw, "paint", budget);
    // The budget is a UTF-8 byte count, the same unit as MAX_INSPECTION_BYTES.
    const bytes = new TextEncoder().encode(JSON.stringify(published)).length;
    assert.equal(
      budget.bytes,
      bytes,
      `${label}: charged bytes must equal the published JSON instead of trailing it`,
    );
    assert.deepEqual(
      paintRecord(raw, "paint", new InspectionBudget(bytes)),
      published,
      `${label}: the exact published size is allowed`,
    );
    assert.throws(
      () => paintRecord(raw, "paint", new InspectionBudget(bytes - 1)),
      (error: unknown) =>
        error instanceof InspectionSerializationError &&
        error.message.includes(`${bytes} bytes of UTF-8`),
      `${label}: one byte under must fail`,
    );
  }
});

test("an exhausted paint budget stops before the next field getter is read", () => {
  let readPath = 0;
  let readBounds = 0;
  const record = Object.defineProperties(
    { kind: "box" } as Record<string, unknown>,
    {
      path: {
        enumerable: true,
        get: () => {
          readPath++;
          return "card";
        },
      },
      paintRole: { value: "content", enumerable: true },
      space: { value: "scene-target-pixels", enumerable: true },
      resolution: { value: [320, 180], enumerable: true },
      accuracy: { value: "exact-rectangle", enumerable: true },
      bounds: {
        enumerable: true,
        get: () => {
          readBounds++;
          return { x: 0, y: 0, width: 10, height: 10 };
        },
      },
      provenance: { value: "projected-box-draw-quad", enumerable: true },
      geometryVisible: { value: false, enumerable: true },
    },
  );
  // The 65-byte structure charge fits; charging `kind` pushes past the limit.
  assert.throws(
    () => paintRecord(record, "paint", new InspectionBudget(66)),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /over the 66-byte/.test(error.message),
  );
  assert.equal(
    readPath,
    0,
    "`path` is never read once the budget is exhausted",
  );
  assert.equal(readBounds, 0, "the geometry branch is never entered");
});

test("rejected paint values are described by type and never coerced", () => {
  let coerced = 0;
  const hostile = Object.defineProperties(
    {},
    {
      [Symbol.toPrimitive]: {
        get: () => {
          coerced++;
          throw Error("Symbol.toPrimitive was read");
        },
      },
      toString: {
        get: () => {
          coerced++;
          throw Error("toString was read");
        },
      },
    },
  );
  const rejection = (patch: Record<string, unknown>) => {
    try {
      paintRecord(paintFields(patch), "paint");
    } catch (error) {
      assert.ok(
        error instanceof InspectionSerializationError,
        `expected a serialization error, received ${String(error)}`,
      );
      return error.message;
    }
    throw Error("paint record must be rejected");
  };
  assert.match(
    rejection({ bounds: { x: 0, y: 0, width: hostile, height: 1 } }),
    /bounds\.width must be a finite number, received an object\./,
  );
  assert.match(
    rejection({ paintRole: hostile }),
    /paintRole must be "content" or "background", received an object\./,
  );
  assert.match(
    rejection({ inspection: { id: hostile, nodeId: 0, role: "content" } }),
    /inspection\.id must be a non-negative safe integer, received an object\./,
  );
  assert.match(
    rejection({ accuracy: Symbol("accuracy") }),
    /received a symbol\./,
  );
  assert.match(
    rejection({ provenance: () => "projected-box-draw-quad" }),
    /received a function\./,
  );
  assert.match(
    rejection({ bounds: null }),
    /bounds must be an object, received null\./,
  );
  assert.equal(coerced, 0, "no rejected value had its coercion hooks read");
});

test("a revoked proxy array reports a read error at the shared list boundary", () => {
  const revokedArray = () => {
    const { proxy, revoke } = Proxy.revocable<readonly unknown[]>(
      [320, 180],
      {},
    );
    revoke();
    return proxy;
  };
  assert.throws(
    () => paintRecord(paintFields({ resolution: revokedArray() }), "paint"),
    (error: unknown) =>
      error instanceof InspectionReadError && /revoked/.test(error.message),
  );

  const frame = { ...authoredFrame(), commands: revokedArray() };
  const built = document(
    inspection([{ id: "revoked", frame }, { id: "fine" }]),
  );
  assert.equal(built.scenes[0].inspection, "unavailable");
  assert.match(
    built.scenes[0].unavailable!,
    /revoked/,
    "one revoked array degrades its scope instead of failing the inspection",
  );
  assert.equal(built.scenes[1].inspection, "available");
});

test("resolution tuples reject unreadable indices and holes through the read boundary", () => {
  const throwingIndex = new Proxy([320, 180] as readonly unknown[], {
    get(target, property, receiver) {
      if (property === "1") throw Error("resolution index exploded");
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(
    () => paintRecord(paintFields({ resolution: throwingIndex }), "paint"),
    (error: unknown) =>
      error instanceof InspectionReadError &&
      /resolution index exploded/.test(error.message),
  );
  const hole = [320];
  hole.length = 2;
  assert.throws(
    () => paintRecord(paintFields({ resolution: hole }), "paint"),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /resolution\[1\] must be a finite number, received undefined\./.test(
        error.message,
      ),
  );
  assert.throws(
    () => paintRecord(paintFields({ resolution: [320] }), "paint"),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /resolution must have 2 entries, received 1\./.test(error.message),
  );
});

/** Minimal layout node for identity fixtures; patch fields land beside these defaults. */
function plainNode(fields: Record<string, unknown> = {}) {
  return {
    path: "root",
    kind: "box",
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    transform: [1, 1, 0, 0],
    children: [],
    ...fields,
  };
}

/**
 * One raw frame with a single layout node and command. The node is assigned, never spread,
 * so a fixture may pass an object whose properties are getters.
 */
function identityFrame(
  node: unknown = plainNode(),
  command: Record<string, unknown> = {},
) {
  const bounds = { x: 0, y: 0, width: 10, height: 10 };
  return {
    requestedTime: 0,
    effectiveTime: 0,
    scenes: [
      {
        id: "main",
        name: "Main",
        time: 0,
        localTime: 0,
        progress: 0,
        frame: {
          tree: node,
          commands: [
            {
              kind: "box",
              path: "root",
              bounds,
              transform: [1, 1, 0, 0],
              opacity: 1,
              ...command,
            },
          ],
          warnings: [],
        },
      },
    ],
  } as unknown as FrameInspection;
}

/** Smallest limit at which the document builds, found by bisection. */
function minimumBudget(frame: FrameInspection): number {
  const builds = (limit: number) => {
    try {
      buildInspectionDocument({
        packageVersion: "0.0.0-test",
        project,
        frame,
        limit,
      });
      return true;
    } catch {
      return false;
    }
  };
  let low = 0;
  let high = 1 << 20;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (builds(mid)) high = mid;
    else low = mid + 1;
  }
  return low;
}

test("node and command identities are charged exactly and before the record is published", () => {
  const nodeIdentity = { inspectionId: 7 };
  const commandIdentity = {
    inspection: { id: 3, nodeId: 4, role: "surface" },
  };
  const baseline = identityFrame();
  const baseBytes = measureInspection(document(baseline));
  const baseLimit = minimumBudget(baseline);
  assert.equal(
    minimumBudget(baseline),
    baseLimit,
    "bisection must be stable for the plain frame",
  );
  for (const [label, patch] of Object.entries({
    "node identity": identityFrame(plainNode(nodeIdentity)),
    "command identity": identityFrame(plainNode(), commandIdentity),
    "both identities": identityFrame(plainNode(nodeIdentity), commandIdentity),
  })) {
    const bytes = measureInspection(document(patch)) - baseBytes;
    const charged = minimumBudget(patch) - baseLimit;
    assert.ok(bytes > 0, `${label}: the published JSON must grow`);
    assert.equal(
      charged,
      bytes,
      `${label}: charged bytes must equal the published JSON instead of trailing it`,
    );
    assert.throws(
      () =>
        buildInspectionDocument({
          packageVersion: "0.0.0-test",
          project,
          frame: patch,
          limit: baseLimit + bytes - 1,
        }),
      (error: unknown) =>
        error instanceof InspectionSerializationError &&
        error.message.includes("bytes of UTF-8"),
      `${label}: one byte under must fail`,
    );
  }
});

test("both target paths retain node and command identities from the full report", () => {
  // Two rooms authorize the same paths under different spaces, and the overlay nests one more
  // composition. Only `space` and the identity counter tell their nodes apart, so a path-based
  // owner lookup would hand one room's paint to the other room's node.
  const room = (label: string) =>
    HStack([
      Box({ width: 20, height: 10 })
        .background({ fill: "#FF0000" })
        .id(`${label}-card`),
      Box({ width: 10, height: 10 }),
    ]).id(`${label}-row`);
  const view = Composition(
    World(() => room("world").frame({ width: 60 }), { size: [100, 80] }),
    {
      size: [100, 80],
      overlay: () =>
        Composition(
          World(() => room("overlay").frame({ width: 60 }), {
            size: [100, 80],
          }),
          { size: [100, 80] },
        ).id("overlay-room"),
    },
  ).id("viewport");
  const frame = evaluateView(view, {
    time: 0,
    width: 100,
    height: 80,
    measureText: measure,
    inspection: true,
  });
  const layers = inspection([{ id: "main", frame }]);
  const full = document(layers);

  type Node = {
    path: string;
    space?: string;
    id?: string;
    inspectionId?: number;
    children: readonly Node[];
  };
  const flat = (root: Node) => {
    const out: string[] = [];
    const walk = (node: Node) => {
      out.push(
        `${node.space ?? "layout"}|${node.path}|${node.id ?? "-"}|${node.inspectionId ?? "-"}`,
      );
      node.children.forEach(walk);
    };
    walk(root);
    return out;
  };
  const commandKeys = (
    entries: readonly {
      path: string;
      space?: string;
      inspection?: unknown;
    }[],
  ) =>
    entries.map(
      (entry) =>
        `${entry.space ?? "layout"}|${entry.path}|${JSON.stringify(entry.inspection)}`,
    );

  const fullTree = flat(full.scenes[0].tree as unknown as Node);
  const fullCommands = commandKeys(full.scenes[0].commands ?? []);
  assert.ok(
    fullTree.every((entry) => !entry.endsWith("|-")),
    "every real node carries an inspectionId when inspection is enabled",
  );
  assert.ok(
    fullCommands.length > 0 &&
      fullCommands.every((entry) => entry.includes('"nodeId"')),
    "every paint of an inspection-enabled frame carries its own identity",
  );
  // The two rooms really do publish the same authored paths in different spaces.
  assert.ok(
    fullTree.some(
      (entry) =>
        entry.startsWith("viewport/world|") && entry.includes("|world-card|"),
    ),
    "the world room is present",
  );
  assert.ok(
    fullTree.some(
      (entry) =>
        entry.startsWith("viewport/overlay/") &&
        entry.includes("|overlay-card|"),
    ),
    "the overlay room is present",
  );

  // `dropped` is the twin room's space prefix, which must not survive at all.
  for (const [id, dropped, cardId] of [
    ["world-card", "viewport/overlay", "world-card"],
    ["overlay-card", "viewport/world", "overlay-card"],
    ["world-row", "viewport/overlay", "world-card"],
    ["overlay-room", "viewport/world", "overlay-card"],
    ["viewport", undefined, "world-card"],
  ] as const) {
    const target = { scope: "scene:main", id };
    const initial = buildInspectionDocument({
      packageVersion: "0.0.0-test",
      project,
      frame: layers,
      target,
    });
    const secondPass = applyInspectionTarget(full, target);
    const tree = flat(initial.scenes[0].tree as unknown as Node);
    assert.deepEqual(
      tree,
      flat(secondPass.scenes[0].tree as unknown as Node),
      `${id}: pruning must keep the same node identities as direct construction`,
    );
    assert.deepEqual(
      commandKeys(initial.scenes[0].commands ?? []),
      commandKeys(secondPass.scenes[0].commands ?? []),
      `${id}: pruning must keep the same command identities as direct construction`,
    );
    for (const entry of tree) {
      assert.ok(
        fullTree.includes(entry),
        `${id}: ${entry} must keep the identity the full report published`,
      );
    }
    for (const entry of commandKeys(initial.scenes[0].commands ?? [])) {
      assert.ok(
        fullCommands.includes(entry),
        `${id}: kept command ${entry} must match the full report`,
      );
    }
    if (id !== "viewport")
      assert.ok(
        tree.length < fullTree.length,
        `${id}: the discarded sibling branch is dropped`,
      );

    // The retained paint names the node that emitted it, in its own room and space.
    const nodes = new Map<string, Node>();
    const index = (node: Node) => {
      nodes.set(`${node.space ?? "layout"}|${node.path}`, node);
      node.children.forEach(index);
    };
    index(initial.scenes[0].tree as unknown as Node);
    for (const entry of initial.scenes[0].commands ?? []) {
      const owner = nodes.get(`${entry.space ?? "layout"}|${entry.path}`);
      assert.equal(
        entry.inspection?.nodeId,
        owner?.inspectionId,
        `${id}: ${entry.path} in ${entry.space ?? "layout"} must name its emitting node`,
      );
    }
    // Only the target room survives, with its own authored IDs, never the twin's.
    assert.ok(
      tree.some((entry) => entry.includes(`|${cardId}|`)),
      `${id}: the target room keeps its ${cardId} node`,
    );
    if (dropped)
      assert.ok(
        tree.every((entry) => !entry.startsWith(`${dropped}|`)),
        `${id}: the twin room under ${dropped} is dropped`,
      );
    else
      assert.ok(
        tree.some((entry) => entry.startsWith("viewport/overlay|")) &&
          tree.some((entry) => entry.startsWith("viewport/world|")),
        `${id}: targeting the root keeps both rooms`,
      );
  }

  // A missing or ambiguous authored ID fails the same way on both paths.
  assert.throws(
    () =>
      buildInspectionDocument({
        packageVersion: "0.0.0-test",
        project,
        frame: layers,
        target: { scope: "scene:main", id: "absent" },
      }),
    (error: unknown) =>
      error instanceof InspectionTargetError &&
      /No node has ID "absent"/.test(error.message),
  );
  assert.throws(
    () => applyInspectionTarget(full, { scope: "scene:main", id: "absent" }),
    (error: unknown) => error instanceof InspectionTargetError,
  );
});

test("an invalid identity is rejected through the existing value boundaries", () => {
  const reject = (
    node: Record<string, unknown>,
    command: Record<string, unknown>,
    pattern: RegExp,
  ) =>
    assert.throws(
      () => document(identityFrame(plainNode(node), command)),
      (error: unknown) =>
        error instanceof InspectionSerializationError &&
        pattern.test(error.message),
      pattern.source,
    );
  reject(
    { inspectionId: 1.5 },
    {},
    /inspectionId must be a non-negative safe integer/,
  );
  reject(
    { inspectionId: -1 },
    {},
    /inspectionId must be a non-negative safe integer/,
  );
  reject(
    { inspectionId: "7" },
    {},
    /inspectionId must be a non-negative safe integer/,
  );
  reject(
    {},
    { inspection: { id: 1, nodeId: 2, role: "border" } },
    /must be "content" or "background" or "surface"/,
  );
  reject(
    {},
    { inspection: { id: -1, nodeId: 2, role: "content" } },
    /inspection\.id must be a non-negative safe integer/,
  );
  reject(
    {},
    { inspection: { id: 1, nodeId: null, role: "content" } },
    /inspection\.nodeId must be a non-negative safe integer/,
  );

  const throwing = Object.defineProperties(plainNode(), {
    inspectionId: {
      enumerable: true,
      get: () => {
        throw Error("inspectionId getter exploded");
      },
    },
  });
  const built = document(identityFrame(throwing));
  assert.equal(built.scenes[0].inspection, "unavailable");
  assert.match(built.scenes[0].unavailable!, /inspectionId getter exploded/);

  let coerced = 0;
  const hostile = Object.defineProperties(
    {},
    {
      [Symbol.toPrimitive]: {
        get: () => {
          coerced++;
          throw Error("Symbol.toPrimitive was read");
        },
      },
      toString: {
        get: () => {
          coerced++;
          throw Error("toString was read");
        },
      },
    },
  );
  assert.throws(
    () => document(identityFrame(plainNode({ inspectionId: hostile }))),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /received an object/.test(error.message),
  );
  assert.equal(
    coerced,
    0,
    "no rejected identity value had its coercion hooks read",
  );
});

test("an exhausted budget stops before the identity getters are read", () => {
  let readNodeId = 0;
  let readCommandId = 0;
  const node = Object.defineProperties(plainNode(), {
    inspectionId: {
      enumerable: true,
      get: () => {
        readNodeId++;
        return 1;
      },
    },
  });
  const frame = identityFrame(node);
  // The 47-byte node header charge fits; charging `path` pushes past the limit.
  assert.throws(
    () =>
      buildInspectionDocument({
        packageVersion: "0.0.0-test",
        project,
        frame,
        limit: 48,
      }),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /over the 48-byte/.test(error.message),
  );
  assert.equal(readNodeId, 0, "the node identity is never read");

  // A command path longer than the whole budget: charging it must stop the read before the
  // identity key is even looked at. The command is assigned rather than spread, so its
  // getters survive into the report.
  const longPath = identityFrame();
  longPath.scenes[0].frame!.commands = [
    Object.defineProperties(
      { kind: "box", opacity: 1 },
      {
        path: { value: "p".repeat(4096), enumerable: true },
        bounds: {
          value: { x: 0, y: 0, width: 10, height: 10 },
          enumerable: true,
        },
        transform: { value: [1, 1, 0, 0], enumerable: true },
        inspection: {
          enumerable: true,
          get: () => {
            readCommandId++;
            return { id: 1, nodeId: 1, role: "content" };
          },
        },
      },
    ),
  ] as never;
  assert.throws(
    () =>
      buildInspectionDocument({
        packageVersion: "0.0.0-test",
        project,
        frame: longPath,
        limit: 1000,
      }),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /over the 1000-byte/.test(error.message),
  );
  assert.equal(readCommandId, 0, "the command identity is never read");
});

/** One raw frame whose provider may or may not publish a paint record collection. */
function recordsFrame(
  tree: unknown,
  records?: readonly unknown[],
): FrameInspection {
  return {
    requestedTime: 0,
    effectiveTime: 0,
    scenes: [
      {
        id: "main",
        name: "Main",
        time: 0,
        localTime: 0,
        progress: 0,
        frame: {
          tree,
          commands: [],
          warnings: [],
          ...(records === undefined ? {} : { paintRecords: records }),
        },
      },
    ],
  } as unknown as FrameInspection;
}

/**
 * Two rooms that author the same `root/card` path in different spaces, so only `inspectionId`
 * names the owner of a paint record. Node 2 is the target; node 7 is a sibling of its row.
 */
function twoRoomTree() {
  const node = (
    path: string,
    inspectionId: number,
    {
      space,
      id,
      children = [],
    }: {
      space?: string;
      id?: string;
      children?: unknown[];
    } = {},
  ) => ({
    path,
    kind: "box",
    ...(space === undefined ? {} : { space }),
    ...(id === undefined ? {} : { id }),
    inspectionId,
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    transform: [1, 1, 0, 0],
    children,
  });
  return node("root", 0, {
    children: [
      node("root/row-a", 1, {
        space: "a",
        id: "row-a",
        children: [
          node("root/card", 2, {
            space: "a",
            id: "target",
            children: [node("root/card/leaf", 3, { space: "a" })],
          }),
          node("root/sibling", 7, { space: "a" }),
        ],
      }),
      node("root/row-b", 4, {
        space: "b",
        id: "row-b",
        children: [
          node("root/card", 5, {
            space: "b",
            id: "other-card",
            children: [node("root/card/leaf", 6, { space: "b" })],
          }),
        ],
      }),
    ],
  });
}

/** Identity a real collector stamps from the frame's one counter: record `id` and owner `nodeId`. */
function owner(nodeId: number) {
  return { id: nodeId, nodeId, role: "content" as const };
}

/** Every published record as `<owner>|<space>|<path>`, which is what attribution must decide. */
function recordKeys(
  entries: readonly {
    path: string;
    space: string;
    inspection?: { nodeId: number };
  }[],
) {
  return entries.map(
    (entry) =>
      `${entry.inspection?.nodeId ?? "-"}|${entry.space}|${entry.path}`,
  );
}

/** One record per node of {@link twoRoomTree}, plus an untagged and an orphan record. */
function twoRoomRecords() {
  return [
    paintFields({ path: "root", inspection: owner(0) }),
    paintFields({ path: "root/row-a", inspection: owner(1) }),
    paintFields({ path: "root/card", inspection: owner(2) }),
    paintFields({ path: "root/card/leaf", inspection: owner(3) }),
    paintFields({ path: "root/sibling", inspection: owner(7) }),
    paintFields({ path: "root/row-b", inspection: owner(4) }),
    paintFields({ path: "root/card", inspection: owner(5) }),
    paintFields({ path: "root/card/leaf", inspection: owner(6) }),
    paintFields({ path: "root/card" }),
    paintFields({ path: "root/card", inspection: owner(99) }),
  ];
}

test("a paint record collection is published only when the provider supplies one", () => {
  const absent = document(recordsFrame(twoRoomTree())).scenes[0];
  assert.equal(
    "paintRecords" in absent,
    false,
    "a provider without a collection publishes no field instead of an empty one",
  );
  const empty = document(recordsFrame(twoRoomTree(), [])).scenes[0];
  assert.deepEqual(
    empty.paintRecords,
    [],
    "an available collection with no records is empty, not absent",
  );
  const built = document(
    recordsFrame(twoRoomTree(), [
      paintFields({ path: "root/card", inspection: owner(2) }),
      paintFields({
        kind: "text",
        path: "root/card/leaf",
        inspection: owner(3),
        accuracy: "unavailable",
        unsupported: "text paint is not collected.",
      }),
    ]),
  ).scenes[0];
  assert.deepEqual(recordKeys(built.paintRecords!), [
    "2|scene-target-pixels|root/card",
    "3|scene-target-pixels|root/card/leaf",
  ]);
  assert.equal(built.paintRecords![0].accuracy, "exact-rectangle");
  assert.deepEqual(built.paintRecords![1], {
    kind: "text",
    path: "root/card/leaf",
    inspection: owner(3),
    paintRole: "content",
    space: "scene-target-pixels",
    resolution: [320, 180],
    accuracy: "unavailable",
    unsupported: "text paint is not collected.",
  });
  // The untargeted report publishes every valid record, including ones no node owns.
  const full = document(recordsFrame(twoRoomTree(), twoRoomRecords()))
    .scenes[0];
  assert.deepEqual(recordKeys(full.paintRecords!), [
    "0|scene-target-pixels|root",
    "1|scene-target-pixels|root/row-a",
    "2|scene-target-pixels|root/card",
    "3|scene-target-pixels|root/card/leaf",
    "7|scene-target-pixels|root/sibling",
    "4|scene-target-pixels|root/row-b",
    "5|scene-target-pixels|root/card",
    "6|scene-target-pixels|root/card/leaf",
    "-|scene-target-pixels|root/card",
    "99|scene-target-pixels|root/card",
  ]);
});

test("both target paths attribute paint records by owner identity, never by path or space", () => {
  const frame = recordsFrame(twoRoomTree(), twoRoomRecords());
  const target = { scope: "scene:main", id: "target" };
  const initial = buildInspectionDocument({
    packageVersion: "0.0.0-test",
    project,
    frame,
    target,
  });
  const secondPass = applyInspectionTarget(document(frame), target);
  // Ancestors 0 and 1, the target 2, and its descendant 3 stay. The sibling 7 and the twin
  // room's 5 are dropped even though 5 carries the same `root/card` path, so nothing leaks
  // through path association; the untagged and orphan records cannot be attributed at all.
  const expected = [
    "0|scene-target-pixels|root",
    "1|scene-target-pixels|root/row-a",
    "2|scene-target-pixels|root/card",
    "3|scene-target-pixels|root/card/leaf",
  ];
  assert.deepEqual(recordKeys(initial.scenes[0].paintRecords!), expected);
  assert.deepEqual(
    initial.scenes[0].paintRecords,
    secondPass.scenes[0].paintRecords,
    "direct construction and pruning must publish the same records",
  );
  // Every published record is a whitelisted copy, never the provider's own object.
  const raw = twoRoomRecords();
  const copies = document(recordsFrame(twoRoomTree(), raw)).scenes[0]
    .paintRecords!;
  for (const record of copies) assert.ok(!raw.includes(record as never));

  // A missing target still fails on both paths, and neither publishes records.
  assert.throws(
    () =>
      buildInspectionDocument({
        packageVersion: "0.0.0-test",
        project,
        frame,
        target: { scope: "scene:main", id: "absent" },
      }),
    (error: unknown) => error instanceof InspectionTargetError,
  );
  assert.throws(
    () =>
      applyInspectionTarget(document(frame), {
        scope: "scene:main",
        id: "absent",
      }),
    (error: unknown) => error instanceof InspectionTargetError,
  );
});

test("target filtering keeps a Text draw quad only for a uniquely retained owner", () => {
  const kept = paintFields({
    kind: "text",
    path: "root/card",
    provenance: "projected-text-draw-quad",
    inspection: owner(2),
  });
  const droppedSibling = paintFields({
    kind: "text",
    path: "root/sibling",
    provenance: "projected-text-draw-quad",
    inspection: owner(7),
  });
  const untagged = paintFields({
    kind: "text",
    path: "root/card",
    provenance: "projected-text-draw-quad",
  });
  const frame = recordsFrame(twoRoomTree(), [kept, droppedSibling, untagged]);
  const target = { scope: "scene:main", id: "target" };
  const initial = buildInspectionDocument({
    packageVersion: "0.0.0-test",
    project,
    frame,
    target,
  });
  const secondPass = applyInspectionTarget(document(frame), target);
  assert.deepEqual(recordKeys(initial.scenes[0].paintRecords!), [
    "2|scene-target-pixels|root/card",
  ]);
  const published = initial.scenes[0].paintRecords![0];
  assert.equal(published.kind, "text");
  if (published.accuracy === "unavailable")
    assert.fail("a retained Text quad must keep its geometry");
  assert.equal(published.provenance, "projected-text-draw-quad");
  assert.deepEqual(
    initial.scenes[0].paintRecords,
    secondPass.scenes[0].paintRecords,
  );
  const full = document(frame).scenes[0].paintRecords!;
  assert.equal(
    full.length,
    3,
    "an untargeted report still publishes every Text record",
  );
  assert.ok(!full.includes(kept as never), "published records are copies");
});

test("a duplicate node inspection ID makes its paint records unattributable on both paths", () => {
  const tree = twoRoomTree() as { children: { children: unknown[] }[] };
  // A second node carrying ID 2 outside the target's retained subtree: the ID no longer names
  // exactly one node, so neither path may hand its record to either candidate.
  tree.children[1].children.push({
    path: "root/row-b/duplicate",
    kind: "box",
    space: "b",
    inspectionId: 2,
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    transform: [1, 1, 0, 0],
    children: [],
  });
  const frame = recordsFrame(tree, twoRoomRecords());
  const target = { scope: "scene:main", id: "target" };
  const initial = buildInspectionDocument({
    packageVersion: "0.0.0-test",
    project,
    frame,
    target,
  });
  const secondPass = applyInspectionTarget(document(frame), target);
  const expected = [
    "0|scene-target-pixels|root",
    "1|scene-target-pixels|root/row-a",
    "3|scene-target-pixels|root/card/leaf",
  ];
  assert.deepEqual(recordKeys(initial.scenes[0].paintRecords!), expected);
  assert.deepEqual(
    recordKeys(secondPass.scenes[0].paintRecords!),
    expected,
    "uniqueness is decided on the full tree before pruning drops the twin branch",
  );
  // The untargeted report still publishes the record; it is raw metadata, not an attribution.
  assert.ok(
    recordKeys(document(frame).scenes[0].paintRecords!).includes(
      "2|scene-target-pixels|root/card",
    ),
  );
});

test("malformed or unreadable paint records keep their own error kinds under targeting", () => {
  const target = { scope: "scene:main", id: "target" };
  const build = (frame: FrameInspection, targeted = false) =>
    buildInspectionDocument({
      packageVersion: "0.0.0-test",
      project,
      frame,
      ...(targeted ? { target } : {}),
    });
  // Readable but malformed identity data rejects the document instead of publishing it.
  for (const targeted of [false, true])
    assert.throws(
      () =>
        build(
          recordsFrame(twoRoomTree(), [
            paintFields({ inspection: { id: 1, nodeId: -1, role: "content" } }),
          ]),
          targeted,
        ),
      (error: unknown) =>
        error instanceof InspectionSerializationError &&
        /nodeId must be a non-negative safe integer/.test(error.message),
      `targeted=${targeted}: a malformed owner ID is a serialization error`,
    );
  assert.throws(
    () =>
      build(
        recordsFrame(twoRoomTree(), [paintFields({ accuracy: "unavailable" })]),
      ),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /unsupported must be a string/.test(error.message),
  );
  // A throwing getter degrades only its own scope instead of failing the whole inspection.
  let reads = 0;
  const throwing = () => {
    const record = paintFields({ inspection: owner(2) });
    Object.defineProperty(record.inspection!, "nodeId", {
      enumerable: true,
      get: () => {
        reads++;
        throw Error("nodeId getter exploded");
      },
    });
    return record;
  };
  const built = build({
    ...recordsFrame(twoRoomTree()),
    scenes: [
      ...recordsFrame(twoRoomTree(), [throwing()]).scenes,
      ...inspection([{ id: "fine" }]).scenes,
    ],
  } as unknown as FrameInspection);
  assert.equal(built.scenes[0].inspection, "unavailable");
  assert.match(built.scenes[0].unavailable!, /nodeId getter exploded/);
  assert.equal(built.scenes[1].inspection, "available");
  assert.equal(reads, 1, "the throwing getter is read once");
  // The targeted path keeps the existing error for a scope that degraded to unavailable.
  assert.throws(
    () => build(recordsFrame(twoRoomTree(), [throwing()]), true),
    (error: unknown) =>
      error instanceof InspectionTargetError &&
      /no layout tree to target: Main inspection failed: .*nodeId getter exploded/.test(
        error.message,
      ),
  );
  // A non-array collection is malformed; a revoked proxy is a read error.
  assert.throws(
    () => build(recordsFrame(twoRoomTree(), { length: 1 } as never)),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /paintRecords must be an array/.test(error.message),
  );
  const revokedProxy = () => {
    const { proxy, revoke } = Proxy.revocable<readonly unknown[]>(
      twoRoomRecords(),
      {},
    );
    revoke();
    return proxy;
  };
  const revoked = build(recordsFrame(twoRoomTree(), revokedProxy()));
  assert.equal(revoked.scenes[0].inspection, "unavailable");
  assert.match(revoked.scenes[0].unavailable!, /revoked/);
});

test("a paint record collection charges its field and elements before reading a record", () => {
  const plainLimit = minimumBudget(recordsFrame(twoRoomTree()));
  const emptyFrame = recordsFrame(twoRoomTree(), []);
  assert.equal(
    minimumBudget(emptyFrame) - plainLimit,
    18,
    '`,"paintRecords":[]` is charged exactly',
  );
  let readPath = 0;
  const record = paintFields({ inspection: owner(2) });
  Object.defineProperty(record, "path", {
    enumerable: true,
    get: () => {
      readPath++;
      return "root/card";
    },
  });
  const oneFrame = recordsFrame(twoRoomTree(), [record]);
  // The structure charge lands first: one byte less and the collection is refused unread.
  assert.throws(
    () =>
      buildInspectionDocument({
        packageVersion: "0.0.0-test",
        project,
        frame: oneFrame,
        limit: plainLimit + 17,
      }),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /over the/.test(error.message),
  );
  assert.equal(
    readPath,
    0,
    "no record field is read while the field charge fails",
  );
  assert.throws(
    () =>
      buildInspectionDocument({
        packageVersion: "0.0.0-test",
        project,
        frame: oneFrame,
        limit: plainLimit + 18,
      }),
    (error: unknown) => error instanceof InspectionSerializationError,
  );
  assert.equal(
    readPath,
    0,
    "the record structure charge precedes its first field",
  );
  // The published byte growth and the charged growth match exactly, so the budget never trails.
  const plainBytes = measureInspection(
    buildInspectionDocument({
      packageVersion: "0.0.0-test",
      project,
      frame: recordsFrame(twoRoomTree()),
    }),
  );
  const oneBytes =
    measureInspection(
      buildInspectionDocument({
        packageVersion: "0.0.0-test",
        project,
        frame: oneFrame,
      }),
    ) - plainBytes;
  assert.ok(
    oneBytes > 18,
    "one record grows the published JSON past its brackets",
  );
  assert.equal(
    minimumBudget(oneFrame) - plainLimit,
    oneBytes,
    "charged bytes must equal the published JSON instead of trailing it",
  );
  readPath = 0;
  assert.doesNotThrow(() =>
    buildInspectionDocument({
      packageVersion: "0.0.0-test",
      project,
      frame: oneFrame,
      limit: plainLimit + oneBytes,
    }),
  );
  assert.equal(readPath, 1, "the exact published size reads the record once");
  // A second record pays its own separator, and both stay exact.
  let secondReads = 0;
  const second = paintFields({ path: "root/card/leaf", inspection: owner(3) });
  Object.defineProperty(second, "path", {
    enumerable: true,
    get: () => {
      secondReads++;
      return "root/card/leaf";
    },
  });
  const twoFrame = recordsFrame(twoRoomTree(), [record, second]);
  const twoBytes =
    measureInspection(
      buildInspectionDocument({
        packageVersion: "0.0.0-test",
        project,
        frame: twoFrame,
      }),
    ) - plainBytes;
  assert.equal(
    minimumBudget(twoFrame) - plainLimit,
    twoBytes,
    "each record and its separating comma are charged",
  );
  // Stop the budget at the second record's own structure charge (65) plus its comma (1), so that
  // record is refused before any of its fields is read.
  secondReads = 0;
  assert.throws(
    () =>
      buildInspectionDocument({
        packageVersion: "0.0.0-test",
        project,
        frame: twoFrame,
        limit: plainLimit + oneBytes + 1 + 64,
      }),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /over the/.test(error.message),
  );
  assert.equal(
    secondReads,
    0,
    "an exhausted budget stops before the next record's first field",
  );
});

/** Minimal geometry every raw node in the target-work fixtures carries. */
const workGeometry = {
  bounds: { x: 0, y: 0, width: 10, height: 10 },
  transform: [1, 1, 0, 0],
};

/**
 * A proxy child array of `count` entries: every third entry is a primitive and the rest are holes,
 * so no entry is ever a real node.
 */
function sparseChildren(count: number, reads: { index: number }) {
  return new Proxy(new Array(count), {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) {
        reads.index++;
        return Number(property) % 3 === 0 ? "primitive" : undefined;
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

/** `root` with one child of `count` non-node entries beside the leaf target. */
function workTree(count: number, reads: { index: number } = { index: 0 }) {
  return {
    path: "root",
    kind: "stack",
    ...workGeometry,
    children: [
      {
        path: "root/big",
        kind: "box",
        ...workGeometry,
        children: sparseChildren(count, reads),
      },
      {
        path: "root/target",
        id: "target",
        kind: "box",
        ...workGeometry,
        children: [],
      },
    ],
  };
}

function targetDocument(frame: FrameInspection) {
  return buildInspectionDocument({
    packageVersion: "0.0.0-test",
    project,
    frame,
    target: { scope: "scene:main", id: "target" },
  });
}

test("a discarded sibling spends target work units but publishes no bytes", () => {
  let siblingPathReads = 0;
  const reads = { index: 0 };
  const tree = {
    path: "root",
    kind: "stack",
    ...workGeometry,
    children: [
      Object.defineProperties(
        { kind: "box", ...workGeometry },
        {
          path: {
            enumerable: true,
            get: () => {
              siblingPathReads++;
              return "root/big";
            },
          },
          children: { enumerable: true, value: sparseChildren(100_000, reads) },
        },
      ),
      {
        path: "root/target",
        id: "target",
        kind: "box",
        ...workGeometry,
        children: [],
      },
    ],
  };
  // The discarded sibling costs a work unit per entry but no output byte, so a tight byte
  // budget still publishes the tiny targeted tree around the match.
  const built = targetDocument(recordsFrame(tree));
  const scene = built.scenes[0];
  assert.equal(scene.tree!.children.length, 1);
  assert.equal(scene.tree!.children[0].id, "target");
  assert.equal(
    reads.index,
    100_000,
    "the scan reads every discarded entry once",
  );
  assert.equal(
    siblingPathReads,
    0,
    "an unretained sibling never has its own fields read",
  );
  // A budget far below what those 100,000 discarded nodes would serialize still fits, because
  // work units never charge output bytes.
  assert.doesNotThrow(() =>
    buildInspectionDocument({
      packageVersion: "0.0.0-test",
      project,
      frame: recordsFrame(tree),
      target: { scope: "scene:main", id: "target" },
      limit: 2_000,
    }),
  );
  // Over the work limit the scan refuses instead of walking further.
  assert.throws(
    () => targetDocument(recordsFrame(workTree(1_000_001))),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /work limit/.test(error.message),
  );
});

test("the target work limit accepts its exact boundary and refuses one unit more", () => {
  const builds = (count: number) => {
    try {
      targetDocument(recordsFrame(workTree(count)));
      return true;
    } catch (error) {
      assert.ok(
        error instanceof InspectionSerializationError &&
          /work limit/.test(error.message),
        `count ${count}: ${String(error)}`,
      );
      return false;
    }
  };
  assert.ok(builds(0), "the smallest tree fits");
  // Find the boundary by doubling, so the test pins the behaviour instead of the constant.
  let high = 1;
  while (builds(high)) high *= 2;
  // Bisect for the largest accepted entry count.
  let low = 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (builds(mid)) low = mid;
    else high = mid - 1;
  }
  assert.ok(builds(low), `the exact boundary of ${low} entries is accepted`);
  // One entry more must fail before the extra index and its node fields are read.
  const reads = { index: 0 };
  let targetIdReads = 0;
  const tree = workTree(low + 1, reads);
  const target = tree.children[1];
  delete (target as { id?: string }).id;
  Object.defineProperty(target, "id", {
    enumerable: true,
    get: () => {
      targetIdReads++;
      return "target";
    },
  });
  assert.throws(
    () => targetDocument(recordsFrame(tree)),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /work limit/.test(error.message),
  );
  assert.ok(
    reads.index <= low + 1,
    `stopped after ${reads.index} discarded entries instead of walking all ${low + 1}`,
  );
  assert.equal(
    targetIdReads,
    0,
    "the refused traversal never reaches the target's own fields",
  );
});

test("the target scan covers deep chains, holes and primitive entries without stack overflow", () => {
  const depth = 50_000;
  let deep: Record<string, unknown> = {
    path: "root/leaf",
    id: "target",
    kind: "box",
    ...workGeometry,
    children: [],
  };
  for (let index = 0; index < depth; index++)
    deep = {
      path: `n${index}`,
      kind: "box",
      ...workGeometry,
      children: [deep],
    };
  const holes = new Array(3);
  const tree = {
    path: "root",
    kind: "stack",
    ...workGeometry,
    children: [null, "primitive", holes, deep],
  };
  const built = targetDocument(recordsFrame(tree));
  let node = built.scenes[0].tree!;
  let levels = 0;
  while (node.children.length > 0) {
    node = node.children[0];
    levels++;
  }
  assert.equal(node.id, "target");
  assert.equal(
    levels,
    depth + 1,
    "every ancestor level is retained exactly once",
  );
});

test("targeted construction reads children, index, id and inspectionId getters once", () => {
  const counts = new Map<string, number>();
  // A second read throws, so a repeated getter would fail the build instead of only a count.
  const once = (label: string, value: unknown) => ({
    enumerable: true,
    get: () => {
      const read = (counts.get(label) ?? 0) + 1;
      counts.set(label, read);
      if (read > 1) throw Error(`${label} was read twice`);
      return value;
    },
  });
  // Children arrays count their index reads through the same bookkeeping.
  const bump = (label: string) => {
    const read = (counts.get(label) ?? 0) + 1;
    counts.set(label, read);
    if (read > 1) throw Error(`${label} was read twice`);
  };
  const entries = (label: string, values: unknown[]) =>
    new Proxy(values, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property))
          bump(`${label}[${property}]`);
        return Reflect.get(target, property, receiver);
      },
    });
  const node = (
    label: string,
    fields: { id?: string; inspectionId?: number },
    children: unknown[],
  ) =>
    Object.defineProperties(
      { kind: "box", ...workGeometry },
      {
        path: { enumerable: true, value: `${label}/path` },
        ...(fields.id === undefined
          ? {}
          : { id: once(`${label}.id`, fields.id) }),
        ...(fields.inspectionId === undefined
          ? {}
          : {
              inspectionId: once(`${label}.inspectionId`, fields.inspectionId),
            }),
        children: once(`${label}.children`, entries(label, children)),
      },
    );
  const leaf = node("leaf", { inspectionId: 2 }, []);
  const target = node("target", { id: "target", inspectionId: 1 }, [leaf]);
  const sibling = node("sibling", { inspectionId: 7 }, [
    node("sibling-leaf", { inspectionId: 8 }, []),
  ]);
  const tree = node("root", { inspectionId: 0 }, [target, sibling]);
  const built = targetDocument(
    recordsFrame(tree, [
      paintFields({ path: "target/path", inspection: owner(1) }),
    ]),
  );
  assert.deepEqual(recordKeys(built.scenes[0].paintRecords!), [
    "1|scene-target-pixels|target/path",
  ]);
  assert.equal(built.scenes[0].tree!.id, undefined);
  assert.equal(built.scenes[0].tree!.children[0].id, "target");
  // Every structural field the scan and the construction share is read exactly once.
  assert.deepEqual([...counts.keys()].sort(), [
    "leaf.children",
    "leaf.inspectionId",
    "root.children",
    "root.inspectionId",
    "root[0]",
    "root[1]",
    "sibling-leaf.children",
    "sibling-leaf.inspectionId",
    "sibling.children",
    "sibling.inspectionId",
    "sibling[0]",
    "target.children",
    "target.id",
    "target.inspectionId",
    "target[0]",
  ]);
  for (const read of counts.values()) assert.equal(read, 1, "read once");

  // Without a record collection the scan still walks every branch, but only the retained nodes
  // have their identity read.
  counts.clear();
  const plain = targetDocument(recordsFrame(tree));
  assert.equal(plain.scenes[0].paintRecords, undefined);
  assert.deepEqual([...counts.keys()].sort(), [
    "leaf.children",
    "leaf.inspectionId",
    "root.children",
    "root.inspectionId",
    "root[0]",
    "root[1]",
    "sibling-leaf.children",
    "sibling.children",
    "sibling[0]",
    "target.children",
    "target.id",
    "target.inspectionId",
    "target[0]",
  ]);
  for (const read of counts.values()) assert.equal(read, 1, "read once");
});

test("a duplicate inspection ID and a shared or cyclic reference keep their target errors", () => {
  // Two distinct nodes with the same identity: neither may claim the record, even though one
  // copy sits in a discarded branch.
  const tree = twoRoomTree() as { children: { children: unknown[] }[] };
  tree.children[1].children.push({
    path: "root/row-b/duplicate",
    kind: "box",
    space: "b",
    inspectionId: 1,
    ...workGeometry,
    children: [],
  });
  const duplicate = targetDocument(recordsFrame(tree, twoRoomRecords()));
  assert.ok(
    !recordKeys(duplicate.scenes[0].paintRecords!).includes(
      "1|scene-target-pixels|root/row-a",
    ),
    "the shared identity is unattributable across the whole tree",
  );
  // A repeated object is not a second logical node: the existing traversal error stands.
  const shared = {
    path: "root/shared",
    kind: "box",
    inspectionId: 9,
    ...workGeometry,
    children: [],
  };
  const dag = {
    path: "root",
    kind: "stack",
    ...workGeometry,
    children: [
      {
        path: "root/target",
        id: "target",
        kind: "box",
        ...workGeometry,
        children: [],
      },
      shared,
      shared,
    ],
  };
  assert.throws(
    () => targetDocument(recordsFrame(dag)),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /cycle/.test(error.message),
  );
  const cyclic: Record<string, unknown> = {
    path: "root/target",
    id: "target",
    kind: "box",
    ...workGeometry,
    children: [],
  };
  (cyclic.children as unknown[]).push(cyclic);
  assert.throws(
    () => targetDocument(recordsFrame(cyclic)),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /cycle/.test(error.message),
  );
});

/** Nodes whose `children` and `inspectionId` are counted getters, so a second read is visible. */
function countedTree(counts: Map<string, number>) {
  const counter = (label: string, value: unknown) => ({
    enumerable: true,
    get: () => {
      counts.set(label, (counts.get(label) ?? 0) + 1);
      return value;
    },
  });
  const node = (
    label: string,
    fields: { id?: string; inspectionId?: number },
    children: unknown[],
  ) =>
    Object.defineProperties(
      { path: `${label}/path`, kind: "box", ...workGeometry },
      {
        ...(fields.id === undefined
          ? {}
          : { id: counter(`${label}.id`, fields.id) }),
        ...(fields.inspectionId === undefined
          ? {}
          : {
              inspectionId: counter(
                `${label}.inspectionId`,
                fields.inspectionId,
              ),
            }),
        children: counter(`${label}.children`, children),
      },
    );
  const leaf = node("leaf", { inspectionId: 2 }, []);
  const target = node("target", { id: "target", inspectionId: 1 }, [leaf]);
  const sibling = node("sibling", { inspectionId: 7 }, []);
  return node("root", { inspectionId: 0 }, [target, sibling]);
}

test("owner indexing reads discarded identities only when a record collection exists", () => {
  const reads = (counts: Map<string, number>) =>
    [...counts.keys()]
      .filter((key) => key.endsWith(".inspectionId"))
      .map((key) => key.replace(".inspectionId", ""))
      .sort();
  const counts = new Map<string, number>();

  for (const records of [undefined, [] as unknown[]]) {
    counts.clear();
    const built = targetDocument(recordsFrame(countedTree(counts), records));
    assert.deepEqual(
      built.scenes[0].paintRecords,
      records,
      "an absent collection stays absent and an empty one stays []",
    );
    assert.deepEqual(
      reads(counts),
      ["leaf", "root", "target"],
      "an absent or empty collection never indexes a discarded sibling",
    );
  }

  counts.clear();
  const built = targetDocument(
    recordsFrame(countedTree(counts), [
      paintFields({ path: "target/path", inspection: owner(1) }),
    ]),
  );
  assert.deepEqual(
    reads(counts),
    ["leaf", "root", "sibling", "target"],
    "a populated collection counts every node of the full tree",
  );
  assert.deepEqual(recordKeys(built.scenes[0].paintRecords!), [
    "1|scene-target-pixels|target/path",
  ]);
});

test("a target reads the paint record collection and its length once", () => {
  for (const records of [
    undefined,
    [],
    [paintFields({ path: "target/path", inspection: owner(1) })],
  ] as const) {
    const counts = { paintRecords: 0, length: 0, index: 0 };
    const frame = recordsFrame(countedTree(new Map()));
    const raw = (
      frame.scenes[0] as unknown as {
        frame: Record<string, unknown>;
      }
    ).frame;
    const entries =
      records === undefined
        ? undefined
        : new Proxy([...records], {
            get(target, property, receiver) {
              if (property === "length") counts.length++;
              if (typeof property === "string" && /^\d+$/.test(property))
                counts.index++;
              return Reflect.get(target, property, receiver);
            },
          });
    Object.defineProperty(raw, "paintRecords", {
      enumerable: true,
      get: () => {
        counts.paintRecords++;
        return entries;
      },
    });
    targetDocument(frame);
    assert.equal(counts.paintRecords, 1, "the field is read once");
    assert.equal(
      counts.length,
      records === undefined ? 0 : 1,
      "the collection length is read once",
    );
    assert.equal(
      counts.index,
      records?.length ?? 0,
      "each kept element is read once",
    );
  }
});

test("a paint separator is checked before the next candidate and returned when filtered", () => {
  const tree = {
    path: "root",
    id: "target",
    kind: "box",
    inspectionId: 1,
    ...workGeometry,
    children: [],
  };
  const target = { scope: "scene:main", id: "target" };
  const build = (frame: FrameInspection, limit?: number) =>
    buildInspectionDocument({
      packageVersion: "0.0.0-test",
      project,
      frame,
      target,
      ...(limit === undefined ? {} : { limit }),
    });
  const minimum = (frame: FrameInspection) => {
    const fits = (limit: number) => {
      try {
        build(frame, limit);
        return true;
      } catch {
        return false;
      }
    };
    let low = 0;
    let high = 1 << 20;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (fits(mid)) high = mid;
      else low = mid + 1;
    }
    return low;
  };
  const retained = paintFields({ path: "root", inspection: owner(1) });
  const oneFrame = recordsFrame(tree, [retained]);
  const one = minimum(oneFrame);
  const oneBytes = measureInspection(build(oneFrame));

  const reads = { index: 0, inspection: 0 };
  const blockedNext = paintFields({ path: "root/next", inspection: owner(1) });
  Object.defineProperty(blockedNext, "inspection", {
    enumerable: true,
    get() {
      reads.inspection++;
      return owner(1);
    },
  });
  const blocked = new Proxy([retained, blockedNext], {
    get(recordTarget, property, receiver) {
      if (property === "1") reads.index++;
      return Reflect.get(recordTarget, property, receiver);
    },
  });
  assert.throws(
    () => build(recordsFrame(tree, blocked), one),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /over the/.test(error.message),
  );
  assert.equal(reads.index, 0, "the next index getter does not run");
  assert.equal(reads.inspection, 0, "the next identity getter does not run");

  reads.index = 0;
  reads.inspection = 0;
  const filtered = paintFields({ path: "root/dropped" });
  Object.defineProperty(filtered, "inspection", {
    enumerable: true,
    get() {
      reads.inspection++;
      return undefined;
    },
  });
  const filteredRecords = new Proxy([retained, filtered], {
    get(recordTarget, property, receiver) {
      if (property === "1") reads.index++;
      return Reflect.get(recordTarget, property, receiver);
    },
  });
  const filteredFrame = recordsFrame(tree, filteredRecords);
  assert.doesNotThrow(() => build(filteredFrame, one + 1));
  assert.equal(
    reads.index,
    1,
    "one spare byte is checked before the index getter",
  );
  assert.equal(
    reads.inspection,
    1,
    "identity is read only after the comma fits",
  );
  // The spare byte must exist to inspect the candidate, then is not kept.
  assert.equal(minimum(filteredFrame), one + 1);
  assert.equal(measureInspection(build(filteredFrame)), oneBytes);

  const second = paintFields({ path: "root/leaf", inspection: owner(1) });
  const pair = recordsFrame(tree, [retained, second]);
  const withFiltered = recordsFrame(tree, [retained, filtered, second]);
  const emptyBytes = measureInspection(build(recordsFrame(tree, [])));
  const secondBytes =
    measureInspection(build(recordsFrame(tree, [second]))) - emptyBytes;
  const twoBytes = measureInspection(build(pair));
  assert.equal(
    twoBytes - oneBytes,
    secondBytes + 1,
    "a retained candidate pays exactly one comma",
  );
  assert.equal(minimum(pair) - one, twoBytes - oneBytes);
  assert.equal(
    measureInspection(build(withFiltered)),
    twoBytes,
    "a filtered candidate between retained records returns the comma",
  );
  assert.equal(minimum(withFiltered), minimum(pair));
});

test("an ambiguous deep chain reports matches without copying ancestor arrays", () => {
  const depth = 8_000;
  let ambiguous: Record<string, unknown> = {
    path: "n0",
    id: "same",
    space: "clip",
    kind: "box",
    ...workGeometry,
    children: [],
  };
  for (let index = 1; index < depth; index++)
    ambiguous = {
      path: `n${index}`,
      id: "same",
      kind: "box",
      ...workGeometry,
      children: [ambiguous],
    };
  const before = process.memoryUsage().heapUsed;
  assert.throws(
    () =>
      buildInspectionDocument({
        packageVersion: "0.0.0-test",
        project,
        frame: recordsFrame(ambiguous),
        target: { scope: "scene:main", id: "same" },
      }),
    (error: unknown) => {
      assert.ok(error instanceof InspectionTargetError, String(error));
      assert.match(error.message, new RegExp(`${depth} nodes have ID "same"`));
      assert.match(error.message, /clip:n0(?!\d)/);
      assert.match(error.message, new RegExp(`layout:n${depth - 1}(?!\\d)`));
      return true;
    },
  );
  const growth = process.memoryUsage().heapUsed - before;
  assert.ok(
    growth < 48 * 1024 * 1024,
    `ambiguous scan grew heap by ${growth} bytes`,
  );

  const chain = 1_000;
  let unique: Record<string, unknown> = {
    path: "leaf",
    id: "target",
    kind: "box",
    ...workGeometry,
    children: [],
  };
  for (let index = 0; index < chain; index++)
    unique = {
      path: `u${index}`,
      kind: "box",
      ...workGeometry,
      children: [unique],
    };
  const built = targetDocument(recordsFrame(unique));
  let node = built.scenes[0].tree!;
  let levels = 0;
  while (node.children.length > 0) {
    node = node.children[0];
    levels++;
  }
  assert.equal(node.id, "target");
  assert.equal(levels, chain, "the unique match keeps every ancestor once");
});

function mediaPaint(provenance: string, patch: Record<string, unknown> = {}) {
  return paintFields({
    kind: "media",
    accuracy: "conservative",
    provenance,
    ...patch,
  });
}

test("media paint records whitelist both provenances and do not alias or read private fields", () => {
  const forbidden = () => {
    throw Error("non-whitelisted media field was read");
  };
  for (const provenance of [
    "projected-image-draw-quad",
    "projected-video-draw-quad",
  ] as const) {
    const bounds = { x: 1.5, y: 2, width: 3, height: 4 };
    const resolution = [320, 180];
    const inspection = { id: 3, nodeId: 4, role: "content" as const };
    const raw = Object.defineProperties(
      mediaPaint(provenance, { bounds, resolution, inspection }),
      {
        source: { get: forbidden, enumerable: true },
        texture: { get: forbidden, enumerable: true },
        uv: { get: forbidden, enumerable: true },
      },
    );
    const published = paintRecord(raw, "paint");
    assert.equal(published.kind, "media");
    if (published.accuracy === "unavailable")
      assert.fail(`${provenance}: media geometry must stay available`);
    assert.equal(published.accuracy, "conservative");
    assert.equal(published.provenance, provenance);
    assert.deepEqual(published.bounds, bounds);
    assert.notEqual(published.bounds, bounds);
    assert.deepEqual(published.resolution, resolution);
    assert.notEqual(published.resolution, resolution);
    assert.deepEqual(published.inspection, inspection);
    assert.notEqual(published.inspection, inspection);
    assert.notEqual(published, raw);
  }
  const unavailable = Object.defineProperties(
    mediaPaint("projected-image-draw-quad", {
      accuracy: "unavailable",
      unsupported: "media paint is not finite.",
    }),
    {
      bounds: { get: forbidden, enumerable: true },
      provenance: { get: forbidden, enumerable: true },
    },
  );
  const hidden = paintRecord(unavailable, "paint");
  assert.equal(hidden.accuracy, "unavailable");
  assert.equal(hidden.unsupported, "media paint is not finite.");
  assert.equal("bounds" in hidden, false);
  assert.equal("provenance" in hidden, false);
});

test("media paint rejects non-finite geometry and hostile getters without coercing them", () => {
  assert.throws(
    () =>
      paintRecord(
        mediaPaint("projected-image-draw-quad", {
          bounds: { x: 0, y: 0, width: Number.NaN, height: 1 },
        }),
        "paint",
      ),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /bounds\.width must be a finite number/.test(error.message),
  );
  assert.throws(
    () =>
      paintRecord(
        Object.defineProperties(mediaPaint("projected-video-draw-quad"), {
          provenance: {
            enumerable: true,
            get: () => {
              throw Error("media provenance getter exploded");
            },
          },
        }),
        "paint",
      ),
    (error: unknown) =>
      error instanceof InspectionReadError &&
      /media provenance getter exploded/.test(error.message),
  );
});

test("targeted media records follow retained, orphan, and duplicate owners on both routes", () => {
  for (const provenance of [
    "projected-image-draw-quad",
    "projected-video-draw-quad",
  ]) {
    const kept = mediaPaint(provenance, {
      path: "root/card",
      inspection: owner(2),
    });
    const orphan = mediaPaint(provenance, {
      path: "root/card",
      inspection: owner(99),
    });
    const untagged = mediaPaint(provenance, { path: "root/card" });
    const frame = recordsFrame(twoRoomTree(), [kept, orphan, untagged]);
    const target = { scope: "scene:main", id: "target" };
    const initial = buildInspectionDocument({
      packageVersion: "0.0.0-test",
      project,
      frame,
      target,
    });
    const secondPass = applyInspectionTarget(document(frame), target);
    assert.deepEqual(recordKeys(initial.scenes[0].paintRecords!), [
      "2|scene-target-pixels|root/card",
    ]);
    assert.deepEqual(
      initial.scenes[0].paintRecords,
      secondPass.scenes[0].paintRecords,
      provenance,
    );
    const published = initial.scenes[0].paintRecords![0];
    assert.equal(published.kind, "media");
    if (published.accuracy === "unavailable")
      assert.fail("retained media must keep conservative geometry");
    assert.equal(published.provenance, provenance);
    assert.notEqual(published, kept);
    const full = document(frame).scenes[0].paintRecords!;
    assert.equal(full.length, 3, "untargeted media still publishes orphans");
    assert.ok(!full.includes(kept as never));

    const tree = twoRoomTree() as { children: { children: unknown[] }[] };
    tree.children[1].children.push({
      path: "root/row-b/duplicate",
      kind: "box",
      space: "b",
      inspectionId: 2,
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      transform: [1, 1, 0, 0],
      children: [],
    });
    const duplicated = recordsFrame(tree, [kept]);
    const dropped = buildInspectionDocument({
      packageVersion: "0.0.0-test",
      project,
      frame: duplicated,
      target,
    });
    const droppedAgain = applyInspectionTarget(document(duplicated), target);
    assert.equal(
      recordKeys(dropped.scenes[0].paintRecords!).includes(
        "2|scene-target-pixels|root/card",
      ),
      false,
      provenance,
    );
    assert.deepEqual(
      dropped.scenes[0].paintRecords,
      droppedAgain.scenes[0].paintRecords,
    );
  }
});

test("outer clipProjection rejects bad pairing and does not read foreign mask data", () => {
  const base = paintFields({
    accuracy: "conservative",
    clipProjection: {
      clipOccurrenceIds: [4, 9],
      coverage: "outer-clipped-draw-quad",
      clipShapes: ["circle", "rect"],
    },
  });
  const rejected = (clipProjection: unknown, pattern: RegExp) =>
    assert.throws(
      () => paintRecord({ ...base, clipProjection }, "paint"),
      (error: unknown) =>
        error instanceof InspectionSerializationError &&
        pattern.test(error.message),
      pattern.source,
    );
  rejected(
    { clipOccurrenceIds: [4], coverage: "outer-clipped-draw-quad" },
    /clipShapes must be present/,
  );
  rejected(
    {
      clipOccurrenceIds: [4],
      coverage: "outer-clipped-draw-quad",
      clipShapes: ["circle", "rect"],
    },
    /must have 1 entries/,
  );
  rejected(
    {
      clipOccurrenceIds: [4],
      coverage: "outer-clipped-draw-quad",
      clipShapes: ["mask"],
    },
    /clipShapes\[0\]/,
  );
  rejected(
    {
      clipOccurrenceIds: [4, 9],
      coverage: "rect-clipped-draw-quad",
      clipShapes: ["circle", "rect"],
    },
    /clipShapes must be absent/,
  );
  rejected(
    {
      clipOccurrenceIds: [4],
      coverage: "outer-clipped-draw-quad",
      clipShapes: ["rect"],
    },
    /every clip shape is "rect"/,
  );
  let foreign = 0;
  const forbidden = () => {
    foreign++;
    throw Error("foreign mask data was read");
  };
  const ids = [4, 9];
  const shapes = ["circle", "rect"];
  const raw = Object.defineProperties(
    {
      clipOccurrenceIds: ids,
      coverage: "outer-clipped-draw-quad",
      clipShapes: shapes,
    },
    {
      outline: { enumerable: true, get: forbidden },
      url: { enumerable: true, get: forbidden },
      bitmap: { enumerable: true, get: forbidden },
      provider: { enumerable: true, get: forbidden },
      mask: { enumerable: true, get: forbidden },
    },
  );
  const budget = new InspectionBudget();
  const published = paintRecord({ ...base, clipProjection: raw }, "paint", budget);
  assert.equal(foreign, 0);
  if (published.accuracy === "unavailable") throw Error("expected geometry");
  assert.deepEqual(published.clipProjection?.clipShapes, ["circle", "rect"]);
  ids.push(1);
  shapes[0] = "path";
  assert.deepEqual(published.clipProjection?.clipOccurrenceIds, [4, 9]);
  assert.deepEqual(published.clipProjection?.clipShapes, ["circle", "rect"]);
  assert.equal(JSON.stringify(published).includes("outline"), false);
  const counted = published;
  const bytes = new TextEncoder().encode(JSON.stringify(counted)).length;
  assert.equal(budget.bytes, bytes);
  assert.throws(
    () => paintRecord(base, "paint", new InspectionBudget(bytes - 1)),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /bytes of UTF-8/.test(error.message),
  );
});

test("public inspection exports do not gain a media paint alias", async () => {
  const api = await import("../src/index.ts");
  assert.equal("paintRecord" in api, false);
  assert.equal("InspectionPaintRecord" in api, false);
  assert.equal("PaintRecord" in api, false);
  assert.equal(typeof api.Image, "function");
  assert.equal(typeof api.Video, "function");
  assert.equal(typeof api.buildInspectionDocument, "function");
});
