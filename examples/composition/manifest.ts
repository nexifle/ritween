import {
  Box,
  Camera,
  Composition,
  HStack,
  Shot,
  Text,
  VStack,
  World,
  ZStack,
  keyframes,
  type Project,
} from "ritween";

const card = (label: string, color: string) =>
  ZStack([
    Box({ width: 800, height: 440, fill: "#FFFFFF", radius: 36 }),
    VStack(
      [
        Box({ width: 80, height: 80, fill: color, radius: 20 }),
        Text(label, { size: 64, color: "#202B38" }),
      ],
      { gap: 28 },
    ),
  ]);
const cards = World(
  () =>
    VStack(
      [
        HStack([card("Ideas", "#4268EC"), card("Design", "#F37158")], {
          gap: 160,
        }),
        HStack([card("Motion", "#7D56D8"), card("Your story", "#4268EC")], {
          gap: 120,
        }),
      ],
      { gap: 120 },
    ),
  { size: [1760, 1000] },
);
const badge = World(
  () =>
    ZStack([
      Box({ width: 420, height: 130, fill: "#4268EC", radius: 24 }),
      Text("REUSABLE WORLD", { size: 24, color: "#FFFFFF", tracking: 2 }),
    ]),
  { size: [420, 130] },
);
const end = World(
  () =>
    VStack(
      [
        Text("One world. Many shots.", { size: 88, color: "#202B38" }),
        Composition(badge).id("badge"),
      ],
      { gap: 48 },
    ).frame({ width: "fill", height: "fill" }),
  { size: [1920, 1080] },
);
const overlay = () =>
  Text("RITWEEN / SCREEN-SPACE OVERLAY", {
    size: 22,
    tracking: 2,
    color: "#202B38",
  })
    .padding(48)
    .frame({ width: "fill", height: "fill", align: "start" });
const camera = Camera({
  x: keyframes([
    { at: 0, value: 400 },
    { at: 1, value: 400 },
    { at: 2.5, value: 880, ease: "ease-in-out" },
    { at: 3, value: 880 },
    { at: 4.5, value: 1360, ease: "ease-in-out" },
  ]),
  y: keyframes([
    { at: 0, value: 220 },
    { at: 1, value: 220 },
    { at: 2.5, value: 500, ease: "ease-in-out" },
    { at: 3, value: 500 },
    { at: 4.5, value: 780, ease: "ease-in-out" },
  ]),
  zoom: keyframes([
    { at: 0, value: 1.6 },
    { at: 1, value: 1.6 },
    { at: 2.5, value: 0.85, ease: "ease-in-out" },
    { at: 3, value: 0.85 },
    { at: 4.5, value: 1.6, ease: "ease-in-out" },
  ]),
});
export const project: Project = {
  name: "Worlds, shots and compositions",
  resolution: [1920, 1080],
  aspectRatio: [16, 9],
  duration: 9,
  scenes: [
    Shot({
      id: "reveal",
      name: "Reveal and refocus",
      source: "manifest.ts",
      start: 0,
      duration: 5,
      world: cards,
      camera,
      overlay,
      textResolution: 2,
    }),
    Shot({
      id: "continuation",
      name: "Same world, next shot",
      source: "manifest.ts",
      start: 5,
      duration: 1.5,
      world: cards,
      worldOffset: 5,
      camera: Camera({ x: 1360, y: 780, zoom: 1.6 }),
      overlay,
      textResolution: 2,
    }),
    Shot({
      id: "end",
      name: "Another world",
      source: "manifest.ts",
      start: 5.75,
      duration: 3.25,
      world: end,
      overlay,
      transition: { type: "crossfade", duration: 0.75 },
    }),
  ],
};
