import type { Project } from "../../../types";

/**
 * AVC Level 4.2, matching the export codec avc1.42002a.
 * ITU-T H.264 Table A-1: at most 8704 macroblocks, and neither side
 * wider than floor(sqrt(MaxFS * 8)) macroblocks.
 */
export const H264_LEVEL_42_MAX_MACROBLOCKS = 8704;
const H264_LEVEL_42_MAX_SIDE_MBS = Math.floor(
  Math.sqrt(H264_LEVEL_42_MAX_MACROBLOCKS * 8),
);

/** Short side of each offered export step. The other side keeps the project aspect. */
export const EXPORT_SHORT_SIDES = [360, 720, 1080] as const;

const LANDSCAPE_PRESETS = [
  [640, 360, "360p"],
  [1280, 720, "720p"],
  [1920, 1080, "1080p"],
] as const;

export type ExportSize = {
  width: number;
  height: number;
  /** Set only for the 16:9 sizes named 360p, 720p, and 1080p. */
  name?: "360p" | "720p" | "1080p";
};

function nearestEven(value: number) {
  return 2 * Math.round(value / 2);
}

/** Even dimensions that a Level 4.2 H.264 encoder is allowed to store. */
export function fitsH264Level42(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return false;
  if (width < 2 || height < 2 || width % 2 !== 0 || height % 2 !== 0)
    return false;
  const across = Math.ceil(width / 16);
  const down = Math.ceil(height / 16);
  return (
    across <= H264_LEVEL_42_MAX_SIDE_MBS &&
    down <= H264_LEVEL_42_MAX_SIDE_MBS &&
    across * down <= H264_LEVEL_42_MAX_MACROBLOCKS
  );
}

/**
 * One pixel on the shorter side. Authored resolution and aspectRatio still
 * use the stricter 0.001 check in validateProject.
 */
export function exportAspectTolerance(width: number, height: number) {
  return Math.max(0.001, 1 / Math.min(width, height));
}

export function matchesExportAspect(
  width: number,
  height: number,
  resolution: readonly [number, number],
) {
  return (
    Math.abs(width / height - resolution[0] / resolution[1]) <=
    exportAspectTolerance(width, height)
  );
}

function presetName(width: number, height: number): ExportSize["name"] {
  const found = LANDSCAPE_PRESETS.find(
    ([presetWidth, presetHeight]) =>
      presetWidth === width && presetHeight === height,
  );
  return found?.[2];
}

/** Scale steps for this project. Steps that exceed Level 4.2 are omitted. */
export function exportSizes(
  resolution: readonly [number, number],
): ExportSize[] {
  const ratio = resolution[0] / resolution[1];
  const sizes: ExportSize[] = [];
  for (const shortSide of EXPORT_SHORT_SIDES) {
    const landscape = ratio >= 1;
    const width = landscape ? nearestEven(shortSide * ratio) : shortSide;
    const height = landscape ? shortSide : nearestEven(shortSide / ratio);
    if (!fitsH264Level42(width, height)) continue;
    if (!matchesExportAspect(width, height, resolution)) continue;
    sizes.push({ width, height, name: presetName(width, height) });
  }
  return sizes;
}

/** The short-side-720 step, or the largest step that still fits. */
export function defaultExportSize(
  resolution: readonly [number, number],
): ExportSize | undefined {
  const sizes = exportSizes(resolution);
  return (
    sizes.find((size) => Math.min(size.width, size.height) === 720) ??
    sizes.at(-1)
  );
}

export function assertExportSize(
  project: Pick<Project, "resolution" | "aspectRatio">,
  width: number,
  height: number,
) {
  if (!fitsH264Level42(width, height))
    throw Error(
      "Export dimensions must be even and fit H.264 Level 4.2 (at most 8704 macroblocks, neither side above 4208).",
    );
  if (!matchesExportAspect(width, height, project.resolution))
    throw Error(
      `Export ${width}×${height} does not match the project aspect ${project.aspectRatio.join(":")} (${project.resolution.join("×")}).`,
    );
}
