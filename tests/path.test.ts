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
