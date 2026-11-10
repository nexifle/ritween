import { ZStack, type ViewNode } from "./nodes";

export interface GridCell {
  readonly id: string;
  readonly column: number;
  readonly row: number;
  readonly columnSpan?: number;
  readonly rowSpan?: number;
  readonly view: ViewNode;
}
export interface GridOptions {
  readonly columns: number;
  readonly rows: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly columnGap?: number;
  readonly rowGap?: number;
}

/** Explicit, fixed-size cells; content may paint outside its cell. */
export function Grid(
  cells: readonly GridCell[],
  options: GridOptions,
): ViewNode {
  const {
    columns,
    rows,
    cellWidth,
    cellHeight,
    columnGap = 0,
    rowGap = 0,
  } = options;
  if (
    ![columns, rows].every((n) => Number.isSafeInteger(n) && n > 0) ||
    ![cellWidth, cellHeight].every((n) => Number.isFinite(n) && n > 0) ||
    ![columnGap, rowGap].every((n) => Number.isFinite(n) && n >= 0)
  )
    throw Error(
      "Grid needs positive integer dimensions, positive cell sizes and non-negative gaps.",
    );
  const width = columns * cellWidth + (columns - 1) * columnGap;
  const height = rows * cellHeight + (rows - 1) * rowGap;
  if (!Number.isFinite(width) || !Number.isFinite(height))
    throw Error("Grid size must be finite.");
  const ids = new Set<string>();
  const children = cells.map(
    ({ id, column, row, columnSpan = 1, rowSpan = 1, view }) => {
      if (
        typeof id !== "string" ||
        !id ||
        ids.has(id) ||
        ![column, row].every((n) => Number.isSafeInteger(n) && n >= 0) ||
        ![columnSpan, rowSpan].every((n) => Number.isSafeInteger(n) && n > 0) ||
        column + columnSpan > columns ||
        row + rowSpan > rows ||
        !(view instanceof Object) ||
        !("spec" in view)
      )
        throw Error(
          "Grid cells need unique IDs and valid in-bounds positions and spans.",
        );
      ids.add(id);
      return view
        .frame({
          width: columnSpan * cellWidth + (columnSpan - 1) * columnGap,
          height: rowSpan * cellHeight + (rowSpan - 1) * rowGap,
          align: "start",
        })
        .offset(
          column * cellWidth + column * columnGap,
          row * cellHeight + row * rowGap,
        )
        .id(id);
    },
  );
  return ZStack(children, { align: "start" }).frame({
    width,
    height,
    align: "start",
  });
}
