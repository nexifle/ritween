/**
 * Lane B mask-family fixture. Design size equals output, so scene-target pixels
 * match layout pixels before the outer clip quad. One stage, no transition at
 * the sample times. The row offset is inside the frame; the viewport offset is
 * outside the clip, so the mask stays fixed while the leaves slide.
 *
 * Mask URLs are load inputs only. They are not inspection fields.
 */
import { Box, FrameSource, HStack, StageEntry, ZStack } from "ritween";

export { FrameSource };

export const OUTPUT = Object.freeze([320, 180]);
export const TIME_A = 0.25;
export const TIME_B = 1.25;
export const BACKGROUND = "#112233";
export const COLOR_RED = "#E23D3D";
export const COLOR_BLUE = "#2E6BFF";
export const MASK_HALF_URL = "/mask-half.png";
export const MASK_CLEAR_URL = "/mask-clear.png";
export const LEAF_ID = "rounded-red";
export const SCOPE = "scene:mask";

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

function row(scroll, redId, blueId, rowId) {
  return HStack(
    [
      Box({ width: 40, height: 40, fill: COLOR_RED }).id(redId),
      Box({ width: 40, height: 40, fill: COLOR_BLUE }).id(blueId),
    ],
    { gap: 0, align: "start" },
  )
    .id(rowId)
    .offset(scroll, 0)
    .frame({ width: 40, height: 40, align: "start" });
}

function view(scroll) {
  return ZStack(
    [
      Box({
        width: OUTPUT[0],
        height: OUTPUT[1],
        fill: BACKGROUND,
      }).id("bg-mask"),
      row(scroll, "rounded-red", "rounded-blue", "rounded-row")
        .clip({ shape: "rect", radius: 10 })
        .id("rounded-view")
        .offset(10, 30),
      row(scroll, "circle-red", "circle-blue", "circle-row")
        .clip({ shape: "circle" })
        .id("circle-view")
        .offset(70, 30),
      row(scroll, "path-red", "path-blue", "path-row")
        .clip({ shape: "path", outline: [["M",0,0],["L",40,0],["L",0,40],["Z"]] })
        .id("path-view")
        .offset(130, 30),
      row(scroll, "half-red", "half-blue", "half-row")
        .clip({ shape: "image", url: "/mask-half.png", mode: "alpha" })
        .id("half-view")
        .offset(190, 30),
      row(scroll, "clear-red", "clear-blue", "clear-row")
        .clip({ shape: "image", url: "/mask-clear.png", mode: "alpha" })
        .id("clear-view")
        .offset(250, 30),
    ],
    { align: "start" },
  ).id("mask-stage");
}

const stage = {
  source: "scenes.ts",
  designSize: OUTPUT,
  background: BACKGROUND,
  transition: { type: "cut" },
};

export const project = {
  name: "Lane B mask family inspection",
  resolution: OUTPUT,
  aspectRatio: [16, 9],
  duration: 2,
  scenes: [
    StageEntry({
      ...stage,
      id: "mask",
      name: "Mask families",
      start: 0,
      duration: 2,
      view: ({ localTime }) => view(localTime < 1 ? 0 : -40),
    }),
  ],
};

export default project;
