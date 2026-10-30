import test from "node:test";
import assert from "node:assert/strict";
import {
  Box,
  Grid,
  evaluateView,
  type GridCell,
  type GridOptions,
  type ViewNode,
} from "../src/index";

const frame = (view: ViewNode) =>
  evaluateView(view, {
    time: 0,
    width: 500,
    height: 500,
    measureText: () => 0,
  });
const box = (fill = "red") => Box({ width: 2, height: 3, fill });
const options = {
  columns: 2,
  rows: 2,
  cellWidth: 10,
  cellHeight: 20,
  columnGap: 3,
  rowGap: 4,
};

test("Grid resolves finite zero offsets for one large column and row", () => {
  const result = frame(
    Grid([{ id: "a", column: 0, row: 0, view: box() }], {
      columns: 1,
      rows: 1,
      cellWidth: 1e308,
      cellHeight: 1e308,
      columnGap: 1e308,
      rowGap: 1e308,
    }),
  );
  assert.deepEqual(result.tree.bounds, {
    x: 0,
    y: 0,
    width: 1e308,
    height: 1e308,
  });
  assert.deepEqual(result.tree.children[0].children[0].transform, [1, 1, 0, 0]);
  assert.deepEqual(result.commands[0].transform, [1, 1, 0, 0]);
});

test("Grid paints overlaps in input order and keeps semantic paths when reordered", () => {
  const cells = [
    { id: "a", column: 0, row: 0, view: box("red") },
    { id: "b", column: 0, row: 0, view: box("blue") },
  ];
  const first = frame(Grid(cells, options));
  const reversed = frame(Grid([...cells].reverse(), options));
  assert.deepEqual(
    first.commands.map((c) => c.kind === "box" && c.fill),
    ["red", "blue"],
  );
  assert.deepEqual(
    reversed.commands.map((c) => c.kind === "box" && c.fill),
    ["blue", "red"],
  );
  assert.deepEqual(
    first.commands.map((c) => c.path).sort(),
    reversed.commands.map((c) => c.path).sort(),
  );
  assert.ok(first.commands.some((c) => c.path.includes("/a/")));
  assert.ok(first.commands.some((c) => c.path.includes("/b/")));
});

test("Grid snapshots cells, array and options and preserves view and Grid modifiers", () => {
  const cell = {
    id: "a",
    column: 1,
    row: 1,
    view: box().offset(4, 5).opacity(0.5),
  };
  const cells = [cell];
  const settings = { ...options };
  const grid = Grid(cells, settings).offset(7, 8).opacity(0.5);
  cell.id = "changed";
  cell.column = 0;
  cell.row = 0;
  cell.view = box("blue");
  cells.length = 0;
  settings.cellWidth = 99;
  settings.rowGap = 99;
  const result = frame(grid);
  assert.deepEqual(result.tree.bounds, { x: 0, y: 0, width: 23, height: 44 });
  assert.equal(result.commands.length, 1);
  const command = result.commands[0];
  assert.equal(command.kind, "box");
  if (command.kind !== "box") throw Error("Expected box");
  assert.equal(command.fill, "red");
  assert.match(command.path, /\/a\//);
  assert.deepEqual(command.transform, [1, 1, 24, 37]);
  assert.equal(command.opacity, 0.25);
});

test("Grid rejects invalid dimensions, sizes, gaps and overflowing totals", () => {
  for (const patch of [
    { columns: 0 },
    { rows: 1.5 },
    { columns: Infinity },
    { cellWidth: 0 },
    { cellHeight: -1 },
    { cellWidth: NaN },
    { cellHeight: Infinity },
    { columnGap: -1 },
    { rowGap: -1 },
    { columnGap: NaN },
    { rowGap: Infinity },
    { columns: 2, cellWidth: 1e308 },
    { rows: 2, cellHeight: 1e308 },
    { columns: 2, cellWidth: 5e307, columnGap: 1e308 },
    { rows: 2, cellHeight: 5e307, rowGap: 1e308 },
  ]) {
    assert.throws(() => Grid([], { ...options, ...patch } as GridOptions));
  }
});

test("Grid rejects duplicate or empty IDs and invalid coordinates and spans", () => {
  const cell: GridCell = { id: "a", column: 0, row: 0, view: box() };
  assert.throws(() => Grid([cell, cell], options));
  for (const patch of [
    { id: "" },
    { column: -1 },
    { row: -1 },
    { column: 0.5 },
    { row: Infinity },
    { column: 2 },
    { row: 2 },
    { columnSpan: 0 },
    { rowSpan: -1 },
    { columnSpan: 1.5 },
    { rowSpan: NaN },
    { column: 1, columnSpan: 2 },
    { row: 1, rowSpan: 2 },
  ]) {
    assert.throws(() => Grid([{ ...cell, ...patch }], options));
  }
});
