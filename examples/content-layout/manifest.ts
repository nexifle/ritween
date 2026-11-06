import { type Project } from "ritween";
import { diagnosticsEntry } from "./src/scenes/diagnostics";

export const project: Project = {
  name: "Request context",
  resolution: [960, 720],
  aspectRatio: [4, 3],
  duration: 6,
  scenes: [diagnosticsEntry],
};
