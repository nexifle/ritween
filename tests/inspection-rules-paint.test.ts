import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateRules,
  type InspectionRule,
} from "../src/engine/inspect/rules";
import type { InspectionDocument } from "../src/engine/inspect/report";
const target = (id: string) => ({
  scope: "scene:a",
  space: "layout",
  id,
  bounds: "projected-paint" as const,
});
function evaluate(kind: InspectionRule["kind"], x: number) {
  const node = (id: string, inspectionId: number) => ({
    id,
    inspectionId,
    path: id,
    children: [],
    kind: "box",
  });
  const paint = (nodeId: number, left: number, paintRole = "content") => ({
    kind: "box",
    path: "box",
    inspection: { nodeId },
    paintRole,
    accuracy: "exact-rectangle",
    geometryVisible: true,
    sceneWeight: 1,
    bounds: { x: left, y: 0, width: 10, height: 10 },
  });
  const doc = {
    time: { effective: 0 },
    scenes: [
      {
        scope: "scene:a",
        tree: { path: "root", children: [node("a", 1), node("b", 2)] },
        finalPaintRecords: [
          paint(1, 0),
          paint(1, -100, "background"),
          paint(2, x),
        ],
      },
    ],
  } as unknown as InspectionDocument;
  return evaluateRules(doc, {
    schemaVersion: 1,
    rules: [
      {
        id: "paint",
        kind,
        a: target("a"),
        b: target("b"),
        space: "output-pixels",
        assertionDomain: "ideal-projected-bounds",
        axis: "x",
        minimum: 10,
        align: "start",
      },
    ],
  })[0];
}
test("explicit ideal bounds restore measurements without claiming pixel support", () => {
  assert.equal(evaluate("non-overlap", 20).status, "pass");
  assert.equal(evaluate("non-overlap", 5).status, "fail");
  assert.equal(evaluate("minimum-gap", 20).status, "pass");
  assert.deepEqual(evaluate("minimum-gap", 20).measured, [10]);
  assert.equal(evaluate("minimum-gap", 19).status, "fail");
  assert.equal(evaluate("containment", 0).status, "pass");
  assert.equal(evaluate("containment", 5).status, "fail");
  assert.equal(evaluate("alignment", 0).status, "pass");
  assert.equal(evaluate("alignment", 5).status, "fail");
  assert.match(evaluate("alignment", 0).explanation, /no ink, raster coverage/);
});
