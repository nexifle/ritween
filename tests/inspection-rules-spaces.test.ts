import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRules, type InspectionRule } from "../src/engine/inspect/rules";
import type { InspectionDocument } from "../src/engine/inspect/report";
test("recorded World mapping supports shared layout space, negative scale and rejects singular or ambiguous chains", () => {
  const bounds = { x: 0, y: 0, width: 10, height: 10 };
  const target = { scope: "scene:a", id: "a", space: "world", bounds: "safe-rectangle" as const };
  const rule: InspectionRule = { id: "mapped", kind: "alignment", a: target, b: target, space: "scene:a/layout", axis: "x", align: "start" };
  const descriptor = (matrix: number[]) => ({ id: "world", kind: "world", parent: { status: "known", id: "layout" }, mapping: { status: "mapped", source: "evaluateCamera", precision: "binary64-evaluated", kind: "world-to-composition-viewport", matrix } });
  const run = (spaces: unknown[]) => evaluateRules({ time: { effective: 0 }, scenes: [{ scope: "scene:a", spaces, tree: { id: "a", path: "a", space: "world", safeBounds: bounds, children: [] } }] } as unknown as InspectionDocument, { schemaVersion: 1, rules: [rule] })[0];
  const negative = descriptor([-2, 0, 0, 2, 100, 0]);
  assert.equal(run([negative]).status, "pass");
  assert.ok(run([negative]).provenance?.includes("evaluateCamera:binary64-evaluated"));
  assert.equal(run([descriptor([0, 0, 0, 0, 0, 0])]).status, "indeterminate");
  assert.equal(run([negative, negative]).status, "indeterminate");
  assert.equal(run([]).status, "indeterminate");
});
