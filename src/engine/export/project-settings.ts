import type { Project } from "../types";
import type { EncodingOptions } from "./settings";
import { defaultExportSize, assertExportSize } from "./formats/mp4/sizes";

/** Project defaults stay declarative: auto bitrate is evaluated at export time. */
export function projectExportSettings(project: Project) {
  const saved = project.settings?.export;
  const size = defaultExportSize(project.resolution);
  const [width, height] =
    saved?.resolution ??
    (size ? [size.width, size.height] : project.resolution);
  return {
    width,
    height,
    fps: saved?.fps ?? 30,
    bitrate: saved?.bitrate ?? "auto",
    latencyMode: saved?.latencyMode ?? "quality",
    keyFrameInterval: saved?.keyFrameInterval ?? 2,
  } as const;
}

export type ExportOverrides = Omit<EncodingOptions, "bitrate"> & {
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number | "auto";
};

/** Explicit caller flags > project settings > framework defaults. */
export function resolveExportRequest(
  project: Project,
  overrides: ExportOverrides = {},
) {
  const defaults = projectExportSettings(project);
  if ((overrides.width === undefined) !== (overrides.height === undefined))
    throw Error("Export width and height must be passed together.");
  const width = overrides.width ?? defaults.width;
  const height = overrides.height ?? defaults.height;
  assertExportSize(project, width, height);
  const fps = overrides.fps ?? defaults.fps;
  if (![24, 30, 60].includes(fps))
    throw Error("Unsupported export frame rate.");
  const bitrate = overrides.bitrate ?? defaults.bitrate;
  return {
    width,
    height,
    fps,
    bitrate: bitrate === "auto" ? undefined : bitrate,
    latencyMode: overrides.latencyMode ?? defaults.latencyMode,
    keyFrameInterval: overrides.keyFrameInterval ?? defaults.keyFrameInterval,
  };
}
