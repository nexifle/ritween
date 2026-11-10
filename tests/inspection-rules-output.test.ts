import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRules, type InspectionRule } from "../src/engine/inspect/rules";
import type { InspectionDocument } from "../src/engine/inspect/report";

test("output layout safety uses occurrence camera, node motion, surface and compositor without inferring clipping", () => {
  const rect = { x: 10, y: 10, width: 20, height: 20 };
  const node = { id: "safe", path: "safe", space: "layout", inspectionId: 1, transform: [-1, 1, 50, 7], safeBounds: rect, children: [] };
  const frame = { id: 0, layoutSpace: { status: "known", id: "layout" }, parentSurface: { status: "known", occurrenceId: 9 }, drawCameras: [{ ownerNodeId: 1, camera: { status: "mapped", matrix: [2, 0, 0, 2, 0, 0] } }] };
  const reference = { id: "reference", path: "reference", space: "reference", safeBounds: { x: 5, y: 2, width: 100, height: 100 }, children: [] };
  const scene = { scope: "scene:a", tree: { children: [node, reference] }, frameOccurrences: [frame], surfaceOccurrences: [{ occurrenceId: 9, projection: { status: "mapped", childPixelsToScene: [1, 0, 0, 1, 100, 0] } }], finalProjection: { status: "available" }, outputLayoutMapping: { matrix: [0.5, 0, 0, 0.5, 3, 0] } };
  const target = { scope: "scene:a", id: "safe", space: "layout", bounds: "safe-rectangle" as const };
  // Independent analytic oracle: x=[20,40] -> [40,80] -> [140,180]
  // -> [73,93]; y=[17,37] -> [34,74] -> [17,37].
  // Reference is already in output coordinates, not transformed by the tested chain.
  const rule: InspectionRule = { id: "output", kind: "containment", a: target, b: { ...target, id: "reference", space: "reference" }, space: "output-pixels" };
  const referenceFrame = { id: 1, layoutSpace: { status: "known", id: "reference" }, parentSurface: { status: "unavailable", reason: "root render target is not a tagged surface." }, drawCameras: [{ ownerNodeId: 2, camera: { status: "mapped", matrix: [2, 0, 0, 2, -6, 0] } }] };
  Object.assign(reference, { inspectionId: 2, transform: [1, 1, 0, 0] });
  scene.frameOccurrences.push(referenceFrame as typeof frame);
  const run = () => evaluateRules({ time: { effective: 1 }, scenes: [scene] } as unknown as InspectionDocument, { schemaVersion: 1, rules: [rule] })[0];
  assert.equal(run().status, "pass");
  assert.deepEqual(run().measured, [68, 12, 15, 65]);
  assert.ok(run().provenance?.includes("recorded-surface:childPixelsToScene:unclipped"));
  const originalCamera = frame.drawCameras[0].camera.matrix;
  // Uploaded float32 .1 is not binary64 .1. Keep that distinction in the
  // expected value rather than rounding observed geometry to design units.
  frame.drawCameras[0].camera.matrix = [Math.fround(0.1), 0, 0, 2, 0, 0];
  const precise = run().measured!;
  assert.equal(precise[0], 48 + Math.fround(0.1) * 10);
  assert.notEqual(precise[0], 49);
  frame.drawCameras[0].camera.matrix = originalCamera;
  scene.frameOccurrences.push(frame);
  assert.equal(run().status, "indeterminate");
  scene.frameOccurrences.pop();
  node.transform = [0, 1, 50, 7];
  assert.equal(run().status, "indeterminate");
  node.transform = [1, 1, 0, 0];
  scene.finalProjection.status = "unavailable";
  assert.equal(run().status, "indeterminate");
});
