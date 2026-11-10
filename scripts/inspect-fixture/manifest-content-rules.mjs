import { Stage, SafeArea, Text, Box, HStack, VStack, ZStack } from "ritween";

export const fixtureTimes = Object.freeze({ entrance: [0, 0.15, 0.3], compact: [0.5, 1], expanded: [2, 3], shake: [4, 4.1, 4.2, 4.3, 4.4], settled: [4.5, 5] });
const family = "Ritween G4 Inter";
export const fontProof = [];
for (const [file, weight] of [["Inter-Regular.woff2", "400"], ["Inter-Bold.woff2", "700"]]) {
  const url = new URL(`../../tests/fixtures/fonts/${file}`, import.meta.url);
  const response = await fetch(url);
  if (!response.ok) throw Error(`Fixture font unavailable: ${url}`);
  const bytes = await response.arrayBuffer();
  const face = await new FontFace(family, bytes, { weight }).load();
  document.fonts.add(face);
  if (face.status !== "loaded" || ![...document.fonts].includes(face)) throw Error("Fixture face registration failed");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  context.font = `${weight} 20px "${family}"`;
  const width = context.measureText("Search logs WWW iii").width;
  context.font = `${weight} 20px monospace`;
  if (width === context.measureText("Search logs WWW iii").width) throw Error("Fixture font fallback detected");
  fontProof.push({ file, weight, bytes: bytes.byteLength, width, status: face.status });
}
const label = (text, id, poor = false) => Text(text, { font: family, size: poor ? 9 : 16, lineHeight: 22, color: poor ? "#273344" : "#e7edf7", wrap: false }).id(id);
export function makeProject(variant = "valid") {
  return {
    name: `G4 content-driven ${variant}`, resolution: [640, 360], aspectRatio: [16, 9], duration: 6,
    scenes: [{ id: "content", name: "Content", source: "fixture", start: 0, duration: 6, transition: { type: "cut" }, create: () => Stage(({ time }) => {
      const poor = variant === "poor";
      const expanded = time >= 2;
      const gap = variant === "broken-gap" ? 2 : 12;
      const query = "request timeout".slice(0, Math.min(15, Math.floor(time * 8)));
      const search = HStack([label(`Search: ${query}`, "query", poor).flex(), Box({ width: 64, height: 22, fill: "#5688dc" }).id("button")], { gap, align: "start" }).frame({ width: 544, alignX: "start" }).id("search");
      const logs = VStack(Array.from({ length: 9 }, (_, i) => label(`${i + 1}  INFO request=${101 + i} duration=${20 + i}ms`, `log-${i}`, poor)), { gap: 4, align: "start" }).offset(0, -Math.max(0, time - 2) * 12).frame({ width: 544, height: expanded ? 90 : 44, alignX: "start", alignY: "start" }).clip().id("logs");
      const content = VStack([
        label(expanded ? "Request diagnostics — production service" : "Request diagnostics", "title", poor),
        label(expanded ? "Status: degraded · retry budget exhausted" : "Status: healthy", "status", poor),
        search,
        logs,
        label(expanded ? "Warning: slow requests need structured context" : "Waiting for incoming requests", "warning", poor),
        label(time >= 4 ? "ALERT: upstream timeout" : "No active alerts", "alert", poor),
      ], { gap: 8, align: "start" }).id("panel");
      const entrance = time < 0.3 ? -40 * (1 - time / 0.3) ** 3 : 0;
      const shake = time >= 4 && time < 4.4 ? 12 * Math.sin((time - 4) * Math.PI * 15) : 0;
      const moving = SafeArea(SafeArea(content, { left: 24, right: 24, top: 12, bottom: 12 }).id("inner-safe"), { left: 24, right: 24, top: 16, bottom: 16 }).id("outer-safe").offset(entrance + shake + (variant === "broken-output" ? 100 : 0), 0);
      return ZStack([Box({ width: 640, height: 360, fill: "#101824" }).id("screen"), moving]);
    }, { designSize: [640, 360] }) }],
  };
}
export const project = makeProject();
