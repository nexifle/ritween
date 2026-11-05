/**
 * Conservative float32 vertex-stage guard shared by leaf paint and Clip uniform mapping.
 * Same staging as the uploaded quad; not a GPU rounding model.
 */

/** One float32 vertex stage; a stage leaving the finite range makes the quad unavailable. */
function stage32(value: number, label: string): number {
  const rounded = Math.fround(value);
  if (!Number.isFinite(rounded))
    throw new RangeError(`${label} overflows float32.`);
  return rounded;
}

/**
 * Rejects vertex stages that leave float32 while every uniform stays finite:
 * `(rect.xy + uv * rect.zw) * transform.xy + transform.zw` through both camera rows. Real GPUs
 * may fuse or widen these steps, so this is a safety check, never a rounding model.
 */
export function checkVertexFloat32(
  rect: readonly [number, number, number, number],
  transform: readonly [number, number, number, number],
  cameraX: readonly [number, number, number],
  cameraY: readonly [number, number, number],
) {
  const [x, y, width, height] = rect;
  const [sx, sy, tx, ty] = transform;
  for (const u of [0, 1])
    for (const v of [0, 1]) {
      const worldX = stage32(
        stage32(stage32(x + u * width, "rect x") * sx, "transform x") + tx,
        "transform x",
      );
      const worldY = stage32(
        stage32(stage32(y + v * height, "rect y") * sy, "transform y") + ty,
        "transform y",
      );
      // The product sum is staged before the constant: two float32 products can overflow while
      // a cancelling constant brings the unstaged total back into range. Neither order is proven
      // GPU behaviour, so this stays a conservative check.
      for (const [row, label] of [
        [cameraX, "camera X"],
        [cameraY, "camera Y"],
      ] as const)
        stage32(
          stage32(
            stage32(row[0] * worldX, label) + stage32(row[1] * worldY, label),
            label,
          ) + row[2],
          label,
        );
    }
}
