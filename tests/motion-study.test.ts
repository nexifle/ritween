import { test } from "node:test";
import assert from "node:assert/strict";
import { squareCentersAt } from "../skills/ritween/assets/motion-study/scene";

const group = [
  [320, 180],
  [302, 216],
  [338, 216],
];

test("motion study preserves identities and resolves the intact group deterministically", () => {
  assert.deepEqual(squareCentersAt(0), [
    [84, 210],
    [181, 260],
    [555, 161],
  ]);
  const earlier = squareCentersAt(2.8);
  const end = group.map(([x, y]) => [x + 96, y]);
  assert.deepEqual(squareCentersAt(5.2), end);
  assert.deepEqual(squareCentersAt(6), end);
  assert.deepEqual(squareCentersAt(2.8), earlier);
  const a = squareCentersAt(3.5);
  const b = squareCentersAt(4.5);
  for (let i = 1; i < 3; i++) {
    for (let axis = 0; axis < 2; axis++) {
      assert.ok(
        Math.abs(a[i][axis] - a[0][axis] - (b[i][axis] - b[0][axis])) < 1e-9,
      );
    }
  }
});

test("motion study overlaps beats without pauses or velocity discontinuities", () => {
  const h = 0.0001;
  for (const time of [1.85, 2.4, 2.85, 3.4]) {
    const before = squareCentersAt(time - h);
    const at = squareCentersAt(time);
    const after = squareCentersAt(time + h);
    let totalSpeed = 0;
    for (let i = 0; i < 3; i++) {
      for (let axis = 0; axis < 2; axis++) {
        const incoming = (at[i][axis] - before[i][axis]) / h;
        const outgoing = (after[i][axis] - at[i][axis]) / h;
        assert.ok(Math.abs(incoming - outgoing) < 0.5, `velocity at ${time}`);
        totalSpeed += Math.abs(incoming);
      }
    }
    assert.ok(totalSpeed > 1, `no full stop at ${time}`);
  }
});
