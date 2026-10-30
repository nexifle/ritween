import { normalizePaths } from "./path-geometry";
import { ViewNode } from "./nodes";
import { resolveNumber, snapshotNumber, type AnimatedNumber } from "./motion";

/** Absolute SVG-style commands. Matching command topology is required for morphs. */
export type PathCommand =
  | readonly ["M" | "L", number, number]
  | readonly ["Q", number, number, number, number]
  | readonly ["C", number, number, number, number, number, number]
  | readonly ["Z"];
export type PathOutline = readonly PathCommand[];
export interface PathStyle {
  readonly width: number;
  readonly height: number;
  readonly fill?: string;
  readonly fillRule?: "nonzero" | "evenodd";
  readonly to?: PathOutline;
  readonly progress?: AnimatedNumber;
  /** Auto matches contours; strict preserves exact matching Bézier commands. */
  readonly topology?: "auto" | "strict";
}
export interface PathSpec {
  readonly kind: "path";
  readonly outline: PathOutline;
  readonly style: PathStyle;
}
export function snapshotOutline(outline: PathOutline): PathOutline {
  if (!outline.length || outline.length > 4096 || outline[0][0] !== "M")
    throw Error("Path needs 1..4096 commands starting with M.");
  const lengths = { M: 3, L: 3, Q: 5, C: 7, Z: 1 };
  for (const command of outline) {
    if (
      command.length !== lengths[command[0]] ||
      !command
        .slice(1)
        .every((v) => typeof v === "number" && Number.isFinite(v))
    )
      throw Error("Invalid path command.");
  }
  return Object.freeze(
    outline.map((c) => Object.freeze([...c]) as PathCommand),
  );
}
/** Pure coordinate interpolation; contour order and winding must correspond. */
export function morphPath(
  from: PathOutline,
  to: PathOutline,
  progress: number,
): PathOutline {
  if (!Number.isFinite(progress)) throw Error("Morph progress must be finite.");
  if (
    from.length !== to.length ||
    from.some((c, i) => c[0] !== to[i][0] || c.length !== to[i].length)
  )
    throw Error(
      "Morph paths need matching commands and contours; normalize outlines first.",
    );
  const t = Math.max(0, Math.min(1, progress));
  return from.map(
    (c, i) =>
      c.map((v, j) =>
        j === 0
          ? v
          : (v as number) + ((to[i][j] as number) - (v as number)) * t,
      ) as unknown as PathCommand,
  );
}
export function Path(outline: PathOutline, style: PathStyle): ViewNode {
  if (![style.width, style.height].every((v) => Number.isFinite(v) && v > 0))
    throw Error("Path dimensions must be positive and finite.");
  if (style.fillRule && !["nonzero", "evenodd"].includes(style.fillRule))
    throw Error("Invalid path fill rule.");
  let from = snapshotOutline(outline),
    to = style.to && snapshotOutline(style.to);
  if (
    to &&
    style.topology !== "strict" &&
    (from.length !== to.length ||
      from.some((c, i) => c[0] !== to![i][0] || c.length !== to![i].length))
  )
    [from, to] = normalizePaths(from, to);
  if (to) morphPath(from, to, 0);
  return new ViewNode({
    kind: "path",
    outline: from,
    style: Object.freeze({
      ...style,
      to,
      progress:
        style.progress === undefined
          ? undefined
          : snapshotNumber(style.progress),
    }),
  });
}
export interface GlyphDefinition {
  readonly outline: PathOutline;
  readonly advance: number;
}
/** Font-extracted glyph outlines use the same morph engine, including hole contours. */
export function Glyph(
  glyph: GlyphDefinition,
  style: PathStyle & { readonly toGlyph?: GlyphDefinition },
): ViewNode {
  if (!Number.isFinite(glyph.advance) || glyph.advance < 0)
    throw Error("Glyph advance must be non-negative and finite.");
  return Path(glyph.outline, {
    ...style,
    to: style.toGlyph?.outline ?? style.to,
  });
}
export function evaluatePath(spec: PathSpec, time: number): PathOutline {
  return spec.style.to
    ? morphPath(
        spec.outline,
        spec.style.to,
        resolveNumber(spec.style.progress ?? 0, time),
      )
    : spec.outline;
}
export function pathData(outline: PathOutline): string {
  return outline.map((c) => c.join(" ")).join(" ");
}

export type PathPoint = readonly [number, number];
export interface PolylineStyle {
  readonly width?: number;
  readonly color?: string;
}
export interface PolygonStyle {
  readonly fill?: string;
  readonly fillRule?: "nonzero" | "evenodd";
}
export interface ArrowStyle extends PolylineStyle {
  readonly headLength?: number;
  readonly headWidth?: number;
}

function pointsSnapshot(
  points: readonly PathPoint[],
  min: number,
): PathPoint[] {
  if (
    points.length < min ||
    points.length > 4094 ||
    points.some((p) => p.length !== 2 || !p.every(Number.isFinite))
  )
    throw Error(`Expected ${min}..4094 finite points.`);
  return points.map(([x, y]) => [x, y]);
}
function positiveSize(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0)
    throw Error(`${name} must be positive and finite.`);
  return value;
}
function pointPath(
  contours: readonly (readonly PathPoint[])[],
  fill?: string,
  fillRule?: "nonzero" | "evenodd",
): ViewNode {
  const points = contours.flat();
  const minX = Math.min(...points.map((p) => p[0])),
    minY = Math.min(...points.map((p) => p[1]));
  const width = Math.max(...points.map((p) => p[0])) - minX,
    height = Math.max(...points.map((p) => p[1])) - minY;
  if (![width, height].every((v) => Number.isFinite(v) && v > 0))
    throw Error("Geometry bounds must be positive and finite.");
  const outline: PathCommand[] = [];
  for (const contour of contours) {
    contour.forEach(([x, y], i) =>
      outline.push([i ? "L" : "M", x - minX, y - minY]),
    );
    outline.push(["Z"]);
  }
  return Path(outline, { width, height, fill, fillRule });
}
function segment(from: PathPoint, to: PathPoint, width: number): PathPoint[] {
  const dx = to[0] - from[0],
    dy = to[1] - from[1],
    length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length === 0)
    throw Error("Consecutive points must be distinct and finite in distance.");
  const nx = ((-dy / length) * width) / 2,
    ny = ((dx / length) * width) / 2;
  return [
    [from[0] + nx, from[1] + ny],
    [to[0] + nx, to[1] + ny],
    [to[0] - nx, to[1] - ny],
    [from[0] - nx, from[1] - ny],
  ];
}
/** Open, butt-capped segments; each segment is an independently filled contour. */
export function Polyline(
  points: readonly PathPoint[],
  style: PolylineStyle = {},
): ViewNode {
  const p = pointsSnapshot(points, 2),
    width = positiveSize(style.width ?? 4, "Polyline width");
  return pointPath(
    p.slice(1).map((to, i) => segment(p[i], to, width)),
    style.color,
  );
}
/** Closed polygon, painted by the Path winding/parity fill rule. */
export function Polygon(
  points: readonly PathPoint[],
  style: PolygonStyle = {},
): ViewNode {
  const p = pointsSnapshot(points, 3);
  const [a, b] = p;
  if (
    p.some(
      (v, i) =>
        v[0] === p[(i + 1) % p.length][0] && v[1] === p[(i + 1) % p.length][1],
    ) ||
    !p.slice(2).some((c) => {
      const bx = b[0] - a[0],
        by = b[1] - a[1],
        cx = c[0] - a[0],
        cy = c[1] - a[1];
      if (![bx, by, cx, cy].every(Number.isFinite))
        throw Error("Geometry bounds must be positive and finite.");
      const x = Math.max(Math.abs(bx), Math.abs(cx)) || 1,
        y = Math.max(Math.abs(by), Math.abs(cy)) || 1;
      return (bx / x) * (cy / y) !== (by / y) * (cx / x);
    })
  )
    throw Error(
      "Polygon needs distinct adjacent points and non-collinear geometry.",
    );
  return pointPath([p], style.fill, style.fillRule);
}
/** A straight butt-capped shaft and triangular head; coincident endpoints are rejected. */
export function Arrow(
  from: PathPoint,
  to: PathPoint,
  style: ArrowStyle = {},
): ViewNode {
  const [a, b] = pointsSnapshot([from, to], 2);
  const width = positiveSize(style.width ?? 4, "Arrow width");
  const headLength = positiveSize(style.headLength ?? 12, "Arrow head length");
  const headWidth = positiveSize(style.headWidth ?? 12, "Arrow head width");
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length === 0)
    throw Error("Arrow endpoints must be distinct and finite in distance.");
  if (headLength > length)
    throw Error("Arrow head length cannot exceed its length.");
  const ux = dx / length,
    uy = dy / length;
  const base: PathPoint = [b[0] - ux * headLength, b[1] - uy * headLength];
  const head: PathPoint[] = [
    [base[0] - (uy * headWidth) / 2, base[1] + (ux * headWidth) / 2],
    b,
    [base[0] + (uy * headWidth) / 2, base[1] - (ux * headWidth) / 2],
  ];
  return pointPath(
    length === headLength ? [head] : [segment(a, base, width), head],
    style.color,
  );
}
