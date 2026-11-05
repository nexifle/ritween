/**
 * Lane B flat Text fixture. Design size equals output. No transition overlaps
 * the sample times. A and B are the same line-box draw quad shifted by OFFSET;
 * the quad is the texture box, not glyph ink.
 *
 * Both Inter faces load before this module finishes evaluating, which is before
 * FrameSource.create. config.ts is the consumer handshake port; the repo copy is 0.
 */
import { HANDSHAKE_PORT } from "./config.ts";
import { Box, FrameSource, StageEntry, Text, ZStack } from "ritween";

export { FrameSource };

export const OUTPUT = Object.freeze([320, 180]);
export const TIME_A = 0.25;
export const TIME_B = 1.25;
export const OFFSET = 40;
export const ORIGIN_X = 80;
export const ORIGIN_Y = 72;
export const EDGE_CLEARANCE = 40;
export const TEXT_ID = "ink";
export const BACKGROUND_ID = "bg-ink";
export const STAGE_ID = "flat-stage";
export const STYLE_ID = "ink-style";
export const FONT_FAMILY = "Ritween Fixture Inter";
export const TEXT = "H";
export const SIZE = 28;
export const WEIGHT = 700;
export const LINE_HEIGHT = 36;
export const QUAD_INSET = 2;
/** shortcut: 2px covers scale-1 linear filtering, raise it if textResolution bleeds further. */
export const OUTSIDE_MARGIN = 2;
export const BACKGROUND = "#112233";
export const INK = "#F7F4EC";

export const INK_STYLE = Object.freeze({
  id: STYLE_ID,
  font: FONT_FAMILY,
  size: SIZE,
  weight: WEIGHT,
  color: INK,
  align: "left",
  lineHeight: LINE_HEIGHT,
  wrap: false,
});
export const DRAWN_FONT = `${WEIGHT} ${SIZE}px ${FONT_FAMILY}`;

const theme = Object.freeze({
  colors: Object.freeze({ background: BACKGROUND, ink: INK }),
  font: FONT_FAMILY,
  textColor: INK,
});

const FONT_FILES = Object.freeze([
  ["/fonts/Inter-Regular.woff2", "400"],
  ["/fonts/Inter-Bold.woff2", "700"],
]);

function rgba(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return Object.freeze([
    (value >> 16) & 255,
    (value >> 8) & 255,
    value & 255,
    255,
  ]);
}

export const BACKGROUND_RGBA = rgba(BACKGROUND);
export const INK_RGBA = rgba(INK);

function backgroundSibling() {
  return Box({
    width: OUTPUT[0],
    height: OUTPUT[1],
    fill: BACKGROUND,
  })
    .background({ fill: BACKGROUND })
    .id(BACKGROUND_ID);
}

function inkView(originX) {
  return ZStack(
    [
      backgroundSibling(),
      Text(TEXT, {
        font: INK_STYLE.font,
        size: INK_STYLE.size,
        weight: INK_STYLE.weight,
        color: INK_STYLE.color,
        align: INK_STYLE.align,
        lineHeight: INK_STYLE.lineHeight,
        wrap: INK_STYLE.wrap,
      })
        .id(TEXT_ID)
        .offset(originX, ORIGIN_Y),
    ],
    { align: "start" },
  ).id(STAGE_ID);
}

const stage = {
  source: "scenes.ts",
  designSize: OUTPUT,
  background: BACKGROUND,
  transition: { type: "cut" },
  theme,
};

export const project = {
  name: "Lane B flat text inspection",
  resolution: OUTPUT,
  aspectRatio: [16, 9],
  duration: 2,
  scenes: [
    StageEntry({
      ...stage,
      id: "flat",
      name: "Flat text",
      start: 0,
      duration: 2,
      view: ({ localTime }) =>
        inkView(localTime < 1 ? ORIGIN_X : ORIGIN_X + OFFSET),
    }),
  ],
};

export default project;

export async function loadFonts() {
  const weights = [];
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
    weights.push({ weight, status: face.status, family: face.family });
  }
  const documentFaces = [];
  document.fonts.forEach((face) => {
    if (face.family === FONT_FAMILY)
      documentFaces.push({
        family: face.family,
        weight: String(face.weight),
        status: face.status,
      });
  });
  const proof = { family: FONT_FAMILY, weights, documentFaces };
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

export const fontProof = await loadFonts();
