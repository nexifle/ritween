import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRules, type InspectionRule } from "../src/engine/inspect/rules";
import type { InspectionDocument } from "../src/engine/inspect/report";

test("output layout safety uses occurrence camera, node motion, surface and compositor without inferring clipping", () => {
  const rect = { x: 10, y: 10, width: 20, height: 20 };
  const node = { id: "safe", path: "safe", space: "layout", inspectionId: 1, transform: [-1, 1, 50, 7], safeBounds: rect, children: [] };
  const frame = { id: 0, layoutSpace: { status: "known", id: "layout" }, parentSurface: { status: "known", occurrenceId: 9 }, drawCameras: [{ ownerNodeId: 1, camera: { status: "mapped", matrix: [2, 0, 0, 2, 0, 0] } }] };
  const scene = { scope: "scene:a", tree: node, frameOccurrences: [frame], surfaceOccurrences: [{ occurrenceId: 9, projection: { status: "mapped", childPixelsToScene: [1, 0, 0, 1, 100, 0] } }], finalProjection: { status: "available" }, outputLayoutMapping: { matrix: [0.5, 0, 0, 0.5, 3, 0] } };
  const target = { scope: "scene:a", id: "safe", space: "layout", bounds: "safe-rectangle" as const };
  const rule: InspectionRule = { id: "output", kind: "containment", a: target, b: target, space: "output-pixels" };
  const run = () => evaluateRules({ time: { effective: 1 }, scenes: [scene] } as unknown as InspectionDocument, { schemaVersion: 1, rules: [rule] })[0];
  assert.equal(run().status, "pass");
  assert.deepEqual(run().measured, [0, 0, 0, 0]);
  assert.ok(run().provenance?.includes("recorded-surface:childPixelsToScene:unclipped"));
  scene.frameOccurrences.push(frame);
  assert.equal(run().status, "indeterminate");
  scene.frameOccurrences.pop();
  node.transform = [0, 1, 50, 7];
  assert.equal(run().status, "indeterminate");
  node.transform = [1, 1, 0, 0];
  scene.finalProjection.status = "unavailable";
  assert.equal(run().status, "indeterminate");
});
