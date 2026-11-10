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
  const sourcePaths = new Set<string>();
  /** Emitted target path per ID, so one modifier chain never emits the same ID twice. */
  const emitted = new Map<string, string>();
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
    // A filled/stroked shape emits multiple paint commands for one source node.
    // `matchId` is the wrapper-declared identity of a modifier's own paint, so a wrapper
    // ID yields one target without borrowing the child's `sharedId`. Commands are in paint
    // order (wrapper before its descendants), so an ancestor already owning the ID wins and
    // repeating that ID further down the same chain (`id("a").background().id("a")`) stays
    // one target instead of becoming a duplicate the matcher rejects.
    const id = c.sharedId ?? c.matchId;
    if (id && !sourcePaths.has(c.path)) {
      const owner = emitted.get(id);
      if (owner === undefined || !c.path.startsWith(`${owner}/`)) {
        result.push({ id, matrix });
        sourcePaths.add(c.path);
        if (owner === undefined) emitted.set(id, c.path);
      }
    }
    // A tagged composition is one flattened shared element; do not double-transform descendants.
    if ((c.kind === "composition" || c.kind === "group") && !c.sharedId) {
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
