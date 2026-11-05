import type { Bounds } from "./layout";

/** Canvas-convention affine matrix: `x' = a*x + c*y + e`, `y' = b*x + d*y + f`. */
export type Affine2D = readonly [
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
];

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite.`);
  return value;
}

const binary64 = new DataView(new ArrayBuffer(8));

/** Exact binary64 split into `significand * 2^exponent`; both zeros give `0n`. */
function dyadic(value: number): [bigint, number] {
  binary64.setFloat64(0, value);
  const high = binary64.getUint32(0);
  const exponentBits = (high >>> 20) & 0x7ff;
  const fraction = (BigInt(high & 0xfffff) << 32n) | BigInt(binary64.getUint32(4));
  const significand = exponentBits === 0 ? fraction : fraction | (1n << 52n);
  return [
    high >>> 31 ? -significand : significand,
    exponentBits === 0 ? -1074 : exponentBits - 1075,
  ];
}

/**
 * Exact `a*d - b*c !== 0`. Rounded `number` products can underflow to zero or
 * cancel to equal values while the dyadic determinant stays nonzero.
 */
function nonsingular(a: number, b: number, c: number, d: number): boolean {
  const [pa, ea] = dyadic(a);
  const [pd, ed] = dyadic(d);
  const [pb, eb] = dyadic(b);
  const [pc, ec] = dyadic(c);
  const p = pa * pd;
  const q = pb * pc;
  if (p === 0n || q === 0n) return p !== q;
  if ((p < 0n) !== (q < 0n)) return true;
  const shift = ea + ed - (eb + ec);
  return shift >= 0 ? p << BigInt(shift) !== q : p !== q << BigInt(-shift);
}

/**
 * Pure rectangle projection: local bounds through an affine matrix into the
 * target-space AABB. Reports geometry only; it makes no paint decision.
 */
export function projectRect(
  bounds: Bounds,
  matrix: Affine2D,
  opacity: number,
): { bounds: Bounds; accuracy: "exact" | "aabb"; visible: boolean } {
  const { x, y, width, height } = bounds;
  const [a, b, c, d, e, f] = matrix;
  if (![x, y, width, height, a, b, c, d, e, f].every(Number.isFinite))
    throw new RangeError("projectRect expects finite bounds and matrix.");
  if (width < 0 || height < 0)
    throw new RangeError("projectRect expects non-negative width and height.");
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)
    throw new RangeError("projectRect expects opacity in [0, 1].");

  finite(a * d - b * c, "projectRect determinant");
  const invertible = nonsingular(a, b, c, d);
  const right = finite(x + width, "projectRect bounds right edge");
  const bottom = finite(y + height, "projectRect bounds bottom edge");

  const xs: number[] = [];
  const ys: number[] = [];
  for (const px of [x, right]) {
    for (const py of [y, bottom]) {
      xs.push(finite(a * px + c * py + e, "projectRect corner x"));
      ys.push(finite(b * px + d * py + f, "projectRect corner y"));
    }
  }
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const projectedWidth = finite(maxX - minX, "projectRect projected width");
  const projectedHeight = finite(maxY - minY, "projectRect projected height");

  const positive = width > 0 && height > 0;
  const exact =
    positive && invertible
      ? (a === 0 && d === 0) || (b === 0 && c === 0)
      : projectedWidth === 0 || projectedHeight === 0;

  return {
    bounds: {
      x: minX,
      y: minY,
      width: projectedWidth,
      height: projectedHeight,
    },
    accuracy: exact ? "exact" : "aabb",
    visible: positive && invertible && opacity !== 0,
  };
}
