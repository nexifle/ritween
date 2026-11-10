import { test } from "node:test";
import assert from "node:assert/strict";
import { projectRect } from "../src/authoring/project-rect";
import type { Affine2D } from "../src/authoring/project-rect";
import type { Bounds } from "../src/authoring/layout";

const unit = { x: 0, y: 0, width: 10, height: 20 };
const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const run = (m: Affine2D, opacity = 1, bounds = unit) => projectRect(bounds, m, opacity);

test("projectRect translates, scales, and reflects axis-aligned bounds exactly", () => {
  assert.deepEqual(run([1, 0, 0, 1, 5, -7]), { bounds: box(5, -7, 10, 20), accuracy: "exact", visible: true });
  assert.deepEqual(run([-2, 0, 0, 3, 0, 0]).bounds, box(-20, 0, 20, 60));
});

test("projectRect keeps quarter-turn and general rotation accuracy distinct", () => {
  const quarter = run([0, 1, -1, 0, 0, 0]);
  assert.deepEqual(quarter.bounds, box(-20, 0, 20, 10));
  assert.equal(quarter.accuracy, "exact");
  const rotated = run([0.6, 0.8, -0.8, 0.6, 0, 0]);
  assert.deepEqual(rotated.bounds, box(-16, 0, 22, 20));
  assert.equal(rotated.accuracy, "aabb");
  assert.equal(rotated.visible, true);
});

test("projectRect reports shear as aabb and singular matrices as invisible", () => {
  assert.equal(run([1, 0, 1, 1, 0, 0]).accuracy, "aabb");
  assert.deepEqual(run([1, 0, 0, 0, 0, 0]), { bounds: box(0, 0, 10, 0), accuracy: "exact", visible: false });
  assert.equal(run([1, 1, 2, 2, 0, 0]).accuracy, "aabb");
  assert.equal(run([1, 0, 0, 1, 0, 0], 1, box(1, 2, 0, 20)).visible, false);
});

test("projectRect keeps exact singularity across underflowing and extreme scales", () => {
  const underflow = run([1e-200, 0, 0, 1e-200, 0, 0]);
  assert.deepEqual(underflow, { bounds: box(0, 0, 1e-199, 2e-199), accuracy: "exact", visible: true });
  const proportional = run([1e-300, 1e300, 1e-300, 1e300, 0, 0]);
  assert.equal(proportional.accuracy, "aabb");
  assert.equal(proportional.visible, false);
  const nearProportional = run([1e-300, 1e300, 1e-300, 1.0000000000000002e300, 0, 0]);
  assert.equal(nearProportional.accuracy, "aabb");
  assert.equal(nearProportional.visible, true);
  const zeroProducts = run([1e-200, 1e-200, 1e-200, 2e-200, 0, 0]);
  assert.equal(zeroProducts.accuracy, "aabb");
  assert.equal(zeroProducts.visible, true);
  assert.equal(run([1e-300, 1e300, 1e-300, -1e300, 0, 0]).visible, true);
  assert.equal(run([1, 0, 0, 1, 0, 0], -0).visible, false);
});

test("projectRect hides zero and near-zero opacity without changing geometry", () => {
  const hidden = run([1, 0, 0, 1, 5, -7], 0);
  assert.equal(hidden.visible, false);
  assert.deepEqual(hidden.bounds, box(5, -7, 10, 20));
  assert.equal(run([1, 0, 0, 1, 0, 0], Number.MIN_VALUE).visible, true);
});

test("projectRect rejects bad dimensions, opacity, non-finite inputs, and overflow", () => {
  const cases: Array<[Bounds, Affine2D, number]> = [
    [box(0, 0, -1, 20), [1, 0, 0, 1, 0, 0], 1],
    [box(0, 0, 1, -1), [1, 0, 0, 1, 0, 0], 1],
    [unit, [1, 0, 0, 1, 0, 0], 1.5],
    [unit, [1, 0, 0, 1, 0, 0], -0.1],
    [unit, [1, 0, 0, 1, 0, 0], Number.NaN],
    [box(Infinity, 0, 1, 1), [1, 0, 0, 1, 0, 0], 1],
    [unit, [Number.NaN, 0, 0, 1, 0, 0], 1],
    [unit, [1, 0, 0, 1, Infinity, 0], 1],
    [unit, [1e200, 0, 0, 1e200, 0, 0], 1],
    [box(-8e307, 0, 1.6e308, 1), [2, 0, 0, 1, 0, 0], 1],
    [unit, [1e200, 1e200, 1e200, 1e200, 0, 0], 1],
    [box(1e308, 0, 1e308, 1), [1, 0, 0, 1, 0, 0], 1],
  ];
  for (const [bounds, matrix, opacity] of cases) assert.throws(() => projectRect(bounds, matrix, opacity), RangeError);
});
