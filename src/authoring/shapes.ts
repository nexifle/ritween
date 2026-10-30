import { ViewNode } from "./nodes";
import { resolveNumber, snapshotNumber, type AnimatedNumber } from "./motion";
import type { PathOutline, PathCommand } from "./path";

export interface CircleStyle {
  readonly radius: AnimatedNumber;
  readonly fill?: string;
  readonly stroke?: string;
  readonly strokeWidth?: number;
  /** Fractions of one clockwise turn, starting at twelve o'clock. */
  readonly trim?: readonly [AnimatedNumber, AnimatedNumber];
}
export interface LineStyle {
  readonly from: readonly [number, number];
  readonly to: readonly [number, number];
  readonly color?: string;
  readonly width?: number;
  readonly progress?: AnimatedNumber;
}
export type ShapeSpec =
  | { readonly kind: "circle"; readonly style: CircleStyle }
  | { readonly kind: "line"; readonly style: LineStyle };

export function Circle(style: CircleStyle): ViewNode {
  return new ViewNode({
    kind: "circle",
    style: Object.freeze({
      ...style,
      radius: snapshotNumber(style.radius),
      trim:
        style.trim &&
        (Object.freeze(style.trim.map(snapshotNumber)) as CircleStyle["trim"]),
    }),
  });
}
export function Line(style: LineStyle): ViewNode {
  return new ViewNode({
    kind: "line",
    style: Object.freeze({
      ...style,
      from: Object.freeze([...style.from]) as LineStyle["from"],
      to: Object.freeze([...style.to]) as LineStyle["to"],
      progress: snapshotNumber(style.progress ?? 1),
    }),
  });
}
function polygon(points: readonly (readonly [number, number])[]): PathOutline {
  return points.length
    ? [
        ...points.map(([x, y], i) => [i ? "L" : "M", x, y] as PathCommand),
        ["Z"],
      ]
    : [];
}
/** Shapes share the existing GPU path painter; no additional render pipeline. */
export function shapeGeometry(spec: ShapeSpec, time: number) {
  if (spec.kind === "circle") {
    const s = spec.style;
    const r = resolveNumber(s.radius, time),
      width = s.strokeWidth ?? 0;
    const start = resolveNumber(s.trim?.[0] ?? 0, time),
      end = resolveNumber(s.trim?.[1] ?? 1, time);
    if (
      r < 0 ||
      !Number.isFinite(width) ||
      width < 0 ||
      start < 0 ||
      end > 1 ||
      end < start
    )
      throw Error(
        "Circle needs a non-negative radius/stroke and 0 <= trim start <= end <= 1.",
      );
    // shortcut: 96 arc segments, increase adaptively if measured close-ups expose faceting.
    const arc = (radius: number) =>
      Array.from({ length: 97 }, (_, i) => {
        const a =
          (start + ((end - start) * i) / 96) * Math.PI * 2 - Math.PI / 2;
        return [r + radius * Math.cos(a), r + radius * Math.sin(a)] as const;
      });
    const empty = r === 0 || start === end;
    return {
      width: r * 2,
      height: r * 2,
      fill: empty
        ? []
        : polygon(start === 0 && end === 1 ? arc(r) : [[r, r], ...arc(r)]),
      stroke:
        empty || width === 0
          ? []
          : polygon([...arc(r), ...arc(Math.max(0, r - width)).reverse()]),
    };
  }
  const s = spec.style,
    width = s.width ?? 4;
  const progress = resolveNumber(s.progress ?? 1, time);
  if (
    ![...s.from, ...s.to, width].every(Number.isFinite) ||
    width < 0 ||
    progress < 0 ||
    progress > 1
  )
    throw Error(
      "Line needs finite endpoints, non-negative width, and progress between 0 and 1.",
    );
  const minX = Math.min(s.from[0], s.to[0]) - width / 2;
  const minY = Math.min(s.from[1], s.to[1]) - width / 2;
  const [x, y] = [s.from[0] - minX, s.from[1] - minY];
  const dx = (s.to[0] - s.from[0]) * progress,
    dy = (s.to[1] - s.from[1]) * progress;
  const length = Math.hypot(dx, dy);
  const nx = length ? ((-dy / length) * width) / 2 : 0,
    ny = length ? ((dx / length) * width) / 2 : 0;
  return {
    width: Math.abs(s.to[0] - s.from[0]) + width,
    height: Math.abs(s.to[1] - s.from[1]) + width,
    fill:
      length && width
        ? polygon([
            [x + nx, y + ny],
            [x + dx + nx, y + dy + ny],
            [x + dx - nx, y + dy - ny],
            [x - nx, y - ny],
          ])
        : [],
    stroke: [],
  };
}
