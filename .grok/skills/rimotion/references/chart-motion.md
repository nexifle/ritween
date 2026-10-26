# A chart that moves

A dashboard listens to a pointer. A scene cannot. `render` is a pure function of the timestamp the engine passes in. It must not integrate a delta, append to a ring, or remember the previous domain. Seek to the same time from either side and the frame matches, including every label.

The picture is one opaque target. Draw the grid, the marks, the ticks, and the callout into it. There is no second SVG layer in the export. [chart-scales.md](chart-scales.md), [chart-marks.md](chart-marks.md), and [chart-series.md](chart-series.md) are the geometry. This file is how that geometry follows the clock.

## The clock

`localTime` is seconds since the scene started. `progress` is 0 at the start and 1 at the end. A window, a highlighted index, and a panel selection are expressions of those. `smoothstep` is the ease. A reduced-motion cut is an expression that jumps. The export has no operating-system setting to read, so the jump is a choice in the scene.

```ts
const t = smoothstep(0, 1, clamp((localTime - 1) / 2, 0, 1));
const factor = mix(1, 0.25, t); // zoom in across two seconds
const domain = zoomDomain(full, anchor, factor);
```

`zoomDomain` is in [chart-scales.md](chart-scales.md). Clamp it to the data and to a minimum span in the same function. The result depends only on `localTime`.

A pan is the same. Add `(dx(localTime) / plotWidth) * span` to both ends. Do a log axis in log space, then convert back.

## Two data sets

When the series changes at a moment in the shot, interpolate. Samples that pair one-to-one mix per point: `y = mix(before, after, eased)`. When the counts differ, resample both onto the same x grid first, then mix. A jump with no blend is a hard cut, and it belongs on a scene boundary if the viewer should not see the morph.

The blend parameter is `progress` or a window of `localTime`. It is not a clock started on the previous frame.

## A rolling window

The right edge is story time minus a small delay. The left edge is that minus the window length.

```ts
const right = storyTime(localTime) - delay;
const left = right - windowSec;
```

Real packets arrive in bursts. A right edge glued to "now" lurches each time a burst lands. A delay at least as long as the burst keeps the edge full. In a scene the samples are a function, `value(i) = f(seed, i)`, with `i` from `floor(left * rate)` to `floor(right * rate)`. Write that slice into the storage buffer every `render`, or store the whole series in `setup` and pass `first` and `count` with the view. Both seek. An append-only ring does not: at a frame in the middle of the shot the buffer would only contain what earlier frames happened to push.

A GPU ring that mirrors the window is for a live feed that never rewinds. Do not use it here.

The y range of a moving window is part of the same function. Fit it to the samples inside `[left, right]`, pad it, and snap it to a 1-2-5 step. Expand as soon as a sample would leave the frame. Shrink only after the samples have used less than about 40% of the range for a stretch of story time you can see by scanning the series, not by counting frames you already drew. Animate between two snapped ranges with `mix` and an exponential of elapsed story time:

```ts
const shown = target + (from - target) * Math.exp(-(localTime - t0) / 0.15);
```

`t0` is the story time when `target` last changed, which you can find because you can see the whole series. Do not keep `from` in an instance field that the next `render` reads back.

## Spikes and decimation are authored

A live feed can outrun the frame. The video cannot grow a queue. Decide the rate in the scene. The screen still only needs the minimum and the maximum of each pixel column, from [chart-series.md](chart-series.md). Bucket while you build the slice: one column is `windowSec / plotWidth` seconds wide, and you keep two samples from it. A spike survives. The buffer stays the size of the plot.

## Callouts

A tooltip in a video is a label you place on purpose. Choose the x in data units from the clock. Invert is unnecessary if you already have the value. If you have a pixel, invert the scale, then binary-search the sorted samples and mark the nearer one. Draw the marker on the sample, not on the query position. Format the number on the CPU and draw it with the digit atlas.

The hit target is a story choice, not a finger. Nearest-within-radius beats "the instance drawn last" when two marks overlap. A crosshair is two hairlines through that sample, in the axis color, plus the label. Keep it inside the frame: flip the label left when it would pass the right edge, and above the point when it would pass the bottom.

Several series at one x share the vertical rule. Spread their labels with the same push used for direct labels.

## Linked panels

One selection, every panel. The selection is a time range or a category index derived from `localTime`. Each panel reads it. None of them store their own.

A brush that tightens across the shot is `zoomDomain` on the overview. The detail panel uses that domain as its x scale. A bar chart of hour-of-day recomputes its 24 means from the samples inside the range:

```ts
function hourlyMean(values: number[], times: number[], range: [number, number] | null): number[] {
  const sum = new Array(24).fill(0);
  const count = new Array(24).fill(0);
  for (let i = 0; i < values.length; i++) {
    if (range && (times[i] < range[0] || times[i] > range[1])) continue;
    const h = hourOf(times[i]);
    sum[h] += values[i];
    count[h] += 1;
  }
  return sum.map((s, h) => (count[h] ? s / count[h] : 0));
}
```

Highlight the active hour in both panels from the same index. A scatter and a heatmap built from one series can share it. Stride the scatter, for example every fifth sample, and let the heatmap count them all. The same index has to land on the same event in every panel, so derive both from one array in `setup`.

## Several panels in one frame

Divide `resolution` into plot rectangles. Each panel has its own domain, its own view uniform or its own offset inside one uniform array, and the same paper and ink. Leave a gap. Align time axes that should be compared. A panel that shares an x scale with the one above can drop its x labels.

The title of the frame is the finding. The axis title is the unit. Both are glyph strings, placed in the margin.

## What not to import

Pointer movement, a wheel factor, a two-finger pinch, hover, and a live WebSocket are inputs. Replace each with a function of `localTime` before you draw. A quadtree is a pointer index. The scene already knows the index.

Do not read pixels back to build a tooltip, and do not take a second snapshot for print. Preview and export call the same `render`. If the callout is in the pass, it is in the MP4.

Check a moving chart the way you check any scene. Render a PNG inside the shot, seek backward to it, and render both sides of a cut where the domain or the selection changes. Then export. A window that only looks right while the preview plays forward is an accumulated buffer.
