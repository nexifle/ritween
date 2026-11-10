/**
 * Lane B rect-clip fixture. Design size equals output, so scene-target pixels
 * match layout pixels before clip projection. One stage, no transition at the
 * sample times. Frame is applied before clip; the scroll offset is inside that
 * frame; the viewport offset is outside the clip.
 */
import { Box, FrameSource, HStack, StageEntry, ZStack } from "ritween";

export { FrameSource };

export const OUTPUT = Object.freeze([320, 180]);
export const TIME_A = 0.25;
export const TIME_B = 1.25;
export const BACKGROUND = "#112233";
export const COLOR_RED = "#E23D3D";
export const COLOR_BLUE = "#2E6BFF";
export const COLOR_NESTED = "#F5C542";
export const VIEWPORT = Object.freeze({ x: 40, y: 30, width: 80, height: 40 });
export const OUTER_VIEWPORT = Object.freeze({
  x: 180,
  y: 30,
  width: 80,
  height: 40,
});
export const INNER_FRAME = Object.freeze({ width: 30.5, height: 17.25 });
export const INNER_OFFSET = Object.freeze({ x: 10.25, y: 4.5 });
export const LEAF_ID = "leaf/a%b";
export const SAMPLE_RED = Object.freeze([50, 50]);
export const SAMPLE_SEAM = Object.freeze([70, 50]);
export const SAMPLE_BLUE = Object.freeze([110, 50]);
export const SAMPLE_LEFT = Object.freeze([30, 50]);
export const SAMPLE_RIGHT = Object.freeze([130, 50]);
export const SAMPLE_BG = Object.freeze([16, 16]);

function rgba(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return Object.freeze([
    (value >> 16) & 255,
    (value >> 8) & 255,
    value & 255,
    255,
  ]);
}

export const BACKGROUND_RGBA = rgba(BACKGROUND);
export const COLOR_RED_RGBA = rgba(COLOR_RED);
export const COLOR_BLUE_RGBA = rgba(COLOR_BLUE);
export const COLOR_NESTED_RGBA = rgba(COLOR_NESTED);

function halves(scroll) {
  return HStack(
    [
      Box({ width: 60, height: 40, fill: COLOR_RED }).id("clip-red"),
      Box({ width: 60, height: 40, fill: COLOR_BLUE }).id("clip-blue"),
    ],
    { gap: 0, align: "start" },
  )
    .id("clip-row")
    .offset(scroll, 0)
    .frame({ width: 80, height: 40, align: "start" })
    .clip()
    .id("clip-view")
    .offset(VIEWPORT.x, VIEWPORT.y);
}

function nestedLeaf() {
  return Box({ width: 40, height: 20, fill: COLOR_NESTED })
    .id(LEAF_ID)
    .scale(-1, 1, [0.25, 0])
    .frame({ width: INNER_FRAME.width, height: INNER_FRAME.height, align: "start" })
    .clip()
    .id("clip-inner")
    .offset(INNER_OFFSET.x, INNER_OFFSET.y)
    .frame({
      width: OUTER_VIEWPORT.width,
      height: OUTER_VIEWPORT.height,
      align: "start",
    })
    .clip()
    .id("clip-outer")
    .offset(OUTER_VIEWPORT.x, OUTER_VIEWPORT.y);
}

function view(scroll) {
  return ZStack(
    [
      Box({
        width: OUTPUT[0],
        height: OUTPUT[1],
        fill: BACKGROUND,
      }).id("bg-clip"),
      halves(scroll),
      nestedLeaf(),
    ],
    { align: "start" },
  ).id("clip-stage");
}

const stage = {
  source: "scenes.ts",
  designSize: OUTPUT,
  background: BACKGROUND,
  transition: { type: "cut" },
};

export const project = {
  name: "Lane B rect clip inspection",
  resolution: OUTPUT,
  aspectRatio: [16, 9],
  duration: 2,
  scenes: [
    StageEntry({
      ...stage,
      id: "clip",
      name: "Rect clip",
      start: 0,
      duration: 2,
      view: ({ localTime }) => view(localTime < 1 ? 0 : -40),
    }),
  ],
};

export default project;
