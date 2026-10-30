import type { SharedElement } from "../types";

export type Affine = readonly number[];
export const identity: Affine = [1, 0, 0, 1, 0, 0];
export function multiply(a: Affine, b: Affine): number[] {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
export function inverse(m: Affine): number[] {
  const d = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(d) < 1e-12)
    throw Error("Shared element has a singular transform.");
  return [
    m[3] / d,
    -m[1] / d,
    -m[2] / d,
    m[0] / d,
    (m[2] * m[5] - m[3] * m[4]) / d,
    (m[1] * m[4] - m[0] * m[5]) / d,
  ];
}
/** Match explicit semantic IDs, never infer identity from text or sibling position. */
export function matchSharedElements(
  a: readonly SharedElement[],
  b: readonly SharedElement[],
  progress: number,
) {
  const index = (items: readonly SharedElement[]) => {
    const result = new Map<string, Affine>();
    for (const item of items) {
      if (result.has(item.id))
        throw Error(`Duplicate shared element ID: ${item.id}`);
      if (item.matrix.length !== 6 || !item.matrix.every(Number.isFinite))
        throw Error(`Invalid shared element pose: ${item.id}`);
      result.set(item.id, item.matrix);
    }
    return result;
  };
  const left = index(a),
    right = index(b);
  const outgoing = new Map<string, Affine>(),
    incoming = new Map<string, Affine>();
  const t = Math.max(0, Math.min(1, progress));
  const eased = t * t * (3 - 2 * t);
  for (const [id, start] of left) {
    const end = right.get(id);
    if (!end) continue;
    const pose = start.map((value, i) => value + (end[i] - value) * eased);
    outgoing.set(id, multiply(pose, inverse(start)));
    incoming.set(id, multiply(pose, inverse(end)));
  }
  return [outgoing, incoming] as const;
}
