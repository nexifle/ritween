import type { SceneEntry, Transition } from "../engine/types";
import { videoResource } from "../engine/render/visual";
import { Stage, type StageContext, type StageOptions } from "./stage";
import type { ViewNode } from "./nodes";
import { Camera } from "./camera";
import { snapshotFonts } from "./fonts";

export interface StageEntryOptions extends StageOptions {
  readonly id: string;
  readonly name?: string;
  readonly source: string;
  readonly start: number;
  readonly duration: number;
  readonly transition?: Transition;
  readonly view: (context: StageContext) => ViewNode;
}

/** Declare footage once for timeline audio and independently owned Stage resources. */
export function StageEntry(options: StageEntryOptions): SceneEntry {
  const {
    id,
    name = id,
    source,
    start,
    duration,
    view,
    transition = { type: "cut" },
    ...stageOptions
  } = options;
  if (
    !id ||
    !Number.isFinite(start) ||
    start < 0 ||
    !Number.isFinite(duration) ||
    duration <= 0
  )
    throw Error("StageEntry needs an ID and valid timing.");
  const mediaClips =
    stageOptions.mediaClips &&
    Object.freeze(stageOptions.mediaClips.map(videoResource));
  // Capture configuration before callers can mutate their options or clip list.
  const settings = Object.freeze({
    ...stageOptions,
    mediaClips,
    fonts: snapshotFonts(stageOptions.fonts),
    camera:
      typeof stageOptions.camera === "function"
        ? stageOptions.camera
        : stageOptions.camera && Camera(stageOptions.camera),
    images: stageOptions.images && Object.freeze([...stageOptions.images]),
    designSize:
      stageOptions.designSize &&
      (Object.freeze([
        ...stageOptions.designSize,
      ]) as StageOptions["designSize"]),
    theme:
      stageOptions.theme &&
      Object.freeze({
        ...stageOptions.theme,
        colors: Object.freeze({ ...stageOptions.theme.colors }),
      }),
  });
  return {
    id,
    name,
    source,
    start,
    duration,
    mediaClips,
    transition: Object.freeze({ ...transition }),
    create: () => Stage(view, settings),
  };
}
