import { snapshotOutline, type PathOutline } from "./path";

export interface ImageMask {
  readonly shape: "image";
  readonly url: string;
  /** Default alpha; luminance is Rec.709-weighted sampled RGB multiplied by alpha. */
  readonly mode?: "alpha" | "luminance";
}
export type ClipShape =
  | ImageMask
  | { readonly shape: "rect"; readonly radius?: number }
  | { readonly shape: "circle" }
  | {
      readonly shape: "path";
      readonly outline: PathOutline;
      readonly fillRule?: "nonzero" | "evenodd";
    };

export function snapshotClip(shape: ClipShape): ClipShape {
  if (shape.shape === "image") {
    if (typeof shape.url !== "string" || !shape.url.trim())
      throw Error("Mask image URL must not be empty.");
    if (
      shape.mode !== undefined &&
      shape.mode !== "alpha" &&
      shape.mode !== "luminance"
    )
      throw Error("Mask mode must be alpha or luminance.");
    return Object.freeze({ ...shape });
  }
  if (shape.shape === "path") {
    if (shape.fillRule && !["nonzero", "evenodd"].includes(shape.fillRule))
      throw Error("Invalid clip fill rule.");
    return Object.freeze({ ...shape, outline: snapshotOutline(shape.outline) });
  }
  if (shape.shape === "rect") {
    if (!Number.isFinite(shape.radius ?? 0) || (shape.radius ?? 0) < 0)
      throw Error("Clip radius must be finite and non-negative.");
  } else if (shape.shape !== "circle") throw Error("Unknown clip shape.");
  return Object.freeze({ ...shape });
}
/** Mask coordinates are local design units within the modifier's layout bounds. */
export function clipOutline(
  shape: Exclude<ClipShape, ImageMask>,
  width: number,
  height: number,
): PathOutline {
  if (shape.shape === "path") return shape.outline;
  const r =
    shape.shape === "circle"
      ? Math.min(width, height) / 2
      : Math.min(shape.radius ?? 0, width / 2, height / 2);
  const x = shape.shape === "circle" ? width / 2 - r : 0;
  const y = shape.shape === "circle" ? height / 2 - r : 0;
  const w = shape.shape === "circle" ? r * 2 : width;
  const h = shape.shape === "circle" ? r * 2 : height;
  const k = r * 0.5522847498307936;
  return [
    ["M", x + r, y],
    ["L", x + w - r, y],
    ["C", x + w - r + k, y, x + w, y + r - k, x + w, y + r],
    ["L", x + w, y + h - r],
    ["C", x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h],
    ["L", x + r, y + h],
    ["C", x + r - k, y + h, x, y + h - r + k, x, y + h - r],
    ["L", x, y + r],
    ["C", x, y + r - k, x + r - k, y, x + r, y],
    ["Z"],
  ];
}
