/**
 * Lane B flat Box fixture. Design size equals output, so scene-target pixels are
 * the numeric rects below. No transition overlaps the sample times.
 *
 * A and B are alternate content boxes, not simultaneous paints: each is a sibling
 * of an explicitly identified background. The clip scene authors a real allocation
 * error inside a clip and a clip that fits; clip itself is not an error code.
 */
import { Box, FrameSource, HStack, Spacer, StageEntry, ZStack } from "ritween";

export { FrameSource };

export const OUTPUT = Object.freeze([320, 180]);
export const BOX_A = Object.freeze({ x: 40, y: 30, width: 80, height: 40 });
export const BOX_B = Object.freeze({ x: 100, y: 30, width: 80, height: 40 });
export const BACKGROUND = "#112233";
export const COLOR_A = "#E23D3D";
export const COLOR_B = "#2E6BFF";
export const TIME_A = 0.25;
export const TIME_B = 1.25;
export const TIME_CLIP = 2.25;
/** Interiors of the non-overlapping rects, inset from every quad edge. */
export const SAMPLE_A = Object.freeze([70, 50]);
export const SAMPLE_B = Object.freeze([150, 50]);
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
export const COLOR_A_RGBA = rgba(COLOR_A);
export const COLOR_B_RGBA = rgba(COLOR_B);

function contentBox(id, rect, fill) {
  return Box({ width: rect.width, height: rect.height, fill })
    .id(id)
    .offset(rect.x, rect.y);
}

function backgroundSibling(id) {
  return Box({
    width: OUTPUT[0],
    height: OUTPUT[1],
    fill: BACKGROUND,
  })
    .background({ fill: BACKGROUND })
    .id(id);
}

/** One state: identified background sibling plus one content box. No other paint. */
export function flatView(state) {
  const content =
    state === "a"
      ? contentBox("box-a", BOX_A, COLOR_A)
      : contentBox("box-b", BOX_B, COLOR_B);
  return ZStack(
    [backgroundSibling(state === "a" ? "bg-a" : "bg-b"), content],
    { align: "start" },
  ).id("flat-stage");
}

/**
 * `clip-fit` is a clip with no overflow. `clip-chips` is the same deficit the
 * G1b fixture uses, wrapped in a clip so the published code can be observed.
 */
function clipView() {
  return ZStack(
    [
      backgroundSibling("bg-clip"),
      Box({ width: 40, height: 20, fill: COLOR_A })
        .id("clipped-fit")
        .frame({ width: 80, height: 40 })
        .clip()
        .id("clip-fit"),
      HStack(
        [
          Box({ width: 96, height: 12, fill: COLOR_B }).id("clip-chip-a"),
          Box({ width: 96, height: 12, fill: COLOR_B }).id("clip-chip-b"),
          Box({ width: 96, height: 12, fill: COLOR_B }).id("clip-chip-c"),
          Spacer(),
        ],
        { gap: 0 },
      )
        .id("clip-chips")
        .frame({ width: 100, height: 40 })
        .clip()
        .id("clip-deficit"),
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
  name: "Lane B flat box inspection",
  resolution: OUTPUT,
  aspectRatio: [16, 9],
  duration: 3,
  scenes: [
    StageEntry({
      ...stage,
      id: "flat",
      name: "Flat boxes",
      start: 0,
      duration: 2,
      view: ({ localTime }) => flatView(localTime < 1 ? "a" : "b"),
    }),
    StageEntry({
      ...stage,
      id: "clip",
      name: "Clip diagnostic probe",
      start: 2,
      duration: 1,
      view: () => clipView(),
    }),
  ],
};

export default project;
