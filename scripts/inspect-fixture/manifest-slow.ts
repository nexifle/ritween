/**
 * Deliberately slow consumer variant. Cancellation must be provable while a frame is
 * actually being evaluated/written, not only during browser startup, so this manifest
 * renders a large layout that keeps the render phase open long enough to signal
 * deterministically. It is otherwise the same project, so the inspection contract is
 * unchanged.
 */
import {
  Box,
  HStack,
  Overlay,
  Spacer,
  StageEntry,
  Text,
  VStack,
} from "ritween";
import type { Project, SceneEntry } from "ritween";
import { HANDSHAKE_PORT } from "./config.ts";
import { FONT_PROBE, loadFonts } from "./scenes.ts";

export const fontProof = await loadFonts();

const theme = Object.freeze({
  colors: Object.freeze({
    background: "#F4F0E7",
    ink: "#202B38",
    accent: "#4268EC",
  }),
  font: "Ritween Fixture Inter, monospace",
  textColor: "#202B38",
});

/** 6000 text rows: enough layout work to keep the frame open for seconds. */
const ROWS = 6000;
const slow: SceneEntry = StageEntry({
  id: "slow",
  name: "Slow scene",
  source: "src/project/scenes-slow.ts",
  start: 0,
  duration: 4,
  transition: { type: "cut" },
  theme,
  view: () => {
    if (typeof HANDSHAKE_PORT === "number" && HANDSHAKE_PORT > 0) {
      fetch(`http://127.0.0.1:${HANDSHAKE_PORT}/render-started`).catch(
        () => {},
      );
    }
    return VStack(
      Array.from({ length: ROWS }, (_, index) =>
        HStack([
          Text(`row ${index} ${FONT_PROBE}`, { size: 12, wrap: false }).id(
            `row-${index}`,
          ),
          Spacer(),
          Box({ width: 40, height: 8 }).id(`bar-${index}`),
        ]),
      ),
      { gap: 0, align: "start" },
    )
      .id("rows")
      .padding(8);
  },
});

export const project: Project = {
  name: "G1b slow inspection consumer",
  resolution: [320, 180],
  aspectRatio: [16, 9],
  duration: 4,
  scenes: [slow],
  overlay: () =>
    Overlay(() => Text("SLOW", { size: 10, weight: 700 }).id("hud"), {
      theme,
    }),
};
export default project;
