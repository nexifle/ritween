import test from "node:test";
import assert from "node:assert/strict";
import {
  Grid,
  Box,
  BarChart,
  LineChart,
  DonutChart,
  ScatterChart,
  evaluateView,
  type ViewNode,
} from "../src/index";

const frame = (node: ViewNode, time = 1) =>
  evaluateView(node, { time, width: 500, height: 500, measureText: () => 0 });
test("Grid sizes spans and gaps, preserves ids and reports overflow", () => {
  const grid = Grid(
    [
      {
        id: "a",
        row: 1,
        column: 1,
        columnSpan: 2,
        view: Box({ width: 90, height: 10 }),
      },
    ],
    {
      columns: 3,
      rows: 2,
      cellWidth: 20,
      cellHeight: 10,
      columnGap: 5,
      rowGap: 3,
    },
  );
  const result = frame(grid);
  assert.deepEqual(result.tree.bounds, { x: 0, y: 0, width: 70, height: 23 });
  assert.ok(result.warnings.some((w) => w.includes("exceeds")));
  const child = result.tree.children[0].children[0];
  assert.equal(child.path, "root/zstack/a");
  assert.deepEqual(child.transform, [1, 1, 25, 13]);
  assert.throws(() =>
    Grid(
      [
        {
          id: "x",
          column: 1,
          row: 0,
          columnSpan: 2,
          view: Box({ width: 1, height: 1 }),
        },
      ],
      { columns: 2, rows: 1, cellWidth: 1, cellHeight: 1 },
    ),
  );
  assert.throws(() =>
    Grid([], { columns: 0, rows: 1, cellWidth: 1, cellHeight: 1 }),
  );
});
test("charts draw stable IDs, support empty and signed data, and snapshot input", () => {
  const data = [
    { id: "a", value: -2 },
    { id: "b", value: 3 },
  ];
  const opts = { width: 100, height: 50, color: "red" };
  const bars = BarChart(data, opts);
  data[0].value = 99;
  opts.color = "blue";
  assert.equal(frame(bars).commands[0].kind, "box");
  assert.deepEqual(
    frame(bars).commands.map((c) => c.sharedId),
    [undefined, undefined],
  );
  assert.equal((frame(bars).commands[0] as { fill: string }).fill, "red");
  assert.equal(
    frame(LineChart([{ id: "a", value: 0 }], opts)).commands.length,
    1,
  );
  assert.equal(frame(BarChart([], opts)).commands.length, 0);
  assert.equal(
    frame(DonutChart([{ id: "a", value: 0 }], { radius: 20, thickness: 5 }))
      .commands.length,
    0,
  );
  assert.equal(
    frame(ScatterChart([{ id: "a", x: -2, y: 4 }], opts)).commands.length,
    1,
  );
  assert.throws(() =>
    DonutChart([{ id: "x", value: -1 }], { radius: 20, thickness: 5 }),
  );
  assert.throws(() => LineChart([{ id: "x", value: NaN }], opts));
  assert.throws(() => ScatterChart([{ id: "x", x: Infinity, y: 0 }], opts));
});
