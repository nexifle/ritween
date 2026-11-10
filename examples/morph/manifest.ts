import {
  Box,
  Glyph,
  Path,
  Stage,
  Text,
  ZStack,
  type PathOutline,
  type Project,
} from "../../src/index";

const square: PathOutline = [
  ["M", 0, 0],
  ["L", 200, 0],
  ["L", 200, 200],
  ["L", 0, 200],
  ["Z"],
];
const diamond: PathOutline = [
  ["M", 100, 0],
  ["L", 200, 100],
  ["L", 100, 200],
  ["L", 0, 100],
  ["Z"],
];
// Hand-authored letter silhouettes, not outlines extracted from a browser font.
// Both contours have corresponding vertices so the entire glyph changes geometry.
const letterA: PathOutline = [
  ["M", 80, 0],
  ["L", 120, 0],
  ["L", 200, 200],
  ["L", 155, 200],
  ["L", 135, 145],
  ["L", 65, 145],
  ["L", 45, 200],
  ["L", 0, 200],
  ["Z"],
  ["M", 100, 55],
  ["L", 120, 110],
  ["L", 80, 110],
  ["Z"],
];
const letterO: PathOutline = [
  ["M", 60, 0],
  ["L", 140, 0],
  ["L", 200, 60],
  ["L", 200, 140],
  ["L", 140, 200],
  ["L", 60, 200],
  ["L", 0, 140],
  ["L", 0, 60],
  ["Z"],
  ["M", 100, 40],
  ["L", 155, 150],
  ["L", 45, 150],
  ["Z"],
];
const progress = {
  keyframes: [
    { at: 0, value: 0 },
    { at: 1, value: 0 },
    { at: 2.5, value: 1, ease: "ease-in-out" as const },
    { at: 3.5, value: 1 },
    { at: 5, value: 0, ease: "ease-in-out" as const },
    { at: 6, value: 0 },
  ],
};
export const project: Project = {
  name: "Path and glyph morph",
  resolution: [1280, 720],
  aspectRatio: [16, 9],
  duration: 6,
  scenes: [
    {
      id: "morph",
      name: "Geometry, not a crossfade",
      source: "manifest.ts",
      start: 0,
      duration: 6,
      transition: { type: "cut" },
      create: () =>
        Stage(
          () =>
            ZStack(
              [
                Text("MORPH / OUTLINE STUDY", {
                  size: 20,
                  color: "#92A4BC",
                  tracking: 3,
                }).offset(72, 54),
                Text("Geometry, not a crossfade.", {
                  size: 48,
                  color: "#F4F7FC",
                }).offset(72, 104),
                Box({
                  width: 548,
                  height: 390,
                  radius: 24,
                  fill: "#17243A",
                }).offset(72, 220),
                Box({
                  width: 548,
                  height: 390,
                  radius: 24,
                  fill: "#17243A",
                }).offset(660, 220),
                Path(square, {
                  width: 200,
                  height: 200,
                  fill: "#6FA8FF",
                  to: diamond,
                  progress,
                }).offset(246, 276),
                Glyph(
                  { outline: letterA, advance: 200 },
                  {
                    width: 200,
                    height: 200,
                    fill: "#FFCA78",
                    fillRule: "evenodd",
                    toGlyph: { outline: letterO, advance: 200 },
                    progress,
                  },
                ).offset(834, 276),
                Text("PATH   /   SQUARE ↔ DIAMOND", {
                  size: 20,
                  color: "#B8C8DF",
                }).offset(104, 550),
                Text("GLYPH   /   A ↔ O", {
                  size: 20,
                  color: "#B8C8DF",
                }).offset(692, 550),
                Text(
                  "Same contours · deterministic time · reversible seeking",
                  { size: 20, color: "#92A4BC" },
                ).offset(72, 654),
              ],
              { align: "start" },
            ),
          { designSize: [1280, 720], background: "#0B1220" },
        ),
    },
  ],
};
