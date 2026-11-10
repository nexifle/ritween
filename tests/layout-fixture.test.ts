/**
 * G0 fixture assertions (docs/plans/declarative-layout-hardening.md §5.5–5.7):
 * stable IDs, recorded state samples, content-driven geometry change, a stationary
 * scroll viewport, and the exact evaluated LayoutNode count of the stress fixture.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countLayoutNodes,
  evaluateRegression,
  evaluateStress,
  layoutNodeById,
  layoutNodes,
  regressionAttentionIds,
  regressionLogViewportHeight,
  regressionPadding,
  regressionStableIds,
  regressionStates,
  regressionTimeline,
  regressionWindowWidth,
  requireLayoutNode,
  stressDistinctTextKeys,
  stressExpectedLayoutNodeCount,
  stressRowCount,
} from "./fixtures/layout-regression";
import type { DrawCommand } from "../src/authoring/index";

function clipCommand(
  commands: readonly DrawCommand[],
): Extract<DrawCommand, { kind: "composition" }> {
  const command = commands.find(
    (candidate) => candidate.kind === "composition",
  );
  assert.ok(command, "scrolling logs must emit a clip composition command");
  return command as Extract<DrawCommand, { kind: "composition" }>;
}

test("regression fixture exposes every stable ID in every recorded state", () => {
  for (const state of regressionStates) {
    const tree = evaluateRegression(state.time).tree;
    for (const id of regressionStableIds)
      assert.ok(layoutNodeById(tree, id), `${state.id} must contain ${id}`);
    const attention = state.time >= regressionTimeline.attention;
    for (const id of regressionAttentionIds)
      assert.equal(
        Boolean(layoutNodeById(tree, id)),
        attention,
        `${state.id} ${id} presence must match the attention boundary`,
      );
  }
});

test("state samples are ordered, finite, and end on the transition boundaries", () => {
  const times = regressionStates.map((state) => state.time);
  assert.deepEqual(
    times,
    [...times].sort((a, b) => a - b),
  );
  assert.equal(
    new Set(regressionStates.map((state) => state.id)).size,
    regressionStates.length,
  );
  assert.ok(times.every((time) => Number.isFinite(time) && time >= 0));
  assert.ok(times.includes(regressionTimeline.typing.start));
  assert.ok(times.includes(regressionTimeline.typing.end));
  assert.ok(times.includes(regressionTimeline.attention));
  assert.ok(times.includes(regressionTimeline.scroll.end));
  assert.ok(times.includes(regressionTimeline.resize.start));
  assert.ok(times.includes(regressionTimeline.resize.end));
});

test("search typing changes the title text and the visible row count", () => {
  const textLines = (time: number) =>
    evaluateRegression(time)
      .commands.filter((command) => command.kind === "text")
      .map((command) =>
        (command as Extract<DrawCommand, { kind: "text" }>).text.lines.join(
          " ",
        ),
      );
  assert.ok(textLines(0).includes("All events"));
  assert.ok(
    textLines(regressionTimeline.typing.end).includes('Results for "media"'),
  );
  // All 12 rows before typing, only the two "media: …" rows after it.
  const rows = (time: number) =>
    layoutNodes(evaluateRegression(time).tree).filter(
      (node) =>
        node.kind === "text" &&
        node.path.startsWith("window/padding/vstack/logs/frame/offset/vstack/"),
    ).length;
  assert.equal(rows(0), 12);
  assert.equal(rows(regressionTimeline.typing.end), 2);
});

test("variable title and status lengths move the status node geometry", () => {
  // The header HStack ends at the window's padded content edge, so the status
  // text (rightmost sibling) always ends there while its width varies.
  const edge = (width: number) => width - regressionPadding;
  for (const [time, width] of [
    [0, regressionWindowWidth.compact],
    [regressionTimeline.typing.end, regressionWindowWidth.compact],
    [regressionTimeline.resize.end, regressionWindowWidth.expanded],
  ] as const) {
    const status = requireLayoutNode(evaluateRegression(time).tree, "status");
    assert.equal(status.bounds.x + status.bounds.width, edge(width));
  }
  const idle = requireLayoutNode(evaluateRegression(0).tree, "status");
  const typed = requireLayoutNode(
    evaluateRegression(regressionTimeline.typing.end).tree,
    "status",
  );
  // "12 events" vs "2 events": fewer rows means a narrower status text.
  assert.equal(idle.bounds.width - typed.bounds.width, 10);
  // The title stops changing once typing ends at the recorded boundary.
  assert.equal(
    requireLayoutNode(
      evaluateRegression(regressionTimeline.attention).tree,
      "title",
    ).bounds.width,
    requireLayoutNode(
      evaluateRegression(regressionTimeline.typing.end).tree,
      "title",
    ).bounds.width,
  );
});

test("compact and expanded windows change width and log viewport height", () => {
  const compact = evaluateRegression(regressionTimeline.resize.start);
  const expanded = evaluateRegression(regressionTimeline.resize.end);
  const width = (frame: typeof compact) =>
    requireLayoutNode(frame.tree, "window").bounds.width;
  const viewport = (frame: typeof compact) =>
    clipCommand(frame.commands).bounds;
  assert.equal(width(compact), regressionWindowWidth.compact);
  assert.equal(width(expanded), regressionWindowWidth.expanded);
  assert.equal(viewport(compact).height, regressionLogViewportHeight.compact);
  assert.equal(viewport(expanded).height, regressionLogViewportHeight.expanded);
  // Width is content-driven: the clip follows the window padding, not a fixed size.
  assert.equal(
    viewport(expanded).width,
    regressionWindowWidth.expanded - regressionPadding * 2,
  );
  assert.equal(
    viewport(compact).width,
    regressionWindowWidth.compact - regressionPadding * 2,
  );
});

test("log content taller than its viewport warns only while typing has not filtered", () => {
  // Characterized legacy behavior: the scroll content exceeds the compact viewport
  // whenever all 12 rows are present, so the overflow warning is expected there and
  // disappears once the search query narrows the list.
  const overflow = (time: number) =>
    evaluateRegression(time).warnings.filter((warning) =>
      warning.includes("content exceeds offered bounds"),
    );
  assert.equal(overflow(0).length, 2);
  assert.ok(overflow(0).every((warning) => warning.includes("/logs/")));
  assert.deepEqual(overflow(regressionTimeline.typing.end), []);
});

test("warning and alert appear from the attention boundary with explicit states", () => {
  const before = evaluateRegression(regressionTimeline.attention - 0.01).tree;
  const at = evaluateRegression(regressionTimeline.attention).tree;
  const settled = evaluateRegression(regressionTimeline.alertSettle).tree;
  assert.equal(layoutNodeById(before, "warning"), undefined);
  assert.ok(layoutNodeById(at, "warning-text"));
  assert.ok(layoutNodeById(at, "alert-badge"));
  // The alert finishes rising exactly at alertSettle.
  assert.deepEqual(
    requireLayoutNode(at, "alert").bounds,
    requireLayoutNode(settled, "alert").bounds,
  );
  assert.notDeepEqual(
    requireLayoutNode(before, "window").bounds,
    requireLayoutNode(at, "window").bounds,
  );
});

test("scrolling logs move inside a stationary clip viewport", () => {
  const times = [
    regressionTimeline.scroll.start,
    3.5,
    regressionTimeline.scroll.end,
    regressionTimeline.resize.end,
  ];
  const viewports = times.map(
    (time) => clipCommand(evaluateRegression(time).commands).bounds,
  );
  const offsets = times.map((time) => {
    const clip = clipCommand(evaluateRegression(time).commands);
    const content = layoutNodes(clip.frame.tree).find((node) =>
      node.path.endsWith("/logs/frame/offset"),
    );
    assert.ok(content, "log content must sit under the offset inside the clip");
    return content.transform[3];
  });
  // The viewport is identical while the content offset keeps growing, then stops.
  assert.deepEqual(viewports[0], viewports[1]);
  assert.deepEqual(viewports[1], viewports[2]);
  assert.ok(
    offsets[0] > offsets[1] && offsets[1] > offsets[2],
    `offsets must decrease: ${offsets}`,
  );
  assert.equal(offsets[2], -regressionTimeline.scroll.distance);
  assert.equal(offsets[3], -regressionTimeline.scroll.distance);
  // The resize changes the viewport size without moving its origin.
  assert.deepEqual(
    { x: viewports[3].x, y: viewports[3].y },
    { x: viewports[0].x, y: viewports[0].y },
  );
});

test("stress fixture evaluates exactly 1000 LayoutNodes including wrappers", () => {
  const frame = evaluateStress();
  assert.equal(countLayoutNodes(frame.tree), stressExpectedLayoutNodeCount);
  assert.equal(stressExpectedLayoutNodeCount, 1000);
  // 111 rows × 9 nodes (zstack, box, padding, vstack, 2 texts, hstack, box, text)
  // plus the root vstack.
  assert.equal(stressRowCount, 111);
  assert.equal((stressExpectedLayoutNodeCount - 1) / 9, stressRowCount);
  const rows = frame.tree.children;
  assert.equal(rows.length, stressRowCount);
  assert.equal(new Set(rows.map((row) => row.path)).size, stressRowCount);
});

test("stress text diversity stays inside the production bounded raster cache", () => {
  // ViewRenderer's text cache throws beyond MAX_TEXT_ENTRIES (128) distinct
  // raster keys; the original per-row-unique fixture needed 323 and could not
  // render. The repaired fixture keeps 18 distinct texts, and row IDs (paths)
  // preserve per-row identity without entering the raster cache.
  assert.equal(stressDistinctTextKeys(evaluateStress()), 18);
  assert.ok(
    stressDistinctTextKeys(evaluateStress()) < 128,
    "stress fixture must stay below the 128-entry production text cache",
  );
});
