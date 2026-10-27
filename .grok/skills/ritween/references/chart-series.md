# Thick series and large series

`line-list` is a hardware line of one pixel. It has no width, no join, and no dash. A chart line is a quad per segment, pulled from a storage buffer. `instance_index` is the segment. `vertex_index` is the corner. There is no vertex buffer of corners.

A plot that is a thousand pixels wide cannot show a million distinct x positions. Past about two samples per pixel column, draw the column's extent, not every sample. The picture matches. The vertex load does not.

Scales and the view uniform are [chart-scales.md](chart-scales.md). Bars and circles are [chart-marks.md](chart-marks.md).

## A segment is a quad

Corners of one segment, as `(along, across)`:

```wgsl
const CORNER = array<vec2f, 6>(
  vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(0.0, 1.0),
  vec2f(0.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
);
```

`dir` is `normalize(b - a)`. The side is `vec2f(-dir.y, dir.x)`. Half the width is in pixels, so a zoom does not thicken the stroke. Pad the quad by about one pixel. The fragment shader spends that pad on the rim.

```wgsl
let dir = safe_normalize(b - a, vec2f(1.0, 0.0));
let n = vec2f(-dir.y, dir.x);
let c = CORNER[vi];
let along = c.x * length(b - a) + (c.x * 2.0 - 1.0) * pad;
let pos = a + dir * along + n * c.y * (half_width + pad);
```

`draw(6, count - 1)` strokes every segment. Positions are pixels of the full frame, then `vec2f(px / resolution * 2.0 - 1.0)` with y flipped. `point_px` runs the sample through the same view uniform as the ticks.

A zero-length segment uses a fallback direction. A gap stores a flag and emits a degenerate triangle so the stroke breaks.

## Joins, caps, and dashes

Two quads leave a wedge on the outside of a corner. A third draw, `draw(6, count - 2)`, fills one instance per interior vertex.

The miter reaches `1 / sin(alpha / 2)` half-widths from the vertex, where `alpha` is the interior angle. A sharp corner throws that point far outside the plot. When that ratio passes a limit near 4, draw a bevel instead. The bevel cuts across the two outer corners.

In the fragment shader the miter is the intersection of the two segment strips: a pixel is inside while its distance to each center line is at most the half-width. The bevel adds a cut along the outer edge. A round join is a fan of that radius at the vertex. Round is calmer on a noisy series. Miter matches a crisp polyline until the limit trips.

Caps are the two ends, a third small draw. Butt ends flush with the end sample. Square extends half a width past it. Round is a semicircle. Butt is the honest end of a measured series.

A dash is a distance along the polyline, not along x. Store the prefix length at each vertex. The fragment shader sees `fract(distance / (dash + gap))`. Inside the dash the extra distance is negative. Combine it with the side distance by `max`, so both the stroke edge and the dash edge anti-alias. A gap sample still breaks the stroke. A dash must not stitch across a gap.

## Anti-alias the stroke

The quad's local coordinate is already `(along, across)` in pixels. The signed distance to the stroke edge is `abs(across) - half_width`. Coverage is `clamp(0.5 - d, 0, 1)` in target pixels. Discard outside. Premultiply. This is the circle rim from [chart-marks.md](chart-marks.md), applied to a strip. Hardware multisample only answers in quarters of a pixel and costs a larger target. The distance is enough.

## When there are more samples than pixels

In one column the stroke is a vertical extent from the lowest sample to the highest. Samples in between do not change that extent. An average deletes a spike. The minimum and the maximum keep it.

One compute thread per column. The x values are sorted, so binary search finds the first index in the column and the first index past it. Scan that range, remember which index was lowest and which was highest, and write those two samples in their original order. The line into the next column then leaves from the sample that actually happened last. An empty column repeats the samples on either side so the stroke does not break.

```wgsl
@compute @workgroup_size(64)
fn minmax(@builtin(global_invocation_id) gid: vec3u) {
  let b = gid.x;
  if (b >= params.buckets) { return; }
  let lo = lower_bound(params.x0 + f32(b) * params.x_step, 0u, params.count);
  let hi = lower_bound(params.x0 + f32(b + 1u) * params.x_step, lo, params.count);
  // write pts[earlier extreme], then pts[later extreme], into out_pts[2b], out_pts[2b + 1]
}
```

`buckets` is the plot width in target pixels. Dispatch `ceil(buckets / 64)` on the frame encoder before the render pass. Do not `submit` and do not `finish`. The engine submits once. The line layer then reads `out_pts` with a count of `2 * buckets`.

If the visible samples are already at most about two per column, skip the reduce and draw the raw slice. A binary search on the CPU finds `from` and `to`. `draw(6, to - from - 1)` with a first-index uniform. The big buffer stays uploaded.

Build a pyramid in `setup` when the series is fixed and the shot zooms. Level `k` stores two points for every `2^k` source samples, using the same min and max. At `render`, with `visible` samples and `columns` pixel columns, choose `k = round(log2(visible / columns))` so the level still has about two points per column. Draw the visible slice of that level. No compute on the frame. A level that is coarser than a pixel column can swallow one of a close pair of opposite spikes. While zoomed out, that is the same limit as the screen. While zoomed in, drop toward level 0.

Largest-triangle-three-buckets keeps exactly one sample per bucket, the one that makes the biggest triangle with the previous choice and the average of the next bucket. It is the reduction to use when you need a fixed count. It will drop one of two opposite spikes that share a neighborhood. The screen path wants min and max. A parallel version replaces the previous choice with the average of the previous bucket, so each bucket is one thread.

## Points off screen

A sorted series does not need a visibility pass. The binary search is the cull. An unsorted scatter still runs the vertex shader for every point. At a tight zoom that is almost all misses. A compute pass appends the visible indices and writes the count into an indirect-argument buffer. `drawIndirect` reads that count. The count does not come back to the CPU, which would stall the frame and break a pure `render`.

Skip the cull when the window shows most of the set. The compact then costs more than it saves.

## Density instead of a stroke

A million overlapping points read as a flat blob. Count them. The heatmap and the hex grid in [chart-marks.md](chart-marks.md) are the picture of density. Use them when the question is "where is it crowded," not "what was the peak."

## What stays on the CPU

The series buffer is uploaded in `setup`. A window change writes the 64-byte view, and maybe a reduce dispatch. Filtering to a subset uploads a new buffer once, at the cut where the subset changes, not every frame inside the shot.

Prepare a typed array before the scene if the source is a file. Parsing inside `render` stalls the export and is not a function of the timestamp alone.
