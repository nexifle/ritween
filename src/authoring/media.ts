import { snapshotNumber, type AnimatedNumber } from "./motion";
import type { MediaClip } from "../engine/types";
import { validateMediaClip } from "../engine/media/project";
import { ViewNode } from "./nodes";

export interface MediaStyle {
  readonly width: number;
  readonly height: number;
  readonly fit?: "contain" | "cover";
  /** Cover crop: normalized focal point (0..1) and zoom >= 1. */
  readonly crop?: {
    readonly x?: AnimatedNumber;
    readonly y?: AnimatedNumber;
    readonly zoom?: AnimatedNumber;
  };
}
export type MediaSpec =
  | { readonly kind: "image"; readonly url: string; readonly style: MediaStyle }
  | {
      readonly kind: "video";
      readonly clip: Readonly<MediaClip>;
      readonly style: MediaStyle;
    };
function styleSnapshot(style: MediaStyle): MediaStyle {
  if (
    ![style.width, style.height].every((n) => Number.isFinite(n) && n > 0) ||
    (style.fit !== undefined &&
      style.fit !== "contain" &&
      style.fit !== "cover")
  )
    throw Error(
      "Media needs positive finite dimensions and contain/cover fit.",
    );
  return Object.freeze({
    width: style.width,
    height: style.height,
    fit: style.fit,
    crop:
      style.crop &&
      Object.freeze({
        x: snapshotNumber(style.crop.x ?? 0.5),
        y: snapshotNumber(style.crop.y ?? 0.5),
        zoom: snapshotNumber(style.crop.zoom ?? 1),
      }),
  });
}
/** Explicit design bounds keep layout independent of asynchronous asset loading. */
export function Image(
  options: MediaStyle & { readonly url: string },
): ViewNode {
  if (!options.url) throw Error("Image URL must not be empty.");
  return new ViewNode({
    kind: "image",
    url: options.url,
    style: styleSnapshot(options),
  });
}
/** Reuse this clip in Stage/Shot.mediaClips; its project clock also drives audio. */
export function Video(clip: Readonly<MediaClip>, style: MediaStyle): ViewNode {
  validateMediaClip(clip);
  return new ViewNode({
    kind: "video",
    clip: Object.freeze({ ...clip }),
    style: styleSnapshot(style),
  });
}

/** Normalized UVs and a centered contain rectangle within the offered bounds. */
export function fitMedia(
  width: number,
  height: number,
  sourceWidth: number,
  sourceHeight: number,
  fit: "contain" | "cover",
) {
  const ratio = sourceWidth / sourceHeight,
    boxRatio = width / height;
  let w = width,
    h = height,
    sx = 1,
    sy = 1;
  if (fit === "contain") {
    if (boxRatio > ratio) w = height * ratio;
    else h = width / ratio;
  } else {
    if (boxRatio > ratio) sy = ratio / boxRatio;
    else sx = boxRatio / ratio;
  }
  return {
    x: (width - w) / 2,
    y: (height - h) / 2,
    width: w,
    height: h,
    uv: [sx, sy, (1 - sx) / 2, (1 - sy) / 2] as const,
  };
}
