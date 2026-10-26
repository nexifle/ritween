# Marks

Pick the mark from the question. A line shows change over an order, usually time. A bar compares amounts and starts at zero. An area is a line filled to a baseline and also starts at zero, because the ink is read as an amount. A scatter shows how two quantities move together. A histogram shows a distribution. A donut shows two or three shares of one whole. More slices, or slices that are close, lose to a sorted bar chart. Angles are hard to compare. Bars that share a baseline are not.

The scene owns the pipeline. [chart-scales.md](chart-scales.md) is the scale and the axis. This file is the geometry. Clear the target to paper, draw the grid, then the marks, then ticks and labels. The target is opaque. Overlapping marks use premultiplied color and a blend of `one` / `one-minus-src-alpha`, so two translucent points composite instead of cutting holes.

`render` is a pure function of the timestamp. A seeded hash of the sample index is the noise. `Math.random`, `Date.now`, and a value left over from the previous frame make a seek land on a different picture.

## What the question allows

| Question | Mark | Baseline |
| --- | --- | --- |
| Which category is larger? | Bar | Zero |
| How does one series change? | Line | The data extent, not zero |
| How much, stacked through time? | Area | Zero |
| How do two measurements relate? | Scatter | Both extents |
| What shape is this distribution? | Histogram | Zero, bars touching |
| What share is this of the whole? | Donut, only for two or three parts | — |

A line forced through zero flattens a small but real change. An area or a bar that does not start at zero makes the ink lie about the amount. A missing sample is a gap. Joining across it invents a slope. Store a gap as a non-finite value and start a new subpath. On the GPU, degenerate that segment to a zero-area triangle, or skip it with a restart flag.

A title states the finding, computed from the data: the change between the first week and the last week, not the first day and the last day. One odd day should not write the sentence. A moving mean of the last 7 samples shows the trend. Keep the raw series thin and gray underneath.

## Bars

A bar is a rectangle from the baseline to the value. In data units that is `x0, y0, x1, y1`. Category bars leave a gap. Histogram bars touch, because the bins are adjacent intervals.

Grouped bars answer "which series inside this category." A band scale inside the category band places one bar per series, all from zero. Stacked bars answer "what is the total, and what contributes." Each piece starts where the previous piece ended:

```ts
function stack(values: number[], percent: boolean): { y0: number; y1: number }[] {
  const total = values.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  return values.map((v) => {
    const h = percent ? (v / total) * 100 : v;
    const piece = { y0: acc, y1: acc + h };
    acc += h;
    return piece;
  });
}
```

Only the bottom piece is easy to compare across categories. A middle piece has no shared baseline. If the question is how that series changed, draw it as its own line. A 100% stack shows share and hides the total, so the title or a label has to say the total.

On the GPU one bar is one instance. A storage buffer of `vec4f` holds the rectangle in data units. The vertex shader maps both corners through `data_to_clip`, converts to pixels, and builds a quad. When thousands of bars share a short plot, a bar thinner than one pixel disappears. Widen to a minimum pixel width after the scale, not in data units:

```wgsl
let a = clip_to_px(data_to_clip(rect.xy));
let b = clip_to_px(data_to_clip(rect.zw));
let center = (a + b) * 0.5;
let half = max(abs(b - a) * 0.5, vec2f(min_width_px * 0.5, 0.0));
```

A bar from the minimum to the maximum of a bucket floats. It does not have to grow from zero. That is a range, not a magnitude.

`draw(6, count)` is one draw for every bar. Upload the rectangles in `setup` when the data is fixed. Write only the view uniform when the window moves.

## Lines and areas

Map each sample to a pixel. A linear series is those points in order. Smooth a measured series with a monotone cubic, not a centripetal spline that overshoots. The overshoot is a peak that never happened.

At an interior point, take the slope of the segment on each side. Opposite signs mean a peak or a valley, so the tangent is 0. Same signs, keep the smaller of the two slopes and half their weighted average. Controls sit one third of the x distance along that tangent:

```ts
c1 = { x: a.x + dx, y: a.y + m[i] * dx };
c2 = { x: b.x - dx, y: b.y - m[i + 1] * dx };
```

`dx` is `(b.x - a.x) / 3`. The GPU does not stroke a cubic. Flatten it. In pixels, the control polygon's bend is `M = max(|p0 - 2 p1 + p2|, |p1 - 2 p2 + p3|)`. The segment count that stays within `tol` pixels is `ceil(sqrt(0.75 * M / tol))`. A zoom recomputes this because `M` is in pixels. Give every cubic a fixed number of slots and repeat the end point in the unused ones, so the buffer does not resize when the window changes. Measured data can stay linear. A straight segment has `M = 0` and needs one piece.

An area walks the top in order and the baseline backward, then closes. A stacked area uses `y1` as the top and `y0` as the baseline, the same running sum as a stacked bar. Overlapping translucent areas hide the series under them. Several series that should be compared are lines.

Thick series, joins, and a million-point line are in [chart-series.md](chart-series.md).

## Scatter

One point is one instance of a six-vertex quad. `instance_index` reads `array<vec2f>` from a storage buffer, eight bytes per point, interleaved `x, y`. A second `array<u32>` is the category. Upload once.

The fragment shader turns the quad into a circle. `local` is the pixel center relative to the point. The signed distance to the rim is `length(local) - radius`. Coverage across one pixel is `clamp(0.5 - d, 0, 1)`. Discard at or below 0. Multiply the rgb by that coverage before blending. A hard `d <= 0` test flickers when the center sits on a fractional pixel.

```wgsl
let d = length(in.local) - in.radius;
let coverage = clamp(0.5 - d, 0.0, 1.0);
if (coverage <= 0.0) { discard; }
let a = in.color.a * coverage;
return vec4f(in.color.rgb * a, a);
```

The quad is `radius + 1` pixel larger than the circle so the rim is not clipped. Radius stays in pixels when the domain zooms. A zoom that also scales the quad's size in data units makes dots grow.

Highlight one point by index from the CPU. A scripted callout already knows the index, or finds it with a binary search on a sorted axis. Do not read an id texture back inside `render`. `mapAsync` waits, and a seek cannot depend on the previous read.

## Histogram and hex density

Bin counts: width `(hi - lo) / k`, index `floor((v - lo) / width)`. The value exactly at `hi` belongs to the last bin. Start from a rule, then look:

- Sturges, `ceil(log2(n)) + 1`, is few bins. It suits a small, single-humped set.
- A square root, `ceil(sqrt(n))`, is a middle guess.
- Freedman–Diaconis, bin width `2 * IQR * n^(-1/3)`, ignores the tails. IQR is the gap between the 25% and 75% quantiles of the sorted values.

Too few bins hide a second hump. Too many turn the hump into noise. Bins touch.

When points pile up, the pile hides the count. A heatmap counts points per cell, then colors the count. One compute thread per point does `atomicAdd` into its cell. One thread per cell writes a color. A sequential palette from `log(1 + count)` keeps a single spike from flattening every other cell. Cell size is in pixels. Small cells speckle. Large cells blur. Rebuild the counts when the window changes. The points themselves stay in the buffer.

A square grid makes diagonals look like structure because a diagonal neighbor is farther than a side neighbor. A hex grid does not. From a pixel, the fractional axial coordinates are:

```wgsl
let qf = ((0.57735027 * x) - y / 3.0) / size;
let rf = ((2.0 / 3.0) * y) / size;
```

Round in cube coordinates. `sf = -qf - rf`. Round all three, then rebuild the component that moved the most so `q + r + s` stays 0. Draw one instance per cell. An empty cell sends its vertices off screen. The hex size stays in pixels while the window zooms.

## Color on the mark

Upload the palette as floats in a uniform. A category index masks into that array. A sequential or diverging value is a `mix` along the scale, not a second category hue. The paper, ink, grid, and highlight come from the same uniform, so one write restyles the frame.

A series that is not selected goes to a muted color. Selection in a video is a function of time, shared by every panel in the shot. [chart-motion.md](chart-motion.md) is that clock.
