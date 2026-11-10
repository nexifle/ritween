import type { PathCommand, PathOutline } from "./path";
export type Point = readonly [number, number];
/** Adaptive subdivision in outline units; bounded to reject pathological geometry. */
export function flattenPath(outline: PathOutline, tolerance = 0.25): Point[][] {
  const contours: Point[][] = [];
  let current: Point[] = [],
    p: Point = [0, 0],
    count = 0;
  const add = (v: Point) => {
    if (++count > 32768) throw Error("Path exceeds 32768 flattened points.");
    current.push(v);
    p = v;
  };
  const curve = (points: Point[], depth = 0) => {
    const a = points[0],
      b = points.at(-1)!;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const flat = points
      .slice(1, -1)
      .every((q) =>
        length
          ? Math.abs(
              (b[0] - a[0]) * (a[1] - q[1]) - (a[0] - q[0]) * (b[1] - a[1]),
            ) /
              length <=
              tolerance &&
            Math.hypot(q[0] - a[0], q[1] - a[1]) <= length + tolerance
          : Math.hypot(q[0] - a[0], q[1] - a[1]) <= tolerance,
      );
    if (flat || depth >= 16) {
      add(b);
      return;
    }
    let level = points;
    const left = [a],
      right = [b];
    while (level.length > 1) {
      level = level
        .slice(1)
        .map(
          (q, i) =>
            [(q[0] + level[i][0]) / 2, (q[1] + level[i][1]) / 2] as Point,
        );
      left.push(level[0]);
      right.unshift(level.at(-1)!);
    }
    curve(left, depth + 1);
    curve(right, depth + 1);
  };
  for (const c of outline) {
    if (c[0] === "M") {
      current = [];
      contours.push(current);
      add([c[1], c[2]]);
    } else if (c[0] === "L") add([c[1], c[2]]);
    else if (c[0] === "Q") curve([p, [c[1], c[2]], [c[3], c[4]]]);
    else if (c[0] === "C") curve([p, [c[1], c[2]], [c[3], c[4]], [c[5], c[6]]]);
    else if (current.length) p = current[0];
  }
  return contours.filter((c) => c.length > 1);
}
const area = (c: Point[]) =>
  c.reduce((s, p, i) => {
    const q = c[(i + 1) % c.length];
    return s + p[0] * q[1] - q[0] * p[1];
  }, 0) / 2;
const center = (c: Point[]): Point => [
  c.reduce((s, p) => s + p[0], 0) / c.length,
  c.reduce((s, p) => s + p[1], 0) / c.length,
];
function sample(c: Point[], n: number): Point[] {
  const lengths = c.map((p, i) =>
    Math.hypot(
      p[0] - c[(i + 1) % c.length][0],
      p[1] - c[(i + 1) % c.length][1],
    ),
  );
  const total = lengths.reduce((a, b) => a + b, 0);
  if (!total) return Array.from({ length: n }, () => c[0]);
  let edge = 0,
    start = 0;
  return Array.from({ length: n }, (_, i) => {
    const distance = (i * total) / n;
    while (edge < lengths.length - 1 && start + lengths[edge] < distance)
      start += lengths[edge++];
    const t = lengths[edge] ? (distance - start) / lengths[edge] : 0,
      a = c[edge],
      b = c[(edge + 1) % c.length];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  });
}
/** Closed-contour correspondence by winding and area; missing contours collapse to a point. */
export function normalizePaths(
  from: PathOutline,
  to: PathOutline,
  samples = 64,
): readonly [PathOutline, PathOutline] {
  if (!Number.isInteger(samples) || samples < 8 || samples > 256)
    throw Error("Morph samples must be an integer in 8..256.");
  const sort = (p: PathOutline) =>
    flattenPath(p).sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)));
  const a = sort(from),
    b = sort(to);
  if (Math.max(a.length, b.length) > 32)
    throw Error("Automatic morph supports at most 32 contours.");
  const left: PathCommand[] = [],
    right: PathCommand[] = [];
  while (a.length || b.length) {
    const ac = a.shift();
    let index = ac
      ? b.findIndex((c) => Math.sign(area(c)) === Math.sign(area(ac)))
      : 0;
    const bc = index >= 0 ? b.splice(index, 1)[0] : undefined;
    const x = ac
      ? sample(ac, samples)
      : Array.from({ length: samples }, () => center(bc!));
    let y = bc
      ? sample(bc, samples)
      : Array.from({ length: samples }, () => center(ac!));
    let best = 0,
      cost = Infinity;
    for (let k = 0; k < samples; k++) {
      const d = x.reduce((sum, p, i) => {
        const q = y[(i + k) % samples];
        return sum + (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
      }, 0);
      if (d < cost) {
        cost = d;
        best = k;
      }
    }
    y = y.map((_, i) => y[(i + best) % samples]);
    for (const [out, points] of [
      [left, x],
      [right, y],
    ] as const) {
      points.forEach((p, i) => out.push([i ? "L" : "M", ...p]));
      out.push(["Z"]);
    }
  }
  return [left, right];
}
