import {
  Box,
  HStack,
  Overlay,
  Shot,
  Text,
  World,
  ZStack,
  type Project,
} from "ritween";

const size = [1280, 720] as const;
const world = (label: string, fill: string) =>
  World(
    () =>
      ZStack(
        [
          Box({ width: 1280, height: 720, fill }),
          ...[0, 1, 2, 3, 4].map((i) =>
            Box({
              width: 72,
              height: 180 + i * 60,
              fill: "#FFFFFF",
              radius: 12,
            })
              .opacity(0.15)
              .offset(160 + i * 210, 100),
          ),
          Text(label, { size: 72, color: "#FFFFFF", weight: 800 }).offset(
            160,
            310,
          ),
        ],
        { align: "start" },
      ),
    { size },
  );

export const project: Project = {
  name: "Persistent overlay · outside the transition",
  resolution: size,
  aspectRatio: [16, 9],
  duration: 5,
  overlay: () =>
    Overlay(
      ({ localTime }) =>
        ZStack(
          [
            Box({ width: 550, height: 72, radius: 18, fill: "#102030" }).offset(
              40,
              32,
            ),
            HStack(
              [
                Text("ritween", { size: 30, color: "#8CE5C2", weight: 800 }),
                Text("PERSISTENT PROJECT OVERLAY", {
                  size: 16,
                  color: "#FFFFFF",
                  tracking: 1,
                }),
              ],
              { gap: 24 },
            ).offset(64, 52),
            Box({ width: 1200, height: 4, fill: "#FFFFFF" })
              .opacity(0.2)
              .offset(40, 670),
            Box({
              width: (localTime / 5) * 1200,
              height: 4,
              fill: "#8CE5C2",
            }).offset(40, 670),
          ],
          { align: "start" },
        ),
      { designSize: size },
    ),
  scenes: [
    Shot({
      id: "a",
      source: "manifest.ts",
      start: 0,
      duration: 3,
      designSize: size,
      world: world("A different perspective.", "#233C75"),
    }),
    Shot({
      id: "b",
      source: "manifest.ts",
      start: 2,
      duration: 3,
      designSize: size,
      world: world("The same identity.", "#5B285D"),
      transition: { type: "zoom", duration: 1 },
    }),
  ],
};
