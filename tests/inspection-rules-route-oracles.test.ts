import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRules, type InspectionRule } from "../src/engine/inspect/rules";
import type { InspectionDocument } from "../src/engine/inspect/report";

test("forward inverse and sibling routes measure independently authored coordinates", () => {
  const descriptor = (id: string, matrix: number[]) => ({ id, parent: { status: "known", id: "layout" }, mapping: { status: "mapped", matrix } });
  const nodes = [
    { id: "a", space: "left", safeBounds: { x: 2, y: 3, width: 4, height: 5 } },
    { id: "root", space: "layout", safeBounds: { x: 0, y: 0, width: 1, height: 1 } },
    { id: "right", space: "right", safeBounds: { x: 0, y: 0, width: 1, height: 1 } },
  ].map((n) => ({ ...n, path: n.id, children: [] }));
  const spaces = [descriptor("left", [-2, 0, 0, 3, 20, 7]), descriptor("right", [4, 0, 0, 2, -8, 5])];
  const doc = { time: { effective: 0 }, scenes: [{ scope: "scene:a", spaces, tree: { children: nodes } }] } as unknown as InspectionDocument;
  const target = (id: string, space: string) => ({ scope: "scene:a", id, space, bounds: "safe-rectangle" as const });
  const run = (a: ReturnType<typeof target>, b: ReturnType<typeof target>, destination: string) => evaluateRules(doc, { schemaVersion: 1, rules: [{ id: "oracle", kind: "alignment", axis: "x", align: "start", a, b, space: `scene:a/${destination}` } as InspectionRule] })[0];
  // a left x=[2,6] maps to root x=[8,16], not [16,24].
  assert.deepEqual(run(target("a", "left"), target("root", "layout"), "layout").measured, [8]);
  // root x=[0,1] maps to left x=[9.5,10], compare left x=2.
  assert.deepEqual(run(target("root", "layout"), target("a", "left"), "left").measured, [7.5]);
  // a root x=[8,16] maps right x=[4,6].
  assert.deepEqual(run(target("a", "left"), target("right", "right"), "right").measured, [4]);
  spaces[0] = descriptor("left", [0, 0, 0, 1, 0, 0]);
  assert.equal(run(target("a", "left"), target("root", "layout"), "layout").status, "indeterminate");
  spaces[0] = descriptor("left", [1, 0, 0, 1, Infinity, 0]);
  assert.equal(run(target("a", "left"), target("root", "layout"), "layout").status, "indeterminate");
});
