import type { ClipShape } from "./clip";
import { multiply } from "../engine/render/shared-elements";

/** Clip mask family taken from the clip spec, not from the emitted mask outline. */
export type ClipSurfaceShape = "rect" | "rounded" | "circle" | "path" | "image";

/** Inspection-only identity of one Clip command. Absent on Group and Composition. */
export interface InspectionSurface {
  readonly kind: "clip";
  readonly shape: ClipSurfaceShape;
}

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
 * One drawn Clip occurrence for a single render. Keyed by the evaluation occurrence, never by
 * semantic id. Discarded with the render; not serialized and not a paint record.
 */
export interface SurfaceTrace {
  readonly occurrenceId: number;
  readonly ownerNodeId: number;
  readonly path: string;
  readonly shape: ClipSurfaceShape;
  readonly childResolution: readonly [number, number];
  readonly parentResolution: readonly [number, number];
  readonly uniform: CopiedSurfaceUniform;
  readonly projection: SurfaceMapping;
  /** Parent Clip occurrence, when this Clip was drawn into one. */
  readonly parentOccurrenceId?: number;
}

/** A Clip drawn into Group or Composition has no scene chain in this unit. */
export const NON_CLIP_PARENT_REASON =
  "parent surface is not a clip; scene mapping is unavailable.";

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
      reason: `clip surface mapping is not finite: ${missing.join(", ")}.`,
    };
  if (!(childWidth > 0) || !(childHeight > 0))
    return {
      status: "unavailable",
      reason: `clip surface mapping is not finite: child resolution ${childWidth}x${childHeight} is not positive.`,
    };
  const scaleX = uniform.rect[2] / childWidth;
  const scaleY = uniform.rect[3] / childHeight;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY))
    return {
      status: "unavailable",
      reason: "clip surface mapping is not finite: allocation scale.",
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
    "clip surface mapping",
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

interface PendingClip {
  readonly occurrenceId: number;
  readonly ownerNodeId: number;
  readonly path: string;
  readonly shape: ClipSurfaceShape;
  readonly childResolution: readonly [number, number];
  readonly parentResolution: readonly [number, number];
  readonly uniform: CopiedSurfaceUniform;
  readonly nested: PendingClip[];
  readonly sceneBlocked?: string;
}

interface OpenClip {
  readonly occurrenceId: number;
  readonly ownerNodeId: number;
  readonly path: string;
  readonly shape: ClipSurfaceShape;
  readonly childResolution: readonly [number, number];
  readonly nested: PendingClip[];
}

/**
 * Clip traces for one render. Children are accepted before the parent uniform exists;
 * `finish` runs only after that uniform has been copied.
 */
export class ClipSurfaceTraces {
  readonly roots: PendingClip[] = [];
  readonly blocked: PendingClip[] = [];
  private readonly opens = new Map<number, OpenClip>();

  open(
    occurrenceId: number,
    ownerNodeId: number,
    path: string,
    shape: ClipSurfaceShape,
    childResolution: readonly [number, number],
  ): PendingClip[] {
    const nested: PendingClip[] = [];
    this.opens.set(occurrenceId, {
      occurrenceId,
      ownerNodeId,
      path,
      shape,
      childResolution: [childResolution[0], childResolution[1]],
      nested,
    });
    return nested;
  }

  close(
    occurrenceId: number,
    uniform: CopiedSurfaceUniform,
    sceneBlocked?: string,
  ): PendingClip | undefined {
    const open = this.opens.get(occurrenceId);
    if (!open) return undefined;
    this.opens.delete(occurrenceId);
    return {
      occurrenceId: open.occurrenceId,
      ownerNodeId: open.ownerNodeId,
      path: open.path,
      shape: open.shape,
      childResolution: open.childResolution,
      parentResolution: [uniform.resolution[0], uniform.resolution[1]],
      uniform,
      nested: open.nested,
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

export interface ClipTracePass {
  readonly book: ClipSurfaceTraces;
  readonly sink: PendingClip[];
  readonly blocked?: string;
}

function copyMatrix(matrix: Matrix6): Matrix6 {
  return [matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]];
}

function emit(
  clip: PendingClip,
  parentToScene: Matrix6 | undefined,
  parentOccurrenceId: number | undefined,
  blocked: string | undefined,
  traces: SurfaceTrace[],
) {
  const local = childPixelsToParent(
    clip.uniform,
    clip.childResolution[0],
    clip.childResolution[1],
  );
  const reason = blocked ?? clip.sceneBlocked;
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
    occurrenceId: clip.occurrenceId,
    ownerNodeId: clip.ownerNodeId,
    path: clip.path,
    shape: clip.shape,
    childResolution: clip.childResolution,
    parentResolution: clip.parentResolution,
    uniform: clip.uniform,
    projection,
    ...(parentOccurrenceId !== undefined ? { parentOccurrenceId } : {}),
  });
  const nextBlocked =
    reason ??
    (projection.status === "unavailable" ? projection.reason : undefined);
  const nextParent =
    projection.status === "mapped" ? projection.childPixelsToScene : undefined;
  for (const child of clip.nested)
    emit(child, nextParent, clip.occurrenceId, nextBlocked, traces);
}
