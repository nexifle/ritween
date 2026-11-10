import type { Matrix2D } from "./camera";
import type { Bounds, Transform } from "./layout";
import { identity, multiply } from "../engine/render/shared-elements";

export interface SurfacePlan {
  /** Pixel size of the child target: `ceil(bounds × scale)`, at least 1×1. */
  readonly width: number;
  readonly height: number;
  /** The child renders with the command bounds as its design size. */
  readonly childDesignSize: readonly [number, number];
  /** Shared-correction conjugation space, not a child-pixel-to-parent-target mapping. */
  readonly childSpace: readonly number[];
}

/** Pure surface allocation math extracted from `ViewRenderer.render`. */
export function planSurface(
  bounds: Bounds,
  transform: Transform,
  scale: number,
  worldToPixels: Matrix2D,
  parentSharedSpace?: readonly number[] | null,
): SurfacePlan {
  const width = Math.max(1, Math.ceil(bounds.width * scale)),
    height = Math.max(1, Math.ceil(bounds.height * scale));
  const [sx, sy, tx, ty] = transform;
  const childSpace = multiply(
    parentSharedSpace ?? identity,
    multiply(worldToPixels, [
      (bounds.width * sx) / width,
      0,
      0,
      (bounds.height * sy) / height,
      bounds.x * sx + tx,
      bounds.y * sy + ty,
    ]),
  );
  return {
    width,
    height,
    childDesignSize: [bounds.width, bounds.height],
    childSpace,
  };
}
