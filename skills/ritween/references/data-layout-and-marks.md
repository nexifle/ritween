# Data graphics: scales, labels, and marks

Read when a video explains actual data. These are custom WebGPU implementation patterns, not built-in chart components. Use supplied data or clearly label synthetic examples; never invent statistics or claims to make a composition look complete. Read [data animation and series](data-animation-and-series.md) for moving windows and dense lines.

## Begin with the question

Choose a mark that answers the intended question:

| Question                                | Useful mark                                 | Integrity check                                                       |
| --------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------- |
| Compare category magnitudes             | Bars                                        | Include zero for length encoding; disclose broken axes if exceptional |
| Show change across ordered observations | Line                                        | Preserve order and missing-data gaps                                  |
| Show contribution and total over time   | Stacked area                                | Use a meaningful baseline; middle layers lack a shared baseline       |
| Relate two measurements                 | Scatter                                     | Explain axes and avoid implying causation                             |
| Describe a distribution                 | Histogram or density                        | Declare binning and normalization                                     |
| Compare shares                          | Bars; occasionally a few pie/donut segments | Shares belong to the same whole                                       |

A range bar can float because it encodes an interval, not magnitude from zero. Separate positive and negative accumulation in diverging stacks; a simple cumulative sum is only sufficient for nonnegative values. A percent stack hides absolute totals, so retain total context when it matters.

Write the title from a verified finding, with units and comparison intervals. Distinguish a smoothing estimate from raw observations. Do not interpolate a missing measurement into a fictional continuous observation.

## Share one scale between labels and marks

Reserve a plot rectangle inside the frame for title, axes, labels, and safe margins. Compute scales from the current domain and context resolution. CPU label positions and GPU marks must use the same domain, range, units, and timestamp.

```ts
function scaleLinear(
  value: number,
  d0: number,
  d1: number,
  r0: number,
  r1: number,
) {
  if (d0 === d1) return (r0 + r1) / 2;
  return r0 + ((value - d0) / (d1 - d0)) * (r1 - r0);
}
```

Validate finite inputs and nonzero plot dimensions. Pixel Y increases downward; map increasing data Y toward the top. Convert pixel positions to clip space once, with the corresponding Y flip. Apply a viewport or scissor rectangle to clip marks without clipping external labels.

Float32 cannot preserve fine detail in large epoch timestamps. Subtract a CPU-side origin and store relative seconds or other sensible units before upload. Splitting a uniform center into high/low parts does not recover precision already discarded from vertex data. For extreme zoom ranges, use a deliberately designed rebasing or high/low representation for both data and transform.

Use strictly positive domains for logarithmic axes. Zero and negative values require another scale or an explicit documented treatment. Use calendar-aware ticks and an explicit timezone for dates rather than blindly spacing epoch milliseconds. Category bands need intentional inner/outer padding and stable ordering.

## Make labels readable at delivery size

Choose tick density from the available space and formatted label width. Numeric steps such as 1, 2, and 5 times a power of ten are useful defaults, not a mandatory count. Handle constant domains, very small spans, and nonfinite inputs. Keep formatting stable across a shot; avoid long float tails and ambiguous units.

Suppress colliding labels before shrinking them into illegibility. Direct series labels often reduce legend lookup. Preserve the relationship with a short connector when moving a label to avoid collision. Label every necessary unit, baseline, and category; essential distinctions must not rely on hue alone.

Render text through a prepared texture or a complete atlas. There is no public numeric text helper that a chart can assume exists. Prepare glyph resources in setup; updates for known changing strings must remain synchronous in render. A prebuilt atlas avoids font loading or asynchronous rasterization in the frame loop.

Use categorical colors for unordered groups, sequential colors for magnitude, and diverging colors for a meaningful center. Test mark/background and text/background contrast at output size and over animation. A subtle grid is supporting structure, not a substitute for readable marks. Do not mechanically snap continuously moving marks to pixels; that can cause judder.

## Implement the geometry you need

- **Bars:** one instance per data rectangle; build a six-vertex quad in the vertex shader. Distinguish a minimum visible width from true encoded magnitude—widening dense bars may cause overlap and needs a different representation.
- **Lines:** expand segments into triangles for controllable width and joins. Keep measured data linear unless smoothing is explicitly justified. If smoothing is used, select a shape-preserving method and verify it does not invent extrema.
- **Areas:** construct a valid strip or tessellation between top and baseline, handling crossings and gaps rather than assuming any polygon can be drawn as a fan.
- **Scatter:** instance a padded quad per point; use a signed-distance circle in the fragment shader for filtered coverage. Keep radius in target pixels when zoom should not change marker size.
- **Histogram:** choose bin boundaries deliberately, put the exact upper bound into the final bin, and explain whether heights show counts, proportions, or density. Unequal bin widths require density if area encodes frequency.
- **Heatmap or hex density:** aggregate into cells when overlap hides counts. Clear count buffers before every independently evaluated frame. A fixed CPU aggregation can be simpler than a compute pipeline for modest data.

Choose straight or premultiplied alpha consistently. With premultiplied output, return RGB multiplied by alpha and blend with `one` / `one-minus-src-alpha`. Padding around analytic marks must include their antialiasing fringe. Keep structural grids quieter than the encoded data.

## Check the claim and the image

Validate totals, domains, category order, missing values, units, and the exact comparison used in the title. Inspect labels at the requested frame dimensions. Review animation for misleading changes of baseline or axis range. A technically correct shader does not prove a truthful or understandable chart.
