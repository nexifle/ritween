import type { Project } from "../engine/types";
import intro from "./scenes/intro";
import main from "./scenes/main";
import outro from "./scenes/outro.js";
export const project: Project = {
  name: "Source to motion",
  resolution: [1280, 720],
  aspectRatio: [16, 9],
  duration: 8,
  scenes: [
    {
      id: "intro",
      name: "Intro",
      source: "scenes/intro.ts",
      start: 0,
      duration: 2,
      create: intro,
      transition: { type: "cut" },
    },
    {
      id: "main",
      name: "Pure geometry",
      source: "scenes/main.tsx",
      start: 2,
      duration: 4,
      create: main,
      transition: { type: "cut" },
    },
    {
      id: "outro",
      name: "Outro",
      source: "scenes/outro.js",
      start: 6,
      duration: 2,
      create: outro,
      transition: { type: "cut" },
    },
  ],
};
