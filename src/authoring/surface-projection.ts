import type { ClipShape } from "./clip";
import { multiply } from "../engine/render/shared-elements";
import { checkVertexFloat32 } from "./vertex-float32";

/** Clip mask family taken from the clip spec, not from the emitted mask outline. */
export type ClipSurfaceShape = "rect" | "rounded" | "circle" | "path" | "image";

/** Inspection-only identity of one tagged surface. Absent on Composition, World, and Overlay. */
export type InspectionSurface =
  | { readonly kind: "clip"; readonly shape: ClipSurfaceShape }
  | { readonly kind: "group" };

/** Affine matrix in Canvas order `[a, b, c, d, e, f]`. */
export type Matrix6 = readonly [number, number, number, number, number, number];

/**
 * Float32 fields copied out of the uniform block after `values.set`. Not a view of that block.
 * Shared correction is already inside the camera rows; this is not `childSpace`.
 */
export interface CopiedSurfaceUniform {
  readonly rect: readonly [number, number, number, number];
  readonly transform: readonly [number, number, number, number];
  readonly resolution: readonly [number, number];
  readonly opacity: number;
  readonly cameraX: readonly [number, number, number];
  readonly cameraY: readonly [number, number, number];
}

/**
 * Ideal mapping of one drawn Clip. `mapped` is binary64 over the copied float32 uniforms,
 * not GPU rounding or fragment coverage. `unavailable` carries no nonfinite matrix.
 */
export type SurfaceMapping =
  | {
      readonly status: "mapped";
      /** Child target pixels → the target this Clip quad was drawn into. */
      readonly childPixelsToParent: Matrix6;
      /** That parent target → scene target pixels. Identity when the parent is the scene. */
      readonly parentToScene: Matrix6;
      /** `parentToScene × childPixelsToParent`. */
      readonly childPixelsToScene: Matrix6;
    }
  | { readonly status: "unavailable"; readonly reason: string };

/**
 * One drawn Clip or Group occurrence for a single render. Keyed by the evaluation occurrence,
 * never by semantic id. Discarded with the render; not serialized and not a paint record.
 */
export interface SurfaceTrace {
  readonly occurrenceId: number;
  readonly ownerNodeId: number;
  readonly path: string;
  readonly surface: InspectionSurface;
  readonly childResolution: readonly [number, number];
  readonly parentResolution: readonly [number, number];
  readonly uniform: CopiedSurfaceUniform;
  readonly projection: SurfaceMapping;
  /** Parent tagged surface occurrence, when this surface was drawn into one. */
  readonly parentOccurrenceId?: number;
}

/** A tagged surface drawn into Composition, World, or Overlay has no scene chain. */
export const NON_CLIP_PARENT_REASON =
  "parent surface is not a tagged clip or group; scene mapping is unavailable.";

export const EMPTY_SURFACE_TRACES: readonly SurfaceTrace[] = Object.freeze([]);

const IDENTITY: Matrix6 = [1, 0, 0, 1, 0, 0];

export function clipInspectionSurface(shape: ClipShape): InspectionSurface {
  return {
    kind: "clip",
    shape:
      shape.shape === "rect"
        ? (shape.radius ?? 0) > 0
          ? "rounded"
          : "rect"
        : shape.shape,
  };
}

export function groupInspectionSurface(): InspectionSurface {
  return { kind: "group" };
}

export function copySurfaceUniform(
  values: Float32Array,
  offset: number,
): CopiedSurfaceUniform {
  const at = (index: number) => values[offset + index];
  return {
    rect: [at(0), at(1), at(2), at(3)],
    transform: [at(4), at(5), at(6), at(7)],
    resolution: [at(8), at(9)],
    opacity: at(20),
    cameraX: [at(24), at(25), at(26)],
    cameraY: [at(28), at(29), at(30)],
  };
}

function finiteMatrix(
  matrix: readonly number[],
  label: string,
):
  | { readonly status: "mapped"; readonly matrix: Matrix6 }
  | {
      readonly status: "unavailable";
      readonly reason: string;
    } {
  const bad = matrix.findIndex((value) => !Number.isFinite(value));
  if (bad >= 0)
    return {
      status: "unavailable",
      reason: `${label} is not finite at index ${bad}.`,
    };
  return {
    status: "mapped",
    matrix: [matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]],
  };
}

/**
 * `camera × commandTransform × translate(rect) × scale(rect / child allocation)`.
 * Does not invert. A zero scale stays a finite degenerate mapping.
 */
export function childPixelsToParent(
  uniform: CopiedSurfaceUniform,
  childWidth: number,
  childHeight: number,
):
  | { readonly status: "mapped"; readonly matrix: Matrix6 }
  | { readonly status: "unavailable"; readonly reason: string } {
  const fields: readonly (readonly [string, number])[] = [
    ["rect x", uniform.rect[0]],
    ["rect y", uniform.rect[1]],
    ["rect width", uniform.rect[2]],
    ["rect height", uniform.rect[3]],
    ["transform scale x", uniform.transform[0]],
    ["transform scale y", uniform.transform[1]],
    ["transform translate x", uniform.transform[2]],
    ["transform translate y", uniform.transform[3]],
    ["resolution x", uniform.resolution[0]],
    ["resolution y", uniform.resolution[1]],
    ["opacity", uniform.opacity],
    ["camera X x", uniform.cameraX[0]],
    ["camera X y", uniform.cameraX[1]],
    ["camera X constant", uniform.cameraX[2]],
    ["camera Y x", uniform.cameraY[0]],
    ["camera Y y", uniform.cameraY[1]],
    ["camera Y constant", uniform.cameraY[2]],
    ["child width", childWidth],
    ["child height", childHeight],
  ];
  const missing = fields
    .filter(([, value]) => !Number.isFinite(value))
    .map(([name]) => name);
  if (missing.length)
    return {
      status: "unavailable",
      reason: `surface mapping is not finite: ${missing.join(", ")}.`,
    };
  if (!(childWidth > 0) || !(childHeight > 0))
    return {
      status: "unavailable",
      reason: `surface mapping is not finite: child resolution ${childWidth}x${childHeight} is not positive.`,
    };
  // Same uploaded fields and staged guard as a leaf quad. A finite binary64 matrix is not enough.
  try {
    checkVertexFloat32(
      uniform.rect,
      uniform.transform,
      uniform.cameraX,
      uniform.cameraY,
    );
  } catch (error) {
    return {
      status: "unavailable",
      reason: `surface mapping overflows float32 vertex stages: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const scaleX = uniform.rect[2] / childWidth;
  const scaleY = uniform.rect[3] / childHeight;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY))
    return {
      status: "unavailable",
      reason: "surface mapping is not finite: allocation scale.",
    };
  const camera: Matrix6 = [
    uniform.cameraX[0],
    uniform.cameraY[0],
    uniform.cameraX[1],
    uniform.cameraY[1],
    uniform.cameraX[2],
    uniform.cameraY[2],
  ];
  const command: Matrix6 = [
    uniform.transform[0],
    0,
    0,
    uniform.transform[1],
    uniform.transform[2],
    uniform.transform[3],
  ];
  return finiteMatrix(
    multiply(
      camera,
      multiply(
        command,
        multiply(
          [1, 0, 0, 1, uniform.rect[0], uniform.rect[1]],
          [scaleX, 0, 0, scaleY, 0, 0],
        ),
      ),
    ),
    "surface mapping",
  );
}

/** `parentToScene × childPixelsToParent`. Does not invert. */
export function composeParentToScene(
  parentToScene: Matrix6,
  childPixelsToParent: Matrix6,
):
  | { readonly status: "mapped"; readonly matrix: Matrix6 }
  | { readonly status: "unavailable"; readonly reason: string } {
  const parent = finiteMatrix(parentToScene, "parent-to-scene mapping");
  if (parent.status === "unavailable") return parent;
  const child = finiteMatrix(
    childPixelsToParent,
    "child-pixels-to-parent mapping",
  );
  if (child.status === "unavailable") return child;
  return finiteMatrix(
    multiply(parent.matrix, child.matrix),
    "child-pixels-to-scene mapping",
  );
}

interface PendingSurface {
  readonly occurrenceId: number;
  readonly ownerNodeId: number;
  readonly path: string;
  readonly surface: InspectionSurface;
  readonly childResolution: readonly [number, number];
  readonly parentResolution: readonly [number, number];
  readonly uniform: CopiedSurfaceUniform;
  readonly nested: PendingSurface[];
  readonly paints: CapturedPaint[];
  readonly childScissor?: PixelRect;
  readonly sceneBlocked?: string;
}

interface OpenSurface {
  readonly occurrenceId: number;
  readonly ownerNodeId: number;
  readonly path: string;
  readonly surface: InspectionSurface;
  readonly childResolution: readonly [number, number];
  readonly nested: PendingSurface[];
  readonly paints: CapturedPaint[];
  childScissor?: PixelRect;
}

/**
 * Tagged Clip and Group traces for one render. Children are accepted before the parent
 * uniform exists; `finish` runs only after that uniform has been copied.
 */
export class SurfaceProjectionTraces {
  readonly roots: PendingSurface[] = [];
  readonly blocked: PendingSurface[] = [];
  private readonly opens = new Map<number, OpenSurface>();

  open(
    occurrenceId: number,
    ownerNodeId: number,
    path: string,
    surface: InspectionSurface,
    childResolution: readonly [number, number],
  ): { readonly nested: PendingSurface[]; readonly paints: CapturedPaint[] } {
    const nested: PendingSurface[] = [];
    const paints: CapturedPaint[] = [];
    this.opens.set(occurrenceId, {
      occurrenceId,
      ownerNodeId,
      path,
      surface,
      childResolution: [childResolution[0], childResolution[1]],
      nested,
      paints,
    });
    return { nested, paints };
  }

  /** Child render records the scissor it is about to set, before the parent uniform exists. */
  noteChildScissor(occurrenceId: number, scissor: PixelRect) {
    const open = this.opens.get(occurrenceId);
    if (!open) return;
    open.childScissor = {
      x: scissor.x,
      y: scissor.y,
      width: scissor.width,
      height: scissor.height,
    };
  }

  close(
    occurrenceId: number,
    uniform: CopiedSurfaceUniform,
    sceneBlocked?: string,
  ): PendingSurface | undefined {
    const open = this.opens.get(occurrenceId);
    if (!open) return undefined;
    this.opens.delete(occurrenceId);
    return {
      occurrenceId: open.occurrenceId,
      ownerNodeId: open.ownerNodeId,
      path: open.path,
      surface: open.surface,
      childResolution: open.childResolution,
      parentResolution: [uniform.resolution[0], uniform.resolution[1]],
      uniform,
      nested: open.nested,
      paints: open.paints,
      ...(open.childScissor ? { childScissor: open.childScissor } : {}),
      ...(sceneBlocked ? { sceneBlocked } : {}),
    };
  }

  finish(): readonly SurfaceTrace[] {
    if (this.roots.length === 0 && this.blocked.length === 0)
      return EMPTY_SURFACE_TRACES;
    const traces: SurfaceTrace[] = [];
    for (const clip of this.roots)
      emit(clip, IDENTITY, undefined, undefined, traces);
    for (const clip of this.blocked)
      emit(clip, undefined, undefined, clip.sceneBlocked, traces);
    return traces;
  }
}

/** Integer scissor the renderer actually set, in that target's pixel space. */
export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One render target's pixel bounds plus the scissor that render set. */
export interface TargetWindow {
  readonly resolution: readonly [number, number];
  readonly scissor: PixelRect;
}

export type Point2 = readonly [number, number];

/** Leaf or unsupported draw accepted before the covering clip uniform exists. */
export type CapturedPaint =
  | {
      readonly kind: "leaf";
      readonly commandKind: "box" | "text" | "media";
      readonly path: string;
      readonly inspection?: {
        readonly id: number;
        readonly nodeId: number;
        readonly role: "content" | "background" | "surface";
      };
      readonly paintRole: "content" | "background";
      readonly provenance:
        | "projected-box-draw-quad"
        | "projected-text-draw-quad"
        | "projected-image-draw-quad"
        | "projected-video-draw-quad";
      readonly opacity: number;
      readonly corners?: readonly [Point2, Point2, Point2, Point2];
      readonly failure?: string;
    }
  | {
      readonly kind: "boundary";
      readonly commandKind: string;
      readonly path: string;
      readonly inspection?: {
        readonly id: number;
        readonly nodeId: number;
        readonly role: "content" | "background" | "surface";
      };
      readonly paintRole: "content" | "background";
      readonly unsupported: string;
    }
  | { readonly kind: "nested"; readonly occurrenceId: number };

export interface SurfaceTracePass {
  readonly book: SurfaceProjectionTraces;
  readonly sink: PendingSurface[];
  /** Present only for a tagged child render that is collecting paint. */
  readonly paints?: CapturedPaint[];
  readonly occurrenceId?: number;
  readonly blocked?: string;
}

function copyMatrix(matrix: Matrix6): Matrix6 {
  return [matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]];
}

function emit(
  surface: PendingSurface,
  parentToScene: Matrix6 | undefined,
  parentOccurrenceId: number | undefined,
  blocked: string | undefined,
  traces: SurfaceTrace[],
) {
  const local = childPixelsToParent(
    surface.uniform,
    surface.childResolution[0],
    surface.childResolution[1],
  );
  const reason = blocked ?? surface.sceneBlocked;
  let projection: SurfaceMapping;
  if (local.status === "unavailable") projection = local;
  else if (reason) projection = { status: "unavailable", reason };
  else if (!parentToScene)
    projection = {
      status: "unavailable",
      reason: "parent mapping is unavailable.",
    };
  else {
    const scene = composeParentToScene(parentToScene, local.matrix);
    projection =
      scene.status === "unavailable"
        ? scene
        : {
            status: "mapped",
            childPixelsToParent: local.matrix,
            parentToScene: copyMatrix(parentToScene),
            childPixelsToScene: scene.matrix,
          };
  }
  traces.push({
    occurrenceId: surface.occurrenceId,
    ownerNodeId: surface.ownerNodeId,
    path: surface.path,
    surface: surface.surface,
    childResolution: surface.childResolution,
    parentResolution: surface.parentResolution,
    uniform: surface.uniform,
    projection,
    ...(parentOccurrenceId !== undefined ? { parentOccurrenceId } : {}),
  });
  const nextBlocked =
    reason ??
    (projection.status === "unavailable" ? projection.reason : undefined);
  const nextParent =
    projection.status === "mapped" ? projection.childPixelsToScene : undefined;
  for (const child of surface.nested)
    emit(child, nextParent, surface.occurrenceId, nextBlocked, traces);
}

export interface SurfaceLevel {
  readonly occurrenceId: number;
  /** Group adds no mask shape. A clip shape names the outer quad, not fragment coverage. */
  readonly surface: InspectionSurface;
  readonly opacity: number;
  readonly matrix: Matrix6;
  /** Child target this level's polygon is clipped in, before `matrix`. */
  readonly child: TargetWindow;
}

export type RectClipProjection =
  | {
      readonly status: "bounds";
      readonly bounds: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      };
      readonly geometryVisible: boolean;
      /** Leaf and every clip matrix stay axis-aligned in root, and the result is a rectangle. */
      readonly axisAligned: boolean;
    }
  | { readonly status: "unavailable"; readonly reason: string };

function finitePoint(
  x: number,
  y: number,
): { readonly status: "ok"; readonly point: Point2 } | { readonly status: "unavailable"; readonly reason: string } {
  if (!Number.isFinite(x) || !Number.isFinite(y))
    return {
      status: "unavailable",
      reason: "clip paint projection is not finite.",
    };
  return { status: "ok", point: [x, y] };
}

function applyPoint(
  matrix: Matrix6,
  point: Point2,
): { readonly status: "ok"; readonly point: Point2 } | { readonly status: "unavailable"; readonly reason: string } {
  return finitePoint(
    matrix[0] * point[0] + matrix[2] * point[1] + matrix[4],
    matrix[1] * point[0] + matrix[3] * point[1] + matrix[5],
  );
}

/** `b === 0 && c === 0`, or a quarter-turn `a === 0 && d === 0`. Shear is neither. */
export function axisAlignedMatrix(matrix: Matrix6): boolean {
  const [a, b, c, d] = matrix;
  return (b === 0 && c === 0) || (a === 0 && d === 0);
}

function axisAlignedPolygon(points: readonly Point2[]): boolean {
  if (points.length <= 2) return true;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (a[0] !== b[0] && a[1] !== b[1]) return false;
  }
  return true;
}

function polygonArea(points: readonly Point2[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const cross = a[0] * b[1] - b[0] * a[1];
    if (!Number.isFinite(cross)) return Number.NaN;
    sum += cross;
  }
  return Math.abs(sum) / 2;
}

function intersectRects(scissor: PixelRect, bounds: PixelRect): PixelRect {
  const x = Math.max(scissor.x, bounds.x);
  const y = Math.max(scissor.y, bounds.y);
  const right = Math.min(scissor.x + scissor.width, bounds.x + bounds.width);
  const bottom = Math.min(scissor.y + scissor.height, bounds.y + bounds.height);
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  };
}

function clampPoint(point: Point2, rect: PixelRect): Point2 {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  return [
    Math.min(Math.max(point[0], rect.x), right),
    Math.min(Math.max(point[1], rect.y), bottom),
  ];
}

function intersectVertical(
  a: Point2,
  b: Point2,
  x: number,
): Point2 | undefined {
  const dx = b[0] - a[0];
  if (dx === 0) return undefined;
  const t = (x - a[0]) / dx;
  return finitePoint(x, a[1] + t * (b[1] - a[1])).status === "ok"
    ? [x, a[1] + t * (b[1] - a[1])]
    : undefined;
}

function intersectHorizontal(
  a: Point2,
  b: Point2,
  y: number,
): Point2 | undefined {
  const dy = b[1] - a[1];
  if (dy === 0) return undefined;
  const t = (y - a[1]) / dy;
  const x = a[0] + t * (b[0] - a[0]);
  return Number.isFinite(x) ? [x, y] : undefined;
}

function clipEdge(
  points: readonly Point2[],
  inside: (point: Point2) => boolean,
  cross: (a: Point2, b: Point2) => Point2 | undefined,
): Point2[] | undefined {
  if (points.length === 0) return [];
  const out: Point2[] = [];
  let previous = points[points.length - 1];
  let previousIn = inside(previous);
  for (const point of points) {
    const pointIn = inside(point);
    if (pointIn !== previousIn) {
      const hit = cross(previous, point);
      if (!hit) return undefined;
      out.push(hit);
    }
    if (pointIn) out.push(point);
    previous = point;
    previousIn = pointIn;
  }
  return out;
}

/** Sutherland–Hodgman against an axis-aligned pixel rect. Empty means no overlap. */
function clipPolygon(
  points: readonly Point2[],
  rect: PixelRect,
): Point2[] | undefined {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  let poly = points.slice();
  const edges: readonly [
    (point: Point2) => boolean,
    (a: Point2, b: Point2) => Point2 | undefined,
  ][] = [
    [(point) => point[0] >= rect.x, (a, b) => intersectVertical(a, b, rect.x)],
    [(point) => point[0] <= right, (a, b) => intersectVertical(a, b, right)],
    [(point) => point[1] >= rect.y, (a, b) => intersectHorizontal(a, b, rect.y)],
    [(point) => point[1] <= bottom, (a, b) => intersectHorizontal(a, b, bottom)],
  ];
  for (const [inside, cross] of edges) {
    const next = clipEdge(poly, inside, cross);
    if (!next) return undefined;
    poly = next;
  }
  return poly;
}

function windowRect(window: TargetWindow): PixelRect {
  return intersectRects(window.scissor, {
    x: 0,
    y: 0,
    width: window.resolution[0],
    height: window.resolution[1],
  });
}

function zeroBounds(
  point: Point2,
): RectClipProjection {
  if (!Number.isFinite(point[0]) || !Number.isFinite(point[1]))
    return {
      status: "unavailable",
      reason: "clip paint projection is not finite.",
    };
  return {
    status: "bounds",
    bounds: { x: point[0], y: point[1], width: 0, height: 0 },
    geometryVisible: false,
    axisAligned: true,
  };
}

function notFinite(reason: string): RectClipProjection {
  return { status: "unavailable", reason };
}

/** Map an eliminated point through the clips not yet applied, clamping at each later window. */
function emptyCoverage(
  seed: Point2,
  rect: PixelRect,
  rest: readonly SurfaceLevel[],
  root: TargetWindow,
  axisAligned: boolean,
): RectClipProjection {
  let point = clampPoint(seed, rect);
  if (!Number.isFinite(point[0]) || !Number.isFinite(point[1]))
    return notFinite("clip paint projection is not finite: empty coverage.");
  for (let index = 0; index < rest.length; index++) {
    const mapped = applyPoint(rest[index].matrix, point);
    if (mapped.status === "unavailable") return mapped;
    const next =
      index + 1 < rest.length
        ? windowRect(rest[index + 1].child)
        : windowRect(root);
    if (![next.x, next.y, next.width, next.height].every(Number.isFinite))
      return notFinite("clip paint projection is not finite: empty coverage.");
    point = clampPoint(mapped.point, next);
  }
  if (rest.length === 0) point = clampPoint(point, windowRect(root));
  const zero = zeroBounds(point);
  const aligned =
    axisAligned && rest.every((level) => axisAlignedMatrix(level.matrix));
  return zero.status === "bounds" ? { ...zero, axisAligned: aligned } : zero;
}

/**
 * Clip the leaf quad at each child target, then map by that clip's `childPixelsToParent`.
 * Shared correction is already in those matrices. AABB is taken only after the root clip.
 */
export function projectRectClipChain(
  corners: readonly [Point2, Point2, Point2, Point2],
  leafOpacity: number,
  chain: readonly SurfaceLevel[],
  root: TargetWindow,
): RectClipProjection {
  if (!Number.isFinite(leafOpacity))
    return notFinite("clip paint projection is not finite: leaf opacity.");
  if (
    !chain.length ||
    !root.resolution.every((value) => Number.isFinite(value) && value > 0)
  )
    return notFinite("clip paint projection is not finite: root resolution.");
  let polygon: Point2[] = [corners[0], corners[1], corners[2], corners[3]];
  let axisAligned = axisAlignedPolygon(polygon);
  for (let index = 0; index < chain.length; index++) {
    const level = chain[index];
    if (!axisAlignedMatrix(level.matrix)) axisAligned = false;
    const rect = windowRect(level.child);
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite))
      return notFinite("clip paint projection is not finite: child scissor.");
    const seed = polygon[0];
    const clipped =
      rect.width > 0 && rect.height > 0 ? clipPolygon(polygon, rect) : [];
    if (!clipped)
      return notFinite("clip paint projection is not finite: polygon clip.");
    if (!seed || clipped.length === 0)
      return seed
        ? emptyCoverage(seed, rect, chain.slice(index), root, axisAligned)
        : notFinite("clip paint projection is not finite: empty coverage.");
    const mapped: Point2[] = [];
    for (const point of clipped) {
      const next = applyPoint(level.matrix, point);
      if (next.status === "unavailable") return next;
      mapped.push(next.point);
    }
    polygon = mapped;
  }
  const rootRect = windowRect(root);
  if (![rootRect.x, rootRect.y, rootRect.width, rootRect.height].every(Number.isFinite))
    return notFinite("clip paint projection is not finite: root scissor.");
  const seed = polygon[0];
  const clipped =
    rootRect.width > 0 && rootRect.height > 0
      ? clipPolygon(polygon, rootRect)
      : [];
  if (!clipped)
    return notFinite("clip paint projection is not finite: polygon clip.");
  if (!seed || clipped.length === 0)
    return seed
      ? emptyCoverage(seed, rootRect, [], root, axisAligned)
      : notFinite("clip paint projection is not finite: empty coverage.");
  if (!axisAlignedPolygon(clipped)) axisAligned = false;
  const xs = clipped.map((point) => point[0]);
  const ys = clipped.map((point) => point[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = maxX - minX;
  const height = maxY - minY;
  if (![minX, minY, width, height].every(Number.isFinite))
    return notFinite("clip paint projection is not finite: projected bounds.");
  const area = polygonArea(clipped);
  if (!Number.isFinite(area))
    return notFinite("clip paint projection is not finite: polygon area.");
  const opacityVisible =
    leafOpacity !== 0 && chain.every((level) => level.opacity !== 0);
  return {
    status: "bounds",
    bounds: { x: minX, y: minY, width, height },
    geometryVisible: area > 0 && opacityVisible,
    axisAligned,
  };
}
