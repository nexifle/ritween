import { Box, ZStack, type ViewNode } from "./nodes";
import { Circle, Line } from "./shapes";
import { motion, snapshotNumber, type AnimatedNumber } from "./motion";

export interface ChartDatum {
  readonly id: string;
  readonly value: number;
  readonly color?: string;
}
export interface ScatterDatum {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly color?: string;
}
export interface ChartOptions {
  readonly width: number;
  readonly height: number;
  readonly progress?: AnimatedNumber;
  readonly color?: string;
}
export interface DonutOptions {
  readonly radius: number;
  readonly thickness: number;
  readonly progress?: AnimatedNumber;
  readonly color?: string;
}

function validateSize(width: number, height: number) {
  if (![width, height].every((v) => Number.isFinite(v) && v > 0))
    throw Error("Chart dimensions must be positive and finite.");
}
function validateData<T extends { readonly id: string }>(
  data: readonly T[],
  values: (item: T) => readonly number[],
) {
  const ids = new Set<string>();
  for (const item of data) {
    if (
      typeof item.id !== "string" ||
      !item.id ||
      ids.has(item.id) ||
      !values(item).every(Number.isFinite)
    )
      throw Error("Chart data needs unique IDs and finite values.");
    ids.add(item.id);
  }
}
function track(value: AnimatedNumber | undefined): AnimatedNumber {
  const progress = snapshotNumber(value ?? 1);
  const values =
    typeof progress === "number"
      ? [progress]
      : "keyframes" in progress
        ? progress.keyframes.map((frame) => frame.value)
        : [progress.from, progress.to];
  if (!values.every((n) => Number.isFinite(n) && n >= 0 && n <= 1))
    throw Error("Chart progress values must be between 0 and 1.");
  if (typeof progress !== "number") motion(progress, 0);
  return progress;
}
function mapped(
  value: AnimatedNumber,
  from: number,
  to: number,
): AnimatedNumber {
  const apply = (n: number) => from + (to - from) * n;
  if (typeof value === "number") return apply(value);
  if ("keyframes" in value)
    return {
      keyframes: value.keyframes.map((f) => ({ ...f, value: apply(f.value) })),
    };
  return { ...value, from: apply(value.from), to: apply(value.to) };
}
function canvas(children: readonly ViewNode[], width: number, height: number) {
  return ZStack(children, { align: "start" }).frame({
    width,
    height,
    align: "start",
  });
}
function domain(values: readonly number[]) {
  const min = Math.min(0, ...values),
    max = Math.max(0, ...values);
  if (min === max) return (value: number) => value;
  const scale = Math.max(Math.abs(min), Math.abs(max));
  const low = min / scale,
    range = max / scale - low;
  return (value: number) => (value / scale - low) / range;
}

/** Bars grow from the zero baseline, including negative values. */
export function BarChart(
  data: readonly ChartDatum[],
  options: ChartOptions,
): ViewNode {
  validateSize(options.width, options.height);
  validateData(data, (d) => [d.value]);
  const progress = track(options.progress),
    normalize = domain(data.map((d) => d.value));
  const baseline = (1 - normalize(0)) * options.height,
    slot = options.width / Math.max(1, data.length);
  return canvas(
    data.map((d, i) => {
      const height =
        Math.abs(normalize(d.value) - normalize(0)) * options.height;
      return Box({ width: slot * 0.8, height, fill: d.color ?? options.color })
        .scale(1, progress, [0, d.value < 0 ? 0 : 1])
        .offset(slot * (i + 0.1), d.value < 0 ? baseline : baseline - height)
        .id(d.id);
    }),
    options.width,
    options.height,
  );
}

/** Adjacent points draw in input order; progress reveals every segment. */
export function LineChart(
  data: readonly ChartDatum[],
  options: ChartOptions,
): ViewNode {
  validateSize(options.width, options.height);
  validateData(data, (d) => [d.value]);
  if (!Number.isFinite(Math.hypot(options.width, options.height)))
    throw Error("Chart geometry must be finite.");
  const progress = track(options.progress),
    normalize = domain(data.map((d) => d.value));
  const radius = Math.min(3, options.width / 2, options.height / 2),
    stroke = Math.min(2, radius * 2);
  const point = (d: ChartDatum, i: number): [number, number] => [
    data.length === 1
      ? options.width / 2
      : radius + (i / (data.length - 1)) * (options.width - radius * 2),
    radius + (1 - normalize(d.value)) * (options.height - radius * 2),
  ];
  const children: ViewNode[] = [];
  data.forEach((d, i) => {
    const [x, y] = point(d, i);
    if (i) {
      const [px, py] = point(data[i - 1], i - 1),
        left = Math.min(x, px) - stroke / 2,
        top = Math.min(y, py) - stroke / 2;
      children.push(
        Line({
          from: [px, py],
          to: [x, y],
          width: stroke,
          color: d.color ?? options.color,
          progress,
        })
          .offset(left, top)
          .id(`segment:${d.id}`),
      );
    }
    children.push(
      Circle({ radius, fill: d.color ?? options.color })
        .scale(progress)
        .offset(x - radius, y - radius)
        .id(`point:${d.id}`),
    );
  });
  return canvas(children, options.width, options.height);
}

/** Zero values are omitted; negative values are not meaningful donut slices. */
export function DonutChart(
  data: readonly ChartDatum[],
  options: DonutOptions,
): ViewNode {
  validateSize(options.radius, options.thickness);
  if (options.thickness > options.radius)
    throw Error("Donut thickness cannot exceed its radius.");
  validateData(data, (d) => [d.value]);
  if (data.some((d) => d.value < 0))
    throw Error("Donut values must be non-negative.");
  if (!Number.isFinite(options.radius * 2))
    throw Error("Chart geometry must be finite.");
  const largest = Math.max(0, ...data.map((d) => d.value));
  const total = data.reduce(
    (sum, d) => sum + (largest ? d.value / largest : 0),
    0,
  );
  const progress = track(options.progress);
  let start = 0;
  const children = data
    .filter((d) => d.value > 0)
    .map((d) => {
      const end = Math.min(1, start + d.value / largest / total),
        sliceStart = start;
      start = end;
      return Circle({
        radius: options.radius,
        stroke: d.color ?? options.color,
        strokeOnly: true,
        strokeWidth: options.thickness,
        trim: [sliceStart, mapped(progress, sliceStart, end)],
      }).id(d.id);
    });
  return canvas(children, options.radius * 2, options.radius * 2);
}

export function ScatterChart(
  data: readonly ScatterDatum[],
  options: ChartOptions,
): ViewNode {
  validateSize(options.width, options.height);
  validateData(data, (d) => [d.x, d.y]);
  const progress = track(options.progress),
    normalizeX = domain(data.map((d) => d.x)),
    normalizeY = domain(data.map((d) => d.y)),
    radius = Math.min(4, options.width / 2, options.height / 2);
  return canvas(
    data.map((d) =>
      Circle({ radius, fill: d.color ?? options.color })
        .scale(progress)
        .offset(
          normalizeX(d.x) * (options.width - radius * 2),
          (1 - normalizeY(d.y)) * (options.height - radius * 2),
        )
        .id(d.id),
    ),
    options.width,
    options.height,
  );
}
