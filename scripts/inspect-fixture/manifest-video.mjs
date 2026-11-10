/**
 * Lane B flat Video fixture. Design size equals output, so scene-target pixels
 * are the numeric rects below. One 3s cut scene. No loop field exists on MediaClip.
 *
 * The clip clock is inclusive at both endpoints. before/after sit outside
 * [start, start+duration], not on the endpoints. A/B are source times 0.25 and
 * 1.25, away from the encoded color change at 1s. A→B→A is a seek, not a loop.
 */
import { Box, FrameSource, StageEntry, Video, ZStack } from "ritween";

export { FrameSource };

export const OUTPUT = Object.freeze([320, 180]);
export const TIME_BEFORE = 0.25;
export const TIME_A = 0.75;
export const TIME_B = 1.75;
export const TIME_AFTER = 2.75;
export const VIDEO_ID = "footage-view";
export const BACKGROUND_ID = "bg-footage";
export const STAGE_ID = "flat-stage";
export const URL = "/media/source.mp4";
export const ALLOC = Object.freeze({ x: 40, y: 30, width: 100, height: 80 });
export const ASSET = Object.freeze({ width: 160, height: 80 });
export const CONTAIN = Object.freeze({ x: 40, y: 45, width: 100, height: 50 });
export const BACKGROUND = "#112233";
export const PHASE_RED = "#E23D3D";
export const PHASE_BLUE = "#2E6BFF";
/** Outside the allocation. */
export const SAMPLE_BG = Object.freeze([16, 16]);
/** Contain letterbox, above the fitted quad. */
export const SAMPLE_LETTERBOX = Object.freeze([60, 42]);
/** Interior of the contain quad. Not a coverage claim. */
export const SAMPLE_INTERIOR = Object.freeze([90, 70]);

/** One descriptor, passed to both the stage registration and Video. */
export const CLIP = Object.freeze({
  id: "footage",
  name: "Footage",
  url: URL,
  start: 0.5,
  duration: 2,
  offset: 0,
  muted: true,
});

/** Identified background sibling plus one Video. No other paint. */
export function flatView() {
  return ZStack(
    [
      Box({
        width: OUTPUT[0],
        height: OUTPUT[1],
        fill: BACKGROUND,
      })
        .background({ fill: BACKGROUND })
        .id(BACKGROUND_ID),
      Video(CLIP, {
        width: ALLOC.width,
        height: ALLOC.height,
        fit: "contain",
      })
        .id(VIDEO_ID)
        .offset(ALLOC.x, ALLOC.y),
    ],
    { align: "start" },
  ).id(STAGE_ID);
}

const stage = {
  source: "scenes.ts",
  designSize: OUTPUT,
  background: BACKGROUND,
  transition: { type: "cut" },
  mediaClips: [CLIP],
};

export const project = {
  name: "Lane B flat video inspection",
  resolution: OUTPUT,
  aspectRatio: [16, 9],
  duration: 3,
  scenes: [
    StageEntry({
      ...stage,
      id: "flat",
      name: "Flat video",
      start: 0,
      duration: 3,
      view: () => flatView(),
    }),
  ],
};

export default project;
