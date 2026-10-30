import type { Project } from "../engine/types";
import opening from "./scenes/opening";
import charts from "./scenes/charts";
import npr from "./scenes/npr";
import synthesis from "./scenes/synthesis";
import camera from "./scenes/camera";
import pipeline from "./scenes/pipeline";
import benchmark from "./scenes/benchmark";
import closing from "./scenes/closing";
import { score, effects } from "./audio/score";
export const project: Project = {
  name: "Ritween — Source to motion",
  resolution: [1920, 1080],
  aspectRatio: [16, 9],
  duration: 45,
  settings: {
    version: 1,
    export: { resolution: [1920, 1080], fps: 60, bitrate: 16000000 },
  },
  scenes: [
    {
      source: "scenes/opening.ts",
      create: opening,
      id: "opening",
      name: "Opening · Source to motion",
      start: 0,
      duration: 6,
    },
    {
      source: "scenes/charts.ts",
      create: charts,
      id: "charts",
      name: "01 · Charts",
      start: 6,
      duration: 5,
    },
    {
      source: "scenes/npr.ts",
      create: npr,
      id: "npr",
      name: "02 · NPR animation",
      start: 11,
      duration: 5,
    },
    {
      source: "scenes/synthesis.ts",
      create: synthesis,
      id: "synthesis",
      name: "03 · Sound synthesis",
      start: 16,
      duration: 5,
    },
    {
      source: "scenes/camera.ts",
      create: camera,
      id: "camera",
      name: "04 · Camera & impact",
      start: 21,
      duration: 6,
    },
    {
      source: "scenes/pipeline.ts",
      create: pipeline,
      id: "pipeline",
      name: "05 · Render pipeline",
      start: 27,
      duration: 5,
    },
    {
      source: "scenes/benchmark.ts",
      create: benchmark,
      id: "benchmark",
      name: "06 · Benchmark",
      start: 32,
      duration: 7,
    },
    {
      source: "scenes/closing.ts",
      create: closing,
      id: "closing",
      name: "Closing · More frames. Less wait.",
      start: 39,
      duration: 6,
    },
  ].map((entry) => ({ ...entry, transition: { type: "cut" as const } })),
  audioTracks: [
    {
      id: "music",
      name: "Original • Circuit Playground / 120 BPM",
      clips: [
        {
          id: "score",
          name: "Electronic score",
          start: 0,
          duration: 45,
          create: score,
        },
      ],
    },
    {
      id: "sfx",
      name: "Synchronized motion accents",
      clips: [
        {
          id: "effects",
          name: "Impacts, sweeps and interface ticks",
          start: 0,
          duration: 45,
          create: effects,
        },
      ],
    },
  ],
};
