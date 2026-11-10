import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Camera,
  evaluateCamera,
  fitCamera,
  worldToView,
  viewToWorld,
  keyframes,
  motion,
  Box,
  evaluateView,
} from "../src/authoring/index";
import type { Point2D } from "../src/authoring/index";

function close(
  actual: readonly number[],
  expected: readonly number[],
  epsilon = 1e-9,
) {
  assert.equal(actual.length, expected.length);
  actual.forEach((v, i) =>
    assert.ok(Math.abs(v - expected[i]) < epsilon, `${actual} != ${expected}`),
  );
}
const size: Point2D = [1920, 1080];

test("default camera is identity and defaults follow design size, not output resolution", () => {
  const camera = evaluateCamera(Camera(), 0, size);
  close(camera.matrix, [1, 0, 0, 1, 0, 0]);
  close(camera.position, [960, 540]);
  close(worldToView(camera, [100, 200]), [100, 200]);
  close(evaluateCamera({}, 0, [100, 100]).position, [50, 50]);
});

test("camera focus stays at viewport anchor across zoom and roll", () => {
  for (const zoom of [0.1, 1, 2, 100])
    for (const rotation of [-Math.PI, 0, Math.PI / 2, 7]) {
      const camera = evaluateCamera(
        { x: -120, y: 400, zoom, rotation, anchor: [0.25, 0.8] },
        0,
        size,
      );
      close(worldToView(camera, [-120, 400]), [480, 864]);
      close(viewToWorld(camera, [480, 864]), [-120, 400]);
    }
  const camera = evaluateCamera(
    { x: 0, y: 0, zoom: 2, rotation: Math.PI / 2, anchor: [0, 0] },
    0,
    size,
  );
  close(worldToView(camera, [10, 0]), [0, -20]);
});

test("world/view conversion round trips for rolled cameras, offscreen anchors, and negative world positions", () => {
  for (let i = 1; i < 20; i++) {
    const camera = evaluateCamera(
      {
        x: i * -37,
        y: i * 83,
        zoom: i / 7,
        rotation: i / 3,
        anchor: [-0.2, 1.3],
      },
      i,
      size,
    );
    const point: Point2D = [i * 31, i * -67];
    close(viewToWorld(camera, worldToView(camera, point)), point);
  }
});

test("fitCamera contains every rotated bounds corner with viewport padding", () => {
  const bounds = { x: -200, y: 300, width: 600, height: 240 };
  for (const rotation of [0, Math.PI / 4, Math.PI / 2, -0.7]) {
    const camera = evaluateCamera(
      fitCamera(bounds, size, { padding: 80, rotation }),
      0,
      size,
    );
    close(camera.position, [100, 420]);
    for (const x of [bounds.x, bounds.x + bounds.width])
      for (const y of [bounds.y, bounds.y + bounds.height]) {
        const point = worldToView(camera, [x, y]);
        assert.ok(point[0] >= 80 - 1e-9 && point[0] <= size[0] - 80 + 1e-9);
        assert.ok(point[1] >= 80 - 1e-9 && point[1] <= size[1] - 80 + 1e-9);
      }
  }
});

test("camera descriptors snapshot caller data, including keyframes and anchor tracks", () => {
  const track = [
    { at: 0, value: 1 },
    { at: 2, value: 3 },
  ];
  const anchor = [0.5, 0.5] as [number, number];
  const camera = Camera({ zoom: { keyframes: track }, anchor });
  track[1].value = 99;
  anchor[0] = 0;
  assert.equal(evaluateCamera(camera, 2, size).zoom, 3);
  close(evaluateCamera(camera, 2, size).anchor, [0.5, 0.5]);
  assert.ok(Object.isFrozen(camera));
});

test("multi-segment camera motion is deterministic for direct, forward and backward seeks", () => {
  const camera = Camera({
    x: { from: 300, to: 1600, duration: 4 },
    zoom: keyframes([
      { at: 0, value: 2 },
      { at: 1, value: 2 },
      { at: 2, value: 0.5 },
      { at: 3, value: 0.5 },
      { at: 4, value: 3 },
    ]),
    rotation: { from: -0.1, to: 0.1, duration: 4 },
  });
  const expected = evaluateCamera(camera, 3.5, size);
  for (const time of [0, 1, 2, 3, 4, 1, 0]) evaluateCamera(camera, time, size);
  assert.deepEqual(evaluateCamera(camera, 3.5, size), expected);
});

test("keyframes clamp, hold, use destination easing, and work in existing node modifiers", () => {
  const frames = keyframes([
    { at: 1, value: 10 },
    { at: 2, value: 10 },
    { at: 4, value: 30, ease: "linear" },
    { at: 5, value: 50, ease: "ease-in" },
  ]);
  for (const [time, value] of [
    [-1, 10],
    [1, 10],
    [1.5, 10],
    [3, 20],
    [4, 30],
    [4.5, 32.5],
    [9, 50],
  ])
    assert.equal(motion(frames, time), value);
  assert.equal(motion(keyframes([{ at: 3, value: 12 }]), -9), 12);
  const result = evaluateView(Box({ width: 100, height: 100 }).offset(frames), {
    time: 3,
    width: 400,
    height: 300,
    measureText: () => 0,
  });
  assert.equal(result.commands[0].transform[2], 20);
});

test("camera and keyframes reject malformed numeric inputs and impossible fits", () => {
  for (const zoom of [0, -1, NaN, Infinity])
    assert.throws(() => evaluateCamera({ zoom }, 0, size));
  assert.throws(() => evaluateCamera({}, NaN, size));
  assert.throws(() => evaluateCamera({}, 0, [0, 1080]));
  assert.throws(() => evaluateCamera({ rotation: Infinity }, 0, size));
  assert.throws(() => evaluateCamera({ anchor: [NaN, 0] }, 0, size));
  assert.throws(() => evaluateCamera({ x: 1e308, zoom: 1e308 }, 0, size));
  assert.throws(() => fitCamera({ x: 0, y: 0, width: 0, height: 10 }, size));
  assert.throws(() =>
    fitCamera({ x: 0, y: 0, width: 10, height: 10 }, size, { padding: 540 }),
  );
  for (const frames of [
    [],
    [{ at: 0, value: NaN }],
    [
      { at: 0, value: 1 },
      { at: 0, value: 2 },
    ],
    [
      { at: 1, value: 1 },
      { at: 0, value: 2 },
    ],
  ])
    assert.throws(() => keyframes(frames));
});
