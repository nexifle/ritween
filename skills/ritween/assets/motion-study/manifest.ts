import type { Project } from "ritween";
import motionStudy from "./scene";
import { accent } from "./audio";

export const project: Project = {
  name: "Motion study: paths to form",
  resolution: [640, 360],
  aspectRatio: [16, 9],
  duration: 6,
  settings: { version: 1, export: { resolution: [640, 360], fps: 30 } },
  scenes: [
    {
      id: "motion-study",
      name: "Paths, assembly, handoff",
      source: "scene.ts",
      start: 0,
      duration: 6,
      create: motionStudy,
      transition: { type: "cut" },
    },
  ],
  audioTracks: [
    {
      id: "accents",
      name: "Quiet accents",
      clips: [
        {
          id: "group",
          name: "Group assembles",
          start: 3.4,
          duration: 0.23,
          create: () => accent(392),
        },
        {
          id: "handoff",
          name: "Group arrives",
          start: 5.2,
          duration: 0.28,
          create: () => accent(294),
        },
      ],
    },
  ],
};
