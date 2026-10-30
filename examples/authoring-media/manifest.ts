import {
  Box,
  Circle,
  ForEach,
  Group,
  HStack,
  Image,
  Line,
  Motion,
  Shot,
  Text,
  VStack,
  World,
  type Project,
} from "ritween";

const data = [
  { id: "ideas", label: "IDEAS", value: 150 },
  { id: "layout", label: "LAYOUT", value: 240 },
  { id: "motion", label: "MOTION", value: 190 },
  { id: "video", label: "VIDEO", value: 310 },
];
const world = World(
  () =>
    VStack(
      [
        HStack(
          [
            Image({ url: "/media/mark.png", width: 72, height: 72 }),
            Text("From data to motion.", { size: 64 }),
          ],
          { gap: 24 },
        ),
        HStack(
          ForEach(
            data,
            (item) => item.id,
            (item, index) =>
              VStack(
                [
                  Box({
                    width: 110,
                    height: item.value,
                    radius: 12,
                    fill: index % 2 ? "#F37158" : "#4268EC",
                  })
                    .scale(
                      1,
                      Motion.stagger(
                        index,
                        0.08,
                        Motion.fade({ duration: 0.8 }),
                      ),
                      [0.5, 1],
                    )
                    .frame({ height: 320, align: "end" }),
                  Text(item.label, { size: 22 }),
                ],
                { gap: 16 },
              ),
          ),
          { gap: 48, align: "end" },
        ),
        Group([
          Line({
            from: [0, 0],
            to: [580, 0],
            width: 4,
            color: "#69717B",
            progress: Motion.fade({ duration: 1.2 }),
          }).offset(0, 40),
          Circle({
            radius: 42,
            stroke: "#4268EC",
            strokeWidth: 8,
            trim: [0, Motion.fade({ duration: 2 })],
          }).offset(640, 0),
        ]),
      ],
      { gap: 36, align: "start" },
    )
      .padding(72)
      .offset(0, Motion.slide())
      .opacity(Motion.fade()),
  { size: [1280, 720] },
);

export const project: Project = {
  name: "Authoring media and shapes",
  resolution: [1280, 720],
  aspectRatio: [16, 9],
  duration: 4,
  scenes: [
    Shot({
      id: "overview",
      source: "manifest.ts",
      start: 0,
      duration: 4,
      world,
    }),
  ],
};
