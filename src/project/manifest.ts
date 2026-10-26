import type { Project } from "../engine/types";
import { phrase } from "./audio/phrase";
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
  audioTracks: [
    {
      id: "a1",
      name: "A1",
      clips: [
        {
          id: "a1-phrase",
          name: "Phrase",
          start: 0,
          duration: 4,
          create: phrase(220),
        },
      ],
    },
    {
      id: "a2",
      name: "A2",
      clips: [
        {
          id: "a2-phrase",
          name: "Phrase",
          start: 2,
          duration: 6,
          create: phrase(330),
        },
      ],
    },
  ],
};
