import { Stage, Text, ZStack, Box } from "ritween";

export const family = "Ritween G5 Inter";
export const delayedFamily = "Ritween G5 Conditional";
export const cases = [
  {
    id: "long",
    text: "WWWWWWWWWWWWWWWWWWWWWWWW",
    size: 18,
    width: 104,
    tracking: 0.5,
    lineHeight: 25,
  },
  {
    id: "newlines",
    text: "Alpha\n\nBeta",
    size: 18,
    width: 160,
    tracking: 1,
    lineHeight: 24,
  },
  { id: "empty", text: "", size: 18, width: 160, tracking: 0, lineHeight: 24 },
  {
    id: "combining",
    text: "e\u0301  A\u030a\t n\u0303",
    size: 25,
    width: 180,
    tracking: 1.25,
    lineHeight: 34,
  },
  {
    id: "emoji",
    text: "A 😀 B",
    size: 24,
    width: 180,
    tracking: 0,
    lineHeight: 34,
  },
  {
    id: "bold",
    text: "Bold WWW iii",
    size: 21,
    weight: 700,
    width: 180,
    tracking: 0.75,
    lineHeight: 29,
  },
];
// Tight line box deliberately clips ascenders/descenders at the texture quad.
cases.push({
  id: "tight",
  text: "Ágj e\u0301",
  size: 32,
  width: 180,
  tracking: 0,
  lineHeight: 16,
});
export const fonts = [
  {
    family,
    source: new URL(
      "../../tests/fixtures/fonts/Inter-Regular.woff2",
      import.meta.url,
    ).href,
    weight: "400",
  },
  {
    family,
    source: new URL(
      "../../tests/fixtures/fonts/Inter-Bold.woff2",
      import.meta.url,
    ).href,
    weight: "700",
  },
  {
    family: delayedFamily,
    source: new URL(
      "../../tests/fixtures/fonts/Inter-Bold.woff2?g5-delay",
      import.meta.url,
    ).href,
    weight: "700",
  },
];
export let activeScene;
export const project = {
  name: "G5 typography",
  resolution: [640, 480],
  aspectRatio: [4, 3],
  duration: 4,
  scenes: [
    {
      id: "typography",
      name: "Typography",
      source: "fixture",
      start: 0,
      duration: 4,
      transition: { type: "cut" },
      create: () =>
        (activeScene = Stage(
          ({ time }) => {
            const items = cases.map((c, i) =>
              Text(c.text, {
                font: family,
                weight: c.weight ?? 400,
                size: c.size,
                tracking: c.tracking,
                lineHeight: c.lineHeight,
                maxWidth: c.width,
                color: "#ffffff",
              })
                .id(c.id)
                .offset(12 + (i % 3) * 200, 12 + Math.floor(i / 3) * 160),
            );
            const scrolling = Text(
              "FIRST line\nSECOND line\nTHIRD line\nFOURTH line",
              {
                font: family,
                weight: 400,
                size: 22,
                lineHeight: 30,
                color: "#ffffff",
                wrap: false,
              },
            )
              .offset(0, -time * 17.25)
              .frame({
                width: 240,
                height: 47,
                alignX: "start",
                alignY: "start",
              })
              .clip()
              .id("scroll")
              .offset(12, 370);
            items.push(scrolling);
            items.push(
              Text(time >= 1 ? "Conditional WWW" : "Initial iii", {
                font: time >= 1 ? delayedFamily : family,
                weight: time >= 1 ? 700 : 400,
                size: 24,
                lineHeight: 34,
                color: "#ffffff",
                wrap: false,
              })
                .id("conditional")
                .offset(300, 370),
            );
            items.push(
              Text("NEGATIVE", {
                font: family,
                weight: 400,
                size: 20,
                lineHeight: 28,
                color: "#ffffff",
                wrap: false,
              })
                .scale(-1, 1)
                .frame({
                  width: 170,
                  height: 32,
                  alignX: "start",
                  alignY: "start",
                })
                .clip()
                .offset(300, 425),
            );
            items.push(
              Text("ZERO", {
                font: family,
                weight: 400,
                size: 20,
                color: "#ffffff",
              })
                .scale(0)
                .offset(550, 430),
            );
            items.push(
              Box({
                width: 80,
                height: 30,
                fill: "#000000",
                stroke: "#ff0000",
                strokeWidth: 4,
              }).offset(12, 435),
            );
            return ZStack(items, { align: "start" });
          },
          { designSize: [640, 480], background: "#000000", fonts },
        )),
    },
  ],
};
