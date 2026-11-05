/**
 * G2 additive authoring primitives (docs/plans/declarative-layout-hardening.md §8):
 * per-axis frame alignment, directional padding, content-sized backgrounds,
 * and weighted flexible slots.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Box,
  Text,
  HStack,
  VStack,
  ZStack,
  Spacer,
  Grid,
  BarChart,
  Image,
  Group,
  Composition,
  World,
  ViewNode,
  evaluateView,
} from "../src/authoring/index";
import type { DrawCommand, EvaluatedFrame } from "../src/authoring/index";
import { collectSharedElements } from "../src/authoring/shared-elements";
import {
  matchSharedElements,
  multiply,
} from "../src/engine/render/shared-elements";

const evaluate = (root: ViewNode, time = 0, width = 400, height = 300) =>
  evaluateView(root, {
    time,
    width,
    height,
    measureText: (text, _font, tracking) =>
      Array.from(text).length * 10 +
      Math.max(0, Array.from(text).length - 1) * tracking,
  });
const box = (width = 20, height = 20) => Box({ width, height });
function paints(frame: EvaluatedFrame): readonly DrawCommand[] {
  return frame.commands;
}
function backgroundPaint(
  frame: EvaluatedFrame,
): Extract<DrawCommand, { kind: "box" }> {
  const command = paints(frame).find(
    (candidate) => candidate.paintRole === "background",
  );
  assert.ok(
    command && command.kind === "box",
    "expected a background box paint",
  );
  return command as Extract<DrawCommand, { kind: "box" }>;
}

test("frame alignX and alignY place each axis independently", () => {
  const node = box(20, 20).frame({
    width: 100,
    height: 60,
    alignX: "end",
    alignY: "start",
  });
  assert.deepEqual(paints(evaluate(node))[0].bounds, {
    x: 80,
    y: 0,
    width: 20,
    height: 20,
  });
  const mirrored = box(20, 20).frame({
    width: 100,
    height: 60,
    alignX: "start",
    alignY: "end",
  });
  assert.deepEqual(paints(evaluate(mirrored))[0].bounds, {
    x: 0,
    y: 40,
    width: 20,
    height: 20,
  });
});

test("frame axis alignment falls back to legacy align, then to center", () => {
  // An axis value overrides the legacy both-axis value on that axis only.
  const mixed = evaluate(
    box(20, 20).frame({
      width: 100,
      height: 60,
      align: "end",
      alignY: "start",
    }),
  );
  assert.deepEqual(paints(mixed)[0].bounds, {
    x: 80,
    y: 0,
    width: 20,
    height: 20,
  });
  // Legacy align still drives both axes when no axis value is given.
  const legacy = evaluate(
    box(20, 20).frame({ width: 100, height: 60, align: "start" }),
  );
  assert.deepEqual(paints(legacy)[0].bounds, {
    x: 0,
    y: 0,
    width: 20,
    height: 20,
  });
  // Neither value: center on both axes, exactly as before this primitive existed.
  const defaults = evaluate(box(20, 20).frame({ width: 100, height: 60 }));
  assert.deepEqual(paints(defaults)[0].bounds, {
    x: 40,
    y: 20,
    width: 20,
    height: 20,
  });
  // A single axis value leaves the other axis on the legacy default.
  const oneAxis = evaluate(
    box(20, 20).frame({ width: 100, height: 60, alignX: "start" }),
  );
  assert.deepEqual(paints(oneAxis)[0].bounds, {
    x: 0,
    y: 20,
    width: 20,
    height: 20,
  });
});

test("frame axis alignment keeps negative remaining space on both axes", () => {
  const node = box(150, 80).frame({
    width: 100,
    height: 50,
    alignX: "center",
    alignY: "end",
  });
  assert.deepEqual(paints(evaluate(node))[0].bounds, {
    x: -25,
    y: -30,
    width: 150,
    height: 80,
  });
});

test("stack cross-axis align stays untouched by the new frame axes", () => {
  const cross = evaluate(HStack([box(20, 30), box(5, 5)], { align: "end" }));
  assert.equal(paints(cross)[1].bounds.y, 25);
  const stack = evaluate(VStack([box(50, 10), box(10, 10)], { align: "end" }));
  assert.equal(paints(stack)[1].bounds.x, 40);
  // An explicit per-axis frame still works at the stack child boundary.
  const child = evaluate(
    HStack([box(20, 20).frame({ width: 40, height: 40, alignX: "end" })]),
  );
  assert.deepEqual(paints(child)[0].bounds, {
    x: 20,
    y: 10,
    width: 20,
    height: 20,
  });
});

test("numeric padding keeps its legacy symmetric behavior", () => {
  const symmetric = evaluate(box(20, 20).padding(10));
  assert.deepEqual(symmetric.tree.bounds, {
    x: 0,
    y: 0,
    width: 40,
    height: 40,
  });
  assert.deepEqual(paints(symmetric)[0].bounds, {
    x: 10,
    y: 10,
    width: 20,
    height: 20,
  });
  const asymmetric = evaluate(box(20, 20).padding(10, 4));
  assert.deepEqual(asymmetric.tree.bounds, {
    x: 0,
    y: 0,
    width: 40,
    height: 28,
  });
  assert.deepEqual(paints(asymmetric)[0].bounds, {
    x: 10,
    y: 4,
    width: 20,
    height: 20,
  });
});

test("directional padding defaults omitted edges to zero and normalizes to four insets", () => {
  const left = evaluate(box(20, 20).padding({ left: 6 }));
  assert.deepEqual(left.tree.bounds, { x: 0, y: 0, width: 26, height: 20 });
  assert.deepEqual(paints(left)[0].bounds, {
    x: 6,
    y: 0,
    width: 20,
    height: 20,
  });
  const mixed = evaluate(
    box(20, 20).padding({ top: 3, right: 5, bottom: 7, left: 11 }),
  );
  assert.deepEqual(mixed.tree.bounds, { x: 0, y: 0, width: 36, height: 30 });
  assert.deepEqual(paints(mixed)[0].bounds, {
    x: 11,
    y: 3,
    width: 20,
    height: 20,
  });
  const zero = evaluate(box(20, 20).padding({}));
  assert.deepEqual(zero.tree.bounds, { x: 0, y: 0, width: 20, height: 20 });
});

test("directional padding clamps the child proposal at zero and reports overflow", () => {
  const tight = evaluate(
    box(40, 20).padding({ left: 30, right: 30 }).frame({
      width: 50,
      align: "start",
    }),
  );
  // The child keeps its own size; the wrapper reports the full inset extent.
  assert.deepEqual(tight.tree.bounds, { x: 0, y: 0, width: 50, height: 20 });
  assert.deepEqual(paints(tight)[0].bounds, {
    x: 30,
    y: 0,
    width: 40,
    height: 20,
  });
  assert.ok(
    tight.warnings.some((warning) =>
      warning.includes("content exceeds offered bounds"),
    ),
    `oversized padding must stay diagnosable, got ${JSON.stringify(tight.warnings)}`,
  );
});

test("padding object and background inputs are snapshotted, not retained", () => {
  const insets = { top: 1, right: 2, bottom: 3, left: 4 };
  const padded = box(20, 20).padding(insets);
  insets.top = 100;
  insets.left = 100;
  assert.deepEqual(evaluate(padded).tree.bounds, {
    x: 0,
    y: 0,
    width: 26,
    height: 24,
  });
  const style = {
    fill: "#FF0000",
    radius: 2,
    stroke: "#000000",
    strokeWidth: 1,
  };
  const painted = box(20, 20).background(style);
  style.fill = "#00FF00";
  style.radius = 40;
  const command = backgroundPaint(evaluate(painted));
  assert.equal(command.fill, "#FF0000");
  assert.equal(command.radius, 2);
  assert.equal(command.stroke, "#000000");
  assert.equal(command.strokeWidth, 1);
  assert.ok(Object.isFrozen(painted.spec) && Object.isFrozen(padded.spec));
});

test("new padding and background inputs reject invalid values", () => {
  for (const top of [-1, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(
      () => evaluate(box().padding({ top })),
      /Padding must be finite and non-negative/,
      `padding top ${top} must be rejected`,
    );
  for (const edge of ["right", "bottom", "left"] as const)
    assert.throws(
      () => evaluate(box().padding({ [edge]: -2 })),
      /Padding must be finite and non-negative/,
    );
  assert.throws(() => evaluate(box().padding(2, -1)), /Padding/);
  // Legacy key names would silently become zero insets, so they are rejected here.
  assert.throws(
    () => box().padding({ x: 10, y: 20 } as never),
    /not supported; use top, right, bottom, left/,
  );
  // Background sets no size: width/height are rejected rather than reinterpreted.
  assert.throws(
    () => box().background({ width: 10 } as never),
    /Background sets no size/,
  );
  assert.throws(
    () => box().background({ height: 10 } as never),
    /Background sets no size/,
  );
  assert.throws(() => box().background({ radius: -1 }), /Background radius/);
  assert.throws(
    () => box().background({ strokeWidth: Number.NaN }),
    /Background strokeWidth/,
  );
});

test("background paints the wrapper's measured bounds before its child, without changing layout", () => {
  const plain = evaluate(box(20, 20));
  const painted = evaluate(
    box(20, 20).background({ fill: "#FF0000", radius: 4 }),
  );
  assert.deepEqual(
    painted.tree.bounds,
    plain.tree.bounds,
    "no measurement change",
  );
  assert.deepEqual(painted.tree.children[0].bounds, plain.tree.bounds);
  assert.equal(painted.tree.kind, "background");
  assert.equal(
    painted.commands.length,
    2,
    "one background paint plus the child",
  );
  assert.equal(painted.commands[0].paintRole, "background");
  assert.equal(painted.commands[1].paintRole, undefined);
  assert.deepEqual(painted.commands[0].bounds, {
    x: 0,
    y: 0,
    width: 20,
    height: 20,
  });
  // Content paints are unchanged apart from the extra wrapper path segment every modifier adds.
  assert.deepEqual(
    { ...painted.commands[1], path: "root" },
    plain.commands[0],
    "the child paint itself is unchanged by the wrapper",
  );
});

test("modifier order decides which padding the background covers", () => {
  const outer = evaluate(
    box(20, 20).padding(10).background({ fill: "#FF0000" }),
  );
  assert.deepEqual(backgroundPaint(outer).bounds, {
    x: 0,
    y: 0,
    width: 40,
    height: 40,
  });
  const inner = evaluate(
    box(20, 20).background({ fill: "#FF0000" }).padding(10),
  );
  assert.deepEqual(backgroundPaint(inner).bounds, {
    x: 10,
    y: 10,
    width: 20,
    height: 20,
  });
  // Directional: padding applied inside the background is painted, outside is not.
  const directional = evaluate(
    box(20, 20).padding({ left: 8 }).background({ fill: "#FF0000" }),
  );
  assert.deepEqual(backgroundPaint(directional).bounds, {
    x: 0,
    y: 0,
    width: 28,
    height: 20,
  });
});

test("background follows wrapper scale and offset paint transforms without reflow", () => {
  const scaled = evaluate(
    box(20, 20).background({ fill: "#FF0000" }).scale(2, 2, [0, 0]),
  );
  assert.deepEqual(backgroundPaint(scaled).transform, [2, 2, 0, 0]);
  // A background outside the scale paints unscaled layout bounds; the child still scales.
  const unscaled = evaluate(
    box(20, 20).scale(2, 2, [0, 0]).background({ fill: "#FF0000" }),
  );
  assert.deepEqual(backgroundPaint(unscaled).transform, [1, 1, 0, 0]);
  assert.deepEqual(
    unscaled.tree.children[0].children[0].transform,
    [2, 2, 0, 0],
  );
  const offset = evaluate(
    box(20, 20).background({ fill: "#FF0000" }).offset(5, 6),
  );
  assert.deepEqual(backgroundPaint(offset).transform, [1, 1, 5, 6]);
  // An offset applied inside the background moves only the child, not the wrapper paint.
  const innerOffset = evaluate(
    box(20, 20).offset(5, 6).background({ fill: "#FF0000" }),
  );
  assert.deepEqual(backgroundPaint(innerOffset).transform, [1, 1, 0, 0]);
  assert.deepEqual(innerOffset.tree.children[0].transform, [1, 1, 5, 6]);
});

test("background preserves per-primitive opacity semantics", () => {
  const faded = evaluate(
    box(20, 20).background({ fill: "#FF0000" }).opacity(0.25),
  );
  assert.deepEqual(
    paintedOpacity(faded),
    [0.25, 0.25],
    "the background wrapper is an ordinary primitive wrapper, not an isolation boundary",
  );
  const groupFaded = evaluate(
    Group([box(20, 20).background({ fill: "#FF0000" })]).opacity(0.5),
  );
  const group = groupFaded.commands[0];
  assert.equal(group.kind, "group");
  if (group.kind !== "group") return;
  assert.deepEqual(
    group.frame.commands.map((command) => command.opacity),
    [1, 1],
    "a Group still blends its combined image once",
  );
});
function paintedOpacity(frame: EvaluatedFrame): number[] {
  return frame.commands.map((command) => command.opacity);
}

test("a background does not clip or isolate its child", () => {
  const overflow = evaluate(
    box(80, 80)
      .background({ fill: "#FF0000" })
      .frame({ width: 20, height: 20, align: "start" }),
  );
  // The oversized child still paints its full 80x80 rect; nothing is clipped.
  assert.equal(overflow.commands.length, 2);
  assert.deepEqual(overflow.commands[1].bounds, {
    x: 0,
    y: 0,
    width: 80,
    height: 80,
  });
  assert.ok(overflow.warnings.some((warning) => warning.includes("exceeds")));
  // No composition/nested frame is introduced: a background is never a new surface.
  assert.equal(
    overflow.commands.some((command) => command.kind === "composition"),
    false,
  );
  assert.equal(
    overflow.commands.some((command) => command.kind === "group"),
    false,
  );
});

test("one authored ID yields exactly one shared target on both background orders", () => {
  const poses = (frame: EvaluatedFrame) =>
    collectSharedElements(frame, [400, 300], [400, 300]);
  // `.id()` before the background: the child draw leaf owns the target, as it always has.
  const inner = evaluate(
    box(20, 20).id("card").background({ fill: "#FF0000" }),
  );
  assert.deepEqual(poses(inner), [
    { id: "card", matrix: [20, 0, 0, 20, 0, 0] },
  ]);
  assert.equal(inner.commands[0].paintRole, "background");
  assert.equal(inner.commands[0].sharedId, undefined);
  assert.equal(inner.commands[0].matchId, undefined);
  assert.equal(inner.commands[1].sharedId, "card");
  // `.id()` after the background: the wrapper paint carries the single target via
  // `matchId`, so the declared ID is not lost and the child's paint gains no second one.
  const outer = evaluate(
    box(20, 20).background({ fill: "#FF0000" }).id("card"),
  );
  assert.deepEqual(poses(outer), [
    { id: "card", matrix: [20, 0, 0, 20, 0, 0] },
  ]);
  assert.equal(outer.commands[0].paintRole, "background");
  assert.equal(outer.commands[0].matchId, "card");
  assert.equal(outer.commands[0].sharedId, undefined);
  assert.equal(outer.commands[1].sharedId, undefined);
  assert.equal(outer.commands[1].matchId, undefined);
  // The wrapper target covers the wrapper's measured bounds, including its padding, so a
  // transition animates the painted card rather than only the inset content.
  const padded = evaluate(
    box(20, 20)
      .padding({ top: 4, right: 6, bottom: 4, left: 6 })
      .background({ fill: "#FF0000" })
      .id("card"),
  );
  assert.deepEqual(poses(padded), [
    { id: "card", matrix: [32, 0, 0, 28, 0, 0] },
  ]);
  // Two different declared IDs still produce two targets, one per ID.
  const pair = evaluate(
    ZStack([
      box(20, 20).id("a").background({ fill: "#FF0000" }),
      box(10, 10).background({ fill: "#00FF00" }).id("b"),
    ]),
  );
  assert.deepEqual(
    poses(pair).map((pose) => pose.id),
    ["a", "b"],
  );
  // An inner leaf ID and an outer wrapper ID are two distinct declared IDs, and each
  // keeps its own single target: nothing is duplicated and nothing is dropped.
  const nested = evaluate(
    box(20, 20).id("inner").background({ fill: "#FF0000" }).id("outer"),
  );
  assert.deepEqual(
    poses(nested).map((pose) => pose.id),
    ["outer", "inner"],
  );
  assert.equal(nested.commands[0].matchId, "outer");
  assert.equal(nested.commands[1].sharedId, "inner");
});

test("an ID repeated on one wrapper chain stays a single target", () => {
  const poses = (node: ViewNode) =>
    collectSharedElements(evaluate(node), [400, 300], [400, 300]);
  // `.id("a").background(...).id("a")` declares the same ID twice on one chain. Paint order
  // puts the ancestor first, so it stays exactly one target and the matcher never sees a
  // duplicate it would reject.
  const repeated = poses(
    box(20, 20).id("a").background({ fill: "#FF0000" }).id("a"),
  );
  assert.deepEqual(
    repeated.map((pose) => pose.id),
    ["a"],
  );
  assert.deepEqual(
    matchSharedElements(repeated, repeated, 0.5)[0].get("a"),
    [1, 0, 0, 1, 0, 0],
  );
  // Two distinct sibling chains sharing an ID still fail at layout, as before.
  assert.throws(
    () =>
      evaluate(
        HStack([
          box(20, 20).background({ fill: "#FF0000" }).id("dup"),
          box(20, 20).background({ fill: "#FF0000" }).id("dup"),
        ]),
      ),
    /Duplicate sibling ID: dup/,
  );
});

test("a wrapper-declared background ID carries the same target into shared transitions", () => {
  const poses = (node: ViewNode) =>
    collectSharedElements(evaluate(node), [400, 300], [400, 300]);
  const card = (width: number, height: number) =>
    box(width, height).background({ fill: "#FF0000" }).id("card");
  // Same declared card in two sibling slots: the classic shared-element hand-off.
  const start = poses(HStack([card(20, 20), box(100, 20)], { gap: 10 }));
  const end = poses(HStack([box(100, 20), card(40, 40)], { gap: 10 }));
  assert.deepEqual(
    start.map((pose) => pose.id),
    ["card"],
  );
  assert.deepEqual(
    end.map((pose) => pose.id),
    ["card"],
  );
  const [outgoing, incoming] = matchSharedElements(start, end, 0.5);
  // Both sides resolve to the same mid-transition pose, exactly like a leaf-declared ID.
  assert.deepEqual(
    multiply(outgoing.get("card")!, start[0].matrix),
    multiply(incoming.get("card")!, end[0].matrix),
  );
  assert.deepEqual(
    multiply(outgoing.get("card")!, start[0].matrix),
    [30, 0, 0, 30, 55, 0],
  );
});

test("every paint of a declared chain shares one ordered correction scope", () => {
  // Paint-correction scope is separate from matching identity: both modifier orders publish
  // the same candidate list on the background and the content, so one shared transition moves
  // them together instead of leaving one behind.
  for (const node of [
    box(20, 20).id("card").background({ fill: "#FF0000" }),
    box(20, 20).background({ fill: "#FF0000" }).id("card"),
  ]) {
    const frame = evaluate(node);
    assert.deepEqual(
      frame.commands.map((command) => command.correctionIds),
      [["card"], ["card"]],
      `all paints of the chain share the declared scope: ${JSON.stringify(
        frame.commands.map((command) => command.path),
      )}`,
    );
  }
  // Padding between the declaration and the paint does not change the scope.
  const inset = (idFirst: boolean) => {
    const base = box(20, 20).padding({ left: 10, right: 10 });
    const node = idFirst
      ? base.id("card").background({ fill: "#FF0000" })
      : base.background({ fill: "#FF0000" }).id("card");
    return evaluate(node).commands.map((command) => command.correctionIds);
  };
  assert.deepEqual(inset(true), [["card"], ["card"]]);
  assert.deepEqual(inset(false), [["card"], ["card"]]);
  // Distinct inner and outer declarations share ONE ordered list with the innermost first.
  // Both paints therefore follow the same pose, and an inner ID the transition did not match
  // falls back to the matched outer one instead of suppressing it.
  const distinct = evaluate(
    box(20, 20).id("inner").background({ fill: "#FF0000" }).id("outer"),
  );
  assert.deepEqual(
    distinct.commands.map((command) => [
      command.paintRole,
      command.correctionIds,
    ]),
    [
      ["background", ["inner", "outer"]],
      [undefined, ["inner", "outer"]],
    ],
  );
  // No declared ID means no correction scope at all.
  const anonymous = evaluate(box(20, 20).background({ fill: "#FF0000" }));
  assert.deepEqual(
    anonymous.commands.map((command) => command.correctionIds),
    [undefined, undefined],
  );
});

test("an unmatched surface candidate never suppresses a matched descendant", () => {
  // Review repro: the outgoing Group wrapper declares `outer`, which this transition does not
  // match, while the box inside declares `inner`, which it does. Descendant suppression must
  // depend on the matrix a surface actually resolves, not on candidate names existing.
  const group = evaluate(
    Group([box(20, 20).id("inner")])
      .background({ fill: "#FF0000" })
      .id("outer"),
  );
  const groupSurface = group.commands.find(
    (command) => command.kind === "group",
  );
  assert.ok(groupSurface && groupSurface.kind === "group");
  // The Group surface carries only its own wrapper chain; `inner` is a child, not part of it.
  assert.deepEqual(groupSurface.correctionIds, ["outer"]);
  const inner = groupSurface.frame.commands.find(
    (command) => command.sharedId === "inner",
  );
  assert.ok(inner, "the inner box must still paint");
  assert.deepEqual(
    inner.correctionIds,
    ["inner"],
    "the inner box keeps its own scope instead of inheriting an empty suppression list",
  );
  // The clip analogue: the surface lists `outer`, the content keeps `inner`.
  const clip = evaluate(
    box(20, 20).id("inner").clip().background({ fill: "#FF0000" }).id("outer"),
  );
  const clipSurface = clip.commands.find(
    (command) => command.kind === "composition",
  );
  assert.ok(clipSurface && clipSurface.kind === "composition");
  // A clip wraps its content in one child chain, so its surface lists both declarations.
  assert.deepEqual(clipSurface.correctionIds, ["inner", "outer"]);
  const clippedContent = clipSurface.frame.commands.find(
    (command) => command.sharedId === "inner",
  );
  assert.ok(clippedContent, "the clipped content must still paint");
  assert.deepEqual(
    clippedContent.correctionIds,
    ["inner"],
    "clipped content keeps its own scope too",
  );
});

test("paint metadata is additive only: no command is duplicated per declared ID", () => {
  // Same-IDs-both-matched shape: one command per source, so the renderer cannot apply two
  // matrices to one paint even when every candidate resolves.
  const frame = evaluate(
    Group([box(20, 20).id("inner")])
      .background({ fill: "#FF0000" })
      .id("outer"),
  );
  const flat: DrawCommand[] = [];
  const walk = (commands: readonly DrawCommand[]) => {
    for (const command of commands) {
      flat.push(command);
      if (command.kind === "group" || command.kind === "composition")
        walk(command.frame.commands);
    }
  };
  walk(frame.commands);
  assert.deepEqual(
    flat.map((command) => command.path),
    ["outer", "outer/group", "outer/group/inner"],
    "one paint command per source node, background first",
  );
  assert.equal(
    flat.filter((command) => command.correctionIds?.length).length,
    3,
    "each surviving paint carries exactly one candidate list",
  );
});

test("wrapper traversals stay intact: Grid, charts, media, clips, and Groups", () => {
  const grid = evaluate(
    Grid(
      [
        {
          id: "cell",
          column: 0,
          row: 0,
          view: box(5, 5)
            .padding({ top: 2, right: 3 })
            .background({ fill: "#FF0000" }),
        },
      ],
      { columns: 1, rows: 1, cellWidth: 40, cellHeight: 20 },
    ),
  );
  assert.deepEqual(grid.tree.bounds, { x: 0, y: 0, width: 40, height: 20 });
  assert.equal(grid.commands.length, 2);
  assert.equal(grid.commands[0].paintRole, "background");
  assert.equal(grid.commands[1].kind, "box");
  const chart = evaluate(
    BarChart([{ id: "bar", value: 1 }], { width: 90, height: 80 }).background({
      fill: "#FF0000",
    }),
  );
  assert.deepEqual(backgroundPaint(chart).bounds, {
    x: 0,
    y: 0,
    width: 90,
    height: 80,
  });
  const media = evaluate(
    Image({ url: "/logo.png", width: 40, height: 40 }).background({
      fill: "#FF0000",
    }),
  );
  assert.deepEqual(media.tree.bounds, { x: 0, y: 0, width: 40, height: 40 });
  assert.equal(media.commands[0].paintRole, "background");
  assert.equal(media.commands[1].kind, "media");
  const clipped = evaluate(
    box(20, 20)
      .background({ fill: "#FF0000" })
      .frame({ width: 10, height: 10 })
      .clip(),
  );
  // The clip wraps the background: one composition surface, background painted inside it.
  assert.equal(clipped.commands.length, 1);
  assert.equal(clipped.commands[0].kind, "composition");
  const group = evaluate(Group([box(20, 20).background({ fill: "#FF0000" })]));
  assert.equal(group.commands.length, 1);
  assert.equal(group.commands[0].kind, "group");
});

test("backgrounds inside compositions keep scoped spaces and diagnostics", () => {
  const world = World(
    () =>
      HStack([box(300, 20).background({ fill: "#FF0000" }), box(50)], {
        gap: 10,
      }).id("wide"),
    { size: [200, 300] },
  );
  const frame = evaluateView(Composition(world).id("viewport"), {
    time: 0,
    width: 200,
    height: 300,
    measureText: () => 0,
  });
  const outer = frame.commands[0];
  assert.equal(outer.kind, "composition");
  if (outer.kind !== "composition") return;
  assert.equal(outer.frame.commands[0].paintRole, "background");
  assert.ok(
    frame.diagnostics?.length,
    "overflow inside the world stays diagnosable",
  );
  for (const entry of frame.diagnostics!)
    assert.notEqual(entry.space, "layout");
});

test("numeric padding matches the directional object form, and wrapped Spacers keep their allocation", () => {
  const legacy = evaluate(
    VStack([box(100, 20), box(40, 30)], { gap: 10, align: "end" }).padding(10),
  );
  const directional = evaluate(
    VStack([box(100, 20), box(40, 30)], { gap: 10, align: "end" }).padding({
      top: 10,
      right: 10,
      bottom: 10,
      left: 10,
    }),
  );
  assert.deepEqual(directional, legacy);
  const spacerRow = HStack([Spacer(), box(100), Spacer()]).frame({
    width: 200,
    align: "start",
  });
  const wrapped = HStack([
    Spacer().background({ fill: "#FF0000" }),
    box(100),
    Spacer().padding({ left: 0 }).background({ fill: "#00FF00" }),
  ]).frame({ width: 200, align: "start" });
  assert.deepEqual(
    evaluate(wrapped).tree.children.map((child) => child.bounds.width),
    evaluate(spacerRow).tree.children.map((child) => child.bounds.width),
    "wrapped Spacers keep their flexible allocation",
  );
});

test("text inside a padded background keeps its text layout", () => {
  const text = Text("card", { size: 20, lineHeight: 25 });
  const plain = evaluate(text);
  const card = evaluate(
    text.padding({ top: 6, right: 8, bottom: 6, left: 8 }).background({
      fill: "#FF0000",
      radius: 6,
    }),
  );
  assert.deepEqual(card.tree.bounds, { x: 0, y: 0, width: 56, height: 37 });
  assert.deepEqual(card.commands[0].bounds, card.tree.bounds);
  const textCommand = card.commands[1];
  assert.equal(textCommand.kind, "text");
  if (textCommand.kind !== "text") return;
  assert.deepEqual(
    textCommand.text,
    (plain.commands[0] as { text: unknown }).text,
  );
  assert.deepEqual(textCommand.bounds, { x: 8, y: 6, width: 40, height: 25 });
});

test("deterministic evaluation for direct, forward, and backward seeks", () => {
  const root = VStack([
    Text("title").background({ fill: "#FF0000" }),
    box(40, 20)
      .padding({ left: 4, right: 4 })
      .frame({ alignX: "end" })
      .offset({ from: 40, to: 0, duration: 2 })
      .opacity({ from: 0, to: 1, duration: 2 }),
  ]);
  const expected = evaluate(root, 1.5);
  evaluate(root, 0);
  evaluate(root, 1);
  assert.deepEqual(evaluate(root, 1.5), expected);
  evaluate(root, 2);
  evaluate(root, 0.2);
  assert.deepEqual(evaluate(root, 1.5), expected);
});

test("flex allocates main-axis space by unequal weights on both axes", () => {
  // Horizontal: width 400, flex(1) and flex(3) share 400 -> 100 and 300
  const hFrame = evaluate(
    HStack([box(20, 30).flex(1), box(20, 40).flex(3)], { gap: 0 }),
    0,
    400,
    200,
  );
  assert.deepEqual(
    hFrame.tree.children.map((c) => c.bounds),
    [
      { x: 0, y: 5, width: 100, height: 30 },
      { x: 100, y: 0, width: 300, height: 40 },
    ],
  );
  assert.deepEqual(hFrame.tree.bounds, { x: 0, y: 0, width: 400, height: 40 });

  // Vertical: height 300, flex(1) and flex(2) share 300 -> 100 and 200
  const vFrame = evaluate(
    VStack([box(30, 20).flex(1), box(40, 20).flex(2)], { gap: 0 }),
    0,
    200,
    300,
  );
  assert.deepEqual(
    vFrame.tree.children.map((c) => c.bounds),
    [
      { x: 5, y: 0, width: 30, height: 100 },
      { x: 0, y: 100, width: 40, height: 200 },
    ],
  );
  assert.deepEqual(vFrame.tree.bounds, { x: 0, y: 0, width: 40, height: 300 });
});

test("flex reserves gaps and fixed siblings, and deficit leaves flex at 0 with diagnostic", () => {
  // Available 200, gap 10, fixed 60 -> remaining 130
  const withFixed = evaluate(
    HStack([box(60, 20), box(20, 20).flex(1)], { gap: 10 }),
    0,
    200,
    100,
  );
  assert.deepEqual(
    withFixed.tree.children.map((c) => c.bounds),
    [
      { x: 0, y: 0, width: 60, height: 20 },
      { x: 70, y: 0, width: 130, height: 20 },
    ],
  );
  assert.equal(withFixed.diagnostics, undefined);

  // Deficit: available 100, fixed 70 + 40 = 110, gap 10 -> deficit 20
  const deficit = evaluate(
    HStack([box(70, 20), box(40, 20), box(20, 20).flex(1)], { gap: 10 }),
    0,
    100,
    100,
  );
  assert.deepEqual(
    deficit.tree.children.map((c) => c.bounds.width),
    [70, 40, 0],
    "fixed siblings do not shrink; flexible slot gets 0",
  );
  const defDiag = deficit.diagnostics?.find(
    (d) => d.code === "fixed-allocation-deficit",
  );
  assert.ok(defDiag, "fixed-allocation-deficit must be emitted on deficit");
  assert.equal(defDiag.deficit, 30);
});

test("all boundary padding is included in the slot budget: both orders produce identical outer bounds", () => {
  // Width 200, slot is 200
  // Order A: padding inside flex
  const orderA = evaluate(
    HStack([box(20, 20).padding(10).flex(1)]),
    0,
    200,
    100,
  );
  // Order B: flex inside padding
  const orderB = evaluate(
    HStack([box(20, 20).flex(1).padding(10)]),
    0,
    200,
    100,
  );
  assert.deepEqual(orderA.tree.children[0].bounds, {
    x: 0,
    y: 0,
    width: 200,
    height: 40,
  });
  assert.deepEqual(
    orderB.tree.children[0].bounds,
    orderA.tree.children[0].bounds,
    "both orders have identical outer bounds and do not expand the slot",
  );

  // Deficit with padding: neither order expands 0 slot
  const deficitA = evaluate(
    HStack([box(100, 20), box(20, 20).padding(10).flex(1)]),
    0,
    100,
    100,
  );
  const deficitB = evaluate(
    HStack([box(100, 20), box(20, 20).flex(1).padding(10)]),
    0,
    100,
    100,
  );
  assert.equal(deficitA.tree.children[1].bounds.width, 0);
  assert.equal(deficitB.tree.children[1].bounds.width, 0);
});

test("legacy Spacer and fill frame mix with explicit flex siblings without rewriting legacy behavior", () => {
  // HStack with legacy Spacer (weight 1) and explicit flex(2): total weight 3 in 300 -> 100 and 200
  const mixedSpacer = evaluate(
    HStack([Spacer(), box(20, 20).flex(2)], { gap: 0 }),
    0,
    300,
    100,
  );
  assert.deepEqual(
    mixedSpacer.tree.children.map((c) => c.bounds.width),
    [100, 200],
  );

  // Wrapped Spacer keeps weight 1 in mixed stack
  const mixedWrapped = evaluate(
    HStack([Spacer().padding(10), box(20, 20).flex(2)], { gap: 0 }),
    0,
    300,
    100,
  );
  assert.deepEqual(
    mixedWrapped.tree.children.map((c) => c.bounds.width),
    [100, 200],
  );

  // Fill frame without explicit flex mixes with flex(3): total weight 1 + 3 = 4 in 400 -> 100 and 300
  const mixedFill = evaluate(
    HStack([box(20, 20).frame({ width: "fill" }), box(20, 20).flex(3)], {
      gap: 0,
    }),
    0,
    400,
    100,
  );
  assert.deepEqual(
    mixedFill.tree.children.map((c) => c.bounds.width),
    [100, 300],
  );

  // Fill frame WITH explicit flex: explicit flex weight wins
  const flexWins = evaluate(
    HStack([box(20, 20).frame({ width: "fill" }).flex(2), box(20, 20).flex(1)], {
      gap: 0,
    }),
    0,
    300,
    100,
  );
  assert.deepEqual(
    flexWins.tree.children.map((c) => c.bounds.width),
    [200, 100],
  );
});

test("boundary chain combination errors and valid cross-axis frames", () => {
  // Multiple flex on same boundary chain throws path-specific error
  assert.throws(
    () => evaluate(HStack([box(20, 20).flex(1).flex(2)])),
    /Multiple flex modifiers on the same boundary chain are not supported/,
  );

  // Flex plus numeric main-axis frame throws
  assert.throws(
    () => evaluate(HStack([box(20, 20).frame({ width: 50 }).flex(1)])),
    /Flex cannot be combined with a fixed main-axis frame/,
  );
  assert.throws(
    () => evaluate(VStack([box(20, 20).frame({ height: 50 }).flex(1)])),
    /Flex cannot be combined with a fixed main-axis frame/,
  );

  // Flex plus numeric cross-axis frame is valid
  const crossH = evaluate(
    HStack([box(20, 20).frame({ height: 50 }).flex(1)], { gap: 0 }),
    0,
    200,
    100,
  );
  assert.deepEqual(crossH.tree.children[0].bounds, {
    x: 0,
    y: 0,
    width: 200,
    height: 50,
  });

  const crossV = evaluate(
    VStack([box(20, 20).frame({ width: 50 }).flex(1)], { gap: 0 }),
    0,
    100,
    200,
  );
  assert.deepEqual(crossV.tree.children[0].bounds, {
    x: 0,
    y: 0,
    width: 50,
    height: 200,
  });
});

test("flex outside HStack/VStack has no allocation effect and emits unused-flex diagnostic", () => {
  // At root
  const root = evaluate(box(40, 30).flex(2), 0, 200, 200);
  assert.deepEqual(root.tree.bounds, { x: 0, y: 0, width: 40, height: 30 });
  const rootDiag = root.diagnostics?.find((d) => d.code === "unused-flex");
  assert.ok(rootDiag, "root flex must emit unused-flex diagnostic");
  assert.ok(root.warnings.some((w) => w.includes("flex has no effect")));

  // Inside ZStack
  const zstack = evaluate(ZStack([box(40, 30).flex(1)]), 0, 200, 200);
  assert.ok(
    zstack.diagnostics?.some((d) => d.code === "unused-flex"),
    "ZStack flex must emit unused-flex diagnostic",
  );

  // Inside Group
  const group = evaluate(Group([box(40, 30).flex(1)]), 0, 200, 200);
  assert.ok(
    group.diagnostics?.some((d) => d.code === "unused-flex"),
    "Group flex must emit unused-flex diagnostic",
  );
});

test("content exceeding slot remains visible unless clipped explicitly, with overflow diagnostic", () => {
  // Without clip: slot is 100, child is 150 -> child paints width 150, overflow diagnostic emitted
  const unclipped = evaluate(
    HStack([box(150, 20).flex(1), box(50, 20)], { gap: 0 }),
    0,
    150,
    100,
  );
  // Total 150, fixed 50 -> slot 100
  assert.equal(unclipped.tree.children[0].bounds.width, 100);
  assert.equal(unclipped.tree.children[1].bounds.x, 100);
  const overflow = unclipped.diagnostics?.find(
    (d) => d.code === "offered-size-overflow",
  );
  assert.ok(overflow, "offered-size-overflow must be emitted");
  // Child command paints unclipped at 150
  assert.equal(unclipped.commands[0].bounds.width, 150);

  // With clip: clip bounds are 100, content is clipped
  const clipped = evaluate(
    HStack([box(150, 20).flex(1).clip(), box(50, 20)], { gap: 0 }),
    0,
    150,
    100,
  );
  const clipCmd = clipped.commands[0];
  assert.equal(clipCmd.kind, "composition");
  assert.equal(clipCmd.bounds.width, 100);
});

test("zero offered text width preserves line height and grapheme wrapping without infinite loop", () => {
  // Deficit forces slot to 0: text must wrap graphemes, line height intact, no hang
  const textFrame = evaluate(
    HStack([box(100, 20), Text("search", { wrap: true, size: 20, lineHeight: 24 }).flex(1)]),
    0,
    100,
    100,
  );
  assert.equal(textFrame.tree.children[1].bounds.width, 0);

  // Empty text preserves empty line box (1 line)
  const emptyFrame = evaluate(
    HStack([box(100, 20), Text("", { size: 20, lineHeight: 24 }).flex(1)]),
    0,
    100,
    100,
  );
  assert.equal(emptyFrame.tree.children[1].bounds.width, 0);
});

test("ViewNode.flex is immutable, defaults to weight 1, and rejects invalid inputs", () => {
  const original = box(20, 20);
  const flexed = original.flex();
  assert.notEqual(original, flexed);
  assert.equal(original.spec.kind, "box");
  assert.equal(flexed.spec.kind, "flex");
  assert.equal((flexed.spec as { weight: number }).weight, 1);
  assert.ok(Object.isFrozen(flexed));
  assert.ok(Object.isFrozen(flexed.spec));

  assert.throws(() => original.flex(0), /Flex weight must be finite and positive/);
  assert.throws(() => original.flex(-1), /Flex weight must be finite and positive/);
  assert.throws(() => original.flex(NaN), /Flex weight must be finite and positive/);
  assert.throws(() => original.flex(Infinity), /Flex weight must be finite and positive/);
});

test("negative scale, clip order, and wrapper traversal through flex", () => {
  // Scaled flex card: transforms and paint order intact
  const scaled = evaluate(
    HStack([
      box(20, 20)
        .padding(10)
        .background({ fill: "#FF0000" })
        .scale(-1, 1)
        .flex(1),
    ]),
    0,
    200,
    100,
  );
  assert.equal(scaled.tree.children[0].bounds.width, 200);
  assert.equal(scaled.commands.length, 2);
  assert.equal(scaled.commands[0].paintRole, "background");

  // Grid cell with flex inside cell: inner container owns allocation
  const gridFrame = evaluate(
    Grid(
      [
        {
          id: "cell",
          column: 0,
          row: 0,
          view: HStack([box(10).flex(1), box(10).flex(2)]),
        },
      ],
      { columns: 1, rows: 1, cellWidth: 90, cellHeight: 30 },
    ),
  );
  assert.deepEqual(gridFrame.tree.bounds, { x: 0, y: 0, width: 90, height: 30 });

  // Shared element ID on flex wrapper
  const shared = evaluate(
    HStack([
      box(20, 20)
        .padding(10)
        .background({ fill: "#FF0000" })
        .id("hero")
        .flex(1),
    ]),
  );
  const elements = collectSharedElements(shared, [400, 300], [400, 300]);
  assert.equal(elements.length, 1);
  assert.equal(elements[0].id, "hero");
});

test("content-driven cards and search bar with fixed button without manual coordinates", () => {
  // Real layout pattern: search input expands flexibly, search button stays fixed
  const searchRow = (query: string) =>
    HStack(
      [
        Text(query, { size: 16 })
          .padding({ top: 8, right: 12, bottom: 8, left: 12 })
          .background({ fill: "#EEEEEE", radius: 4 })
          .flex(1),
        Text("Search", { size: 16 })
          .padding({ top: 8, right: 16, bottom: 8, left: 16 })
          .background({ fill: "#0066FF", radius: 4 }),
      ],
      { gap: 10 },
    );

  const shortQuery = evaluate(searchRow("hi"), 0, 400, 100);
  const longQuery = evaluate(searchRow("searching for declarative layout hardening"), 0, 400, 100);

  // In both queries:
  // Button width is fixed at its content + padding (6 * 10 + 32 = 92)
  // Input takes remaining width: 400 - 10 (gap) - 92 = 298
  assert.equal(shortQuery.tree.children[0].bounds.width, 298);
  assert.equal(shortQuery.tree.children[1].bounds.width, 92);
  assert.equal(shortQuery.tree.children[1].bounds.x, 308);

  assert.equal(longQuery.tree.children[0].bounds.width, 298);
  assert.equal(longQuery.tree.children[1].bounds.width, 92);
  assert.equal(longQuery.tree.children[1].bounds.x, 308);

  // Vertically stacked cards without manual Y coordinates
  const cardList = VStack(
    [
      Text("Card A").padding(10).background({ fill: "#FFFFFF" }),
      Text("Card B with longer content").padding(10).background({ fill: "#FFFFFF" }),
      Text("Card C").padding(10).background({ fill: "#FFFFFF" }),
    ],
    { gap: 12 },
  );
  const listFrame = evaluate(cardList, 0, 300, 400);
  assert.equal(listFrame.tree.children.length, 3);
  assert.equal(listFrame.tree.children[0].bounds.y, 0);
  assert.equal(
    listFrame.tree.children[1].bounds.y,
    listFrame.tree.children[0].bounds.height + 12,
  );
  assert.equal(
    listFrame.tree.children[2].bounds.y,
    listFrame.tree.children[0].bounds.height +
      12 +
      listFrame.tree.children[1].bounds.height +
      12,
  );
});

test("slot cap applies to every boundary wrapper on the main axis without inflating internal clip or background", () => {
  // HStack: width 100, fixed 90 -> slot is 10
  // Order A: padding inside clip/background, inside flex
  const orderA = evaluate(
    HStack([
      box(90, 20),
      box(5, 5)
        .padding(10)
        .clip()
        .background({ fill: "#FF0000" })
        .flex(1),
    ]),
    0,
    100,
    100,
  );
  // Outer flex node
  const flexA = orderA.tree.children[1];
  assert.equal(flexA.bounds.width, 10);
  // Background wrapper
  const bgA = flexA.children[0];
  assert.equal(bgA.bounds.width, 10, "background wrapper width must not exceed slotMain");
  // Clip wrapper
  const clipA = bgA.children[0];
  assert.equal(clipA.bounds.width, 10, "clip wrapper width must not exceed slotMain");
  // Padding wrapper
  const padA = clipA.children[0];
  assert.equal(padA.bounds.width, 10, "padding wrapper width must not exceed slotMain");
  // Leaf box
  const leafA = padA.children[0];
  assert.equal(leafA.bounds.width, 5, "leaf box keeps its intrinsic size");

  // Commands: clip and background draw commands bounded by 10
  const bgCmdA = orderA.commands.find((c) => c.paintRole === "background")!;
  assert.equal(bgCmdA.bounds.width, 10, "background draw command width capped at 10");
  const clipCmdA = orderA.commands.find((c) => c.kind === "composition")!;
  assert.equal(clipCmdA.bounds.width, 10, "clip draw command width capped at 10");

  // Order B: flex inside background/clip/padding
  const orderB = evaluate(
    HStack([
      box(90, 20),
      box(5, 5)
        .flex(1)
        .background({ fill: "#FF0000" })
        .clip()
        .padding({ left: 3, right: 3 }),
    ]),
    0,
    100,
    100,
  );
  const padB = orderB.tree.children[1];
  assert.equal(padB.bounds.width, 10, "outer padding width capped at slotMain");
  const clipB = padB.children[0];
  assert.equal(clipB.bounds.width, 4, "internal clip width must not exceed slotMain");
  const bgB = clipB.children[0];
  assert.equal(bgB.bounds.width, 4, "internal background width must not exceed slotMain");

  // Commands in Order B: background is inside clip's composition frame
  const clipCmdB = orderB.commands.find((c) => c.kind === "composition")!;
  assert.equal(clipCmdB.bounds.width, 4, "Order B clip command must not exceed slotMain");
  const bgCmdB = (clipCmdB as { frame: EvaluatedFrame }).frame.commands.find(
    (c) => c.paintRole === "background",
  )!;
  assert.equal(bgCmdB.bounds.width, 4, "Order B background command must not exceed slotMain");

  // VStack: height 100, fixed 90 -> slot is 10
  const vOrderA = evaluate(
    VStack([
      box(20, 90),
      box(5, 5)
        .padding(10)
        .clip()
        .background({ fill: "#FF0000" })
        .flex(1),
    ]),
    0,
    100,
    100,
  );
  const vFlexA = vOrderA.tree.children[1];
  assert.equal(vFlexA.bounds.height, 10);
  const vBgA = vFlexA.children[0];
  assert.equal(vBgA.bounds.height, 10, "VStack background wrapper height capped at 10");
  const vClipA = vBgA.children[0];
  assert.equal(vClipA.bounds.height, 10, "VStack clip wrapper height capped at 10");
  const vPadA = vClipA.children[0];
  assert.equal(vPadA.bounds.height, 10, "VStack padding wrapper height capped at 10");

  // Overflow without clip remains visible with diagnostic
  const overflow = evaluate(
    HStack([box(90, 20), box(30, 20).flex(1)]),
    0,
    100,
    100,
  );
  assert.equal(overflow.tree.children[1].bounds.width, 10);
  // Leaf box draws at its unclipped width 30
  assert.equal(overflow.commands[1].bounds.width, 30);
  assert.ok(
    overflow.diagnostics?.some(
      (d) => d.code === "offered-size-overflow" && d.excess?.width === 20,
    ),
    "offered-size-overflow with exact excess 20 emitted",
  );
});

test("per-level available padding budget caps nested wrappers and clip ends at slot bound", () => {
  // Exact reviewer reproduction:
  // slot 10, chain .padding(10).clip().padding({ left: 5 }).flex()
  // Proposal inside padding({ left: 5 }) is 10 - 5 = 5.
  // Clip is placed at x = 95 with width = 5, ending at 100 (not 105!).
  const repro = evaluate(
    HStack([
      box(90, 20),
      box(2, 2)
        .padding(10)
        .clip()
        .padding({ left: 5 })
        .flex(1),
    ]),
    0,
    100,
    100,
  );
  const flexNode = repro.tree.children[1];
  assert.equal(flexNode.bounds.width, 10);
  const outerPad = flexNode.children[0];
  assert.equal(outerPad.bounds.width, 10);
  const clipNode = outerPad.children[0];
  assert.equal(clipNode.bounds.x, 95);
  assert.equal(clipNode.bounds.width, 5, "clip width must be 5 (per-level budget 10 - 5)");
  assert.equal(clipNode.bounds.x + clipNode.bounds.width, 100, "clip must end at 100, not 105");
  const innerPad = clipNode.children[0];
  assert.equal(innerPad.bounds.width, 5, "inner padding wrapper capped to level proposal 5");
  const leafBox = innerPad.children[0];
  assert.equal(leafBox.bounds.width, 2, "leaf box keeps intrinsic size 2");

  // Clip composition command must have bounds x = 95, width = 5
  const clipCmd = repro.commands.find((c) => c.kind === "composition")!;
  assert.equal(clipCmd.bounds.x, 95);
  assert.equal(clipCmd.bounds.width, 5);

  // Both orders: padding outside flex with nested padding inside
  const orderB = evaluate(
    HStack([
      box(90, 20),
      box(2, 2)
        .padding(10)
        .clip()
        .flex(1)
        .padding({ left: 5 }),
    ]),
    0,
    100,
    100,
  );
  const outerPadB = orderB.tree.children[1];
  assert.equal(outerPadB.bounds.width, 10);
  const flexB = outerPadB.children[0];
  assert.equal(flexB.bounds.x, 95);
  assert.equal(flexB.bounds.width, 5);
  const clipB = flexB.children[0];
  assert.equal(clipB.bounds.x, 95);
  assert.equal(clipB.bounds.width, 5, "Order B clip width must be 5");
  assert.equal(clipB.bounds.x + clipB.bounds.width, 100, "Order B clip must end at 100");

  // Nested background with nested padding: background capped to level budget
  const nestedBg = evaluate(
    HStack([
      box(90, 20),
      box(2, 2)
        .padding(10)
        .background({ fill: "#FF0000" })
        .clip()
        .padding({ left: 5 })
        .flex(1),
    ]),
    0,
    100,
    100,
  );
  const bgClipNode = nestedBg.tree.children[1].children[0].children[0];
  assert.equal(bgClipNode.bounds.x, 95);
  assert.equal(bgClipNode.bounds.width, 5);
  const bgNode = bgClipNode.children[0];
  assert.equal(bgNode.bounds.x, 0, "clip-isolated child bounds start at local origin 0");
  assert.equal(bgNode.bounds.width, 5, "nested background capped to level budget 5");
  const bgClipCmd = nestedBg.commands.find((c) => c.kind === "composition")!;
  assert.equal(bgClipCmd.bounds.x, 95);
  assert.equal(bgClipCmd.bounds.width, 5);
  const innerBgCmd = (bgClipCmd as { frame: EvaluatedFrame }).frame.commands.find(
    (c) => c.paintRole === "background",
  )!;
  assert.equal(innerBgCmd.bounds.x, 0, "clip-isolated background paint starts at local 0");
  assert.equal(innerBgCmd.bounds.width, 5, "background command capped to level budget 5");

  // Both axes (VStack): height 100, fixed 90 -> slot is 10. Outer padding top: 5 leaves level proposal 5
  const vRepro = evaluate(
    VStack([
      box(20, 90),
      box(2, 2)
        .padding(10)
        .clip()
        .padding({ top: 5 })
        .flex(1),
    ]),
    0,
    100,
    100,
  );
  const vOuterPad = vRepro.tree.children[1].children[0];
  const vClipNode = vOuterPad.children[0];
  assert.equal(vClipNode.bounds.y, 95);
  assert.equal(vClipNode.bounds.height, 5, "VStack clip height capped to level budget 5");
  assert.equal(vClipNode.bounds.y + vClipNode.bounds.height, 100, "VStack clip ends at 100");
  const vClipCmd = vRepro.commands.find((c) => c.kind === "composition")!;
  assert.equal(vClipCmd.bounds.y, 95);
  assert.equal(vClipCmd.bounds.height, 5);

  // Unclipped oversized leaf visible when no clip
  const unclippedOversize = evaluate(
    HStack([
      box(90, 20),
      box(30, 20)
        .padding(10)
        .padding({ left: 5 })
        .flex(1),
    ]),
    0,
    100,
    100,
  );
  const unclippedBoxCmd = unclippedOversize.commands.find(
    (c) => c.path === "root/flex[1]/padding/padding/box",
  )!;
  assert.equal(unclippedBoxCmd.bounds.width, 30, "unclipped leaf box remains visible at 30");
  assert.ok(
    unclippedOversize.diagnostics?.some((d) => d.code === "offered-size-overflow"),
    "overflow diagnostic emitted for unclipped leaf",
  );
});

test("gap-only deficit on both axes emits exact excess diagnostic", () => {
  // Horizontal: width 100, gap 120 -> 120 - 100 = 20 deficit
  const hGap = evaluate(
    HStack([box(20, 20).flex(1), box(20, 20).flex(1)], { gap: 120 }),
    0,
    100,
    100,
  );
  assert.deepEqual(hGap.tree.children.map((c) => c.bounds.width), [0, 0]);
  const hDiag = hGap.diagnostics?.find(
    (d) => d.code === "fixed-allocation-deficit",
  );
  assert.ok(hDiag, "HStack gap deficit must emit fixed-allocation-deficit");
  assert.equal(hDiag.deficit, 20, "gap deficit must report exact excess 20");

  // Vertical: height 100, gap 120 -> 120 - 100 = 20 deficit
  const vGap = evaluate(
    VStack([box(20, 20).flex(1), box(20, 20).flex(1)], { gap: 120 }),
    0,
    100,
    100,
  );
  assert.deepEqual(vGap.tree.children.map((c) => c.bounds.height), [0, 0]);
  const vDiag = vGap.diagnostics?.find(
    (d) => d.code === "fixed-allocation-deficit",
  );
  assert.ok(vDiag, "VStack gap deficit must emit fixed-allocation-deficit");
  assert.equal(vDiag.deficit, 20, "gap deficit must report exact excess 20");
});

test("mixed legacy Spacer with numeric main frame is fixed at 80 not flexible 150 on both axes", () => {
  // HStack: Spacer().frame({ width: 80 }) is fixed 80; flex(1) gets 220 in 300
  const hFixedSpacer = evaluate(
    HStack([Spacer().frame({ width: 80 }), box(20, 20).flex(1)]),
    0,
    300,
    100,
  );
  assert.deepEqual(
    hFixedSpacer.tree.children.map((c) => c.bounds.width),
    [80, 220],
    "Spacer with numeric width frame must be fixed at 80",
  );

  // VStack: Spacer().frame({ height: 80 }) is fixed 80; flex(1) gets 220 in 300
  const vFixedSpacer = evaluate(
    VStack([Spacer().frame({ height: 80 }), box(20, 20).flex(1)]),
    0,
    100,
    300,
  );
  assert.deepEqual(
    vFixedSpacer.tree.children.map((c) => c.bounds.height),
    [80, 220],
    "Spacer with numeric height frame must be fixed at 80",
  );

  // Nested frame order characterization on HStack:
  // Outer fill, inner 50 -> outer fill wins: flexible with weight 1 (shares 150/150)
  const outerFill = evaluate(
    HStack([box().frame({ width: 50 }).frame({ width: "fill" }), box().flex(1)]),
    0,
    300,
    100,
  );
  assert.deepEqual(
    outerFill.tree.children.map((c) => c.bounds.width),
    [150, 150],
  );

  // Outer 50, inner fill -> outer numeric wins: fixed 50, flex gets 250
  const outerNumeric = evaluate(
    HStack([box().frame({ width: "fill" }).frame({ width: 50 }), box().flex(1)]),
    0,
    300,
    100,
  );
  assert.deepEqual(
    outerNumeric.tree.children.map((c) => c.bounds.width),
    [50, 250],
  );

  // Cross-axis frame on Spacer: Spacer().frame({ height: 50 }) has width undefined -> flexible on main axis
  const crossSpacer = evaluate(
    HStack([Spacer().frame({ height: 50 }), box(20, 20).flex(1)]),
    0,
    200,
    100,
  );
  assert.deepEqual(
    crossSpacer.tree.children.map((c) => c.bounds.width),
    [100, 100],
  );
  assert.equal(crossSpacer.tree.children[0].bounds.height, 50);
});

test("weights: finite MAX sum overflow normalizes by max and preserves tiny weights on both axes", () => {
  // Two Number.MAX_VALUE siblings on HStack: each gets 150 in 300
  const hMax = evaluate(
    HStack([box(10, 10).flex(Number.MAX_VALUE), box(10, 10).flex(Number.MAX_VALUE)]),
    0,
    300,
    100,
  );
  assert.deepEqual(
    hMax.tree.children.map((c) => c.bounds.width),
    [150, 150],
    "Number.MAX_VALUE weights must normalize and split 150/150",
  );

  // Unequal huge weights on HStack: 1e308 and 1.5e308 in 250 -> 100 and 150
  const hUnequal = evaluate(
    HStack([box(10, 10).flex(1e308), box(10, 10).flex(1.5e308)]),
    0,
    250,
    100,
  );
  assert.ok(Math.abs(hUnequal.tree.children[0].bounds.width - 100) < 1e-6);
  assert.ok(Math.abs(hUnequal.tree.children[1].bounds.width - 150) < 1e-6);

  // Tiny weights on HStack: 1e-300 and 3e-300 in 400 -> 100 and 300
  const hTiny = evaluate(
    HStack([box(10, 10).flex(1e-300), box(10, 10).flex(3e-300)]),
    0,
    400,
    100,
  );
  assert.deepEqual(
    hTiny.tree.children.map((c) => c.bounds.width),
    [100, 300],
  );

  // Two Number.MAX_VALUE siblings on VStack: each gets 150 in 300
  const vMax = evaluate(
    VStack([box(10, 10).flex(Number.MAX_VALUE), box(10, 10).flex(Number.MAX_VALUE)]),
    0,
    100,
    300,
  );
  assert.deepEqual(
    vMax.tree.children.map((c) => c.bounds.height),
    [150, 150],
    "VStack Number.MAX_VALUE weights must normalize and split 150/150",
  );

  // Tiny weights on VStack: 1e-300 and 3e-300 in 400 -> 100 and 300
  const vTiny = evaluate(
    VStack([box(10, 10).flex(1e-300), box(10, 10).flex(3e-300)]),
    0,
    100,
    400,
  );
  assert.deepEqual(
    vTiny.tree.children.map((c) => c.bounds.height),
    [100, 300],
  );
});
