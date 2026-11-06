import {
  StageEntry,
  SafeArea,
  Text,
  HStack,
  VStack,
  ZStack,
  Box,
} from "ritween";

const family = "Request Context Inter";
const fonts = [
  {
    family,
    source: new URL("../../public/fonts/Inter-Regular.woff2", import.meta.url)
      .href,
    weight: "400",
  },
  {
    family,
    source: new URL("../../public/fonts/Inter-Bold.woff2", import.meta.url)
      .href,
    weight: "700",
  },
];
const ink = "#e9eef7";
const text = (value: string, id: string, size = 20) =>
  Text(value, { font: family, size, lineHeight: size + 8, color: ink }).id(id);

export const diagnosticsEntry = StageEntry({
  id: "requests",
  source: "src/scenes/diagnostics.ts",
  start: 0,
  duration: 6,
  designSize: [960, 720],
  fonts,
  view: ({ time }) => {
    const expanded = time >= 2 && time < 4;
    const resolved = time >= 4;
    const query = time < 1 ? "request" : "request timeout / checkout";
    const search = HStack(
      [
        text(query, "query").flex(3),
        text(resolved ? "Resolved" : "Live", "status").flex(1),
        text("Filter", "filter")
          .padding({ left: 16, right: 16, top: 8, bottom: 8 })
          .background({ fill: "#3156a0", radius: 8 })
          .id("button"),
      ],
      { gap: 16, align: "center" },
    )
      .frame({ width: "fill", alignX: "start" })
      .id("search");
    const summary = VStack(
      [
        Text(
          resolved ? "Context restored" : "Follow the request, not the noise",
          {
            font: family,
            weight: 700,
            size: 30,
            lineHeight: 40,
            color: ink,
          },
        ).id("title"),
        text(
          expanded
            ? "The checkout service exceeded its retry budget. Include the request ID, upstream duration, and retry count so the next investigation starts with context."
            : resolved
              ? "Structured events connect the symptom to its upstream cause."
              : "One request ID connects every event in the checkout path.",
          "description",
        ),
        search,
      ],
      { gap: 16, align: "start" },
    )
      .padding(24)
      .background({ fill: "#1b2a41", radius: 16 })
      .id("summary");
    const rows = [
      "09:41:00  INFO  checkout started · request=7f2",
      "09:41:01  INFO  inventory reserved · items=3",
      "09:41:02  WARN  upstream slow · duration=840ms",
      "09:41:03  WARN  retry scheduled · attempt=2",
      "09:41:04  INFO  trace attached · upstream=payments",
      "09:41:05  INFO  recovery complete · request=7f2",
    ];
    const logs = VStack(
      rows.map((row, i) => text(row, `event-${i}`, 18)),
      { gap: 8, align: "start" },
    )
      // Move the content, never the viewport wrappers.
      .offset(0, -Math.max(0, time - 2) * 19.25)
      .frame({ width: "fill", height: 112, alignX: "start", alignY: "start" })
      .clip()
      .id("scroll");
    const events = VStack([text("EVENT STREAM", "stream-heading", 16), logs], {
      gap: 12,
      align: "start",
    })
      .padding(24)
      .background({ fill: "#152238", radius: 16 })
      .id("events");
    const content = VStack([summary, events], { gap: 24, align: "start" })
      .id("content")
      .offset(0, time < 0.4 ? 16 * (1 - time / 0.4) ** 3 : 0);
    return ZStack([
      Box({ width: 960, height: 720, fill: "#0b1322" }).id("screen"),
      SafeArea(content, { left: 48, right: 48, top: 48, bottom: 48 }).id(
        "safe",
      ),
    ]);
  },
});
