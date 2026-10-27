# Data graphics: timeline animation and large series

Use with [data layout and marks](data-layout-and-marks.md). Animate a finding, not an interactive dashboard transplanted into a video. Scales, selected samples, annotations, and every panel must be functions of the requested timestamp.

## Author the data clock

Keep video seconds separate from data-domain time. A pure `storyTime(localTime)` can map a six-second reveal onto several years of observations. Store fixed data in setup and derive the visible range, highlight, and labels from that shared mapping.

For a zoom, interpolate domain endpoints or scale around a chosen anchor:

```ts
function zoomDomain(
  domain: readonly [number, number],
  anchor: number,
  factor: number,
) {
  return [
    anchor + (domain[0] - anchor) * factor,
    anchor + (domain[1] - anchor) * factor,
  ];
}
```

Clamp to meaningful extents and a minimum span. A logarithmic axis zooms in log space. Explain changing axes when they affect comparison; a fixed range can be more honest than constant auto-fitting.

A rolling window is `[storyTime - windowDuration, storyTime]`, with any intended delay stated explicitly. Slice preloaded data or regenerate deterministic samples from their indices. Do not append to a playback-dependent ring buffer. If an auto-range needs hysteresis, precompute its state changes from the full series; do not retain the last displayed range as the next frame's input.

Interpolate datasets only when sample/category correspondence is meaningful. Resampling to a shared domain requires an explicit policy for gaps and interpolation. Unrelated datasets may need a cut or crossfade rather than a morph that suggests identity.

## One selection across all panels

A callout is an authored annotation, not a hover event. Select the actual sample by index or by searching a sorted axis, then put the marker on that sample. Use the same selection for linked overview, detail, scatter, and aggregate panels.

Do not read an ID texture back inside synchronous render. Avoid `mapAsync`, pointer events, live WebSockets, and previous-frame picking results as sources of the exported state. Prepare data indexes in setup where useful. Preserve timezone and aggregation rules across panels; an empty hourly bin is missing data, not automatically a measured zero.

Keep labels within safe margins and away from each other. Animate the focal change without making text chase the moving marks. Every panel has its own plot rectangle and scale but shares semantic colors and the story clock. A DOM tooltip or SVG overlay outside the render target will not appear in the MP4.

## Thick lines need joins and filtering

Generate a quad per line segment in pixel space, with a fallback for zero length and an explicit gap flag. Add a join/cap strategy rather than overlapping translucent quads indefinitely. Use a bounded miter or bevel for sharp corners. Preserve gaps in both geometry and dash phase policy.

Dashes follow distance along the polyline, not X position. Store prefix lengths and evaluate dash coverage in the fragment shader. Pad geometry for an analytic antialiasing fringe and blend consistently. See [geometry and motion](gpu-geometry-motion.md) for edge construction and MSAA tradeoffs.

## Reduce according to screen resolution

A million samples do not create a million distinguishable horizontal positions in a narrow plot. Profile before introducing compute, and preserve the feature the story relies on.

- For sorted time series, locate the visible slice by binary search, including neighboring boundary samples so clipping retains the entering and leaving segments.
- Min/max buckets can preserve extrema better than averages. Preserve temporal order and include first/last samples where needed for continuity. A two-extrema summary is an approximation: it does not reproduce all crossings or topology.
- Buckets should follow the current screen-space transform, including log/time mapping where applicable. A fixed reduction can lose detail after zooming in.
- A precomputed multiresolution pyramid is useful for fixed data. Choose a sufficiently detailed level for the visible span; inspect nearby opposite spikes and missing-data gaps.
- Largest-triangle sampling is useful when a fixed count is needed, but it does not guarantee preservation of every extremum. Do not present it as equivalent to min/max.
- Dense scatter can become a density representation when the question is concentration. Declare the change of encoding instead of silently replacing observations with a different statistic.

A GPU reduction or culling pass records commands on the supplied encoder before the draw. Clear counters on every frame, bound all writes, initialize indirect arguments, and preserve deterministic output order when joining samples. Atomic append order is not a stable polyline order. Do not read counts back synchronously or submit your own command buffer.

Static buffers belong in setup. Update small view uniforms during render rather than reparsing files or rebuilding unchanged geometry. Upload only what actually changes; do not claim GPU acceleration without measuring the affected workload.

## Validate semantics and seeking

Test a time inside the moving window, seek backward, and return using the same renderer. Compare decoded pixels in the same environment and check selected values independently. Inspect both sides of domain changes. Review the full playback for axis pumping, label collisions, dropped spikes, misleading interpolation, and reading time. A matching endpoint image does not validate the story between endpoints.
