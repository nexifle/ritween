/**
 * G0 regression fixture for the declarative layout engine
 * (docs/plans/declarative-layout-hardening.md §5.5–5.6).
 *
 * One reusable content-driven window: search typing, variable title/status text,
 * compact/expanded widths, a warning row, an alert that rises in, and a scrolling
 * log list inside a stationary clip. Every node that later gates must keep stable
 * carries an explicit ID, and every state change happens at a recorded project time.
 *
 * Counting rule for the stress fixture: one LayoutNode per evaluated ViewNode,
 * including modifier wrappers (padding/frame/offset/opacity/scale/clip) and Group
 * nodes. Nested Composition trees are attached as LayoutNode children by
 * evaluateView, so the stress fixture deliberately contains no Composition node to
 * keep the 1000-node count unambiguous.
 */
import {
  Box,
  ForEach,
  HStack,
  Spacer,
  Text,
  VStack,
  ZStack,
  defaultTheme,
  evaluateView,
  motion,
} from "../../src/authoring/index";
import type {
  DrawCommand,
  EvaluatedFrame,
  LayoutNode,
  MeasureText,
  Theme,
  ViewNode,
} from "../../src/authoring/index";

/** Deterministic measurer used by unit tests; browser baselines pass a real one
 * through `evaluateRegression`/`evaluateStress` options. */
export function fixtureMeasureText(
  text: string,
  _font: string,
  tracking: number,
): number {
  const count = Array.from(text).length;
  return count * 10 + Math.max(0, count - 1) * tracking;
}

/** Fixture typography: pass a provisioned fixture font family for real-font runs. */
export function fixtureTheme(font: string = defaultTheme.font): Theme {
  return Object.freeze({
    ...defaultTheme,
    font,
    colors: Object.freeze({ ...defaultTheme.colors }),
  });
}

export const regressionStage = Object.freeze({ width: 960, height: 540 });
/** Window padding; the log viewport insets by it on every side. */
export const regressionPadding = 16;

/** Compact window before the resize, expanded after it. */
export const regressionWindowWidth = Object.freeze({
  compact: 420,
  expanded: 560,
});
export const regressionLogViewportHeight = Object.freeze({
  compact: 120,
  expanded: 200,
});

const SEARCH_QUERY = "media";
const EVENTS = Object.freeze([
  { id: "boot", text: "boot: renderer ready" },
  { id: "gpu-adapter", text: "gpu: adapter ok" },
  { id: "gpu-pass", text: "gpu: 3 passes" },
  { id: "gpu-cache", text: "gpu: cache warm" },
  { id: "media-mix", text: "media: audio mix" },
  { id: "media-decode", text: "media: decode drop" },
  { id: "export-frame", text: "export: frame muxed" },
  { id: "export-tail", text: "export: tail closed" },
  { id: "search-miss", text: "search: no match" },
  { id: "search-hit", text: "search: hit" },
  { id: "idle-wait", text: "idle: waiting" },
  { id: "idle-sleep", text: "idle: sleeping" },
]);

/** Project-clock boundaries; state tests sample on and just inside each edge. */
export const regressionTimeline = Object.freeze({
  typing: { start: 0.5, end: 2 },
  attention: 2.4,
  alertSettle: 2.7,
  scroll: { start: 3, end: 4, distance: 96 },
  resize: { start: 4.5, end: 5 },
});

export const regressionStates = Object.freeze([
  { id: "idle", time: 0 },
  { id: "typing-start", time: regressionTimeline.typing.start },
  { id: "typing-mid", time: 1.25 },
  { id: "typed", time: regressionTimeline.typing.end },
  { id: "warning-in", time: regressionTimeline.attention },
  { id: "alert-settled", time: regressionTimeline.alertSettle },
  { id: "scrolling", time: 3.5 },
  { id: "scroll-end", time: regressionTimeline.scroll.end },
  { id: "compact-end", time: regressionTimeline.resize.start },
  { id: "expanded", time: regressionTimeline.resize.end },
]);

/** IDs present in every state. Alert/warning IDs appear from the attention boundary. */
export const regressionStableIds = Object.freeze([
  "window",
  "header",
  "title",
  "status",
  "search",
  "search-label",
  "search-value",
  "logs",
]);
export const regressionAttentionIds = Object.freeze([
  "warning",
  "warning-mark",
  "warning-text",
  "alert",
  "alert-badge",
  "alert-text",
]);

function typedQuery(time: number): string {
  const typed = motion(
    {
      from: 0,
      to: SEARCH_QUERY.length,
      delay: regressionTimeline.typing.start,
      duration: regressionTimeline.typing.end - regressionTimeline.typing.start,
      ease: "linear",
    },
    time,
  );
  return SEARCH_QUERY.slice(0, Math.round(typed));
}

function windowWidth(time: number): number {
  return motion(
    {
      from: regressionWindowWidth.compact,
      to: regressionWindowWidth.expanded,
      delay: regressionTimeline.resize.start,
      duration: regressionTimeline.resize.end - regressionTimeline.resize.start,
      ease: "linear",
    },
    time,
  );
}

function logViewportHeight(time: number): number {
  return motion(
    {
      from: regressionLogViewportHeight.compact,
      to: regressionLogViewportHeight.expanded,
      delay: regressionTimeline.resize.start,
      duration: regressionTimeline.resize.end - regressionTimeline.resize.start,
      ease: "linear",
    },
    time,
  );
}

/** Scrolling logs move inside a fixed frame; the clip viewport itself never moves. */
function logScroll(time: number): number {
  return motion(
    {
      from: 0,
      to: regressionTimeline.scroll.distance,
      delay: regressionTimeline.scroll.start,
      duration: regressionTimeline.scroll.end - regressionTimeline.scroll.start,
      ease: "linear",
    },
    time,
  );
}

function alertRise(time: number): number {
  return motion(
    {
      from: -12,
      to: 0,
      delay: regressionTimeline.attention,
      duration: regressionTimeline.alertSettle - regressionTimeline.attention,
      ease: "linear",
    },
    time,
  );
}

export function regressionView(time: number): ViewNode {
  const query = typedQuery(time);
  const visible = EVENTS.filter((event) => event.text.includes(query));
  const width = windowWidth(time);
  const attention = time >= regressionTimeline.attention;
  return VStack(
    [
      HStack(
        [
          Text(query ? `Results for "${query}"` : "All events", {
            size: 20,
            weight: 700,
            maxWidth: 200,
          }).id("title"),
          Spacer(),
          Text(`${visible.length} events`, { size: 14 }).id("status"),
        ],
        { gap: 12 },
      ).id("header"),
      HStack(
        [
          Text("Search", { size: 12 }).id("search-label"),
          Text(query || "-", { size: 16, wrap: false })
            .frame({ width: 200, align: "start" })
            .id("search-value"),
        ],
        { gap: 8 },
      ).id("search"),
      ...(attention
        ? [
            HStack(
              [
                Box({ width: 6, height: 14, radius: 3, fill: "#B3341F" }).id(
                  "warning-mark",
                ),
                Text("decode queue dropped 1 frame", {
                  size: 12,
                  wrap: false,
                }).id("warning-text"),
              ],
              { gap: 8 },
            ).id("warning"),
            ZStack(
              [
                Box({ width: 260, height: 28, radius: 8, fill: "#FDE8E4" }).id(
                  "alert-badge",
                ),
                Text("2 events need attention", { size: 12, wrap: false }).id(
                  "alert-text",
                ),
              ],
              { align: "start" },
            )
              .offset(0, alertRise(time))
              .id("alert"),
          ]
        : []),
      VStack(
        ForEach(
          visible,
          (event) => event.id,
          (event) => Text(event.text, { size: 12, wrap: false }),
        ),
        { gap: 6, align: "start" },
      )
        .offset(0, -logScroll(time))
        .frame({
          width: width - 32,
          height: logViewportHeight(time),
          align: "start",
        })
        .clip({ shape: "rect", radius: 8 })
        .id("logs"),
    ],
    { gap: 12, align: "start" },
  )
    .padding(16)
    .frame({ width, align: "start" })
    .id("window");
}

export function evaluateRegression(
  time: number,
  options: { font?: string; measureText?: MeasureText } = {},
): EvaluatedFrame {
  return evaluateView(regressionView(time), {
    time,
    width: regressionStage.width,
    height: regressionStage.height,
    theme: fixtureTheme(options.font),
    measureText: options.measureText ?? fixtureMeasureText,
  });
}

export function layoutNodes(tree: LayoutNode): LayoutNode[] {
  return [tree, ...tree.children.flatMap(layoutNodes)];
}

/** One LayoutNode per evaluated ViewNode, including modifier wrappers. */
export function countLayoutNodes(tree: LayoutNode): number {
  return (
    1 +
    tree.children.reduce((total, child) => total + countLayoutNodes(child), 0)
  );
}

/** Node paths are `/`-joined; the fixture root uses its ID as the whole path. */
export function hasLayoutId(path: string, id: string): boolean {
  return path === id || path.endsWith(`/${id}`);
}

export function layoutNodeById(
  tree: LayoutNode,
  id: string,
): LayoutNode | undefined {
  return layoutNodes(tree).find((candidate) => hasLayoutId(candidate.path, id));
}

export function requireLayoutNode(tree: LayoutNode, id: string): LayoutNode {
  const node = layoutNodeById(tree, id);
  if (!node) throw Error(`Missing layout node: ${id}`);
  return node;
}

/**
 * Every row is exactly nine nodes: zstack, box, padding, vstack, 2 texts,
 * hstack, box, text. Text diversity is bounded on purpose: the production
 * ViewRenderer text cache holds at most MAX_TEXT_ENTRIES (128) distinct
 * raster keys (text + bounds + scale, src/authoring/renderer.ts), and the
 * original per-row-unique stress fixture (333 distinct keys) could not render
 * at all. Pools of 6 labels × 6 details × 6 values keep representative text
 * variety while the distinct raster-key count stays comfortably below 128.
 * The 1000 evaluated-node contract is unchanged.
 */
const STRESS_ROW_NODES = 9;
export const stressRowCount = 111;
export const stressExpectedLayoutNodeCount =
  1 + stressRowCount * STRESS_ROW_NODES;

/** Reproduction evidence for the original unsatisfiable fixture. */
export const stressOriginalDistinctTextKeys = 323;

interface StressRow {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly value: string;
}

const stressLabels = Object.freeze([
  "Metric",
  "Throughput",
  "Latency",
  "Bitrate",
  "Buffer",
  "Queue",
]);
const stressDetails = Object.freeze([
  "gpu",
  "audio",
  "encode",
  "seek",
  "cache",
  "pipeline",
]);
const stressValues = Object.freeze(["0", "17", "42", "63", "88", "100"]);

const stressRows: readonly StressRow[] = Object.freeze(
  Array.from({ length: stressRowCount }, (_, index) =>
    Object.freeze({
      id: `metric-${index}`,
      label: `${stressLabels[index % stressLabels.length]} ${index % 6}`,
      detail: `sample ${index % 6} · ${stressDetails[index % stressDetails.length]}`,
      value: stressValues[index % stressValues.length],
    }),
  ),
);

/** Distinct text strings the stress fixture produces; the production raster
 * key also folds in bounds and scale, so this is a lower bound of the true
 * cache-key count (review finding follow-up). */
export function stressDistinctTextKeys(frame: EvaluatedFrame): number {
  const keys = new Set(
    frame.commands
      .filter(
        (command): command is Extract<DrawCommand, { kind: "text" }> =>
          command.kind === "text",
      )
      .map((command) => command.text.lines.join("\n")),
  );
  return keys.size;
}

export function stressView(): ViewNode {
  return VStack(
    ForEach(
      stressRows,
      (row) => row.id,
      (row) =>
        ZStack(
          [
            Box({ width: 260, height: 34, radius: 6 }).id(`${row.id}-card`),
            VStack(
              [
                Text(row.label, { size: 12, wrap: false }),
                Text(row.detail, { size: 10, wrap: false }),
              ],
              { gap: 2, align: "start" },
            ).padding(4),
            HStack(
              [
                Box({ width: 6, height: 6, radius: 3 }),
                Text(row.value, { size: 12, wrap: false }),
              ],
              { gap: 4 },
            ),
          ],
          { align: "start" },
        ).id(row.id),
    ),
    { gap: 4, align: "start" },
  ).id("stress");
}

export function evaluateStress(
  time = 0,
  options: { font?: string; measureText?: MeasureText } = {},
): EvaluatedFrame {
  return evaluateView(stressView(), {
    time,
    width: 1200,
    height: 900,
    theme: fixtureTheme(options.font),
    measureText: options.measureText ?? fixtureMeasureText,
  });
}
