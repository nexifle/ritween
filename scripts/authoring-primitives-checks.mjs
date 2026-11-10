/** Pixel checks for the public grid, chart and path authoring primitives. */
export async function validateAuthoringPrimitives(page) {
  return page.evaluate(async () => {
    const {
      FrameSource,
      Stage,
      Box,
      Group,
      Grid,
      BarChart,
      LineChart,
      ScatterChart,
      DonutChart,
      Polyline,
      Polygon,
      Arrow,
    } = await import("/src/index.ts");
    const white = [255, 255, 255, 255],
      red = [255, 0, 0, 255],
      blue = [0, 0, 255, 255];
    const tween = { from: 0, to: 1, duration: 1, ease: "linear" };
    const cases = [
      {
        name: "grid",
        view: () =>
          Grid(
            [
              {
                id: "span",
                column: 0,
                row: 0,
                columnSpan: 2,
                view: Box({ width: 50, height: 20, fill: "#FF0000" }),
              },
              {
                id: "overlap",
                column: 1,
                row: 0,
                view: Box({ width: 20, height: 20, fill: "#0000FF" }),
              },
              {
                id: "row",
                column: 0,
                row: 1,
                view: Box({ width: 20, height: 20, fill: "#0000FF" }),
              },
            ],
            {
              columns: 2,
              rows: 2,
              cellWidth: 20,
              cellHeight: 20,
              columnGap: 10,
              rowGap: 10,
            },
          ),
        samples: [
          [10, 10, red],
          [25, 10, red],
          [35, 10, blue],
          [10, 25, white],
          [10, 35, blue],
        ],
      },
      {
        name: "bars",
        view: () =>
          BarChart(
            [
              { id: "positive", value: 2 },
              { id: "negative", value: -2 },
              { id: "zero", value: 0 },
            ],
            { width: 90, height: 80, color: "#FF0000", progress: tween },
          ),
        samples: [
          [15, 30, red],
          [15, 10, white],
          [45, 50, red],
          [45, 70, white],
          [75, 40, white],
        ],
      },
      {
        name: "line",
        view: (clip = true) => {
          const chart = LineChart(
            [
              { id: "low", value: -1 },
              { id: "high", value: 1 },
            ],
            { width: 60, height: 60, color: "#FF0000" },
          );
          return clip ? chart.clip() : chart;
        },
        compareUnclipped: true,
        samples: [
          [3, 56, red],
          [56, 3, red],
          [0, 30, white],
          [59, 30, white],
        ],
      },
      {
        name: "scatter",
        view: (clip = true) => {
          const chart = ScatterChart(
            [
              { id: "low", x: -1, y: -1 },
              { id: "high", x: 1, y: 1 },
            ],
            { width: 60, height: 60, color: "#FF0000" },
          );
          return clip ? chart.clip() : chart;
        },
        compareUnclipped: true,
        samples: [
          [4, 55, red],
          [55, 4, red],
          [0, 30, white],
          [59, 30, white],
        ],
      },
      {
        name: "tiny-line",
        view: (clip = true) => {
          const chart = LineChart([{ id: "one", value: 0 }], {
            width: 4,
            height: 4,
            color: "#FF0000",
          });
          return (clip ? chart.clip() : chart)
            .scale(5, 5, [0, 0])
            .offset(10, 10);
        },
        compareUnclipped: true,
        samples: [
          [20, 20, red],
          [8, 20, white],
          [32, 20, white],
        ],
      },
      {
        name: "tiny-scatter",
        view: (clip = true) => {
          const chart = ScatterChart([{ id: "one", x: 0, y: 0 }], {
            width: 4,
            height: 4,
            color: "#FF0000",
          });
          return (clip ? chart.clip() : chart)
            .scale(5, 5, [0, 0])
            .offset(10, 10);
        },
        compareUnclipped: true,
        samples: [
          [20, 20, red],
          [8, 20, white],
          [32, 20, white],
        ],
      },
      {
        name: "donut-theme",
        theme: {
          colors: { background: "#FFFFFF", accent: "#FF0000" },
          font: "Arial",
          textColor: "#000000",
        },
        view: () =>
          DonutChart(
            [
              { id: "zero", value: 0, color: "#0000FF" },
              { id: "full", value: 1 },
            ],
            { radius: 40, thickness: 10 },
          ).offset(10, 10),
        samples: [
          [50, 50, white],
          [84, 50, red],
          [16, 50, red],
        ],
      },
      {
        name: "donut-zero",
        view: () =>
          DonutChart([{ id: "zero", value: 0 }], {
            radius: 40,
            thickness: 10,
            color: "#FF0000",
          }),
        samples: [
          [40, 5, white],
          [40, 40, white],
        ],
      },
      {
        name: "polyline",
        view: () =>
          Polyline(
            [
              [0, 0],
              [60, 0],
              [60, 60],
            ],
            { width: 8, color: "#FF0000" },
          ).offset(10, 10),
        samples: [
          [30, 14, red],
          [70, 40, red],
          [35, 35, white],
        ],
      },
      {
        name: "polygon",
        view: () =>
          Polygon(
            [
              [0, 0],
              [60, 0],
              [60, 20],
              [20, 20],
              [20, 60],
              [0, 60],
            ],
            { fill: "#FF0000", fillRule: "evenodd" },
          ).offset(10, 10),
        samples: [
          [20, 50, red],
          [50, 20, red],
          [50, 50, white],
        ],
      },
      {
        name: "arrow",
        view: () =>
          Arrow([0, 0], [70, 0], {
            width: 6,
            headLength: 20,
            headWidth: 24,
            color: "#FF0000",
          }).offset(10, 10),
        samples: [
          [30, 22, red],
          [65, 17, red],
          [30, 12, white],
          [85, 22, white],
        ],
      },
      {
        name: "group-opacity",
        view: () =>
          Group([
            Polygon(
              [
                [0, 0],
                [60, 0],
                [60, 60],
                [0, 60],
              ],
              { fill: "#FF0000" },
            ),
            Polygon(
              [
                [0, 0],
                [60, 0],
                [60, 60],
                [0, 60],
              ],
              { fill: "#0000FF" },
            ).offset(20, 0),
          ])
            .opacity(0.5)
            .offset(10, 10),
        samples: [
          [20, 30, [255, 128, 128, 255]],
          [40, 30, [128, 128, 255, 255]],
          [95, 30, white],
        ],
      },
      {
        name: "transformed-clip",
        view: () =>
          Polygon(
            [
              [0, 0],
              [80, 0],
              [80, 80],
              [0, 80],
            ],
            { fill: "#FF0000" },
          )
            .frame({ width: 40, height: 40, align: "start" })
            .clip()
            .scale(1.5, 1.5, [0, 0])
            .offset(10, 10),
        samples: [
          [20, 20, red],
          [65, 65, red],
          [75, 30, white],
          [30, 75, white],
        ],
      },
    ];
    const errors = [];
    async function makeSource(c, clip = true) {
      return FrameSource.create(
        {
          name: c.name,
          resolution: [100, 100],
          aspectRatio: [1, 1],
          duration: 2,
          scenes: [
            {
              id: "fixture",
              name: "fixture",
              source: "fixture",
              start: 0,
              duration: 2,
              transition: { type: "cut" },
              create: () =>
                Stage(() => c.view(clip), {
                  designSize: [100, 100],
                  background: "#FFFFFF",
                  theme: c.theme,
                }),
            },
          ],
        },
        { width: 100, height: 100, onError: (e) => errors.push(String(e)) },
      );
    }
    async function frame(source, time) {
      const canvas = await source.render(time),
        copy = new OffscreenCanvas(100, 100),
        ctx = copy.getContext("2d");
      ctx.drawImage(canvas, 0, 0);
      return ctx.getImageData(0, 0, 100, 100).data;
    }
    for (const c of cases) {
      const source = await makeSource(c),
        directSource = await makeSource(c);
      try {
        const direct = await frame(directSource, 0.5);
        if (c.compareUnclipped) {
          const unclippedSource = await makeSource(c, false);
          try {
            const unclipped = await frame(unclippedSource, 0.5);
            // Clip-edge antialiasing can differ; compare only fully interior pixels.
            const [left, top, right, bottom] = c.name.startsWith("tiny-")
              ? [18, 18, 22, 22]
              : [1, 1, 59, 59];
            for (let y = top; y < bottom; y++)
              for (let x = left; x < right; x++)
                for (let channel = 0; channel < 4; channel++) {
                  const i = (y * 100 + x) * 4 + channel;
                  if (Math.abs(direct[i] - unclipped[i]) > 3)
                    throw Error(
                      `${c.name}: clipping changed interior at ${x},${y}`,
                    );
                }
          } finally {
            unclippedSource.dispose();
          }
        }
        const start = await frame(source, 0);
        const forward = await frame(source, 0.5);
        const end = await frame(source, 1);
        if (c.name === "bars") {
          const pixel = (data, x, y) => [
            ...data.slice((y * 100 + x) * 4, (y * 100 + x) * 4 + 4),
          ];
          for (const [x, y] of [
            [15, 30],
            [45, 50],
          ]) {
            if (
              pixel(start, x, y).some((v, i) => v !== white[i]) ||
              pixel(end, x, y).some((v, i) => Math.abs(v - red[i]) > 3)
            )
              throw Error(`bars progress endpoints at ${x},${y}`);
          }
          if (pixel(end, 75, 40).some((v, i) => v !== white[i]))
            throw Error("zero bar painted at full progress");
        }
        const backward = await frame(source, 0.5);
        if (!direct.every((v, i) => v === forward[i] && v === backward[i]))
          throw Error(`${c.name}: direct/forward/backward frame mismatch`);
        for (const [x, y, expected] of c.samples) {
          const actual = [
            ...direct.slice((y * 100 + x) * 4, (y * 100 + x) * 4 + 4),
          ];
          if (actual.some((v, i) => Math.abs(v - expected[i]) > 3))
            throw Error(
              `${c.name} at ${x},${y}: expected ${expected}, got ${actual}`,
            );
        }
      } finally {
        source.dispose();
        directSource.dispose();
      }
    }
    if (errors.length) throw Error(`FrameSource errors: ${errors.join("; ")}`);
    return cases.map((c) => c.name);
  });
}
