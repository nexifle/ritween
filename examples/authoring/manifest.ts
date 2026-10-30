import {
  Box,
  HStack,
  Spacer,
  Stage,
  Text,
  VStack,
  ZStack,
  type Project,
} from "ritween";

const ink = "#202B38",
  blue = "#4268EC",
  muted = "#69717B";
const enter = { from: 0, to: 1, duration: 0.8 } as const;
const rise = { from: 28, to: 0, duration: 0.8 } as const;

export const project: Project = {
  name: "Declarative authoring · foundation",
  resolution: [1920, 1080],
  aspectRatio: [16, 9],
  duration: 8,
  scenes: [
    {
      id: "title",
      name: "Title card",
      source: "manifest.ts",
      start: 0,
      duration: 3,
      transition: { type: "cut" },
      create: () =>
        Stage(
          () =>
            ZStack([
              Box({ width: 1728, height: 888, fill: "#FFFFFF", radius: 40 }),
              VStack(
                [
                  Text("RITWEEN / DECLARATIVE VIDEO", {
                    size: 24,
                    tracking: 3,
                    color: blue,
                  }),
                  Text("Make ideas move.", {
                    size: 112,
                    weight: 800,
                    color: ink,
                  }),
                  Text(
                    "Compose the story. Let the framework handle the pixels.",
                    { size: 36, maxWidth: 960, align: "center", color: muted },
                  ),
                ],
                { gap: 28 },
              )
                .offset(0, rise)
                .opacity(enter)
                .id("title-content"),
            ]).frame({ width: "fill", height: "fill" }),
          { designSize: [1920, 1080] },
        ),
    },
    {
      id: "chart",
      name: "Data-driven bars",
      source: "manifest.ts",
      start: 3,
      duration: 5,
      transition: { type: "cut" },
      create: () =>
        Stage(
          () =>
            VStack(
              [
                Text("From values to visual rhythm.", {
                  size: 64,
                  color: ink,
                }).id("heading"),
                Text("One layout. Four values. No pixel coordinates.", {
                  size: 30,
                  color: muted,
                }),
                Spacer(),
                HStack(
                  [
                    { id: "ideas", label: "Ideas", value: 140 },
                    { id: "design", label: "Design", value: 260 },
                    { id: "motion", label: "Motion", value: 340 },
                    { id: "stories", label: "Stories", value: 440 },
                  ].map((item, i) =>
                    VStack(
                      [
                        Text(String(item.value), { size: 32, color: ink }),
                        Box({
                          width: 180,
                          height: item.value,
                          fill: i % 2 ? "#F37158" : blue,
                          radius: 12,
                        })
                          .scale(
                            1,
                            { ...enter, delay: 0.25 + i * 0.1 },
                            [0.5, 1],
                          )
                          .frame({ width: 240, height: 440, align: "end" }),
                        Text(item.label, { size: 30, color: muted }),
                      ],
                      { gap: 20 },
                    )
                      .frame({ width: "fill" })
                      .id(item.id),
                  ),
                  { gap: 32, align: "end" },
                ),
                Spacer(),
                Text("CODE → TREE → LAYOUT → WEBGPU", {
                  size: 22,
                  tracking: 2,
                  color: blue,
                }),
              ],
              { gap: 24, align: "start" },
            )
              .padding(96)
              .frame({ width: "fill", height: "fill" }),
          { designSize: [1920, 1080] },
        ),
    },
  ],
};
