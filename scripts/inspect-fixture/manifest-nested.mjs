/**
 * Lane B nested camera/surface fixture. Design size equals output, so the only
 * scale is the Composition camera and the authored negative leaf scale.
 *
 * Shape: Composition → World → Clip → Group → Composition → World → leaf, plus an
 * overlay on the inner Composition. Every camera is fractional with a negative
 * scale, so a swapped or duplicated matrix changes the raster location.
 * The outer camera pans between A and B; the inner one is static.
 */
import { Box, Composition, FrameSource, Group, StageEntry, World, ZStack } from "ritween";

export { FrameSource };

export const OUTPUT = Object.freeze([240, 160]);
export const TIME_A = 0;
export const TIME_B = 1;
export const SCOPE = "scene:nested";

/**
 * Outer Composition sits at (30, 20) with a 160×120 viewport. Its camera has a
 * fractional position and a 1.5 zoom anchored at (0.25, 0.75), so the world→viewport
 * affine is not identity. It pans 4.5 viewport pixels between A and B.
 */
export const OUTER = Object.freeze({ x: 30, y: 20, width: 160, height: 120 });
export const OUTER_CAMERA_A = Object.freeze({
  x: 73.5,
  y: 53.25,
  zoom: 0.9,
  anchor: [0.5, 0.5],
});
export const OUTER_CAMERA_B = Object.freeze({
  // A 26.5 world-unit pan at 0.9 zoom moves the leaf ~23.9 px, wider than its 16.5 px quad,
  // so each pan state covers a strip the other one leaves bare.
  x: 100,
  y: 53.25,
  zoom: 0.9,
  anchor: [0.5, 0.5],
});
/** Inner Composition at (12.5, 9.5) in the outer world, 96×72 viewport. */
export const INNER = Object.freeze({ x: 12.5, y: 9.5, width: 96, height: 72 });
export const INNER_CAMERA = Object.freeze({
  x: 47.5,
  y: 35.75,
  zoom: 0.875,
  anchor: [0.5, 0.5],
});
/** Clip padding around the Group content; the group holds the inner Composition. */
export const CLIP_PADDING = 6;
/** The clip offers its padded remainder, so the plate is sized to fit it exactly. */
export const PLATE = Object.freeze({
  width: OUTER.width - CLIP_PADDING * 2,
  height: OUTER.height - CLIP_PADDING * 2,
});
/**
 * Leaf: negative scale on both axes with a zero anchor, so the flipped quad lands at a
 * fractional nonzero world offset instead of flipping about the box centre.
 */
export const LEAF = Object.freeze({ width: 14, height: 10, x: 30, y: 24 });
export const OVERLAY_BOX = Object.freeze({ width: 8, height: 6, x: 3.5, y: 2.5 });

const BACKGROUND = "#000000";
const OUTER_FILL = "#e23d3d";
const INNER_FILL = "#2e6bff";
const OVERLAY_FILL = "#00ff00";
/** Distinct from the inner overlay so a swapped overlay frame changes the sampled colour. */
const OUTER_OVERLAY_FILL = "#ffd400";
const CLIP_FILL = "#112233";

const inner = World(
  () =>
    ZStack(
      [
        Box({ width: 96, height: 72, fill: CLIP_FILL }),
        Box({ width: LEAF.width, height: LEAF.height, fill: INNER_FILL })
          .id("nested-leaf")
          .scale(-1.5, -1.25, [0, 0])
          .offset(LEAF.x, LEAF.y),
      ],
      { align: "start" },
    ),
  { size: [96, 72] },
);

const structure = (overlay) =>
  World(
    () =>
      Group([
        Box({ width: PLATE.width, height: PLATE.height, fill: OUTER_FILL }).id(
          "outer-plate",
        ),
        Composition(inner, {
          size: [96, 72],
          camera: INNER_CAMERA,
          ...(overlay
            ? {
                overlay: () =>
                  Box({
                    width: OVERLAY_BOX.width,
                    height: OVERLAY_BOX.height,
                    fill: OVERLAY_FILL,
                  })
                    .id("nested-overlay")
                    .offset(OVERLAY_BOX.x, OVERLAY_BOX.y),
              }
            : {}),
        })
          .id("nested-composition")
          .offset(INNER.x, INNER.y),
      ])
        .id("nested-group")
        .clip()
        .padding(CLIP_PADDING)
        .id("nested-clip"),
    { size: [160, 120] },
  );

const entry = StageEntry({
  id: "nested",
  source: "scenes.ts",
  start: 0,
  duration: 2,
  designSize: OUTPUT,
  background: BACKGROUND,
  view: ({ localTime }) =>
    Composition(structure(true), {
      size: [OUTER.width, OUTER.height],
      camera: localTime >= 0.5 ? OUTER_CAMERA_B : OUTER_CAMERA_A,
      overlay: () =>
        Box({ width: 6, height: 4, fill: OUTER_OVERLAY_FILL })
          .id("outer-overlay")
          .offset(1.25, 2.75),
    })
      .id("nested-outer")
      .offset(OUTER.x, OUTER.y),
});

export const project = {
  name: "Lane B native nested camera surfaces",
  resolution: OUTPUT,
  aspectRatio: [3, 2],
  duration: 2,
  scenes: [entry],
};

export default project;
