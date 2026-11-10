/**
 * G0 characterization tests for the current declarative layout engine
 * (docs/plans/declarative-layout-hardening.md §5.4).
 *
 * Each test pins a legacy behavior that later gates (G1–G4) must not silently change.
 * A surprising result recorded here is evidence, not a bug to fix speculatively.
 * Reuses the same deterministic measurer convention as tests/authoring.test.ts.
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
  Group,
  Grid,
  Composition,
  World,
  evaluateView,
} from "../src/authoring/index";
import type { ViewNode, LayoutNode } from "../src/authoring/index";

const evaluate = (root: ViewNode, time = 0, width = 400, height = 300) =>
  evaluateView(root, {
    time,
    width,
    height,
    measureText: (text, _font, tracking) =>
      Array.from(text).length * 10 +
      Math.max(0, Array.from(text).length - 1) * tracking,
  });

function find(node: LayoutNode, kind: string): LayoutNode {
  if (node.kind === kind) return node;
  for (const child of node.children) {
    try {
      return find(child, kind);
    } catch {}
  }
  throw Error(`Missing ${kind}`);
}
function box(width = 20, height = 20) {
  return Box({ width, height });
}

test("frame alignment axes: align start/center/end places child within fixed frame", () => {
  // Legacy single align controls both axes inside a fixed frame.
  const start = evaluate(
    box(20, 20).frame({ width: 100, height: 60, align: "start" }),
  );
  assert.deepEqual(start.commands[0].bounds, {
    x: 0,
    y: 0,
    width: 20,
    height: 20,
  });
  const center = evaluate(
    box(20, 20).frame({ width: 100, height: 60, align: "center" }),
  );
  assert.deepEqual(center.commands[0].bounds, {
    x: 40,
    y: 20,
    width: 20,
    height: 20,
  });
  const end = evaluate(
    box(20, 20).frame({ width: 100, height: 60, align: "end" }),
  );
  assert.deepEqual(end.commands[0].bounds, {
    x: 80,
    y: 40,
    width: 20,
    height: 20,
  });
});

test("frame default alignment is center when align is omitted", () => {
  const result = evaluate(box(20, 20).frame({ width: 100, height: 60 }));
  assert.deepEqual(result.commands[0].bounds, {
    x: 40,
    y: 20,
    width: 20,
    height: 20,
  });
});

test("frame fill axis adopts the offered size on the frame node, not the wrapped child", () => {
  const root = evaluate(
    VStack([box(50, 10).frame({ width: "fill" }), box(50, 10)], { gap: 5 }),
    0,
    200,
    300,
  );
  const stack = find(root.tree, "vstack");
  // The frame node itself spans the offered 200.
  assert.equal(stack.children[0].bounds.width, 200);
  assert.equal(stack.children[0].bounds.height, 10);
  // The wrapped box keeps its own 50 and is centered inside the frame (default align).
  const inner = stack.children[0].children[0];
  assert.equal(inner.bounds.width, 50);
  assert.equal(inner.bounds.x, 75);
  // The second sibling stacks below the frame's full height.
  assert.equal(stack.children[1].bounds.y, 15);
});

test("stack cross-axis alignment: measured stack height is its tallest child, not the offer", () => {
  // Characterized legacy quirk: a single-child HStack collapses to the child's height,
  // so cross alignment has zero remaining space regardless of the offered height.
  const single = evaluate(HStack([box(20, 10)], { align: "end" }), 0, 100, 60);
  assert.deepEqual(single.tree.bounds, { x: 0, y: 0, width: 20, height: 10 });
  assert.equal(single.commands[0].bounds.y, 0);
  // With mixed child heights, alignment distributes against the tallest child.
  const end = evaluate(
    HStack([box(20, 30), box(5, 5)], { align: "end" }),
    0,
    100,
    60,
  );
  assert.equal(end.commands[0].bounds.y, 0);
  assert.equal(end.commands[1].bounds.y, 25);
  const center = evaluate(HStack([box(20, 30), box(5, 5)]), 0, 100, 60);
  assert.equal(center.commands[1].bounds.y, 12.5);
  const start = evaluate(
    HStack([box(20, 30), box(5, 5)], { align: "start" }),
    0,
    100,
    60,
  );
  assert.equal(start.commands[1].bounds.y, 0);
  // VStack aligns children on the horizontal cross axis against the widest child.
  const vEnd = evaluate(VStack([box(50, 10), box(10, 10)], { align: "end" }));
  assert.equal(vEnd.commands[1].bounds.x, 40);
});

test("stack main-axis accumulation: cursor advances by size plus gap", () => {
  const result = evaluate(
    HStack([box(20), box(30), box(10)], { gap: 5 }),
    0,
    200,
  );
  const xs = result.commands.map((c) => c.bounds.x);
  assert.deepEqual(xs, [0, 25, 60]);
  assert.equal(result.tree.bounds.width, 70);
});

test("modifier order: padding inside frame does not expand the frame", () => {
  const inner = evaluate(
    box(20, 20).padding(10).frame({ width: 100, height: 100, align: "start" }),
  );
  assert.equal(inner.tree.bounds.width, 100);
  assert.equal(inner.tree.bounds.height, 100);
  assert.deepEqual(inner.commands[0].bounds, {
    x: 10,
    y: 10,
    width: 20,
    height: 20,
  });
  // Outer padding adds to the frame size.
  const outer = evaluate(
    box(20, 20).frame({ width: 100, height: 100 }).padding(10),
  );
  assert.equal(outer.tree.bounds.width, 120);
  assert.equal(outer.tree.bounds.height, 120);
});

test("modifier order: offset then scale composes differently than scale then offset", () => {
  const a = evaluate(box().offset(10).scale(2, 2, [0, 0]));
  const b = evaluate(box().scale(2, 2, [0, 0]).offset(10));
  assert.deepEqual(a.commands[0].transform, [2, 2, 20, 0]);
  assert.deepEqual(b.commands[0].transform, [2, 2, 10, 0]);
});

test("modifier order: clip uses frame bounds when frame precedes clip", () => {
  const result = evaluate(
    box(100, 100)
      .frame({ width: 40, height: 40, align: "start" })
      .clip({ shape: "rect" }),
  );
  const composition = result.commands.find((c) => c.kind === "composition");
  assert.ok(composition, "clip must emit a composition command");
  if (composition.kind !== "composition") return;
  assert.deepEqual(composition.bounds, { x: 0, y: 0, width: 40, height: 40 });
});

test("text height equals line count times line height, wrapping at maxWidth", () => {
  const result = evaluate(
    Text("hello world", { size: 20, lineHeight: 25, maxWidth: 60 }),
  );
  const text = result.commands[0];
  if (text.kind !== "text") throw Error("expected text command");
  assert.deepEqual(text.text.lines, ["hello", "world"]);
  assert.equal(text.bounds.height, 50);
  // Explicit newlines produce empty line boxes that still count.
  const blank = evaluate(Text("a\n\nb", { size: 20, lineHeight: 25 }));
  const blankText = blank.commands[0];
  if (blankText.kind !== "text") throw Error("expected text command");
  assert.deepEqual(blankText.text.lines, ["a", "", "b"]);
  assert.equal(blankText.bounds.height, 75);
});

test("text measured width drives stack layout at zero tracking", () => {
  // "ab" measures 2 chars * 10 + 0 tracking = 20 wide; the next sibling lands at 23.
  const result = evaluate(HStack([Text("ab"), box(10)], { gap: 3 }), 0, 200);
  assert.equal(result.commands[0].bounds.width, 20);
  assert.equal(result.commands[1].bounds.x, 23);
});

test("fixed sibling overflow: oversized fixed child keeps its size and overflows offered bounds", () => {
  const result = evaluate(
    HStack([box(300), box(50)], { gap: 10 }).frame({
      width: 200,
      align: "start",
    }),
    0,
    200,
  );
  // Fixed children do not shrink; the second sibling still lays out after the first.
  const first = result.commands[0];
  const second = result.commands[1];
  assert.deepEqual(first.bounds, { x: 0, y: 0, width: 300, height: 20 });
  assert.equal(second.bounds.x, 310);
  // Legacy behavior: a warning is emitted for content exceeding offered bounds.
  assert.ok(
    result.warnings.some((w) => w.includes("content exceeds offered bounds")),
    `expected overflow warning, got ${JSON.stringify(result.warnings)}`,
  );
});

test("fixed sibling overflow in a fixed-height VStack: frame caps the tree but children overflow", () => {
  const result = evaluate(
    VStack([box(20, 100), box(20, 100)], { gap: 10 }).frame({
      height: 100,
      align: "start",
    }),
  );
  // The frame node reports its fixed height; children still lay out to 210 and warn.
  assert.equal(result.tree.bounds.height, 100);
  assert.equal(result.commands[1].bounds.y, 110);
  assert.ok(
    result.warnings.some((w) => w.includes("content exceeds offered bounds")),
  );
  // Without a frame, the stack itself grows to full content height (210) because the
  // offer (300) exceeds the content, so this example warns only through the frame.
  const unframed = evaluate(VStack([box(20, 100), box(20, 100)], { gap: 10 }));
  assert.equal(unframed.tree.bounds.height, 210);
  assert.deepEqual(unframed.warnings, []);
  // The warning follows the offer, not the frame: an unframed stack whose content
  // exceeds its offer warns on both the oversized child and the stack itself.
  const tight = evaluate(HStack([box(300), box(50)], { gap: 10 }), 0, 200);
  assert.equal(tight.tree.bounds.width, 360);
  assert.deepEqual(tight.warnings, [
    "root/box[0]: content exceeds offered bounds at localTime=0",
    "root: content exceeds offered bounds at localTime=0",
  ]);
});

test("Spacer exhaustion: deficit leaves spacers zero and fixed siblings unscaled", () => {
  // Two spacers share negative remaining space; legacy clamps allocation to zero each.
  const result = evaluate(
    HStack([Spacer(), box(150), Spacer(), box(150)], { gap: 10 }).frame({
      width: 200,
      align: "start",
    }),
    0,
    200,
  );
  const stack = find(result.tree, "hstack");
  assert.equal(stack.children[0].bounds.width, 0);
  assert.equal(stack.children[2].bounds.width, 0);
  // Fixed siblings keep their full size; total exceeds the frame and warns.
  assert.equal(stack.children[1].bounds.width, 150);
  assert.equal(stack.children[3].bounds.width, 150);
  assert.ok(
    result.warnings.some((w) => w.includes("content exceeds offered bounds")),
  );
});

test("Spacer with no competition receives the entire remaining main-axis space", () => {
  const result = evaluate(
    HStack([box(50), Spacer(), box(50)], { gap: 10 }).frame({
      width: 200,
      align: "start",
    }),
    0,
    200,
  );
  const stack = find(result.tree, "hstack");
  assert.equal(stack.children[1].bounds.width, 80);
  assert.equal(stack.children[2].bounds.x, 150);
});

test("wrapped Spacer keeps zero cross-axis size inside a stack", () => {
  const result = evaluate(
    HStack([Spacer().opacity(0.5), box(100, 20), Spacer().offset(0)]),
    0,
    200,
  );
  assert.equal(result.tree.bounds.height, 20);
  // Both wrapped Spacers split the remaining main-axis space (200 - 100 = 100 → 50 each)
  // while keeping zero cross-axis size on both the wrapper and the Spacer itself.
  assert.deepEqual(
    result.tree.children.map((child) => child.bounds),
    [
      { x: 0, y: 10, width: 50, height: 0 },
      { x: 50, y: 0, width: 100, height: 20 },
      { x: 150, y: 10, width: 50, height: 0 },
    ],
  );
  assert.deepEqual(result.tree.children[0].children[0].bounds, {
    x: 0,
    y: 10,
    width: 50,
    height: 0,
  });
  assert.deepEqual(result.tree.children[2].children[0].bounds, {
    x: 150,
    y: 10,
    width: 50,
    height: 0,
  });
});

test("Spacer with no parent stack measures zero", () => {
  const result = evaluate(Spacer(), 0, 100, 50);
  assert.deepEqual(result.tree.bounds, { x: 0, y: 0, width: 0, height: 0 });
});

test("Group measures max child extent; offset children paint beyond without reflow", () => {
  const result = evaluate(
    HStack([Group([box(30), box(30).offset(50)]), box(10)], { gap: 5 }),
    0,
    300,
  );
  // Group's measured layout width is the max child width (30): offset does not reflow.
  assert.equal(result.tree.children[0].bounds.width, 30);
  // The sibling is placed right after the measured width, not the paint extent.
  assert.equal(result.commands[1].bounds.x, 35);
  // Paint extends to the offset child's right edge (80 wide).
  assert.equal(result.commands[0].kind, "group");
  assert.equal(result.commands[0].bounds.width, 80);
});

test("Group opacity isolates children: the group command carries alpha, children stay opaque", () => {
  const faded = evaluate(Group([box(), box()]).opacity(0.5));
  assert.equal(faded.commands.length, 1);
  const group = faded.commands[0];
  if (group.kind !== "group") throw Error("expected group command");
  assert.equal(group.opacity, 0.5);
  assert.deepEqual(
    group.frame.commands.map((c) => c.opacity),
    [1, 1],
  );
});

test("Group paint bounds include offset children beyond layout bounds", () => {
  const result = evaluate(Group([box(20, 20), box(20, 20).offset(100, 0)]));
  const groupCommand = result.commands.find((c) => c.kind === "group");
  assert.ok(groupCommand, "group must emit a paint command");
  if (groupCommand.kind !== "group") return;
  // Paint bounds span from x=0 to the offset child's right edge (120).
  assert.equal(groupCommand.bounds.width, 120);
});

test("Grid cells place content at column/row positions with gaps and column spans", () => {
  const result = evaluate(
    Grid(
      [
        { id: "a", column: 0, row: 0, view: box(5, 5) },
        { id: "b", column: 1, row: 1, view: box(5, 5) },
        { id: "wide", column: 0, row: 2, columnSpan: 2, view: box(5, 5) },
      ],
      {
        columns: 2,
        rows: 3,
        cellWidth: 40,
        cellHeight: 20,
        columnGap: 4,
        rowGap: 6,
      },
    ),
  );
  assert.deepEqual(result.tree.bounds, { x: 0, y: 0, width: 84, height: 72 });
  // Cell b: column 1 → x = 40+4 = 44; row 1 → y = 20+6 = 26.
  const b = result.tree.children[0].children.find((c) => c.path.endsWith("/b"));
  assert.ok(b, "cell b must exist in the tree");
  assert.deepEqual(b.transform, [1, 1, 44, 26]);
  // Span width = 2 cells + 1 gap = 84, aligned start.
  const wide = result.tree.children[0].children.find((c) =>
    c.path.endsWith("/wide"),
  );
  assert.ok(wide, "spanning cell must exist");
  assert.deepEqual(wide.transform, [1, 1, 0, 52]);
  assert.deepEqual(wide.bounds, { x: 0, y: 0, width: 84, height: 20 });
  assert.deepEqual(wide.children[0].bounds, {
    x: 0,
    y: 0,
    width: 84,
    height: 20,
  });
  // Content smaller than the cell keeps its own size (frame align start).
  const aCommand = result.commands[0];
  assert.deepEqual(aCommand.bounds, { x: 0, y: 0, width: 5, height: 5 });
});

test("Grid row spans add one row height plus the row gap", () => {
  const result = evaluate(
    Grid([{ id: "tall", column: 1, row: 0, rowSpan: 2, view: box(5, 5) }], {
      columns: 2,
      rows: 3,
      cellWidth: 40,
      cellHeight: 20,
      columnGap: 4,
      rowGap: 6,
    }),
  );
  const tall = result.tree.children[0].children.find((c) =>
    c.path.endsWith("/tall"),
  );
  assert.ok(tall, "row-spanning cell must exist");
  // Row span height = 2 cells + 1 gap = 46; column 1 sits at 40 + 4 = 44.
  assert.deepEqual(tall.bounds, { x: 0, y: 0, width: 40, height: 46 });
  assert.deepEqual(tall.transform, [1, 1, 44, 0]);
});

test("Grid rejects overflowing spans and invalid dimensions", () => {
  assert.throws(() =>
    Grid([{ id: "x", column: 1, row: 0, columnSpan: 2, view: box() }], {
      columns: 2,
      rows: 1,
      cellWidth: 10,
      cellHeight: 10,
    }),
  );
  assert.throws(() =>
    Grid([], { columns: 0, rows: 1, cellWidth: 10, cellHeight: 10 }),
  );
});

test("offset does not reflow siblings; sibling position ignores offset of the previous child", () => {
  const result = evaluate(HStack([box().offset(50, 10), box()], { gap: 10 }));
  assert.deepEqual(result.commands[0].transform, [1, 1, 50, 10]);
  assert.equal(result.commands[1].bounds.x, 30);
});

test("offset accepts animated numbers and snapshots at evaluation time", () => {
  const tween = { from: 0, to: 100, duration: 2, ease: "linear" } as const;
  const root = box().offset(tween);
  assert.deepEqual(evaluate(root, 0).commands[0].transform, [1, 1, 0, 0]);
  assert.deepEqual(evaluate(root, 1).commands[0].transform, [1, 1, 50, 0]);
  assert.deepEqual(evaluate(root, 2).commands[0].transform, [1, 1, 100, 0]);
  // Mutation of the caller's tween object after wrapping must not change results.
  const mutable = { from: 0, to: 10, duration: 1, ease: "linear" as const };
  const snap = box().offset(mutable);
  mutable.to = 999;
  assert.deepEqual(evaluate(snap, 1).commands[0].transform, [1, 1, 10, 0]);
});

test("nested composition clocks: world time = parent localTime * rate + offset", () => {
  const world = World(
    ({ localTime }) => Box({ width: 20 + localTime * 10, height: 20 }),
    { size: [200, 100] },
  );
  const frame = (time: number) =>
    evaluateView(Composition(world, { size: [100, 50], offset: 3, rate: 2 }), {
      time,
      width: 400,
      height: 300,
      measureText: () => 10,
    });
  // At parent time 1, world time = 1*2 + 3 = 5 → width 20 + 50 = 70.
  const at1 = frame(1);
  const command = at1.commands[0];
  if (command.kind !== "composition")
    throw Error("expected composition command");
  assert.equal(command.frame.commands[0].bounds.width, 70);
  // Determinism under arbitrary seek order.
  const expected = frame(1);
  frame(5);
  frame(0);
  assert.deepEqual(frame(1), expected);
});

test("composition overlay uses parent time while the world uses the mapped clock", () => {
  const world = World(
    ({ localTime }) => Box({ width: 10 + localTime, height: 10 }),
    { size: [100, 50] },
  );
  const overlaySizes: number[] = [];
  const result = evaluateView(
    Composition(world, {
      size: [100, 50],
      rate: 2,
      overlay: ({ localTime }) => {
        overlaySizes.push(localTime);
        return Box({ width: 10 + localTime, height: 5 });
      },
    }),
    { time: 4, width: 400, height: 300, measureText: () => 10 },
  );
  const command = result.commands[0];
  if (command.kind !== "composition")
    throw Error("expected composition command");
  // World saw 4*2 = 8; overlay saw parent time 4.
  assert.equal(command.frame.commands[0].bounds.width, 18);
  assert.equal(command.overlay!.commands[0].bounds.width, 14);
  assert.deepEqual(overlaySizes, [4]);
});

test("nested composition preserves inner viewport and composes transforms through both levels", () => {
  const child = World(
    ({ localTime }) => Box({ width: 20 + localTime, height: 20 }),
    { size: [80, 50] },
  );
  const parent = World(
    () => ZStack([Composition(child, { offset: 10 }).offset(10, 20)]),
    { size: [400, 300] },
  );
  const root = Composition(parent, { rate: 2 });
  const evaluated = evaluateView(root, {
    time: 2,
    width: 400,
    height: 300,
    measureText: () => 10,
  });
  const outer = evaluated.commands[0];
  if (outer.kind !== "composition") throw Error("expected outer composition");
  const nested = outer.frame.commands[0];
  if (nested.kind !== "composition") throw Error("expected nested composition");
  // Parent world time = 2*2 = 4; child world time = 4 + 10 (offset) = 14 → width 34.
  assert.equal(nested.frame.commands[0].bounds.width, 34);
  // Child viewport offset by (10, 20) inside the parent world.
  assert.deepEqual(nested.transform, [1, 1, 10, 20]);
});

test("frame alignment with negative remaining space pins oversized content per axis", () => {
  // Content larger than the frame: align start keeps x at 0; center would go negative.
  const start = evaluate(box(150, 20).frame({ width: 100, align: "start" }));
  assert.deepEqual(start.commands[0].bounds, {
    x: 0,
    y: 0,
    width: 150,
    height: 20,
  });
  const center = evaluate(box(150, 20).frame({ width: 100, align: "center" }));
  assert.equal(center.commands[0].bounds.x, -25);
  const end = evaluate(box(150, 20).frame({ width: 100, align: "end" }));
  assert.equal(end.commands[0].bounds.x, -50);
});

test("negative cross-axis remaining space comes from an outer frame, not stack self-alignment", () => {
  // Characterized legacy quirk: an HStack never aligns against its own offer because its
  // measured height is the max child height; the stack itself reports the child height.
  const stack = evaluate(HStack([box(20, 80)], { align: "end" }), 0, 100, 50);
  assert.equal(stack.commands[0].bounds.y, 0);
  assert.equal(stack.tree.bounds.height, 80);
  // An outer frame with fixed height aligns the oversized stack, producing negative offsets.
  const end = evaluate(
    HStack([box(20, 80)], { align: "end" }).frame({ height: 50, align: "end" }),
  );
  assert.equal(end.commands[0].bounds.y, -30);
  const center = evaluate(
    HStack([box(20, 80)], { align: "end" }).frame({
      height: 50,
      align: "center",
    }),
  );
  assert.equal(center.commands[0].bounds.y, -15);
  const start = evaluate(
    HStack([box(20, 80)], { align: "end" }).frame({
      height: 50,
      align: "start",
    }),
  );
  assert.equal(start.commands[0].bounds.y, 0);
});

test("structured diagnostics accompany the legacy warnings without changing geometry", () => {
  // Same fixture as the pinned "fixed sibling overflow" case above.
  const node = HStack([box(300), box(50)], { gap: 10 }).id("row");
  const result = evaluate(node, 0, 200);
  assert.equal(result.tree.bounds.width, 360, "allocation is unchanged");
  assert.deepEqual(result.warnings, [
    "row/box[0]: content exceeds offered bounds at localTime=0",
    "row: content exceeds offered bounds at localTime=0",
  ]);
  assert.deepEqual(
    result.diagnostics?.map((entry) => [entry.code, entry.path, entry.id]),
    [
      ["offered-size-overflow", "row/box[0]", undefined],
      ["offered-size-overflow", "row", "row"],
    ],
    "one structured entry per detected condition, authored not parsed",
  );
  const [, overflow] = result.diagnostics!;
  assert.equal(overflow.severity, "warning");
  assert.equal(overflow.space, "layout");
  assert.equal(overflow.localTime, 0);
  assert.deepEqual(overflow.bounds, { x: 0, y: 0, width: 200, height: 300 });
  assert.deepEqual(overflow.excess, { width: 160, height: 0 });
});

test("Spacer exhaustion reports a fixed-allocation deficit that legacy allocation hides", () => {
  // Same fixture as the pinned "Spacer exhaustion" case above: spacers get zero.
  const result = evaluate(
    HStack([Spacer(), box(150), Spacer(), box(150)], { gap: 10 }).frame({
      width: 200,
      align: "start",
    }),
    0,
    200,
  );
  const deficit = result.diagnostics!.find(
    (entry) => entry.code === "fixed-allocation-deficit",
  )!;
  assert.equal(deficit.severity, "error");
  assert.equal(
    deficit.deficit,
    130,
    "300 of fixed children against a 170 slot",
  );
  const stack = result.tree.children[0];
  assert.equal(deficit.path, "root/hstack");
  assert.equal(
    stack.children[0].bounds.width,
    0,
    "legacy layout still starves the Spacer",
  );
});

test("a frame without a structured conflict emits no diagnostics field", () => {
  const result = evaluate(box(20, 10));
  assert.equal(
    "diagnostics" in result,
    false,
    "additive field stays absent when empty",
  );
  assert.deepEqual(result.warnings, []);
});

test("nested composition diagnostics resolve to the same nodes as the tree", () => {
  const world = World(
    () => HStack([box(300), box(50)], { gap: 10 }).id("wide"),
    { size: [200, 300] },
  );
  const result = evaluateView(Composition(world).id("viewport"), {
    time: 0,
    width: 200,
    height: 300,
    measureText: (text) => text.length * 10,
  });
  const inner = result.diagnostics ?? [];
  assert.ok(inner.length >= 1);
  // `(space, path)` identifies a node, so a diagnostic must resolve inside its own space,
  // not be prefixed into the outer tree's path string.
  const pathsInSpace = new Set<string>();
  const walk = (node: LayoutNode) => {
    pathsInSpace.add(`${node.space ?? "layout"}|${node.path}`);
    node.children.forEach(walk);
  };
  walk(result.tree);
  for (const entry of inner) {
    assert.ok(
      pathsInSpace.has(`${entry.space}|${entry.path}`),
      `diagnostic (${entry.space}, ${entry.path}) must exist in the tree`,
    );
    assert.ok(
      !entry.path.includes("/world/"),
      `nested paths stay relative to their own space, got ${entry.path}`,
    );
  }
});

test("nested composition spaces are scoped and inherited, never flattened or overwritten", () => {
  const innermost = World(
    () => HStack([box(300), box(50)], { gap: 10 }).id("wide"),
    { size: [200, 300] },
  );
  // Two composition levels: the inner space must extend the outer prefix, not replace it.
  const middle = World(() => Composition(innermost).id("inner-viewport"), {
    size: [200, 300],
  });
  const result = evaluateView(Composition(middle).id("outer"), {
    time: 0,
    width: 200,
    height: 300,
    measureText: (text) => text.length * 10,
  });
  const spaces = new Set(result.diagnostics!.map((entry) => entry.space));
  assert.deepEqual(
    [...spaces],
    ["outer/world/inner-viewport/world"],
    "a deeper space keeps every ancestor prefix",
  );
  for (const entry of result.diagnostics!) {
    assert.notEqual(entry.space, "layout");
    assert.ok(entry.space.startsWith("outer/world/inner-viewport/world"));
  }
  // Descendant tree nodes carry the same inherited space as their diagnostic.
  const walk = (node: LayoutNode) => {
    for (const entry of result.diagnostics!)
      if (entry.path === node.path) assert.equal(node.space, entry.space);
    node.children.forEach(walk);
  };
  walk(result.tree);
});

test("multilevel space collision with slash authored IDs is prevented by segment encoding", () => {
  // Case 1: composition with literal ID "a/world/b"
  const inner1 = World(
    () => HStack([box(300), box(50)], { gap: 10 }).id("wide"),
    { size: [200, 300] },
  );
  const result1 = evaluateView(Composition(inner1).id("a/world/b"), {
    time: 0,
    width: 200,
    height: 300,
    measureText: (text) => text.length * 10,
  });

  // Case 2: composition "a" containing composition "b" in its world
  const inner2 = World(
    () => HStack([box(300), box(50)], { gap: 10 }).id("wide"),
    { size: [200, 300] },
  );
  const middle2 = World(() => Composition(inner2).id("b"), {
    size: [200, 300],
  });
  const result2 = evaluateView(Composition(middle2).id("a"), {
    time: 0,
    width: 200,
    height: 300,
    measureText: (text) => text.length * 10,
  });

  // Case 3: multilevel nesting: "level/1" -> "level/2"
  const inner3 = World(
    () => HStack([box(300), box(50)], { gap: 10 }).id("wide"),
    { size: [200, 300] },
  );
  const middle3 = World(() => Composition(inner3).id("level/2"), {
    size: [200, 300],
  });
  const result3 = evaluateView(Composition(middle3).id("level/1"), {
    time: 0,
    width: 200,
    height: 300,
    measureText: (text) => text.length * 10,
  });

  // Case 4: multilevel nesting: "level" -> "1/world/level/2"
  const inner4 = World(
    () => HStack([box(300), box(50)], { gap: 10 }).id("wide"),
    { size: [200, 300] },
  );
  const middle4 = World(() => Composition(inner4).id("1/world/level/2"), {
    size: [200, 300],
  });
  const result4 = evaluateView(Composition(middle4).id("level"), {
    time: 0,
    width: 200,
    height: 300,
    measureText: (text) => text.length * 10,
  });

  const space1 = result1.diagnostics![0].space;
  const space2 = result2.diagnostics![0].space;
  const space3 = result3.diagnostics![0].space;
  const space4 = result4.diagnostics![0].space;

  assert.equal(space1, "a%2Fworld%2Fb/world");
  assert.equal(space2, "a/world/b/world");
  assert.notEqual(
    space1,
    space2,
    "slash in ID must not collide with nested composition world",
  );

  assert.equal(space3, "level%2F1/world/level%2F2/world");
  assert.equal(space4, "level/world/1%2Fworld%2Flevel%2F2/world");
  assert.notEqual(space3, space4, "multilevel slash IDs must not collide");

  // Authored IDs remain literal
  assert.equal(result1.tree.id, "a/world/b");
  assert.equal(result3.tree.id, "level/1");
});

test("an ID on a modifier wrapper is not forwarded to its draw leaf", () => {
  // Characterized legacy identity rule: only draw leaves carry `sharedId`, so a modifier
  // wrapper's `id()` names the layout node and inspection path but matches no shared
  // element. G2a's background paint must not become the exception that forwards it.
  const wrapperIds = [
    ["padding", (node: ViewNode) => node.padding(4)],
    ["frame", (node: ViewNode) => node.frame({ width: 40 })],
    ["offset", (node: ViewNode) => node.offset(2)],
    ["opacity", (node: ViewNode) => node.opacity(0.5)],
  ] as const;
  for (const [label, wrap] of wrapperIds) {
    const frame = evaluate(wrap(box(10, 10)).id("card"));
    assert.equal(
      frame.tree.id,
      "card",
      `${label} tree node keeps the authored ID`,
    );
    assert.equal(
      frame.commands.some((command) => command.sharedId !== undefined),
      false,
      `${label} must not forward the ID to a draw leaf`,
    );
  }
  // The same ID placed directly on the draw leaf still becomes the shared target.
  const leaf = evaluate(box(10, 10).id("card"));
  assert.equal(leaf.tree.id, "card");
  assert.deepEqual(
    leaf.commands.map((command) => command.sharedId),
    ["card"],
  );
});
