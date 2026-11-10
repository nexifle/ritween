import test from "node:test";
import assert from "node:assert/strict";
import {
  BarChart,
  LineChart,
  ScatterChart,
  DonutChart,
  Circle,
  evaluateView,
  type ViewNode,
  type AnimatedNumber,
} from "../src/index";

const frame = (node: ViewNode, time = 1) =>
  evaluateView(node, { time, width: 500, height: 500, measureText: () => 0 });
const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const options = { width: 100, height: 50 };

test("extreme domains yield finite, correctly positioned bar, line and scatter marks", () => {
  for (const magnitude of [3, 1e308]) {
    const data = [
      { id: "negative", value: -magnitude },
      { id: "positive", value: magnitude },
    ];
    const bars = frame(BarChart(data, options)).commands;
    assert.deepEqual(
      bars.map((c) => c.path),
      ["root/zstack/negative/scale/box", "root/zstack/positive/scale/box"],
    );
    close(bars[0].bounds.height, 25);
    close(bars[0].transform[3], 25);
    close(bars[1].bounds.height, 25);
    close(bars[1].transform[3], 0);
    const line = frame(LineChart(data, options)).commands;
    assert.deepEqual(
      line.map((c) => c.path),
      [
        "root/zstack/point:negative/scale/circle",
        "root/zstack/segment:positive/line",
        "root/zstack/point:positive/scale/circle",
      ],
    );
    close(line[0].transform[3], 44);
    close(line[2].transform[3], 0);
    const points = frame(
      ScatterChart(
        data.map((d) => ({ id: d.id, x: d.value, y: d.value })),
        options,
      ),
    ).commands;
    close(points[0].transform[2], 0);
    close(points[0].transform[3], 42);
    close(points[1].transform[2], 92);
    close(points[1].transform[3], 0);
    for (const c of [...bars, ...line, ...points])
      assert.ok(
        [...Object.values(c.bounds), ...c.transform].every(Number.isFinite),
      );
    const positive = frame(BarChart([{ id: "p", value: magnitude }], options))
      .commands[0];
    close(positive.bounds.height, 50);
    close(positive.transform[3], 0);
    const positiveLine = frame(
      LineChart([{ id: "p", value: magnitude }], options),
    ).commands[0];
    close(positiveLine.transform[3], 0);
    const positiveScatter = frame(
      ScatterChart([{ id: "p", x: magnitude, y: magnitude }], options),
    ).commands[0];
    close(positiveScatter.transform[2], 92);
    close(positiveScatter.transform[3], 0);
  }
  const zero = frame(
    BarChart(
      [
        { id: "z", value: 0 },
        { id: "n", value: -2 },
      ],
      options,
    ),
  ).commands;
  close(zero[0].bounds.height, 0);
  close(zero[0].transform[3], 0);
  close(zero[1].bounds.height, 50);
});

test("donut normalizes overflowing totals into equal half-circle paths", () => {
  const result = frame(
    DonutChart(
      [
        { id: "a", value: 1e308 },
        { id: "b", value: 1e308 },
      ],
      { radius: 20, thickness: 5 },
    ),
  );
  assert.deepEqual(
    result.commands.map((c) => c.path),
    ["root/zstack/a", "root/zstack/b"],
  );
  for (const c of result.commands) {
    assert.equal(c.kind, "path");
    if (c.kind === "path") {
      assert.ok(
        c.outline
          .flat()
          .filter((v) => typeof v === "number")
          .every(Number.isFinite),
      );
      const first = c.outline[0];
      const middle = c.outline[48];
      assert.equal(first[0], "M");
      assert.equal(middle[0], "L");
      close(first[1] as number, 20);
      close(first[2] as number, c.path.endsWith("a") ? 0 : 40);
      close(middle[1] as number, c.path.endsWith("a") ? 40 : 0);
    }
  }
});

const chartFactories = (progress: AnimatedNumber) => [
  () => BarChart([{ id: "a", value: 1 }], { ...options, progress }),
  () =>
    LineChart(
      [
        { id: "a", value: 0 },
        { id: "b", value: 1 },
      ],
      { ...options, progress },
    ),
  () => ScatterChart([{ id: "a", x: 1, y: 1 }], { ...options, progress }),
  () =>
    DonutChart([{ id: "a", value: 1 }], { radius: 20, thickness: 5, progress }),
];

const charts = (progress: AnimatedNumber) =>
  chartFactories(progress).map((create) => create());

test("all charts reject invalid literal and animated progress at construction", () => {
  for (const progress of [
    -0.1,
    1.1,
    NaN,
    { from: -0.1, to: 1, duration: 1 },
    { from: 0, to: 1.1, duration: 1 },
    {
      keyframes: [
        { at: 0, value: 0 },
        { at: 1, value: 1.1 },
      ],
    },
  ]) {
    for (let i = 0; i < 4; i++)
      assert.throws(chartFactories(progress)[i], /progress/);
  }
});

test("all chart tracks agree with literal progress and remain seekable and snapshotted", () => {
  for (const progress of [
    { from: 0, to: 1, delay: 1, duration: 2, ease: "linear" as const },
    {
      keyframes: [
        { at: 1, value: 0 },
        { at: 3, value: 1, ease: "linear" as const },
      ],
    },
  ]) {
    const nodes = charts(progress);
    const times = [0, 1, 2, 3, 4, 2, 0, 4];
    const before = times.map((time) => nodes.map((node) => frame(node, time)));
    for (let i = 0; i < times.length; i++) {
      const value = Math.max(0, Math.min(1, (times[i] - 1) / 2));
      assert.deepEqual(
        before[i],
        charts(value).map((node) => frame(node, times[i])),
      );
    }
    if ("keyframes" in progress) progress.keyframes[1].value = 0;
    else progress.to = 0;
    assert.deepEqual(
      times.map((time) => nodes.map((node) => frame(node, time))),
      before,
    );
  }
});

// Inspect the painted polygon after its cumulative transform, not only layout boxes.
function paintedPoints(node: ViewNode) {
  return frame(node).commands.flatMap((command) => {
    assert.equal(command.kind, "path");
    if (command.kind !== "path") return [];
    return command.outline.flatMap((part) => {
      if (part[0] !== "M" && part[0] !== "L") return [];
      return [
        [
          part[1] * command.transform[0] + command.transform[2],
          part[2] * command.transform[1] + command.transform[3],
        ],
      ];
    });
  });
}

test("line and scatter painted geometry stays inside the full frame at every progress", () => {
  for (const size of [
    { width: 100, height: 50 },
    { width: 2, height: 9 },
    { width: 12, height: 1 },
  ]) {
    for (const progress of [0, 0.5, 1]) {
      const lines = [
        [],
        [{ id: "zero", value: 0 }],
        [{ id: "one", value: 2 }],
        [
          { id: "a", value: -2 },
          { id: "b", value: 2 },
          { id: "c", value: -1 },
        ],
      ];
      const scatters = [
        [],
        [{ id: "zero", x: 0, y: 0 }],
        [{ id: "one", x: 2, y: -2 }],
        [
          { id: "a", x: -2, y: 2 },
          { id: "b", x: 2, y: -2 },
        ],
      ];
      const nodes = [
        ...lines.map((data) => LineChart(data, { ...size, progress })),
        ...scatters.map((data) => ScatterChart(data, { ...size, progress })),
      ];
      for (const node of nodes) {
        const result = frame(node);
        close(result.tree.bounds.width, size.width);
        close(result.tree.bounds.height, size.height);
        for (const [x, y] of paintedPoints(node)) {
          assert.ok(Number.isFinite(x) && Number.isFinite(y));
          assert.ok(x >= -1e-9 && x <= size.width + 1e-9, `x=${x}`);
          assert.ok(y >= -1e-9 && y <= size.height + 1e-9, `y=${y}`);
        }
      }
    }
  }
});

test("line segment endpoints and stroke are positioned once and reveal in input order", () => {
  const data = [
    { id: "a", value: -1 },
    { id: "b", value: 1 },
  ];
  for (const progress of [0.5, 1]) {
    const segment = frame(LineChart(data, { ...options, progress }))
      .commands[1];
    assert.equal(segment.kind, "path");
    if (segment.kind !== "path") continue;
    const vertices = segment.outline.slice(0, 4).map((p) => {
      assert.ok(p[0] === "M" || p[0] === "L");
      return [
        (p[1] as number) + segment.transform[2],
        (p[2] as number) + segment.transform[3],
      ];
    });
    close((vertices[0][0] + vertices[3][0]) / 2, 3);
    close((vertices[0][1] + vertices[3][1]) / 2, 47);
    close((vertices[1][0] + vertices[2][0]) / 2, 3 + 94 * progress);
    close((vertices[1][1] + vertices[2][1]) / 2, 47 - 44 * progress);
    close(
      Math.hypot(
        vertices[0][0] - vertices[3][0],
        vertices[0][1] - vertices[3][1],
      ),
      2,
    );
  }
});

test("chart reuse with transforms and clipping retains geometry and seek determinism", () => {
  const progress = { from: 0, to: 1, duration: 1, ease: "linear" as const };
  for (const node of [
    LineChart(
      [
        { id: "a", value: -1 },
        { id: "b", value: 1 },
      ],
      { ...options, progress },
    ),
    ScatterChart(
      [
        { id: "a", x: -1, y: 1 },
        { id: "b", x: 1, y: -1 },
      ],
      { ...options, progress },
    ),
  ]) {
    const original = frame(node, 0.5);
    const moved = frame(node.scale(2).offset(10, 20), 0.5);
    for (let i = 0; i < original.commands.length; i++) {
      const a = original.commands[i],
        b = moved.commands[i];
      close(b.transform[0], a.transform[0] * 2);
      close(b.transform[1], a.transform[1] * 2);
      close(b.transform[2], a.transform[2] * 2 - 40);
      close(b.transform[3], a.transform[3] * 2 - 5);
    }
    const clipped = frame(node.clip(), 0.5).commands[0];
    assert.equal(clipped.kind, "composition");
    if (clipped.kind === "composition") {
      assert.deepEqual(
        clipped.frame.commands.map((c) => c.path.split("/").slice(-3)),
        original.commands.map((c) => c.path.split("/").slice(-3)),
      );
      assert.deepEqual(
        clipped.frame.commands.map((c) => c.transform),
        original.commands.map((c) => c.transform),
      );
    }
    const first = frame(node, 0.5);
    frame(node, 1);
    frame(node, 0);
    assert.deepEqual(frame(node, 0.5), first);
  }
});

test("donut uses theme stroke with datum and chart color precedence", () => {
  const theme = {
    colors: { accent: "purple" },
    font: "Arial",
    textColor: "black",
  };
  const render = (node: ViewNode, activeTheme = theme) =>
    evaluateView(node, {
      time: 1,
      width: 500,
      height: 500,
      measureText: () => 0,
      theme: activeTheme,
    }).commands;
  const data = [
    { id: "a", value: 1, color: "red" },
    { id: "b", value: 1 },
  ];
  const colors = (node: ViewNode) =>
    render(node).map((c) => c.kind === "path" && c.fill);
  assert.deepEqual(
    colors(DonutChart(data, { radius: 20, thickness: 5, color: "blue" })),
    ["red", "blue"],
  );
  assert.deepEqual(colors(DonutChart(data, { radius: 20, thickness: 5 })), [
    "red",
    "purple",
  ]);
  const fallback = render(
    DonutChart([{ id: "x", value: 1 }], { radius: 20, thickness: 5 }),
    { ...theme, colors: {} },
  );
  assert.equal(fallback[0].kind === "path" && fallback[0].fill, "black");
  const plain = render(Circle({ radius: 20 }));
  const stroke = render(
    Circle({ radius: 20, strokeOnly: true, strokeWidth: 5, fill: "red" }),
  );
  const explicit = render(
    Circle({ radius: 20, strokeOnly: true, strokeWidth: 5, stroke: "blue" }),
  );
  assert.equal(plain.length, 1);
  assert.equal(plain[0].kind === "path" && plain[0].fill, "purple");
  assert.equal(stroke.length, 1);
  assert.equal(stroke[0].kind === "path" && stroke[0].fill, "purple");
  assert.equal(explicit[0].kind === "path" && explicit[0].fill, "blue");
  assert.notDeepEqual(
    plain[0].kind === "path" && plain[0].outline,
    stroke[0].kind === "path" && stroke[0].outline,
  );
});

test("donut omits zero slices and reveals bounded rings deterministically", () => {
  const config = { radius: 20, thickness: 5 };
  for (const data of [[], [{ id: "zero", value: 0 }]]) {
    assert.equal(frame(DonutChart(data, config)).commands.length, 0);
    assert.equal(
      frame(DonutChart(data, config)).tree.children[0].children.length,
      0,
    );
  }
  const data = [
    { id: "a", value: 1 },
    { id: "zero", value: 0 },
    { id: "b", value: 1 },
  ];
  const progress = { from: 0, to: 1, duration: 1, ease: "linear" as const };
  const settings = { ...config, progress, color: "blue" };
  const node = DonutChart(data, settings);
  const results = [0, 0.5, 1].map((time) => frame(node, time));
  assert.equal(results[0].commands.length, 0);
  for (const [i, time] of [0.5, 1].entries()) {
    const commands = results[i + 1].commands;
    assert.deepEqual(
      commands.map((c) => c.path),
      ["root/zstack/a", "root/zstack/b"],
    );
    assert.deepEqual(
      commands,
      frame(DonutChart(data, { ...config, progress: time, color: "blue" }))
        .commands,
    );
    for (const c of commands) {
      assert.equal(c.kind, "path");
      if (c.kind !== "path") continue;
      assert.equal(c.fill, "blue");
      const end = c.outline[96];
      assert.equal(end[0], "L");
      const angle = (c.path.endsWith("a") ? 0 : 0.5) + time * 0.5;
      close(end[1] as number, 20 + 20 * Math.sin(angle * Math.PI * 2));
      close(end[2] as number, 20 - 20 * Math.cos(angle * Math.PI * 2));
    }
    for (const [x, y] of paintedPoints(
      DonutChart(data, { ...config, progress: time }),
    )) {
      assert.ok(x >= -1e-9 && x <= 40 + 1e-9 && y >= -1e-9 && y <= 40 + 1e-9);
    }
  }
  data[0].value = 99;
  data[0].id = "changed";
  settings.color = "red";
  settings.radius = 10;
  progress.to = 0;
  for (const index of [2, 1, 0, 2])
    assert.deepEqual(frame(node, index / 2), results[index]);
});

test("donut rejects invalid data and ring dimensions", () => {
  const valid = { radius: 20, thickness: 5 };
  for (const value of [-1, NaN, Infinity, -Infinity])
    assert.throws(() => DonutChart([{ id: "a", value }], valid));
  for (const invalid of [
    { radius: 0, thickness: 1 },
    { radius: -1, thickness: 1 },
    { radius: Infinity, thickness: 1 },
    { radius: NaN, thickness: 1 },
    { radius: 1, thickness: 0 },
    { radius: 1, thickness: -1 },
    { radius: 1, thickness: Infinity },
    { radius: 1, thickness: NaN },
    { radius: 1, thickness: 2 },
    { radius: Number.MAX_VALUE, thickness: 1 },
  ])
    assert.throws(() => DonutChart([], invalid));
  assert.equal(
    frame(DonutChart([{ id: "a", value: 1 }], { radius: 1, thickness: 1 }))
      .commands.length,
    1,
  );
});
