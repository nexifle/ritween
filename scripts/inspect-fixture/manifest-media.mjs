/**
 * Lane B flat Image fixture. Design size equals output, so scene-target pixels
 * are the numeric rects below. One 2s scene, no transition overlap.
 *
 * A is contain, B is cover. TIME_CROP is an explicit third sample in that same
 * scene. The published record is the fitted draw quad, not a UV or alpha bound.
 * Crop forces cover, so its quad matches cover; sampling is proved by pixels.
 */
import { Box, FrameSource, Image, StageEntry, ZStack } from "ritween";

export { FrameSource };

export const OUTPUT = Object.freeze([320, 180]);
export const TIME_A = 0.25;
export const TIME_B = 1.25;
export const TIME_CROP = 1.75;
export const IMAGE_ID = "still";
export const BACKGROUND_ID = "bg-still";
export const STAGE_ID = "flat-stage";
export const URL = "/media/still.png";
export const ALLOC = Object.freeze({ x: 40, y: 30, width: 100, height: 80 });
export const ASSET = Object.freeze({ width: 160, height: 80 });
export const CONTAIN = Object.freeze({ x: 40, y: 45, width: 100, height: 50 });
export const COVER = Object.freeze({ x: 40, y: 30, width: 100, height: 80 });
export const CROP = Object.freeze({ x: 0.2, y: 0.5, zoom: 2 });
export const BACKGROUND = "#112233";
export const LEFT = "#E23D3D";
export const RIGHT = "#2E6BFF";
/** Outside every image quad. */
export const SAMPLE_BG = Object.freeze([16, 16]);
/** Contain letterbox, cover interior, left field. Away from the texture edge and the color split. */
export const SAMPLE_LETTERBOX_LEFT = Object.freeze([60, 42]);
export const SAMPLE_LETTERBOX_RIGHT = Object.freeze([120, 42]);
/** Interior of both the contain quad and the cover quad. */
export const SAMPLE_LEFT = Object.freeze([60, 70]);
export const SAMPLE_RIGHT = Object.freeze([120, 70]);

function imageStyle(localTime) {
  if (localTime < 1) return { fit: "contain" };
  if (localTime < 1.5) return { fit: "cover" };
  return { crop: CROP };
}

/** Identified background sibling plus one Image. No other paint. */
export function flatView(localTime) {
  return ZStack(
    [
      Box({
        width: OUTPUT[0],
        height: OUTPUT[1],
        fill: BACKGROUND,
      })
        .background({ fill: BACKGROUND })
        .id(BACKGROUND_ID),
      Image({
        url: URL,
        width: ALLOC.width,
        height: ALLOC.height,
        ...imageStyle(localTime),
      })
        .id(IMAGE_ID)
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
};

export const project = {
  name: "Lane B flat image inspection",
  resolution: OUTPUT,
  aspectRatio: [16, 9],
  duration: 2,
  scenes: [
    StageEntry({
      ...stage,
      id: "flat",
      name: "Flat image",
      start: 0,
      duration: 2,
      view: ({ localTime }) => flatView(localTime),
    }),
  ],
};

export default project;
