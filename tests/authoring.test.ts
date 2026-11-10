import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Box,
  Text,
  HStack,
  VStack,
  ZStack,
  Spacer,
  evaluateView,
  motion,
  Stage,
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
const box = (width = 20, height = 20) => Box({ width, height });
function find(node: LayoutNode, kind: string): LayoutNode {
  if (node.kind === kind) return node;
  for (const child of node.children) {
    try {
      return find(child, kind);
    } catch {}
  }
  throw Error(`Missing ${kind}`);
}

test("motion clamps boundaries, uses scene seconds, and rejects invalid inputs", () => {
  const tween = {
    from: 10,
    to: 30,
    delay: 1,
    duration: 2,
    ease: "linear",
  } as const;
  assert.equal(motion(tween, 0), 10);
  assert.equal(motion(tween, 1), 10);
  assert.equal(motion(tween, 2), 20);
  assert.equal(motion(tween, 3), 30);
  assert.equal(motion(tween, 9), 30);
  assert.equal(motion({ from: 0, to: 1, duration: 1 }, 0.5), 0.875);
  assert.equal(
    motion({ from: 0, to: 1, duration: 1, ease: "ease-in" }, 0.5),
    0.125,
  );
  assert.equal(
    motion({ from: 0, to: 1, duration: 1, ease: "ease-in-out" }, 0.5),
    0.5,
  );
  for (const duration of [0, -1, NaN, Infinity])
    assert.throws(() => motion({ ...tween, duration }, 0));
});

test("modifiers are immutable, ordered, and do not mutate reusable inputs", () => {
  const source = box();
  const tween = { from: 0, to: 1, duration: 1 };
  const faded = source.opacity(tween);
  tween.to = 0;
  assert.equal(evaluate(faded, 1).commands[0].opacity, 1);
  assert.equal(source.spec.kind, "box");
  assert.ok(Object.isFrozen(source));
  const a = evaluate(source.padding(10).frame({ width: 100, height: 100 }));
  const b = evaluate(source.frame({ width: 100, height: 100 }).padding(10));
  assert.equal(a.tree.bounds.width, 100);
  assert.equal(b.tree.bounds.width, 120);
  assert.equal(evaluate(source).commands[0].bounds.x, 0);
});

test("seeking directly, forward, and backward gives identical trees and draw lists", () => {
  const root = VStack([
    Text("Deterministic"),
    box()
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

test("stacks divide remaining space and preserve fixed siblings regardless of order", () => {
  const layout = evaluate(
    HStack([Spacer(), box(100), Spacer(), box(100)], { gap: 10 }).frame({
      width: 400,
    }),
  );
  const stack = find(layout.tree, "hstack");
  assert.equal(stack.children[0].bounds.width, 85);
  assert.equal(stack.children[1].bounds.x, 95);
  assert.equal(stack.children[2].bounds.width, 85);
  assert.equal(stack.children[3].bounds.x, 300);
  assert.deepEqual(layout.warnings, []);
  const columns = evaluate(
    HStack([box().frame({ width: "fill" }), box(100)], { gap: 20 }),
  );
  assert.equal(columns.tree.children[0].bounds.width, 280);
  assert.equal(columns.tree.children[1].bounds.x, 300);
});

test("wrapped spacers keep zero cross-axis size and modifier order composes transforms", () => {
  const result = evaluate(
    HStack([Spacer().opacity(0.5), box(100, 20), Spacer().offset(0)]),
  );
  assert.equal(result.tree.bounds.height, 20);
  assert.equal(result.commands[0].bounds.x, 150);
  const a = evaluate(box().offset(10).scale(2, 2, [0, 0]));
  const b = evaluate(box().scale(2, 2, [0, 0]).offset(10));
  assert.deepEqual(a.commands[0].transform, [2, 2, 20, 0]);
  assert.deepEqual(b.commands[0].transform, [2, 2, 10, 0]);
});

test("VStack, ZStack, padding, and alignment expose inspectable bounds", () => {
  const result = evaluate(
    VStack([box(100, 20), box(40, 30)], { gap: 10, align: "end" }).padding(10),
  );
  assert.equal(result.tree.bounds.width, 120);
  assert.equal(result.tree.bounds.height, 80);
  assert.deepEqual(result.commands[1].bounds, {
    x: 70,
    y: 40,
    width: 40,
    height: 30,
  });
  const z = evaluate(ZStack([box(100, 100), box(20, 20)]));
  assert.deepEqual(z.commands[1].bounds, {
    x: 40,
    y: 40,
    width: 20,
    height: 20,
  });
});

test("Text wraps words and graphemes, preserves newlines, and supports tracking and maxWidth", () => {
  const result = evaluate(
    Text("hello world\n\nabcdef", { maxWidth: 50, lineHeight: 20 }),
  );
  const text = result.commands[0];
  assert.equal(text.kind, "text");
  if (text.kind !== "text") return;
  assert.deepEqual(text.text.lines, ["hello", "world", "", "abcde", "f"]);
  assert.equal(text.bounds.height, 100);
  const tracked = evaluate(Text("abc", { tracking: 2 }));
  assert.equal(tracked.commands[0].bounds.width, 34);
  const overflow = evaluate(Text("a long line", { wrap: false }), 0, 30);
  assert.match(overflow.warnings[0], /content exceeds offered bounds/);
});

test("offset does not reflow siblings and scale uses explicit local anchors", () => {
  const root = HStack([box().offset(50, 10), box()], { gap: 10 });
  const result = evaluate(root);
  assert.equal(result.commands[1].bounds.x, 30);
  assert.deepEqual(result.commands[0].transform, [1, 1, 50, 10]);
  const scaled = evaluate(box(100, 100).scale(1, 0.5, [0.5, 1]));
  assert.deepEqual(scaled.commands[0].transform, [1, 0.5, 0, 50]);
});

test("opacity is explicitly per primitive, and sibling IDs are validated", () => {
  const result = evaluate(ZStack([box(), box()]).opacity(0.5));
  assert.deepEqual(
    result.commands.map((c) => c.opacity),
    [0.5, 0.5],
  );
  assert.throws(
    () => evaluate(HStack([box().id("same"), box().id("same")])),
    /Duplicate sibling ID: same/,
  );
});

test("invalid layout values report node paths and overflow does not silently clip", () => {
  assert.throws(() => evaluate(box(-1).id("bad-bar")), /bad-bar.*Box width/);
  assert.throws(() => evaluate(box().padding(-1)), /Padding/);
  assert.throws(() => evaluate(box().opacity(2)), /opacity must be between/);
  assert.throws(() => evaluate(box(), NaN), /Time must be finite/);
  assert.throws(() => evaluate(Text("bad", { weight: NaN })), /Font weight/);
  assert.throws(() => evaluate(Text("bad", { lineHeight: 0 })), /Line height/);
  const result = evaluate(box(100).frame({ width: 10 }));
  assert.equal(result.commands[0].bounds.width, 100);
  assert.ok(result.warnings.length > 0);
});

test("Stage factories do not require a browser until setup and disposal is idempotent", () => {
  const stage = Stage(() => Text("Hello"));
  assert.equal(stage.inspect(), undefined);
  assert.equal(typeof stage.prepareFrame, "function");
  stage.dispose();
  stage.dispose();
  assert.throws(() => stage.render({} as never), /not ready/);
});

test("Stage preparation rejects before setup and preserves cancellation", async () => {
  const stage = Stage(() => Text("Hello"));
  const timing = { time: 2, localTime: 2, progress: 0.5 };
  await assert.rejects(stage.prepareFrame!(timing), /not ready/);
  const controller = new AbortController();
  const reason = new DOMException("Cancelled", "AbortError");
  controller.abort(reason);
  await assert.rejects(
    stage.prepareFrame!({ ...timing, signal: controller.signal }),
    (error) => error === reason,
  );
  stage.dispose();
});
