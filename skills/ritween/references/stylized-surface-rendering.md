# Stylized surfaces, ink, and outlines

Read only when the brief supports illustrative shading, material treatment, or 3D outlines. This is not a default recipe for clean motion graphics. Build the passes using [GPU scene workflow](gpu-scene-workflow.md); use [geometry and motion](gpu-geometry-motion.md) when surfaces deform.

## Choose the surface language first

A toon ramp, warm/cool shading, hatching, and charcoal communicate different materials. Select one coherent treatment from the subject. Do not stack every effect to demonstrate WebGPU. Protect the text region from competing texture and luminance changes.

Lighting inputs must share a coordinate space. Normalize surface normal `n`, light direction `l`, and view direction `v`, with guards for degenerate vectors. Update normals after deformation. Feed time-dependent controls from timeline time and use fixed seeds for grain.

## Banded and warm/cool light

A toon ramp maps a lighting value into authored color bands. Mapping the full dot product preserves variation on the dark side:

```wgsl
let coordinate = clamp(0.5 + 0.5 * dot(n, l), 0.0, 1.0);
```

An authored ramp texture allows unequal band widths. Use clamp-to-edge sampling and sample texel centers deliberately. Nearest filtering yields hard bands that can shimmer; soften boundaries across their pixel footprint. `fwidth` is available in the fragment stage and must execute in derivative-uniform control flow. A hard threshold with no filtering is especially unstable during motion.

For warm/cool form shading, blend two palette-derived colors with the same coordinate. Do not automatically choose blue shadows and yellow highlights for every subject. Add restrained highlights only when the material needs them. Normalize a half-vector only when `l + v` has nonzero length. If using a shadow map, decide whether shadowing changes the ramp coordinate or multiplies the final color; the latter can introduce colors outside a deliberately limited palette.

## Hatching and grain

Hatching encodes darkness as paper coverage, not an extra light source. Add layers as tone darkens while retaining earlier layers. Composite coverage as remaining paper, for example `paperLeft *= 1 - coverage`; summing black strokes can over-darken overlaps.

Choose where marks live:

- UV space follows the surface but inherits UV distortion and seams.
- Object space avoids some UV seams but needs an explicit projection or 3D field.
- Screen space maintains a page-like grain but slides relative to the object.

State that choice rather than letting the shader accidentally swim. Anchor procedural noise to a fixed coordinate and seed; hashing the current time creates boiling texture.

Filter strokes according to their pixel footprint. For subpixel hatch spacing, fade toward average coverage instead of flickering thin stripes. A line of zero width must contribute zero coverage. Compute derivatives before discontinuities such as `fract` where possible and outside pixel-dependent branches. Inspect moving surfaces after H.264 encoding—not only a full-resolution still—because fine texture can shimmer or disappear under compression.

Charcoal can use a grain threshold driven by pressure, but a noise field is not necessarily uniformly distributed; thresholding it does not guarantee a prescribed mean tone. Measure or calibrate coverage if tonal accuracy matters. A directional noise field should follow a small coherent set of surface directions rather than changing orientation independently at every pixel.

## Pick an outline method by its limitations

| Method                                 | Suitable use                                        | Important limitation                                               |
| -------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| View-normal rim in one fragment shader | A soft suggestion of form                           | Width varies with curvature; it is not a uniform silhouette stroke |
| Inverted mesh shell                    | Closed meshes with a controlled silhouette          | Does not capture every front-facing crease or intersection         |
| Explicit edge ribbons                  | Selected silhouettes and authored creases           | Needs adjacency, clipping, joins, and matching deformation         |
| Depth/normal postprocess               | Outlines across several meshes and their boundaries | Requires intermediate targets and careful thresholds               |

For an inverted shell, draw the body with back-face culling and a second inflated shell with front-face culling, with consistent winding and depth state. Split normals at hard corners can tear the shell. Store a separate smooth extrusion direction when appropriate without replacing the lighting normals. World-unit inflation shrinks with distance; pixel-width extrusion needs projection-aware offsets. Avoid copying world-unit bias values between scenes of different scale.

For screen-space outlines, render color plus suitable normals and linear view depth into scene-owned textures, then sample them in a fullscreen pass into `target`. Hardware depth is nonlinear under perspective. Use nearest samples or `textureLoad` when interpolating depth would invent nonexistent surfaces. Distinguish background samples from valid normals and guard divisions near zero depth.

Combine depth discontinuity and normal-angle tests. Relative-depth thresholds help across distance but can still mark sloping planes; second differences can reduce those false positives. Neighbor radius is not an exact universal line-width formula. Tune thresholds at target resolution and inspect silhouettes, creases, intersections, and the background separately.

## Temporal and technical checks

Regenerate intermediate images for each requested time, including backward seeks. Match formats, dimensions, and sample counts across attachments and pipelines; resolve multisampled textures before using a single-sampled postprocess. End every pass and let the engine submit the encoder. Dispose all scene-owned targets.

Inspect both paused frames and moving edges. Check text contrast over the darkest and brightest material states. If the treatment obscures the message, simplify the material—not the user's content.
