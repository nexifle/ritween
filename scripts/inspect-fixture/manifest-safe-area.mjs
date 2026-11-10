import { Stage, SafeArea, Box, HStack } from "ritween";

export const project = {
  name: "G4 safe rectangle and timed layout rules",
  resolution: [320, 180],
  aspectRatio: [16, 9],
  duration: 3,
  scenes: [
    {
      id: "layout",
      name: "Layout",
      source: "fixture",
      start: 0,
      duration: 3,
      transition: { type: "cut" },
      create: () =>
        Stage(
          ({ time }) =>
            SafeArea(
              HStack(
                [
                  Box({ width: 40, height: 30 }).id("first"),
                  Box({ width: 40, height: 30 }).id("second"),
                ],
                { gap: time < 1 ? 4 : 12, align: "start" },
              ).id("row"),
              { left: 16, right: 16, top: 16, bottom: 16 },
            ).id("safe"),
          { designSize: [320, 180] },
        ),
    },
  ],
};
