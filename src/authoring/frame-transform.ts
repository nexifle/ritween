import type { Matrix2D, Point2D } from "./camera";

export interface FrameTransform {
  readonly scale: number;
  readonly ox: number;
  readonly oy: number;
  readonly matrix: Matrix2D;
}

/** Computes viewport scale, letterbox offsets, and the layout-to-target pixel matrix. */
export function computeFrameTransform(
  designSize: readonly [number, number],
  targetResolution: readonly [number, number],
  cameraMatrix?: Matrix2D | null,
): FrameTransform {
  const scale = Math.min(
    targetResolution[0] / designSize[0],
    targetResolution[1] / designSize[1],
  );
  const ox = (targetResolution[0] - designSize[0] * scale) / 2;
  const oy = (targetResolution[1] - designSize[1] * scale) / 2;
  const [ca, cb, cc, cd, ce, cf] = cameraMatrix ?? [1, 0, 0, 1, 0, 0];
  const matrix: Matrix2D = [
    ca * scale,
    cb * scale,
    cc * scale,
    cd * scale,
    ce * scale + ox,
    cf * scale + oy,
  ];
  return { scale, ox, oy, matrix };
}

/** Applies a 2D affine matrix (Canvas convention: [a, b, c, d, e, f]) to a point. */
export function transformPoint(matrix: Matrix2D, point: Point2D): Point2D {
  return [
    matrix[0] * point[0] + matrix[2] * point[1] + matrix[4],
    matrix[1] * point[0] + matrix[3] * point[1] + matrix[5],
  ];
}
