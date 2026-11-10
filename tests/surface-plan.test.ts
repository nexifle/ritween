import { test } from "node:test";
import assert from "node:assert/strict";
import { planSurface } from "../src/authoring/surface-plan";
import { identity, multiply } from "../src/engine/render/shared-elements";
import { computeFrameTransform } from "../src/authoring/frame-transform";
import { evaluateCamera, Camera } from "../src/authoring/camera";

test("surface plan allocates ceil(bounds × scale) pixels with a 1px floor", () => {
  // Exact fit
  const exact = planSurface({ x: 0, y: 0, width: 50, height: 25 }, [1, 1, 0, 0], 2, [1, 0, 0, 1, 0, 0]);
  assert.deepEqual([exact.width, exact.height], [100, 50]);

  // Fractional bounds round up
  const fractional = planSurface({ x: 0, y: 0, width: 33.4, height: 10.2 }, [1, 1, 0, 0], 1, [1, 0, 0, 1, 0, 0]);
  assert.deepEqual([fractional.width, fractional.height], [34, 11]);

  // Fractional scale rounds up
  const fractionalScale = planSurface({ x: 0, y: 0, width: 10, height: 10 }, [1, 1, 0, 0], 1.5, [1, 0, 0, 1, 0, 0]);
  assert.deepEqual([fractionalScale.width, fractionalScale.height], [15, 15]);

  // Tiny allocation floors at 1×1
  const tiny = planSurface({ x: 0, y: 0, width: 0.001, height: 0.001 }, [1, 1, 0, 0], 0.01, [1, 0, 0, 1, 0, 0]);
  assert.deepEqual([tiny.width, tiny.height], [1, 1]);
});

test("surface plan handles negative command scale with exact renderer allocation", () => {
  // The allocation is ceil(bounds × frame scale) and does not include the command's own
  // scale; a mirrored command keeps its target size and flips the mapping axis instead.
  const plan = planSurface(
    { x: 10, y: 5, width: 40, height: 20 },
    [-2, -3, 7, 9],
    1,
    [1, 0, 0, 1, 0, 0],
  );
  assert.deepEqual([plan.width, plan.height], [40, 20]);

  // The mapping places the origin through the mirrored placement, matching renderer math.
  const expected = multiply(
    identity,
    multiply([1, 0, 0, 1, 0, 0], [
      (40 * -2) / 40,
      0,
      0,
      (20 * -3) / 20,
      10 * -2 + 7,
      5 * -3 + 9,
    ]),
  );
  assert.deepEqual(plan.childSpace, expected);
});

test("surface plan keeps child design size distinct from pixel target size", () => {
  const plan = planSurface({ x: 0, y: 0, width: 100, height: 60 }, [1, 1, 0, 0], 2, [1, 0, 0, 1, 0, 0]);
  // Design size stays in layout units; the target is the scaled pixel allocation.
  assert.deepEqual(plan.childDesignSize, [100, 60]);
  assert.deepEqual([plan.width, plan.height], [200, 120]);
});

test("surface plan composes shared-correction space with frame camera and parent space", () => {
  const camera = evaluateCamera(Camera({ zoom: 2 }), 0, [100, 100]);
  const frame = computeFrameTransform([100, 100], [200, 200], camera.matrix);
  const parentShared = [1.5, 0, 0, 0.75, 4, -2] as const;
  const plan = planSurface(
    { x: 10, y: 20, width: 50, height: 50 },
    [1, 1, 0, 0],
    frame.scale,
    frame.matrix,
    parentShared,
  );

  // Correction-space order, not a child-pixel mapping: parent, frame, command placement.
  const placement = [(50 * 1) / plan.width, 0, 0, (50 * 1) / plan.height, 10, 20];
  const expected = multiply(
    parentShared,
    multiply(frame.matrix, placement),
  );
  assert.deepEqual(plan.childSpace, expected);
});

test("surface plan without parent shared space starts from identity", () => {
  const plan = planSurface({ x: 0, y: 0, width: 10, height: 10 }, [1, 1, 0, 0], 1, [1, 0, 0, 1, 0, 0]);
  const expected = multiply(identity, multiply([1, 0, 0, 1, 0, 0], [1, 0, 0, 1, 0, 0]));
  assert.deepEqual(plan.childSpace, expected);
});

test("surface plan child space reproduces the exact renderer expression", () => {
  // Capture the exact pre-extraction renderer math for comparison.
  const bounds = { x: 3, y: 8, width: 70.5, height: 41.2 };
  const transform = [0.9, 1.4, 5, -3] as const;
  const scale = 1.25;
  const worldToPixels = [2, 0.1, -0.2, 1.8, 30, 45] as const;
  const parentShared = [1, 0.05, -0.02, 0.8, 12, -7] as const;

  const plan = planSurface(bounds, transform, scale, worldToPixels, parentShared);
  const width = Math.max(1, Math.ceil(bounds.width * scale));
  const height = Math.max(1, Math.ceil(bounds.height * scale));
  const [sx, sy, tx, ty] = transform;
  const childSpace = multiply(
    parentShared ?? identity,
    multiply(worldToPixels, [
      (bounds.width * sx) / width,
      0,
      0,
      (bounds.height * sy) / height,
      bounds.x * sx + tx,
      bounds.y * sy + ty,
    ]),
  );
  assert.deepEqual(plan.childSpace, childSpace);
  assert.deepEqual([plan.width, plan.height], [width, height]);
  assert.deepEqual(plan.childDesignSize, [bounds.width, bounds.height]);
});
