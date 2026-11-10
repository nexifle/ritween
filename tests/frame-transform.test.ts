import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeFrameTransform,
  transformPoint,
} from "../src/authoring/frame-transform";
import { evaluateCamera, Camera, worldToView } from "../src/authoring/camera";

test("frame transform handles matching aspect ratio without letterbox margins", () => {
  const transform = computeFrameTransform([100, 100], [200, 200]);
  assert.equal(transform.scale, 2);
  assert.equal(transform.ox, 0);
  assert.equal(transform.oy, 0);
  assert.deepEqual(transform.matrix, [2, 0, 0, 2, 0, 0]);

  const p = transformPoint(transform.matrix, [25, 50]);
  assert.deepEqual(p, [50, 100]);
});

test("frame transform handles aspect mismatch with horizontal letterbox (wider target)", () => {
  // Design 100x100 into target 200x100: scale is 1, ox = (200 - 100)/2 = 50, oy = 0
  const transform = computeFrameTransform([100, 100], [200, 100]);
  assert.equal(transform.scale, 1);
  assert.equal(transform.ox, 50);
  assert.equal(transform.oy, 0);
  assert.deepEqual(transform.matrix, [1, 0, 0, 1, 50, 0]);

  // Corners map into centered viewport
  assert.deepEqual(transformPoint(transform.matrix, [0, 0]), [50, 0]);
  assert.deepEqual(transformPoint(transform.matrix, [100, 100]), [150, 100]);
});

test("frame transform handles aspect mismatch with vertical letterbox (taller target)", () => {
  // Design 100x100 into target 100x200: scale is 1, ox = 0, oy = (200 - 100)/2 = 50
  const transform = computeFrameTransform([100, 100], [100, 200]);
  assert.equal(transform.scale, 1);
  assert.equal(transform.ox, 0);
  assert.equal(transform.oy, 50);
  assert.deepEqual(transform.matrix, [1, 0, 0, 1, 0, 50]);

  // Corners map into centered viewport
  assert.deepEqual(transformPoint(transform.matrix, [0, 0]), [0, 50]);
  assert.deepEqual(transformPoint(transform.matrix, [100, 100]), [100, 150]);
});

test("frame transform integrates camera zoom", () => {
  const camera = evaluateCamera(
    Camera({ zoom: 2 }),
    0,
    [100, 100],
  );
  // Viewport 100x100 to target 200x200 (scale 2), camera zoom 2 centered at (50, 50)
  const transform = computeFrameTransform([100, 100], [200, 200], camera.matrix);
  assert.equal(transform.scale, 2);

  // Center (50, 50) should remain at target center (100, 100)
  const center = transformPoint(transform.matrix, [50, 50]);
  assert.equal(Math.round(center[0]), 100);
  assert.equal(Math.round(center[1]), 100);

  // A point at (60, 50) is 10 units away in world -> with zoom 2 and scale 2, it's 40px away
  const offsetPoint = transformPoint(transform.matrix, [60, 50]);
  assert.equal(Math.round(offsetPoint[0]), 140);
  assert.equal(Math.round(offsetPoint[1]), 100);
});

test("frame transform integrates camera rotation", () => {
  const angle = Math.PI / 2; // 90 deg clockwise
  const camera = evaluateCamera(
    Camera({ rotation: angle, x: 50, y: 50 }),
    0,
    [100, 100],
  );
  const transform = computeFrameTransform([100, 100], [200, 100], camera.matrix);
  assert.equal(transform.scale, 1);
  assert.equal(transform.ox, 50);

  // Center (50, 50) maps to letterboxed target center (100, 50)
  const center = transformPoint(transform.matrix, [50, 50]);
  assert.equal(Math.round(center[0]), 100);
  assert.equal(Math.round(center[1]), 50);

  // World point (50, 40) is 10 units above center (negative Y in design space).
  // Rotating the camera clockwise rotates world coordinates counter-clockwise (Y=-10 becomes X=-10).
  const pointAbove = transformPoint(transform.matrix, [50, 40]);
  assert.equal(Math.round(pointAbove[0]), 90);
  assert.equal(Math.round(pointAbove[1]), 50);

  // Directly verify agreement with worldToView from camera.ts
  const [vx, vy] = worldToView(camera, [50, 40]);
  assert.equal(Math.round(vx * transform.scale + transform.ox), Math.round(pointAbove[0]));
  assert.equal(Math.round(vy * transform.scale + transform.oy), Math.round(pointAbove[1]));
});

test("frame transform transforms negative points and negative coordinates", () => {
  const transform = computeFrameTransform([100, 100], [200, 100]);
  // Negative design coordinates
  const p1 = transformPoint(transform.matrix, [-20, -10]);
  assert.deepEqual(p1, [30, -10]);

  const p2 = transformPoint(transform.matrix, [-50, -50]);
  assert.deepEqual(p2, [0, -50]);
});

test("frame transform handles custom camera matrix with negative offsets and scale", () => {
  // Custom matrix with negative translation and reflection/inversion
  const customMatrix = [-1, 0, 0, -1, -10, -20] as const;
  const transform = computeFrameTransform([100, 100], [200, 200], customMatrix);
  assert.equal(transform.scale, 2);
  assert.deepEqual(transform.matrix, [-2, 0, 0, -2, -20, -40]);

  // Point at (-5, -10)
  // x' = -2 * (-5) - 20 = 10 - 20 = -10
  // y' = -2 * (-10) - 40 = 20 - 40 = -20
  const p = transformPoint(transform.matrix, [-5, -10]);
  assert.deepEqual(p, [-10, -20]);
});
