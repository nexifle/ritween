import type { SharedElement } from "../engine/types";
import {
  identity,
  multiply,
  type Affine,
} from "../engine/render/shared-elements";
import type { EvaluatedFrame } from "./layout";

/** Same viewport and camera mapping used by ViewRenderer, including nested overlays. */
export function collectSharedElements(
  frame: EvaluatedFrame,
  size: readonly [number, number],
  resolution: readonly [number, number],
  parent: Affine = identity,
): SharedElement[] {
  const scale = Math.min(resolution[0] / size[0], resolution[1] / size[1]);
  const viewport = [
    scale,
    0,
    0,
    scale,
    (resolution[0] - size[0] * scale) / 2,
    (resolution[1] - size[1] * scale) / 2,
  ];
  const camera = multiply(
    multiply(parent, viewport),
    frame.camera?.matrix ?? identity,
  );
  const result: SharedElement[] = [];
  for (const c of frame.commands) {
    const [sx, sy, tx, ty] = c.transform,
      b = c.bounds;
    const matrix = multiply(camera, [
      b.width * sx,
      0,
      0,
      b.height * sy,
      b.x * sx + tx,
      b.y * sy + ty,
    ]);
    if (c.sharedId) result.push({ id: c.sharedId, matrix });
    // A tagged composition is one flattened shared element; do not double-transform descendants.
    if (c.kind === "composition" && !c.sharedId) {
      const pixels = [
        Math.max(1, Math.ceil(b.width * scale)),
        Math.max(1, Math.ceil(b.height * scale)),
      ] as const;
      const childParent = multiply(matrix, [
        1 / pixels[0],
        0,
        0,
        1 / pixels[1],
        0,
        0,
      ]);
      const childSize = [b.width, b.height] as const;
      result.push(
        ...collectSharedElements(c.frame, childSize, pixels, childParent),
      );
      if (c.overlay)
        result.push(
          ...collectSharedElements(c.overlay, childSize, pixels, childParent),
        );
    }
  }
  return result;
}
