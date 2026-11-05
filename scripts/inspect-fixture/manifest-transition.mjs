/**
 * Native built-in transition proof. Canvas 100×80, opaque black scene background.
 * Each pair is two seconds: outgoing at base, incoming at base+1, overlap 1.
 * The next pair starts at base+3 with a cut. No triple overlap.
 * Shared reuses id "hero" across the two scene scopes. Incoming is type shared, duration 1.
 */
import { Box, FrameSource, StageEntry, ZStack } from "ritween";

export { FrameSource };

export const OUTPUT = Object.freeze([100, 80]);
export const PAIR_SPAN = 3;
export const SOURCE_BOX = Object.freeze({ x: 10, y: 20, width: 30, height: 20 });
export const HERO = Object.freeze({ width: 20, height: 20, y: 20 });
/** Incoming-only crossfade interior. Not an overlap sample. */
export const TIME_A = 2.25;
/** Incoming-only shared interior. Not an overlap sample. */
export const TIME_B = 5.25;

const BACKGROUND = "#000000";
const RED = "#ff0000";
const BLUE = "#0000ff";
export const CUSTOM_SHADER =
  "fn transition(uv: vec2f, progress: f32) -> vec4f { return vec4f(1, 0, 0, 1); }";

export const PAIRS = Object.freeze([
  { key: "crossfade", transition: { type: "crossfade", duration: 1 } },
  { key: "shared", transition: { type: "shared", duration: 1 } },
  {
    key: "slide",
    transition: { type: "slide", duration: 1, direction: "left" },
  },
  { key: "zoom", transition: { type: "zoom", duration: 1 } },
  { key: "wipe", transition: { type: "wipe", duration: 1, direction: "up" } },
  {
    key: "custom",
    transition: { type: "custom", duration: 1, shader: CUSTOM_SHADER },
  },
]);

function background(id) {
  return Box({
    width: OUTPUT[0],
    height: OUTPUT[1],
    fill: BACKGROUND,
  })
    .background({ fill: BACKGROUND })
    .id(id);
}

function sceneView(key, role) {
  const fill = role === "out" ? RED : BLUE;
  const content =
    key === "shared"
      ? Box({ width: HERO.width, height: HERO.height, fill })
          .id("hero")
          .offset(role === "out" ? 0 : 60, HERO.y)
      : Box({
          width: SOURCE_BOX.width,
          height: SOURCE_BOX.height,
          fill,
        })
          .id(`${key}-${role}-box`)
          .offset(SOURCE_BOX.x, SOURCE_BOX.y);
  return ZStack([background(`${key}-${role}-bg`), content], {
    align: "start",
  }).id(`${key}-${role}-stage`);
}

function entry(key, role, index, transition) {
  const base = index * PAIR_SPAN;
  return StageEntry({
    id: `${key}-${role}`,
    name: `${key} ${role}`,
    source: "manifest-transition.mjs",
    start: role === "out" ? base : base + 1,
    duration: 2,
    transition,
    designSize: OUTPUT,
    background: BACKGROUND,
    view: () => sceneView(key, role),
  });
}

export const project = {
  name: "Lane B native transitions",
  resolution: OUTPUT,
  aspectRatio: [5, 4],
  duration: PAIRS.length * PAIR_SPAN,
  scenes: PAIRS.flatMap((pair, index) => [
    entry(pair.key, "out", index, { type: "cut" }),
    entry(pair.key, "in", index, pair.transition),
  ]),
};
