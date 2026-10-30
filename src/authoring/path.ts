import { ViewNode } from "./nodes";
import { resolveNumber, snapshotNumber, type AnimatedNumber } from "./motion";

/** Absolute SVG-style commands. Matching command topology is required for morphs. */
export type PathCommand =
  | readonly ["M" | "L", number, number]
  | readonly ["Q", number, number, number, number]
  | readonly ["C", number, number, number, number, number, number]
  | readonly ["Z"];
export type PathOutline = readonly PathCommand[];
export interface PathStyle {
  readonly width: number;
  readonly height: number;
  readonly fill?: string;
  readonly fillRule?: "nonzero" | "evenodd";
  readonly to?: PathOutline;
  readonly progress?: AnimatedNumber;
}
export interface PathSpec {
  readonly kind: "path";
  readonly outline: PathOutline;
  readonly style: PathStyle;
}
export function snapshotOutline(outline: PathOutline): PathOutline {
  if (!outline.length || outline.length > 4096 || outline[0][0] !== "M")
    throw Error("Path needs 1..4096 commands starting with M.");
  const lengths = { M: 3, L: 3, Q: 5, C: 7, Z: 1 };
  for (const command of outline) {
    if (
      command.length !== lengths[command[0]] ||
      !command
        .slice(1)
        .every((v) => typeof v === "number" && Number.isFinite(v))
    )
      throw Error("Invalid path command.");
  }
  return Object.freeze(
    outline.map((c) => Object.freeze([...c]) as PathCommand),
  );
}
/** Pure coordinate interpolation; contour order and winding must correspond. */
export function morphPath(
  from: PathOutline,
  to: PathOutline,
  progress: number,
): PathOutline {
  if (!Number.isFinite(progress)) throw Error("Morph progress must be finite.");
  if (
    from.length !== to.length ||
    from.some((c, i) => c[0] !== to[i][0] || c.length !== to[i].length)
  )
    throw Error(
      "Morph paths need matching commands and contours; normalize outlines first.",
    );
  const t = Math.max(0, Math.min(1, progress));
  return from.map(
    (c, i) =>
      c.map((v, j) =>
        j === 0
          ? v
          : (v as number) + ((to[i][j] as number) - (v as number)) * t,
      ) as unknown as PathCommand,
  );
}
export function Path(outline: PathOutline, style: PathStyle): ViewNode {
  if (![style.width, style.height].every((v) => Number.isFinite(v) && v > 0))
    throw Error("Path dimensions must be positive and finite.");
  if (style.fillRule && !["nonzero", "evenodd"].includes(style.fillRule))
    throw Error("Invalid path fill rule.");
  const from = snapshotOutline(outline),
    to = style.to && snapshotOutline(style.to);
  if (to) morphPath(from, to, 0);
  return new ViewNode({
    kind: "path",
    outline: from,
    style: Object.freeze({
      ...style,
      to,
      progress:
        style.progress === undefined
          ? undefined
          : snapshotNumber(style.progress),
    }),
  });
}
export interface GlyphDefinition {
  readonly outline: PathOutline;
  readonly advance: number;
}
/** Font-extracted glyph outlines use the same morph engine, including hole contours. */
export function Glyph(
  glyph: GlyphDefinition,
  style: PathStyle & { readonly toGlyph?: GlyphDefinition },
): ViewNode {
  if (!Number.isFinite(glyph.advance) || glyph.advance < 0)
    throw Error("Glyph advance must be non-negative and finite.");
  return Path(glyph.outline, {
    ...style,
    to: style.toGlyph?.outline ?? style.to,
  });
}
export function evaluatePath(spec: PathSpec, time: number): PathOutline {
  return spec.style.to
    ? morphPath(
        spec.outline,
        spec.style.to,
        resolveNumber(spec.style.progress ?? 0, time),
      )
    : spec.outline;
}
export function pathData(outline: PathOutline): string {
  return outline.map((c) => c.join(" ")).join(" ");
}
