/**
 * Lane B shared-transition fixture for the native correction-binding proof. Design size equals
 * output, so the viewport scale is 1 and a leaf's output position is its layout position.
 *
 * Two shared-element cases share one render:
 *
 * 1. Matched surface, suppressed descendant. The `hero` Composition is declared with the same id
 *    in both scenes, so the transition corrects that surface command and the renderer drops the
 *    correction map for the child pass. The leaf inside also declares `hero-leaf`, and that id is
 *    declared a second time as a top-level marker in both scenes, so the map the child pass would
 *    have received really contains it. The leaf must therefore keep its uncorrected camera; a
 *    missing map entry cannot explain the result.
 * 2. Unmatched surface, descendant fallback. The `solo` Composition has no id, so it resolves no
 *    correction and keeps the map; the leaf inside declares `pair-leaf` in both scenes and the
 *    transition pose goes to that leaf, once.
 *
 * Every shared element is a pure translation, so the pose is exactly `smoothstep(progress)` of
 * the authored offset delta and the expected quad is authored geometry, not a fitted report.
 */
import { Box, Composition, FrameSource, StageEntry, World, ZStack } from "ritween";

export { FrameSource };

export const OUTPUT = Object.freeze([160, 100]);
/** The incoming entry starts at 1 and lasts 2 with a one-second overlap. */
export const TIME_A = 1.25;
export const TIME_B = 1.75;
export const PROGRESS_A = 0.25;
export const PROGRESS_B = 0.75;
export const SCOPE_OUT = "scene:shared-out";
export const SCOPE_IN = "scene:shared-in";

export const HERO = Object.freeze({
  viewport: Object.freeze({ width: 60, height: 40 }),
  out: Object.freeze({ x: 20, y: 20 }),
  in: Object.freeze({ x: 60, y: 20 }),
  leaf: Object.freeze({ width: 10, height: 10, x: 5, y: 5 }),
});
export const SOLO = Object.freeze({
  viewport: Object.freeze({ width: 40, height: 30 }),
  at: Object.freeze({ x: 90, y: 20 }),
  leaf: Object.freeze({
    width: 10,
    height: 10,
    y: 5,
    outX: 5,
    inX: 23,
  }),
});
/** The second `hero-leaf` declaration, outside the tagged surface, in both scenes. */
export const MARKER = Object.freeze({
  width: 10,
  height: 10,
  y: 75,
  outX: 120,
  inX: 156,
});

const BACKGROUND = "#000000";
export const HERO_FILL = "#ffffff";
export const PAIR_FILL = "#ffe600";
/** Distinct from both leaf fills, so a swapped marker pose changes the sampled colour. */
export const MARKER_FILL = "#00c2ff";

const heroWorld = World(
  () =>
    ZStack(
      [
        Box({ width: HERO.leaf.width, height: HERO.leaf.height, fill: HERO_FILL })
          .id("hero-leaf")
          .offset(HERO.leaf.x, HERO.leaf.y),
      ],
      { align: "start" },
    ),
  { size: [HERO.viewport.width, HERO.viewport.height] },
);

const soloWorld = (role) =>
  World(
    () =>
      ZStack(
        [
          Box({
            width: SOLO.leaf.width,
            height: SOLO.leaf.height,
            fill: PAIR_FILL,
          })
            .id("pair-leaf")
            .offset(
              role === "out" ? SOLO.leaf.outX : SOLO.leaf.inX,
              SOLO.leaf.y,
            ),
        ],
        { align: "start" },
      ),
    { size: [SOLO.viewport.width, SOLO.viewport.height] },
  );

const sceneView = (role) => {
  const heroAt = role === "out" ? HERO.out : HERO.in;
  return ZStack(
    [
      Composition(heroWorld, {
        size: [HERO.viewport.width, HERO.viewport.height],
      })
        .id("hero")
        .offset(heroAt.x, heroAt.y),
      Composition(soloWorld(role), {
        size: [SOLO.viewport.width, SOLO.viewport.height],
      }).offset(SOLO.at.x, SOLO.at.y),
      Box({
        width: MARKER.width,
        height: MARKER.height,
        fill: MARKER_FILL,
      })
        .id("hero-leaf")
        .offset(role === "out" ? MARKER.outX : MARKER.inX, MARKER.y),
    ],
    { align: "start" },
  ).id(`shared-${role}-stage`);
};

const entry = (role, transition) =>
  StageEntry({
    id: `shared-${role}`,
    source: "manifest-shared.mjs",
    start: role === "out" ? 0 : 1,
    duration: 2,
    transition,
    designSize: OUTPUT,
    background: BACKGROUND,
    view: () => sceneView(role),
  });

export const project = {
  name: "Lane B native shared correction",
  resolution: OUTPUT,
  aspectRatio: [8, 5],
  duration: 3,
  scenes: [
    entry("out", { type: "cut" }),
    entry("in", { type: "shared", duration: 1 }),
  ],
};

export default project;
