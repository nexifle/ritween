import { resolveNumber, snapshotNumber, type AnimatedNumber } from "./motion";
import type { Bounds } from "./layout";

export type Point2D = readonly [number, number];
/** Canvas-compatible affine matrix: x'=a*x+c*y+e, y'=b*x+d*y+f. */
export type Matrix2D = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
];
export interface CameraOptions {
  /** World point mapped to the viewport anchor. Defaults to the design center. */
  readonly x?: AnimatedNumber;
  readonly y?: AnimatedNumber;
  /** Positive magnification. 1 means one design unit per viewport unit. */
  readonly zoom?: AnimatedNumber;
  /** Camera roll in radians, clockwise in Y-down world coordinates. */
  readonly rotation?: AnimatedNumber;
  /** Normalized viewport point. Defaults to center; may lie outside [0, 1]. */
  readonly anchor?: readonly [AnimatedNumber, AnimatedNumber];
}
export interface CameraPose {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
  readonly rotation: number;
  readonly anchor: Point2D;
}
export interface CameraState {
  readonly position: Point2D;
  readonly zoom: number;
  readonly rotation: number;
  readonly anchor: Point2D;
  /** World → design viewport, before output scaling/letterboxing. */
  readonly matrix: Matrix2D;
  readonly inverse: Matrix2D;
}

/** Immutable description; no integrated velocity, hidden clock, or GPU ownership. */
export function Camera(options: CameraOptions = {}): CameraOptions {
  if (options.anchor && options.anchor.length !== 2)
    throw Error("Camera anchor needs two components.");
  return Object.freeze({
    x: options.x === undefined ? undefined : snapshotNumber(options.x),
    y: options.y === undefined ? undefined : snapshotNumber(options.y),
    zoom: options.zoom === undefined ? undefined : snapshotNumber(options.zoom),
    rotation:
      options.rotation === undefined
        ? undefined
        : snapshotNumber(options.rotation),
    anchor: options.anchor
      ? (Object.freeze(options.anchor.map(snapshotNumber)) as readonly [
          AnimatedNumber,
          AnimatedNumber,
        ])
      : undefined,
  });
}
export function evaluateCamera(
  options: CameraOptions,
  time: number,
  size: Point2D,
): CameraState {
  if (
    !Number.isFinite(time) ||
    size.length !== 2 ||
    !size.every((v) => Number.isFinite(v) && v > 0)
  )
    throw Error("Camera needs finite time and positive design dimensions.");
  if (options.anchor && options.anchor.length !== 2)
    throw Error("Camera anchor needs two components.");
  const x = resolveNumber(options.x ?? size[0] / 2, time);
  const y = resolveNumber(options.y ?? size[1] / 2, time);
  const zoom = resolveNumber(options.zoom ?? 1, time);
  const rotation = resolveNumber(options.rotation ?? 0, time);
  const ax = resolveNumber(options.anchor?.[0] ?? 0.5, time);
  const ay = resolveNumber(options.anchor?.[1] ?? 0.5, time);
  if (zoom <= 0) throw Error("Camera zoom must be positive.");
  // Moving/rotating the camera applies the inverse pose to the world.
  const c = Math.cos(rotation),
    s = Math.sin(rotation);
  const a = zoom * c,
    b = -zoom * s,
    cc = zoom * s,
    d = zoom * c;
  const e = ax * size[0] - a * x - cc * y;
  const f = ay * size[1] - b * x - d * y;
  const matrix: Matrix2D = [a, b, cc, d, e, f];
  const inverse: Matrix2D = [
    c / zoom,
    s / zoom,
    -s / zoom,
    c / zoom,
    x - (c * ax * size[0] - s * ay * size[1]) / zoom,
    y - (s * ax * size[0] + c * ay * size[1]) / zoom,
  ];
  if (![...matrix, ...inverse].every(Number.isFinite))
    throw Error("Camera transform exceeds finite numeric range.");
  return Object.freeze({
    position: Object.freeze([x, y]) as Point2D,
    zoom,
    rotation,
    anchor: Object.freeze([ax, ay]) as Point2D,
    matrix: Object.freeze(matrix),
    inverse: Object.freeze(inverse),
  });
}
function apply(matrix: Matrix2D, point: Point2D): Point2D {
  if (point.length !== 2 || !point.every(Number.isFinite))
    throw Error("Camera point must be finite.");
  const [a, b, c, d, e, f] = matrix;
  return [a * point[0] + c * point[1] + e, b * point[0] + d * point[1] + f];
}
export function worldToView(camera: CameraState, point: Point2D): Point2D {
  return apply(camera.matrix, point);
}
export function viewToWorld(camera: CameraState, point: Point2D): Point2D {
  return apply(camera.inverse, point);
}
/** Frame a world-space rectangle, allowing viewport padding and camera roll. */
export function fitCamera(
  bounds: Bounds,
  size: Point2D,
  options: { padding?: number; rotation?: number } = {},
): CameraPose {
  const { padding = 0, rotation = 0 } = options;
  if (
    ![
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      ...size,
      padding,
      rotation,
    ].every(Number.isFinite) ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    padding < 0 ||
    size.some((v) => v <= padding * 2)
  )
    throw Error(
      "Camera fit needs positive bounds and viewport space after padding.",
    );
  const c = Math.abs(Math.cos(rotation)),
    s = Math.abs(Math.sin(rotation));
  const width = bounds.width * c + bounds.height * s,
    height = bounds.width * s + bounds.height * c;
  const pose = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
    zoom: Math.min(
      (size[0] - padding * 2) / width,
      (size[1] - padding * 2) / height,
    ),
    rotation,
    anchor: Object.freeze([0.5, 0.5]) as Point2D,
  };
  evaluateCamera(pose, 0, size);
  return Object.freeze(pose);
}
