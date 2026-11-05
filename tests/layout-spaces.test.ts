/**
 * Public layout-space descriptors. Kind and parent come from evaluation provenance,
 * not from parsing a space id. Mapping is unavailable: this unit publishes no affine.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  Box,
  Composition,
  Group,
  HStack,
  VStack,
  World,
  evaluateView,
  type LayoutNode,
  type MeasureText,
} from "../src/authoring/index";
import type { FrameInspection } from "../src/engine/render/renderer";
import {
  InspectionReadError,
  InspectionSerializationError,
  applyInspectionTarget,
  buildInspectionDocument,
  measureInspection,
  serializeInspection,
} from "../src/engine/inspect/report";

const measure: MeasureText = () => 10;
const project = {
  name: "Spaces",
  duration: 1,
  resolution: [200, 100] as const,
};
const mapping = {
  status: "unavailable" as const,
  reason: "not a captured GPU uniform; no layout affine is published",
};

function evaluate(view: Parameters<typeof evaluateView>[0], inspection = false) {
  return evaluateView(view, {
    time: 0,
    width: 200,
    height: 100,
    measureText: measure,
    ...(inspection ? { inspection: true } : {}),
  });
}

function document(frame: unknown, target?: { scope: string; id: string }) {
  return buildInspectionDocument({
    packageVersion: "0.0.0-test",
    project,
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
          frame,
        },
      ],
    } as FrameInspection,
    ...(target ? { target } : {}),
  });
}

function nestedView() {
  return Composition(
    World(
      () =>
        Group([
          Box({ width: 12, height: 8 }).id("in-group"),
          Box({ width: 9, height: 7 }).clip().id("window"),
        ]).id("cluster"),
      { size: [100, 80] },
    ),
    {
      size: [120, 90],
      overlay: () => Box({ width: 6, height: 5 }).id("hud"),
    },
  ).id("comp");
}

function ids(spaces: readonly { id: string }[]) {
  return spaces.map((space) => space.id);
}

test("nested composition, world, clip, group and overlay publish boundary descriptors only", () => {
  const frame = evaluate(nestedView(), true);
  const again = evaluate(nestedView(), true);
  assert.deepEqual(again.spaceProvenance, frame.spaceProvenance, "reused fixture");
  const built = document(frame);
  const spaces = built.scenes[0].spaces;
  assert.deepEqual(ids(spaces), [
    "layout",
    "comp/world",
    "comp/world/cluster/window/clip",
    "comp/overlay",
  ]);
  assert.deepEqual(spaces[0], {
    id: "layout",
    kind: "layout",
    parent: { status: "unavailable", reason: "scope layout root" },
    mapping,
  });
  const world = spaces[1];
  const clip = spaces[2];
  const overlay = spaces[3];
  assert.equal(world.kind, "world");
  assert.deepEqual(world.parent, { status: "known", id: "layout" });
  assert.equal(world.owner?.path, "comp");
  assert.equal(world.owner?.id, "comp");
  assert.equal(typeof world.owner?.inspectionId, "number");
  assert.equal(clip.kind, "clip-local");
  assert.deepEqual(clip.parent, { status: "known", id: "comp/world" });
  assert.equal(clip.owner?.path, "cluster/window");
  assert.equal(clip.owner?.id, "window");
  assert.equal(overlay.kind, "composition-overlay");
  assert.equal(overlay.owner?.inspectionId, world.owner?.inspectionId);
  assert.equal(overlay.mapping.status, "unavailable");
  assert.equal("matrix" in overlay.mapping, false);
  assert.equal(
    spaces.some((space) => space.id.includes("cluster") && space.kind !== "clip-local"),
    false,
    "group children share the world space",
  );

  const composition = built.scenes[0].tree!;
  assert.equal(composition.space, undefined);
  assert.equal(composition.contentBounds, undefined);
  const worldNode = composition.children[0];
  const overlayNode = composition.children[1];
  assert.equal(worldNode.space, "comp/world");
  assert.equal(overlayNode.space, "comp/overlay");
  const clipNode = worldNode.children[1];
  assert.equal(clipNode.id, "window");
  assert.equal(clipNode.space, "comp/world");
  assert.equal(clipNode.contentBounds, undefined);
  assert.equal(clipNode.children[0].space, "comp/world/cluster/window/clip");
  assert.equal(worldNode.children[0].space, "comp/world");
  assert.equal(serializeInspection(built).includes('"spaces":["layout"]'), false);
});

test("the same space id is valid in two scopes", () => {
  const frame = evaluate(nestedView(), true);
  const built = buildInspectionDocument({
    packageVersion: "0.0.0-test",
    project,
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
          frame,
        },
        {
          id: "other",
          name: "Other",
          time: 0,
          localTime: 0,
          progress: 0,
          frame,
        },
      ],
      overlay: {
        name: "Project overlay",
        time: 0,
        localTime: 0,
        progress: 0,
        frame,
      },
    } as FrameInspection,
  });
  assert.equal(built.scenes.length, 3);
  assert.deepEqual(
    built.scenes.map((scene) => scene.scope),
    ["scene:main", "scene:other", "overlay"],
  );
  for (const scene of built.scenes)
    assert.deepEqual(ids(scene.spaces), ids(built.scenes[0].spaces));
});

test("offset and scale keep nonzero layout placement and do not invent a mapping", () => {
  const frame = evaluate(
    HStack(
      [
        Box({ width: 20, height: 10 }).id("a"),
        Box({ width: 10, height: 10 }).offset(5, 7).scale(2, 3, [0, 0]).id("b"),
      ],
      { gap: 4 },
    ),
  );
  const placed = frame.tree.children[1];
  assert.equal(placed.id, "b");
  assert.deepEqual(placed.bounds, { x: 24, y: 0, width: 10, height: 10 });
  assert.deepEqual(placed.transform, [2, 3, -24, 0]);
  const box = placed.children[0].children[0];
  assert.deepEqual(box.bounds, { x: 24, y: 0, width: 10, height: 10 });
  assert.deepEqual(box.transform, [2, 3, -14, 21]);
  const built = document(frame);
  assert.equal(built.scenes[0].spaces.length, 1);
  assert.equal(built.scenes[0].spaces[0].kind, "layout");
  assert.equal("matrix" in built.scenes[0].spaces[0].mapping, false);
});

test("a target keeps the ancestor space closure and drops the other boundary", () => {
  const frame = evaluate(nestedView(), true);
  const targeted = document(frame, { scope: "scene:main", id: "window" });
  const applied = applyInspectionTarget(document(frame), {
    scope: "scene:main",
    id: "window",
  });
  const expected = ["layout", "comp/world", "comp/world/cluster/window/clip"];
  assert.deepEqual(ids(targeted.scenes[0].spaces), expected);
  assert.deepEqual(targeted.scenes[0].spaces, applied.scenes[0].spaces);
  assert.equal(
    targeted.scenes[0].spaces.some((space) => space.kind === "composition-overlay"),
    false,
  );

  const hud = document(frame, { scope: "scene:main", id: "hud" });
  assert.deepEqual(ids(hud.scenes[0].spaces), ["layout", "comp/overlay"]);
});

test("a parent that no retained node occupies is still kept, and a suffix is not a kind", () => {
  const geometry = {
    bounds: { x: 1, y: 2, width: 3, height: 4 },
    transform: [1, 1, 0, 0] as const,
    children: [],
  };
  const frame = {
    tree: {
      path: "only",
      id: "only",
      kind: "box",
      space: "room/world",
      ...geometry,
    },
    commands: [],
    warnings: [],
    spaceProvenance: [
      {
        id: "layout",
        kind: "layout",
        parent: { status: "unavailable", reason: "scope layout root" },
      },
      {
        id: "room/world",
        kind: "world",
        parent: { status: "known", id: "layout" },
        owner: { path: "room" },
      },
      {
        id: "room/overlay",
        kind: "composition-overlay",
        parent: { status: "known", id: "layout" },
        owner: { path: "room" },
      },
    ],
  };
  const targeted = document(frame, { scope: "scene:main", id: "only" });
  const applied = applyInspectionTarget(document(frame), {
    scope: "scene:main",
    id: "only",
  });
  assert.deepEqual(ids(targeted.scenes[0].spaces), ["layout", "room/world"]);
  assert.deepEqual(targeted.scenes[0].spaces, applied.scenes[0].spaces);
  assert.equal(targeted.scenes[0].tree!.space, "room/world");

  const guessed = document({
    tree: {
      path: "leaf",
      kind: "box",
      space: "not/a/clip",
      ...geometry,
    },
    commands: [],
    warnings: [],
  });
  const foreign = guessed.scenes[0].spaces.find((space) => space.id === "not/a/clip");
  assert.ok(foreign);
  assert.equal(foreign.kind, "unavailable");
  assert.match(foreign.reason, /not inferred/);
  assert.equal(foreign.parent.status, "unavailable");
});

test("inspection off does not allocate a descriptor on ordinary nodes", () => {
  const boxes = Array.from({ length: 30 }, (_, index) =>
    Box({ width: 1, height: 1 }).id(`b${index}`),
  );
  const frame = evaluate(VStack(boxes));
  assert.equal(frame.spaceProvenance?.length, 1);
  let nodes = 0;
  const walk = (node: LayoutNode) => {
    nodes += 1;
    assert.equal("spaceProvenance" in node, false);
    assert.equal("descriptor" in node, false);
    assert.equal("mapping" in node, false);
    node.children.forEach(walk);
  };
  walk(frame.tree);
  assert.equal(nodes, 31);
  assert.ok(nodes > frame.spaceProvenance!.length);
});

test("provenance rejects duplicates, dangling parents, cycles and malformed records", () => {
  const tree = {
    path: "root",
    kind: "box",
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    transform: [1, 1, 0, 0],
    children: [],
  };
  const withProvenance = (spaceProvenance: unknown) =>
    document({ tree, commands: [], warnings: [], spaceProvenance });
  assert.throws(
    () =>
      withProvenance([
        {
          id: "layout",
          kind: "layout",
          parent: { status: "unavailable", reason: "scope layout root" },
        },
        {
          id: "layout",
          kind: "layout",
          parent: { status: "unavailable", reason: "scope layout root" },
        },
      ]),
    InspectionSerializationError,
  );
  assert.throws(
    () =>
      withProvenance([
        {
          id: "clip",
          kind: "clip-local",
          parent: { status: "known", id: "missing" },
          owner: { path: "clip" },
        },
      ]),
    /not a recorded space/,
  );
  assert.throws(
    () =>
      withProvenance([
        {
          id: "a",
          kind: "clip-local",
          parent: { status: "known", id: "b" },
          owner: { path: "a" },
        },
        {
          id: "b",
          kind: "clip-local",
          parent: { status: "known", id: "a" },
          owner: { path: "b" },
        },
      ]),
    /parent cycle/,
  );
  assert.throws(
    () =>
      withProvenance([
        {
          id: "layout",
          kind: "gpu",
          parent: { status: "unavailable", reason: "no" },
        },
      ]),
    InspectionSerializationError,
  );
  assert.throws(() => withProvenance([null]), InspectionSerializationError);

  let coerced = 0;
  const hostileId = Object.defineProperties(
    {},
    {
      [Symbol.toPrimitive]: {
        get() {
          coerced += 1;
          return () => "layout";
        },
      },
      toString: {
        get() {
          coerced += 1;
          return () => "layout";
        },
      },
    },
  );
  assert.throws(
    () =>
      withProvenance([
        {
          id: hostileId,
          kind: "layout",
          parent: { status: "unavailable", reason: "no" },
        },
      ]),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /received object/.test(error.message),
  );
  assert.equal(coerced, 0);

  const exploding = new Proxy([] as unknown[], {
    get(target, property, receiver) {
      if (property === "length") throw Error("provenance length exploded");
      return Reflect.get(target, property, receiver);
    },
  });
  const unavailable = document({
    tree,
    commands: [],
    warnings: [],
    spaceProvenance: exploding,
  });
  assert.equal(unavailable.scenes[0].inspection, "unavailable");
  assert.match(unavailable.scenes[0].unavailable!, /provenance length exploded/);
  assert.equal(unavailable.scenes[0].spaces.length, 0);
  assert.equal(InspectionReadError.name, "InspectionReadError");
});

test("space descriptor bytes match the published document", () => {
  const tree = {
    path: "root",
    kind: "box",
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    transform: [1, 1, 0, 0],
    children: [],
  };
  const layoutOnly = {
    tree,
    commands: [],
    warnings: [],
    spaceProvenance: [
      {
        id: "layout",
        kind: "layout",
        parent: { status: "unavailable", reason: "scope layout root" },
      },
    ],
  };
  const withClip = {
    tree: { ...tree, space: "window/clip" },
    commands: [],
    warnings: [],
    spaceProvenance: [
      ...layoutOnly.spaceProvenance,
      {
        id: "window/clip",
        kind: "clip-local",
        parent: { status: "known", id: "layout" },
        owner: { path: "window", id: "window", inspectionId: 3 },
      },
    ],
  };
  const minimum = (frame: unknown) => {
    const fits = (limit: number) => {
      try {
        buildInspectionDocument({
          packageVersion: "0.0.0-test",
          project,
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
                frame,
              },
            ],
          } as FrameInspection,
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
      if (fits(mid)) high = mid;
      else low = mid + 1;
    }
    return low;
  };
  const plainLimit = minimum(layoutOnly);
  const clipLimit = minimum(withClip);
  const plainBytes = measureInspection(document(layoutOnly));
  const clipBytes = measureInspection(document(withClip));
  assert.equal(clipLimit - plainLimit, clipBytes - plainBytes);
  assert.ok(clipBytes > plainBytes);
});

const box = {
  path: "root",
  kind: "box",
  bounds: { x: 0, y: 0, width: 1, height: 1 },
  transform: [1, 1, 0, 0] as const,
  children: [] as const,
};

function buildFrame(
  frame: unknown,
  extras?: { limit?: number; target?: { scope: string; id: string } },
) {
  return buildInspectionDocument({
    packageVersion: "0.0.0-test",
    project,
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
          frame,
        },
      ],
    } as FrameInspection,
    ...extras,
  });
}

function chainProvenance(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `s${index}`,
    kind: "clip-local" as const,
    parent:
      index === 0
        ? { status: "unavailable" as const, reason: "scope layout root" }
        : { status: "known" as const, id: `s${index - 1}` },
    owner: { path: "p" },
  }));
}

test("a 10k parent chain publishes the full plan in linear work", () => {
  const count = 10_000;
  const started = performance.now();
  const built = buildFrame({
    tree: { ...box, id: "leaf", space: `s${count - 1}` },
    commands: [],
    warnings: [],
    spaceProvenance: chainProvenance(count),
  });
  const elapsed = performance.now() - started;
  assert.ok(
    elapsed < 1_500,
    `parent-chain validation took ${elapsed.toFixed(0)}ms; a per-record rewalk of ${count} is much slower`,
  );
  const spaces = built.scenes[0].spaces;
  assert.equal(built.schemaVersion, 2);
  assert.equal(spaces.length, count);
  assert.equal(spaces[0].id, "s0");
  assert.equal(spaces[0].kind, "clip-local");
  assert.equal(spaces[0].parent.status, "unavailable");
  assert.equal(spaces[count - 1].id, `s${count - 1}`);
  for (let index = 1; index < count; index++) {
    assert.equal(spaces[index].id, `s${index}`);
    assert.deepEqual(spaces[index].parent, {
      status: "known",
      id: `s${index - 1}`,
    });
  }
  assert.equal(spaces[count - 1].mapping.status, "unavailable");
  assert.equal("matrix" in spaces[count - 1].mapping, false);
  assert.equal(JSON.stringify(spaces).includes("G3"), false);
});

test("provenance index and parent getters are read once per record", () => {
  const count = 2_000;
  let indexGets = 0;
  let parentIdGets = 0;
  const records = Array.from({ length: count }, (_, index) => ({
    id: `s${index}`,
    kind: "clip-local",
    parent:
      index === 0
        ? { status: "unavailable", reason: "scope layout root" }
        : new Proxy(
            { status: "known", id: `s${index - 1}` },
            {
              get(target, property, receiver) {
                if (property === "id") parentIdGets += 1;
                return Reflect.get(target, property, receiver);
              },
            },
          ),
    owner: { path: "p" },
  }));
  const spaceProvenance = new Proxy(records, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) indexGets += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const built = buildFrame({
    tree: { ...box, id: "leaf", space: `s${count - 1}` },
    commands: [],
    warnings: [],
    spaceProvenance,
  });
  assert.equal(built.scenes[0].spaces.length, count);
  assert.equal(indexGets, count);
  assert.equal(parentIdGets, count - 1);
});

test("a provenance length over the work cap is refused before any index read", () => {
  let indexGets = 0;
  const spaceProvenance = new Proxy([] as unknown[], {
    get(target, property, receiver) {
      if (property === "length") return 1_000_001;
      if (typeof property === "string" && /^\d+$/.test(property)) {
        indexGets += 1;
        throw Error("provenance index exploded");
      }
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(
    () =>
      buildFrame({
        tree: box,
        commands: [],
        warnings: [],
        spaceProvenance,
      }),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /1,?000,?000-unit work limit/.test(error.message) &&
      !(error instanceof InspectionReadError),
  );
  assert.equal(indexGets, 0);
});

test("unreferenced provenance does not reject a targeted tree that fits", () => {
  const unreferenced = 4_000;
  const spaceProvenance = [
    {
      id: "layout",
      kind: "layout",
      parent: { status: "unavailable", reason: "scope layout root" },
    },
    {
      id: "keep",
      kind: "world",
      parent: { status: "known", id: "layout" },
      owner: { path: "room" },
    },
    ...Array.from({ length: unreferenced }, (_, index) => ({
      id: `u${index}`,
      kind: "clip-local" as const,
      parent: { status: "known" as const, id: "layout" },
      owner: { path: "p" },
    })),
  ];
  const frame = {
    tree: { ...box, id: "leaf", space: "keep" },
    commands: [],
    warnings: [],
    spaceProvenance,
  };
  const target = { scope: "scene:main", id: "leaf" };
  const fits = (
    limit: number,
    extras?: { target?: { scope: string; id: string } },
  ) => {
    try {
      buildFrame(frame, { limit, ...extras });
      return true;
    } catch {
      return false;
    }
  };
  const minimum = (extras?: { target?: { scope: string; id: string } }) => {
    let low = 0;
    let high = 1 << 20;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (fits(mid, extras)) high = mid;
      else low = mid + 1;
    }
    return low;
  };
  const floor = spaceProvenance.length * 164;
  const fullLimit = minimum();
  const targetLimit = minimum({ target });
  assert.ok(fullLimit < floor);
  assert.ok(targetLimit < floor);
  const built = buildFrame(frame, { target, limit: targetLimit });
  const applied = applyInspectionTarget(
    buildFrame(frame, { limit: fullLimit }),
    target,
  );
  assert.deepEqual(ids(built.scenes[0].spaces), ["layout", "keep"]);
  assert.deepEqual(built.scenes[0].spaces, applied.scenes[0].spaces);
  assert.equal(built.scenes[0].inspection, "available");
  assert.equal(built.schemaVersion, 2);
  assert.equal(built.scenes[0].spaces[1].mapping.status, "unavailable");
  assert.equal("matrix" in built.scenes[0].spaces[1].mapping, false);
  assert.equal(JSON.stringify(built.scenes[0].spaces).includes("G3"), false);
});

test("an admitted throwing provenance index stays a read error", () => {
  const spaceProvenance = new Proxy([] as unknown[], {
    get(target, property, receiver) {
      if (property === "length") return 1;
      if (property === "0") throw Error("provenance index exploded");
      return Reflect.get(target, property, receiver);
    },
  });
  const unavailable = buildFrame({
    tree: box,
    commands: [],
    warnings: [],
    spaceProvenance,
  });
  assert.equal(unavailable.scenes[0].inspection, "unavailable");
  assert.match(unavailable.scenes[0].unavailable!, /provenance index exploded/);
  assert.equal(unavailable.scenes[0].spaces.length, 0);
});

test("a huge escaped provenance string is charged without a UTF-8 allocation", () => {
  const marker = "\u0001".repeat(40_000);
  let stringified = 0;
  let encoded = 0;
  const originalStringify = JSON.stringify;
  const originalEncode = TextEncoder.prototype.encode;
  JSON.stringify = ((value: unknown, ...rest: unknown[]) => {
    if (typeof value === "string") stringified += value.length;
    return originalStringify(value, ...(rest as []));
  }) as typeof JSON.stringify;
  TextEncoder.prototype.encode = function (input?: string) {
    encoded += input?.length ?? 0;
    return originalEncode.call(this, input);
  };
  try {
    assert.throws(
      () =>
        buildFrame(
          {
            tree: { ...box, id: "leaf", space: "clip" },
            commands: [],
            warnings: [],
            spaceProvenance: [
              {
                id: "layout",
                kind: "layout",
                parent: { status: "unavailable", reason: "scope layout root" },
              },
              {
                id: "clip",
                kind: "clip-local",
                parent: { status: "known", id: "layout" },
                owner: { path: marker },
              },
            ],
          },
          { limit: 20_000 },
        ),
      (error: unknown) =>
        error instanceof InspectionSerializationError &&
        /UTF-8, over the/.test(error.message),
    );
  } finally {
    JSON.stringify = originalStringify;
    TextEncoder.prototype.encode = originalEncode;
  }
  assert.equal(stringified, 0);
  assert.equal(encoded, 0);
});

test("a frozen foreign provider is not coerced, and escaped descriptor bytes match", () => {
  let coerced = 0;
  const hostilePath = Object.defineProperties(
    {},
    {
      [Symbol.toPrimitive]: {
        get() {
          coerced += 1;
          return () => "path";
        },
      },
      toString: {
        get() {
          coerced += 1;
          return () => "path";
        },
      },
      valueOf: {
        get() {
          coerced += 1;
          return () => "path";
        },
      },
    },
  );
  assert.throws(
    () =>
      buildFrame({
        tree: { ...box, space: "clip" },
        commands: [],
        warnings: [],
        spaceProvenance: Object.freeze([
          Object.freeze({
            id: "clip",
            kind: "clip-local",
            parent: Object.freeze({ status: "known", id: "layout" }),
            owner: Object.freeze({ path: hostilePath }),
          }),
        ]),
      }),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /received object/.test(error.message),
  );
  assert.equal(coerced, 0);

  const foreignId = `not/a/${"é".repeat(40)}`;
  const escaped = `quote\"slash\\${"\u0001".repeat(8)}🎯`;
  const plain = {
    tree: box,
    commands: [],
    warnings: [],
    spaceProvenance: [
      {
        id: "layout",
        kind: "layout",
        parent: { status: "unavailable", reason: "scope layout root" },
      },
    ],
  };
  const rich = {
    tree: { ...box, space: "clip" },
    commands: [],
    warnings: [],
    spaceProvenance: [
      ...plain.spaceProvenance,
      {
        id: "clip",
        kind: "clip-local",
        parent: { status: "known", id: "layout" },
        owner: { path: escaped, id: foreignId, inspectionId: 9_007_199_254_740_991 },
      },
    ],
  };
  const foreign = {
    tree: { ...box, space: foreignId },
    commands: [],
    warnings: [],
    spaceProvenance: plain.spaceProvenance,
  };
  const minimum = (frame: unknown) => {
    const fits = (limit: number) => {
      try {
        buildFrame(frame, { limit });
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
  const plainBuilt = buildFrame(plain);
  const richBuilt = buildFrame(rich);
  const foreignBuilt = buildFrame(foreign);
  const foreignSpace = foreignBuilt.scenes[0].spaces.find(
    (space) => space.id === foreignId,
  );
  assert.equal(foreignSpace?.kind, "unavailable");
  assert.equal("matrix" in (foreignSpace?.mapping ?? {}), false);
  assert.equal(
    minimum(rich) - minimum(plain),
    measureInspection(richBuilt) - measureInspection(plainBuilt),
  );
  assert.equal(
    minimum(foreign) - minimum(plain),
    measureInspection(foreignBuilt) - measureInspection(plainBuilt),
  );
});

test("a targeted budget does not charge the next unretained command", () => {
  let skippedReads = 0;
  const frame = {
    tree: { ...box, id: "keep", space: "room/world" },
    commands: [
      {
        path: "root",
        kind: "box",
        space: "room/world",
        bounds: box.bounds,
        transform: box.transform,
        opacity: 1,
      },
      {
        path: "other",
        kind: "box",
        space: "room/overlay",
        bounds: box.bounds,
        transform: box.transform,
        opacity: 1,
        get sharedId() {
          skippedReads += 1;
          return "x".repeat(80_000);
        },
      },
    ],
    warnings: [],
    spaceProvenance: [
      {
        id: "layout",
        kind: "layout",
        parent: { status: "unavailable", reason: "scope layout root" },
      },
      {
        id: "room/world",
        kind: "world",
        parent: { status: "known", id: "layout" },
        owner: { path: "room" },
      },
      {
        id: "room/overlay",
        kind: "composition-overlay",
        parent: { status: "known", id: "layout" },
        owner: { path: "room" },
      },
    ],
  };
  const target = { scope: "scene:main", id: "keep" };
  const built = buildFrame(frame, { target, limit: 20_000 });
  assert.equal(skippedReads, 0);
  assert.equal(built.scenes[0].commands?.length, 1);
  assert.deepEqual(
    built.scenes[0].spaces.map((space) => space.id),
    ["layout", "room/world"],
  );
  assert.equal(
    built.scenes[0].spaces.some((space) => space.kind === "composition-overlay"),
    false,
  );
});

test("a long parent cycle stays a serialization error after one read per record", () => {
  const count = 64;
  let indexGets = 0;
  const records = chainProvenance(count);
  records[0] = {
    ...records[0],
    parent: { status: "known", id: `s${count - 1}` },
  };
  const spaceProvenance = new Proxy(records, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) indexGets += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(
    () =>
      buildFrame({
        tree: box,
        commands: [],
        warnings: [],
        spaceProvenance,
      }),
    (error: unknown) =>
      error instanceof InspectionSerializationError &&
      /parent cycle/.test(error.message) &&
      !(error instanceof InspectionReadError),
  );
  assert.equal(indexGets, count);
});
