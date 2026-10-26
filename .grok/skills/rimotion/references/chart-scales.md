# Scales, ticks, and the plot

A chart is a scale plus marks. The scale turns a data value into a pixel. The same scale, written into a uniform, turns that value into clip space. Build the scale on the CPU each `render` from `resolution`, the domain, and the story time. Upload it. Do not keep a second copy that updates on a different schedule.

`shaderScene` is a fullscreen triangle and its `text()` glyph set has no digits. A chart needs its own pipeline. The scene shape is in [external-project.md](external-project.md). The engine target is the whole frame, `alphaMode: "opaque"`. Clear it to the paper color. The plot is an inset of that frame, not a separate canvas.

## Plot rectangle

Margins hold the axis, the tick labels, and the title. The plot is what remains. Size the left margin from the longest y label, plus the tick and a gap. A short label such as `2.5 M` gives the marks more room than `2500000`.

```ts
const margin = { l: 64, r: 20, t: 36, b: 40 };
const plot = {
  x: margin.l,
  y: margin.t,
  w: width - margin.l - margin.r,
  h: height - margin.t - margin.b,
};
```

`width` and `height` are `resolution`. A 720p export and a 1080p export must both receive that pair. A scale baked for 1280 will slide when the preset changes.

Pixel y grows downward. Data y grows upward, so the y range runs from the bottom of the plot to the top: `[plot.y + plot.h, plot.y]`. Clip y grows upward again. One place flips it, the uniform, and every mark uses that uniform.

About one horizontal tick per 80 pixels, and one vertical tick per 40. A short axis gets fewer ticks. It does not get smaller type. Labels stay a fixed pixel size so a narrow frame stays readable.

## Linear scale

Domain is the data interval. Range is the pixel interval.

```ts
function scaleLinear(v: number, d0: number, d1: number, r0: number, r1: number): number {
  if (d1 === d0) return (r0 + r1) / 2;
  const u = (v - d0) / (d1 - d0);
  return r0 + u * (r1 - r0);
}
```

The inverse answers which value sits under a pixel. A scripted callout uses it, then snaps to the nearest sample. The pixel is almost never exactly on a sample.

```ts
function invertLinear(px: number, d0: number, d1: number, r0: number, r1: number): number {
  const u = (px - r0) / (r1 - r0);
  return d0 + u * (d1 - d0);
}
```

On the GPU the same line is `px = k * v + b`. Zoom changes `k` and `b`. The vertex buffer stays put.

## One uniform for CPU labels and GPU marks

Write both from the scale you just computed. A label that uses a stale domain sits next to a mark that has already moved.

Store series time as seconds from the first sample, and other large quantities as `(value - origin) / unit`. Float32 keeps about 7 significant digits and exact integers only up to 2^24. An epoch in milliseconds is coarser than two minutes there, so a zoomed line breaks into steps. WGSL has no `f64`.

Split the domain center into a float32 and the leftover so a zoom into a large domain does not quantize:

```wgsl
struct View {
  scale: vec2f,    // clip per data unit
  offset: vec2f,   // clip at the center
  center_hi: vec2f,
  center_lo: vec2f,
  resolution: vec2f,
  dpr: f32,
  log_mask: vec2f, // 1 on an axis that is logarithmic
}
fn data_to_clip(p: vec2f) -> vec2f {
  let logs = log2(max(p, vec2f(1e-30))) * 0.30103;
  let t = select(p, logs, view.log_mask > vec2f(0.5));
  return ((t - view.center_hi) - view.center_lo) * view.scale + view.offset;
}
```

`center_hi` is `Math.fround(center)` on the CPU. `center_lo` is `center - center_hi`. The shader subtracts that center, then scales. `kx` is pixels per x unit and is positive. `ky` is pixels per y unit and is negative, because pixel y grows downward. `pxc` and `pyc` are the frame pixels of the domain center:

```ts
view.scale = [kx * (2 / width), -ky * (2 / height)];
view.offset = [pxc * (2 / width) - 1, 1 - pyc * (2 / height)];
```

Sixteen floats, 64 bytes, is the whole view. Changing the window writes those bytes again.

A device pixel ratio above 1 is `resolution` itself in an export: the frame is already 1280×720 or 1920×1080. Use `dpr = 1` unless you are mapping CSS pixels. Anti-alias widths are in target pixels, so multiply a pixel-space distance by `dpr` only when the positions were computed in a smaller CSS space.

## Ticks at 1, 2, and 5

Divide the domain by the desired tick count. That raw step is rarely a readable number. Take the power of ten under it, and round the remainder to 1, 2, 5, or 10. The boundaries sit at the geometric midpoints, `√2`, `√10`, and `√50`.

```ts
function tickStep(start: number, stop: number, count: number): number {
  const raw = Math.abs(stop - start) / Math.max(1, count);
  if (!(raw > 0) || !Number.isFinite(raw)) return 0;
  const power = 10 ** Math.floor(Math.log10(raw));
  const err = raw / power;
  const factor = err >= Math.sqrt(50) ? 10 : err >= Math.sqrt(10) ? 5 : err >= Math.sqrt(2) ? 2 : 1;
  return factor * power;
}
```

Walk `ceil(lo / step)` through `floor(hi / step)`. For a step below 1, build the value as `i / (1 / step)` so `0.1 * 3` does not become a long decimal. A nice domain extends the data extent out to a tick, with a small pad, so the extreme sample is not glued to the frame.

Time ticks follow the calendar, not a raw millisecond step. A span of hours wants ticks on hours. A span of months wants the first of a month. A linear step across an epoch lands on times nobody reads.

## Log, time, and bands

A log axis maps `log10(v)`. The domain must be strictly positive. Zoom in log space so each decade grows evenly, then convert back with `10 ** t`. Zero and negatives need a different axis.

A time axis is a linear axis on seconds from the series origin. Format the label from that unit: seconds, minutes, hours, days. Do not store the epoch.

A band scale is for categories. Split the range into equal steps and leave padding inside the step:

```ts
function bandStep(span: number, n: number, paddingInner: number, paddingOuter: number): number {
  return span / Math.max(1, n - paddingInner + paddingOuter * 2);
}
function bandStart(i: number, origin: number, step: number, paddingOuter: number): number {
  return origin + step * paddingOuter + step * i;
}
function bandWidth(step: number, paddingInner: number): number {
  return step * (1 - paddingInner);
}
```

Grouped bars are a second band scale inside one category's width. The inverse of a band is the column index, `floor((px - start) / step)`. A gap between bars can return no category, or the nearest bar if a callout should still hit something.

## Axes and a quiet grid

An axis is a domain line, short ticks outside the plot, labels, and an optional title. A grid line is the same tick drawn across the plot. Draw horizontal grid lines. Vertical grid lines on a bar chart add noise. Keep the grid paler than the marks. A 1-pixel line sits on a pixel center, `floor(p) + 0.5`, or it covers two pixels and looks thick. The zero line may be darker. It is data, not scaffolding.

Drop a y domain line when the grid already shows the scale. Keep tick marks even when their labels are hidden.

Labels collide when the gap between centers is under half the sum of their widths plus about 8 pixels. Try every label, then every second, then every third, always from the first tick so the survivors stay regular. Estimate width without measuring a DOM: a digit is about `0.6 em`, a comma or space about `0.3 em`. Ticks stay. Only the text is removed. Rotate labels only when every category name must appear, and prefer a horizontal bar chart before that.

Decimal places come from the tick step, `ceil(-log10(step))`, then one or two more digits if that still rounds the step (`0.25` must not print as `0.3`). Group digits in threes. When the axis max is at least about a million, divide by a thousand, a million, or a billion and append a short suffix. Pick one convention for the shot and keep it. `1.234` and `1,234` are different numbers to different readers.

## Labels are a glyph atlas

Format the string on the CPU. Draw it with a storage buffer of bit rows, the same idea as the demo font: one row per `u32`, five bits of ink, seven rows per glyph. Include `0-9`, minus, the decimal mark, space, and the suffixes you actually use. `shaderScene`'s `text()` cannot print a number.

Center an x label on its tick. End a y label on the tick so the column of numbers shares a right edge. The anchor is the baseline. Shift y down by about `0.35` of the font size to sit on the tick. A label at the end of the axis shifts inward so it is not clipped by the frame.

Direct labels beat a legend when each series has an end. Place the name at the last point. If two ends are closer than the line height, push them apart from the top, then push back from the bottom so they stay inside the plot. A short connector shows which line a moved label belongs to. Gray the series that are not the point of the shot instead of naming all of them.

## Color

Three jobs, three palettes:

- Categories that have no order: distinct hues. Eight is already a lot.
- A quantity from low to high: one hue, pale to strong.
- A quantity around a baseline, such as profit and loss: two hues that meet on a neutral.

Marks against the paper need about 3:1 contrast. Text needs about 4.5:1. The grid is deliberately under that, so it does not compete. On a dark paper, use lighter mark colors than on a white paper. The same blue that is fine on white goes dull on black. The shader never reads a CSS variable. Upload `vec4f` colors. For a video, choose the paper once and derive the ink, the muted axis, the grid, and the series from it.

Do not encode the only distinction as hue. A direct label, a dash, or a marker still works when two hues look alike.

## Zoom is a new domain

The pixel range stays the plot. Zoom pulls both domain ends toward an anchor by the same factor. Below 1 moves in.

```ts
function zoomDomain(domain: [number, number], anchor: number, factor: number): [number, number] {
  return [anchor + (domain[0] - anchor) * factor, anchor + (domain[1] - anchor) * factor];
}
```

The anchor stays under the same pixel because its distance to each end is scaled equally. A pan adds the same amount to both ends: `dx / plotWidth * span`. On a log axis, do both in `log10` space.

Clamp after that. Keep the window inside the data, and refuse a span below a minimum, or the shot ends on two points and empty paper. If the window is wider than the data, pin it to the data.

In a scene the anchor, the factor, and the pan are functions of `localTime` or `progress`. Seek both directions. The domain at 3.0 seconds is the same on the way back.
