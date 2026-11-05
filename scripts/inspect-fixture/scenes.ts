/**
 * G1b public-CLI inspection consumer fixture template
 * (docs/plans/declarative-layout-hardening.md §7 Gate).
 *
 * `scripts/validate-inspect.mjs` copies this directory plus the committed
 * `tests/fixtures/fonts/` files into an ignored `artifacts/` consumer project and
 * renders it through the real `bin/ritween.mjs inspect`. Keeping the source here
 * makes the gate reproducible from a clean checkout; nothing under `artifacts/`
 * is required to run it.
 *
 * The fixture mixes the three capability outcomes the gate requires:
 *
 * - two overlapping Stage scenes during a crossfade (1s–2s), both inspectable,
 * - a persistent project Overlay with its own project clock,
 * - one raw GPU Scene with no `inspect()` capability, published as unavailable
 *   with a reason instead of an empty tree.
 *
 * Typography comes from the committed SIL OFL Inter fixture, registered before the
 * renderer exists, so inspected geometry is real-font geometry.
 */
import type { Project, Scene, SceneEntry } from "ritween";
import { HANDSHAKE_PORT } from "./config.ts";
import {
  Box,
  Composition,
  HStack,
  Overlay,
  Spacer,
  StageEntry,
  Text,
  VStack,
  World,
} from "ritween";

export const FONT_FAMILY = "Ritween Fixture Inter";
const FONT_FILES: readonly [string, string][] = [
  ["/fonts/Inter-Regular.woff2", "400"],
  ["/fonts/Inter-Bold.woff2", "700"],
];

const theme = Object.freeze({
  colors: Object.freeze({
    background: "#F4F0E7",
    ink: "#202B38",
    accent: "#4268EC",
  }),
  font: `${FONT_FAMILY}, monospace`,
  textColor: "#202B38",
});

/** Reusable nested world: proves nested clocks and scoped spaces reach the report. */
export const nestedWorld = World(
  () =>
    VStack([
      Text("World title", { size: 18, weight: 700 }).id("world-title"),
      Box({ width: 120, height: 8, radius: 4, fill: "#4268EC" }).id("bar"),
    ]).id("world-stack"),
  { size: [180, 90] },
);

/**
 * Cards are 300 wide inside a 320-designed stage. The chips row deliberately
 * starves its flexible slot, so the fixture authors a real
 * `fixed-allocation-deficit` error rather than relying on a mock.
 */
function card(title: string, status: string, titleWeight: number) {
  return VStack(
    [
      HStack([
        Text(title, { size: 20, weight: titleWeight, maxWidth: 220 }).id(
          "title",
        ),
        Spacer(),
        Text(status, { size: 14 }).id("status"),
      ])
        .id("header")
        .frame({ width: 260 }),
      Text("decode queue dropped 1 frame while the export tail closed", {
        size: 13,
        wrap: false,
      }).id("warning-text"),
      HStack([
        Box({ width: 96, height: 12, radius: 6, fill: "#4268EC" }).id("chip-a"),
        Box({ width: 96, height: 12, radius: 6, fill: "#4268EC" }).id("chip-b"),
        Box({ width: 96, height: 12, radius: 6, fill: "#4268EC" }).id("chip-c"),
        Spacer(),
      ])
        .id("chips")
        .frame({ width: 260 }),
      Composition(nestedWorld, { rate: 2 }).id("nested"),
    ],
    { gap: 8, align: "start" },
  )
    .id("card")
    .padding(16)
    .frame({ width: 300 })
    .id("window");
}

/** Scene one: 0–2s. A cut means no leading overlap. */
function firstEntry(titleWeight: number): SceneEntry {
  return StageEntry({
    id: "first",
    name: "First scene",
    source: "src/project/scenes.ts",
    start: 0,
    duration: 2,
    transition: { type: "cut" },
    theme,
    view: () => card("Booting media pipeline", "3 events", titleWeight),
  });
}

/** Scene two: 1–3s, so a crossfade with scene one runs from 1s to 2s. */
function secondEntry(titleWeight: number): SceneEntry {
  return StageEntry({
    id: "second",
    name: "Second shot",
    source: "src/project/scenes.ts",
    start: 1,
    duration: 2,
    transition: { type: "crossfade", duration: 1 },
    theme,
    view: () => card("Export tail closed", "0 events", titleWeight),
  });
}

/** Scene three: raw GPU scene with deliberately no `inspect()` capability. */
function rawScene(): Scene {
  return {
    setup() {},
    render({ encoder, target }) {
      encoder
        .beginRenderPass({
          colorAttachments: [
            {
              view: target.createView(),
              loadOp: "clear",
              storeOp: "store",
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
            },
          ],
        })
        .end();
    },
    dispose() {},
  };
}
const raw: SceneEntry = {
  id: "raw",
  name: "Raw GPU scene",
  source: "src/project/scenes.ts",
  start: 3,
  duration: 1,
  transition: { type: "cut" },
  create: rawScene,
};

/**
 * Build the consumer project. `titleWeight` lets validation render the same text at
 * 400 and 700 and compare widths through the real CLI, which proves both faces are
 * loaded and rasterizing distinctly.
 */
export function createProject(titleWeight = 700): Project {
  return {
    name: "G1b inspection consumer",
    resolution: [320, 180],
    aspectRatio: [16, 9],
    duration: 4,
    scenes: [firstEntry(titleWeight), secondEntry(titleWeight), raw],
    overlay: () =>
      Overlay(
        () =>
          HStack([
            Text("PROJECT OVERLAY", { size: 10, weight: 700 }).id("hud-label"),
            Spacer(),
            Text("REC", { size: 10 }).id("hud-state"),
          ])
            .id("hud")
            .frame({ width: 200 })
            .padding(6),
        { theme },
      ),
  };
}

export const project: Project = createProject();

/**
 * Register both weights and prove each face actually rasterizes. `fonts.check`
 * alone is not accepted: each weight must load, and 400 and 700 must measure
 * differently from each other and from the fallback.
 */
export async function loadFonts(): Promise<{
  family: string;
  weights: {
    weight: string;
    measured: number;
    status: string;
    family: string;
  }[];
  fallback: number;
  documentFaces: { family: string; weight: string; status: string }[];
}> {
  const weights: {
    weight: string;
    measured: number;
    status: string;
    family: string;
  }[] = [];
  for (const [url, weight] of FONT_FILES) {
    const response = await fetch(url);
    if (!response.ok)
      throw Error(
        `Fixture font ${url} is unavailable: HTTP ${response.status}.`,
      );
    const face = new FontFace(FONT_FAMILY, await response.arrayBuffer(), {
      weight,
    });
    const loaded = await face.load();
    if (loaded !== face || face.status !== "loaded")
      throw Error(`Fixture font ${url} failed to load (${face.status}).`);
    document.fonts.add(face);
    if (!document.fonts.check(`${weight} 20px ${FONT_FAMILY}`))
      throw Error(`Font ${FONT_FAMILY} weight ${weight} is not usable.`);
    const context = document.createElement("canvas").getContext("2d")!;
    context.font = `${weight} 20px ${FONT_FAMILY}`;
    weights.push({
      weight,
      measured: context.measureText(FONT_PROBE).width,
      status: face.status,
      family: face.family,
    });
  }
  const fallbackContext = document.createElement("canvas").getContext("2d")!;
  fallbackContext.font = "20px monospace";
  const fallback = fallbackContext.measureText(FONT_PROBE).width;
  if (weights.some((entry) => entry.measured === fallback))
    throw Error(
      "A fixture face rasterizes like the fallback; it is not in use.",
    );
  if (weights[0].measured === weights[1].measured)
    throw Error(
      "Fixture 400 and 700 rasterize identically; bold is not in use.",
    );
  const documentFaces: { family: string; weight: string; status: string }[] =
    [];
  document.fonts.forEach((f) => {
    if (f.family === FONT_FAMILY) {
      documentFaces.push({
        family: f.family,
        weight: f.weight,
        status: f.status,
      });
    }
  });
  const proof = { family: FONT_FAMILY, weights, fallback, documentFaces };
  if (typeof HANDSHAKE_PORT === "number" && HANDSHAKE_PORT > 0) {
    try {
      await fetch(`http://127.0.0.1:${HANDSHAKE_PORT}/font-proof`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(proof),
      });
    } catch {}
  }
  return proof;
}

export const FONT_PROBE = "Ritween baseline 123";
