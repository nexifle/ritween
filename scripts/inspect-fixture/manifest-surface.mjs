/**
 * Lane B native Group and Composition surfaces. Two independent surfaces, not
 * nested in each other. Design size equals output. No assets.
 *
 * Group padding is 5 around a 20×10 box; the group offset is 20 or 30 at y 20.
 * Composition viewport is 80×60 at (100, 30). World camera x is 10 and y is 0
 * because the default y is viewport height / 2. Overlay stays at (45, 10).
 */
import {
  Box,
  Camera,
  Composition,
  FrameSource,
  Group,
  StageEntry,
  World,
  ZStack,
} from "ritween";

export { FrameSource };

export const OUTPUT = Object.freeze([320, 180]);
export const TIME_A = 0;
export const TIME_B = 1;
export const SCOPE = "scene:surface";

const world = World(
  ({ localTime }) =>
    Box({ width: 10, height: 10, fill: "#00ff00" })
      .id("world-card")
      .offset(localTime >= 0.5 ? 30 : 20, 20)
      .frame({ width: 80, height: 60, align: "start" }),
  { size: [80, 60] },
);

const entry = StageEntry({
  id: "surface",
  source: "scenes.ts",
  start: 0,
  duration: 2,
  designSize: [320, 180],
  background: "#000000",
  view: ({ localTime }) =>
    ZStack(
      [
        Group([
          Box({ width: 20, height: 10, fill: "#ff0000" })
            .id("group-card")
            .padding(5),
        ])
          .id("group-surface")
          .offset(localTime >= 0.5 ? 30 : 20, 20),

        Composition(world, {
          size: [80, 60],
          // y must be explicit: the default is viewport height / 2.
          camera: Camera({ x: 10, y: 0, anchor: [0, 0] }),
          overlay: () =>
            Box({ width: 10, height: 10, fill: "#0000ff" })
              .id("overlay-card")
              .offset(45, 10)
              .frame({ width: 80, height: 60, align: "start" }),
        })
          .id("composition-surface")
          .offset(100, 30),
      ],
      { align: "start" },
    ).frame({ width: 320, height: 180, align: "start" }),
});

export const project = {
  name: "Lane B native group and composition",
  resolution: [320, 180],
  aspectRatio: [16, 9],
  duration: 2,
  scenes: [entry],
};

export default project;
