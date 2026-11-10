import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Path,
  Glyph,
  morphPath,
  normalizePaths,
  evaluateView,
  type PathOutline,
} from "../src/authoring/index";
const square: PathOutline = [
  ["M", 0, 0],
  ["L", 100, 0],
  ["L", 100, 100],
  ["L", 0, 100],
  ["Z"],
];
const diamond: PathOutline = [
  ["M", 50, 0],
  ["L", 100, 50],
  ["L", 50, 100],
  ["L", 0, 50],
  ["Z"],
];
test("automatic topology normalizes curves, missing contours and unequal command counts", () => {
  const curve: PathOutline = [
    ["M", 0, 0],
    ["C", 100, 0, 100, 100, 0, 100],
    ["Z"],
  ];
  const [a, b] = normalizePaths(square, curve, 32);
  assert.equal(a.length, b.length);
  assert.doesNotThrow(() => morphPath(a, b, 0.5));
  const holed: PathOutline = [
    ...square,
    ["M", 25, 25],
    ["L", 25, 75],
    ["L", 75, 75],
    ["L", 75, 25],
    ["Z"],
  ];
  const [c, d] = normalizePaths(square, holed);
  assert.equal(c.filter((p) => p[0] === "M").length, 2);
  assert.equal(c.length, d.length);
  assert.doesNotThrow(() =>
    Path(square, { width: 100, height: 100, to: curve }),
  );
  assert.throws(
    () =>
      Path(square, { width: 100, height: 100, to: curve, topology: "strict" }),
    /matching/,
  );
  assert.throws(() => normalizePaths(square, curve, 10000), /samples/);
});

test("path morph interpolates actual coordinates and clamps endpoints", () => {
  assert.deepEqual(morphPath(square, diamond, 0.5)[0], ["M", 25, 0]);
  assert.deepEqual(morphPath(square, diamond, -1), square);
  assert.deepEqual(morphPath(square, diamond, 2), diamond);
  assert.throws(() => morphPath(square, [["M", 0, 0]], 0.5), /matching/);
  assert.throws(() => morphPath(square, diamond, NaN), /finite/);
});
test("Path and Glyph use deterministic time-based outline geometry", () => {
  const node = Glyph(
    { outline: square, advance: 100 },
    {
      width: 100,
      height: 100,
      toGlyph: { outline: diamond, advance: 100 },
      progress: { from: 0, to: 1, duration: 1, ease: "linear" },
      fillRule: "evenodd",
    },
  );
  const render = (time: number) =>
    evaluateView(node, { time, width: 100, height: 100, measureText: () => 0 });
  const a = render(0.5);
  render(1);
  assert.deepEqual(render(0.5), a);
  assert.equal(a.commands[0].kind, "path");
  if (a.commands[0].kind === "path") assert.match(a.commands[0].data, /M 25 0/);
  assert.throws(() => Path(square, { width: 0, height: 100 }), /positive/);
  const mutable: any[] = [
    ["M", 0, 0],
    ["L", 10, 10],
  ];
  const p = Path(mutable as PathOutline, { width: 100, height: 100 });
  mutable[0][1] = 99;
  assert.equal(p.spec.kind === "path" && p.spec.outline[0][1], 0);
});

test("Polyline snapshots open butt-capped segments with stroke bounds and theme paint", async () => {
  const { Polyline, defaultTheme } = await import("../src/authoring/index");
  const points: [number, number][] = [
    [10, 20],
    [20, 20],
    [20, 30],
  ];
  const style = { width: 4, color: "red" };
  const node = Polyline(points, style).id("wire");
  points[0][0] = 100;
  style.color = "blue";
  style.width = 20;
  const frame = evaluateView(node, {
    time: 0,
    width: 100,
    height: 100,
    measureText: () => 0,
  });
  const command = frame.commands[0];
  assert.equal(command.kind, "path");
  if (command.kind !== "path") throw Error("expected path");
  assert.equal(command.sharedId, "wire");
  assert.equal(command.fill, "red");
  assert.deepEqual(command.bounds, { x: 0, y: 0, width: 12, height: 12 });
  assert.deepEqual(command.outline, [
    ["M", 0, 4],
    ["L", 10, 4],
    ["L", 10, 0],
    ["L", 0, 0],
    ["Z"],
    ["M", 8, 2],
    ["L", 8, 12],
    ["L", 12, 12],
    ["L", 12, 2],
    ["Z"],
  ]);
  const defaultPaint = evaluateView(
    Polyline([
      [0, 0],
      [10, 0],
    ]),
    { time: 0, width: 100, height: 100, measureText: () => 0 },
  ).commands[0];
  assert.equal(
    defaultPaint.kind === "path" && defaultPaint.fill,
    defaultTheme.textColor,
  );
});

test("Polygon closes concave and self-intersecting outlines using the selected winding rule", async () => {
  const { Polygon } = await import("../src/authoring/index");
  const concave = Polygon(
    [
      [0, 0],
      [10, 0],
      [5, 5],
      [10, 10],
      [0, 10],
    ],
    { fill: "red" },
  );
  assert.deepEqual(concave.spec.kind === "path" && concave.spec.outline, [
    ["M", 0, 0],
    ["L", 10, 0],
    ["L", 5, 5],
    ["L", 10, 10],
    ["L", 0, 10],
    ["Z"],
  ]);
  const crossing = Polygon(
    [
      [0, 0],
      [10, 10],
      [0, 10],
      [10, 0],
    ],
    { fillRule: "evenodd" },
  );
  assert.equal(
    crossing.spec.kind === "path" && crossing.spec.style.fillRule,
    "evenodd",
  );
  assert.deepEqual(
    crossing.spec.kind === "path" && crossing.spec.outline.at(-1),
    ["Z"],
  );
  assert.throws(
    () =>
      Polygon([
        [0, 0],
        [1, 1],
        [2, 2],
      ]),
    /non-collinear/,
  );
  assert.throws(
    () =>
      Polygon([
        [0, 0],
        [1, 1],
        [0, 0],
      ]),
    /distinct/,
  );
});

test("Polygon validates tiny and large finite geometry without cross-product underflow or overflow", async () => {
  const { Polygon } = await import("../src/authoring/index");
  for (const size of [1e-200, 1e200]) {
    const node = Polygon([
      [0, 0],
      [size, size],
      [size, size / 2],
    ]);
    assert.equal(node.spec.kind, "path");
    if (node.spec.kind !== "path") throw Error("expected path");
    assert.equal(node.spec.style.width, size);
    assert.equal(node.spec.style.height, size);
    const frame = evaluateView(node, {
      time: 0,
      width: 100,
      height: 100,
      measureText: () => 0,
    });
    assert.equal(frame.commands[0].kind, "path");
    assert.deepEqual(frame.commands[0].bounds, {
      x: 0,
      y: 0,
      width: size,
      height: size,
    });
    assert.throws(
      () =>
        Polygon([
          [0, 0],
          [size / 2, size / 2],
          [size, size],
        ]),
      /non-collinear/,
    );
  }
  assert.doesNotThrow(() =>
    Polygon([
      [0, 0],
      [1e-200, 0],
      [0, 1e-200],
    ]),
  );
  assert.throws(
    () =>
      Polygon([
        [-1e308, 0],
        [1e308, 1],
        [0, 2],
      ]),
    /bounds/,
  );
});

test("Arrow constructs deterministic heads for horizontal, vertical and diagonal directions", async () => {
  const { Arrow } = await import("../src/authoring/index");
  for (const [end, expected] of [
    [
      [20, 0],
      [
        ["M", 0, 5],
        ["L", 10, 5],
        ["L", 10, 3],
        ["L", 0, 3],
        ["Z"],
        ["M", 10, 8],
        ["L", 20, 4],
        ["L", 10, 0],
        ["Z"],
      ],
    ],
    [
      [0, 20],
      [
        ["M", 3, 0],
        ["L", 3, 10],
        ["L", 5, 10],
        ["L", 5, 0],
        ["Z"],
        ["M", 0, 10],
        ["L", 4, 20],
        ["L", 8, 10],
        ["Z"],
      ],
    ],
  ] as const) {
    const node = Arrow([0, 0], end, { width: 2, headLength: 10, headWidth: 8 });
    assert.deepEqual(node.spec.kind === "path" && node.spec.outline, expected);
  }
  const diagonal = Arrow([0, 0], [30, 40], {
    width: 10,
    headLength: 10,
    headWidth: 20,
  });
  assert.deepEqual(
    diagonal.spec.kind === "path" && diagonal.spec.outline,
    [
      ["M", 0, 3],
      ["L", 24, 35],
      ["L", 32, 29],
      ["L", 8, -3],
      ["Z"],
      ["M", 20, 38],
      ["L", 34, 40],
      ["L", 36, 26],
      ["Z"],
    ].map(([op, x, y]) => (op === "Z" ? [op] : [op, x, (y as number) + 3])),
  );
  assert.throws(() => Arrow([0, 0], [0, 0]), /distinct/);
  assert.throws(() => Arrow([0, 0], [1, 0]), /head length/);
});

test("geometry validates inputs and works with modifiers and backwards time evaluation", async () => {
  const { Polyline, Polygon, Arrow } = await import("../src/authoring/index");
  assert.throws(() => Polyline([]), /points/);
  assert.throws(() => Polyline([[0, 0]]), /points/);
  assert.throws(
    () =>
      Polygon([
        [0, 0],
        [1, 0],
      ]),
    /points/,
  );
  assert.throws(
    () =>
      Polyline([
        [0, 0],
        [NaN, 1],
      ]),
    /finite/,
  );
  assert.throws(
    () =>
      Polyline(
        [
          [0, 0],
          [1, 1],
        ],
        { width: 0 },
      ),
    /width/,
  );
  assert.throws(
    () => Arrow([0, 0], [20, 0], { headWidth: Infinity }),
    /head width/,
  );
  assert.throws(
    () => Arrow([0, 0], [20, 0], { headLength: -1 }),
    /head length/,
  );
  const node = Polyline(
    [
      [0, 0],
      [20, 0],
    ],
    { width: 4 },
  )
    .id("line")
    .opacity({ from: 0, to: 1, duration: 1, ease: "linear" })
    .offset(3, 4)
    .scale(2)
    .clip();
  const render = (time: number) =>
    evaluateView(node, { time, width: 100, height: 100, measureText: () => 0 });
  const first = render(0.5);
  render(1);
  assert.deepEqual(render(0.5), first);
  const clip = first.commands[0];
  assert.equal(clip.kind, "composition");
  if (clip.kind !== "composition") throw Error("expected clip");
  assert.deepEqual(clip.bounds, { x: 0, y: 0, width: 20, height: 4 });
  const paint = clip.frame.commands[0];
  assert.equal(paint.kind, "path");
  assert.equal(paint.sharedId, "line");
  assert.equal(paint.opacity, 0.5);
  assert.deepEqual(paint.transform, [2, 2, -4, 6]);
});
