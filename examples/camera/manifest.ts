import {
  Box,
  Camera,
  HStack,
  Stage,
  Text,
  VStack,
  ZStack,
  keyframes,
  type Project,
} from "ritween";

const colors = ["#4268EC", "#F37158", "#7D56D8"];
const labels = [
  "Ideas",
  "Design",
  "Motion",
  "Layout",
  "Story",
  "Rhythm",
  "Data",
  "Sound",
  "Your next story",
];
const track = (values: readonly number[]) =>
  keyframes(
    values.map((value, i) => ({
      at: [0, 1, 2.4, 3.2, 4.6, 6][i],
      value,
      ease: "ease-in-out",
    })),
  );

export const project: Project = {
  name: "Camera · reveal and refocus",
  resolution: [1920, 1080],
  aspectRatio: [16, 9],
  duration: 7,
  scenes: [
    {
      id: "world",
      name: "Close → reveal → refocus",
      source: "manifest.ts",
      start: 0,
      duration: 7,
      transition: { type: "cut" },
      create: () =>
        Stage(
          () =>
            VStack(
              [0, 1, 2].map((row) =>
                HStack(
                  [0, 1, 2].map((column) => {
                    const i = row * 3 + column;
                    return ZStack([
                      Box({
                        width: 800,
                        height: 440,
                        fill: "#FFFFFF",
                        radius: 36,
                      }),
                      VStack(
                        [
                          Box({
                            width: 88,
                            height: 88,
                            fill: colors[column],
                            radius: 24,
                          }),
                          Text(labels[i], {
                            size: 64,
                            color: "#202B38",
                            weight: 800,
                          }),
                          Text(
                            i === 8
                              ? "A new focus. The same world."
                              : `0${i + 1} / SOURCE TO MOTION`,
                            { size: 24, tracking: 2, color: colors[column] },
                          ),
                        ],
                        { gap: 24 },
                      ),
                    ]).id(`card-${i}`);
                  }),
                  { gap: 160 },
                ).id(`row-${row}`),
              ),
              { gap: 120 },
            ),
          {
            designSize: [1920, 1080],
            textResolution: 2,
            camera: Camera({
              x: track([400, 400, 1360, 1360, 2320, 2320]),
              y: track([220, 220, 780, 780, 1340, 1340]),
              zoom: track([1.7, 1.7, 0.55, 0.55, 1.8, 1.8]),
              rotation: track([0, 0, -0.035, -0.035, 0, 0]),
            }),
          },
        ),
    },
  ],
};
