import test from "node:test";
import assert from "node:assert/strict";
import {
  Box,
  Group,
  HStack,
  Composition,
  World,
  evaluateView,
} from "../src/authoring/index";
import type { ViewNode } from "../src/authoring/index";
import { collectSharedElements } from "../src/authoring/shared-elements";

const evaluate = (root: ViewNode, time = 0) =>
  evaluateView(root, {
    time,
    width: 200,
    height: 200,
    measureText: () => 0,
  });
const box = () => Box({ width: 20, height: 20 });

test("Group isolates animated parent opacity while retaining child and nested-group alpha", () => {
  const node = Group([
    box().opacity(0.4),
    Group([box().opacity(0.6)]).opacity(0.5),
  ]).opacity({ from: 0, to: 1, duration: 2, ease: "linear" });
  const frame = evaluate(node, 1);
  const layer = frame.commands[0];
  assert.equal(layer.kind, "group");
  if (layer.kind !== "group") return;
  assert.equal(layer.opacity, 0.5);
  assert.equal(layer.frame.commands[0].opacity, 0.4);
  const nested = layer.frame.commands[1];
  assert.equal(nested.kind, "group");
  if (nested.kind !== "group") return;
  assert.equal(nested.opacity, 0.5);
  assert.equal(nested.frame.commands[0].opacity, 0.6);
  evaluate(node, 2);
  evaluate(node, 0);
  assert.deepEqual(evaluate(node, 1), frame);
});

test("Group paint bounds preserve overflow and negative scales without changing sibling layout", () => {
  const node = Group([
    box().offset(-30, -10),
    box().scale(-1, 2, [0, 0]).offset(50, 0),
  ]);
  const frame = evaluate(HStack([node, box()], { gap: 5 }));
  assert.equal(frame.tree.children[0].bounds.width, 20);
  assert.equal(frame.commands[1].bounds.x, 25);
  assert.deepEqual(frame.commands[0].bounds, {
    x: -30,
    y: -10,
    width: 80,
    height: 50,
  });
  assert.deepEqual(evaluate(Group([])).commands, []);
  assert.deepEqual(
    evaluate(Group([Box({ width: 0, height: 0 })])).commands,
    [],
  );
});

test("Group keeps descendant shared poses and can itself be one flattened shared element", () => {
  const child = box().id("child").offset(30, 40);
  const direct = collectSharedElements(evaluate(child), [200, 200], [400, 400]);
  const grouped = collectSharedElements(
    evaluate(Group([child])),
    [200, 200],
    [400, 400],
  );
  assert.deepEqual(grouped, direct);
  const tagged = collectSharedElements(
    evaluate(Group([child]).id("group")),
    [200, 200],
    [400, 400],
  );
  assert.equal(tagged.length, 1);
  assert.equal(tagged[0].id, "group");
  const nested = Composition(World(() => Group([child]), { size: [200, 200] }));
  assert.deepEqual(
    collectSharedElements(evaluate(nested), [200, 200], [400, 400]),
    direct,
  );
});

test("Group isolation nesting is bounded", () => {
  let node = box();
  for (let i = 0; i < 33; i++) node = Group([node]);
  assert.throws(() => evaluate(node), /Group nesting exceeds/);
});
