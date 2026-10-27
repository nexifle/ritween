# WGSL shading concepts

These color a surface after the vertex shader. `n`, `l`, and `v` are unit vectors: the normal, the direction toward the light, and the direction toward the camera. Drive every term from those vectors and from scene `time`. Two frames at the same timestamp must match.

`shaderScene` can run a fragment formula on a fullscreen triangle. A mesh needs your own pipeline. An extra draw or a second pass needs a depth texture you create in `setup` and attach yourself. The engine hands you one color `target` and does not add a depth buffer.

## Paint light in bands

Lambert `max(dot(n, l), 0)` is a smooth ramp. A cartoon replaces it with a few flat colors. Store those colors in a 1-pixel-tall texture, one row per look. Map the full dot, including the dark side, into `0..1`:

```wgsl
let u = 0.5 + 0.5 * dot(n, l); // 0 faces away from the light, 1 faces it
```

Do not clamp the dot first. Clamping throws the whole dark side onto one texel, so a painted shadow color and a darker core cannot both exist. Texel `floor(u * width)` is the band. A 16-texel row can be 7 dark, 4 mid, 5 light. `floor(u * bands)` cannot do that: every band is the same width and the color is only a gray step. Multiply the sampled color by the surface color when one row should serve many objects.

A linear sample blends a whole texel, which is `1/16` of `u` and looks soft. A nearest sample is hard and flickers, because the color jumps inside one pixel. Hold the sample on the texel and blend only in a strip as wide as one pixel:

```wgsl
let x = clamp(u, 0.0, 1.0) * f32(width); // width of the ramp row
let s = x - 0.5;
let i = floor(s);
let t = s - i;
let w = max(fwidth(x), 1e-4);            // how far x moves across one pixel
let tt = clamp((t - 0.5) / w + 0.5, 0.0, 1.0);
let uu = clamp((i + tt + 0.5) / f32(width), 0.5 / f32(width), 1.0 - 0.5 / f32(width));
```

`fwidth` must run on every pixel, not inside a branch that depends on the pixel. Clamp `uu` away from the edge of a repeating sampler, or the brightest texel blends with the darkest one. Raise `w` above `fwidth(x)` when the bands should be soft on purpose. At `w = 1` the sample is ordinary linear filtering.

A hard highlight is the same step on a Blinn-Phong lobe. `h = normalize(l + v)`, `s = pow(max(dot(n, h), 0), gloss)`. The gloss now sets the spot size. Cut the lobe at `0.5` and soften that cut with `fwidth(s)`:

```wgsl
fn aa_step(edge: f32, x: f32) -> f32 {
  let w = max(fwidth(x), 1e-4);
  return smoothstep(edge - w, edge + w, x);
}
let spot = aa_step(0.5, s) * step(0.0, dot(n, l));
```

A rim is the same cut on `1 - dot(n, v)`, kept on the lit side so the dark side stays flat.

A shadow map returns `lit` in `0..1`. Darkening the color after the ramp invents a fourth color. Fold the shadow into the coordinate instead, so the occluded pixel reads the dark band: `min(dot(n, l), mix(shadowCap, 1.0, lit))`.

## Keep the dark side colored

`max(dot(n, l), 0)` flattens everything that faces away from the light. Form disappears there. Map the whole dot into `0..1` and blend two tones:

```wgsl
let t = (1.0 + dot(n, l)) * 0.5; // 0 fully dark, 0.5 the terminator, 1 fully lit
let cool = vec3f(0.0, 0.0, 0.4) + 0.2 * albedo;
let warm = vec3f(0.4, 0.4, 0.0) + 0.6 * albedo;
let color = mix(cool, warm, t);
```

The lit side carries more of the surface color. The dark side carries more of the cool color, and it still changes as the surface turns, so the form stays readable. Pure blue and yellow make every object the same. Because this mix never reaches white or black, a white highlight still reads. Mix toward white rather than adding it, so the color stays inside `0..1`:

```wgsl
let h = normalize(l + v);
let s = pow(max(dot(n, h), 0.0), gloss) * step(0.0, dot(n, l));
let shaded = mix(color, vec3f(1.0), s);
```

The cheapest outline is the same fragment: where `dot(n, v)` is small, the surface is edge-on. Soften it across one pixel.

```wgsl
let ndv = max(dot(n, v), 0.0);
let w = max(fwidth(ndv), 1e-4);
let ink = 1.0 - smoothstep(width - w, width + w, ndv);
```

That line is thin on a sphere, fat on a gentle curve, and missing on a flat face seen at an angle. Use a shell or a screen-space pass when the width has to be constant.

## Cover paper with strokes

Ink has one color. Darkness is how much paper a pixel still shows. From Lambert, keep a floor so a back face is not solid black, then invert it:

```wgsl
let light = (0.12 + 0.88 * max(dot(n, l), 0.0)) * exposure;
let g = 1.0 - light; // 0 is bare paper, 1 is covered
```

A toon fill of the same light is a staircase. Soften each step across one pixel or the boundary crawls:

```wgsl
fn toon_steps(x: f32, bands: f32) -> f32 {
  let f = x * bands;
  let fw = max(fwidth(f), 1e-4);
  let level = floor(f) + clamp((fract(f) - 1.0) / fw + 1.0, 0.0, 1.0);
  return clamp(level, 0.0, bands - 1.0) / (bands - 1.0);
}
```

One layer of parallel strokes comes from a coordinate `q` where `1` is the gap between strokes. `s = q.x + q.y` is 45 degrees. `s = q.x - q.y` is the other diagonal. Distance to the nearest stroke center is `abs(fract(s) - 0.5)`. A pixel is ink when that distance is under half the stroke width.

Anti-alias by overlapping the pixel's footprint with the stroke. `w = fwidth(s)` is the footprint. The short form `clamp((h - d) / w + 0.5, 0, 1)` is wrong for a hairline: at `h = 0` it still paints the center. Use the overlap. Compute `fwidth` on the raw `s`, before any wobble, and outside a branch.

```wgsl
fn stroke_cover(s: f32, halfWidth: f32, fw: f32) -> f32 {
  let d = abs(fract(s) - 0.5);
  let w = max(fw, 1e-5);
  let cover = clamp((min(halfWidth, d + 0.5 * w) - max(-halfWidth, d - 0.5 * w)) / w, 0.0, 1.0);
  let avg = clamp(2.0 * halfWidth, 0.0, 1.0);
  return mix(cover, avg, smoothstep(0.35, 0.7, fw)); // closer than ~3 px per stroke becomes a flat gray
}
```

When the strokes are finer than a pixel they shimmer. Past `fwidth(s) > 0.35`, fade to the average coverage `2 * halfWidth`. From far away the hatch becomes the gray it would average to.

One layer cannot get darker than its max width. Add layers as `g` rises, and keep the earlier layers. Thresholds `0.08, 0.30, 0.52, 0.72` with a fade of `0.22` bring each layer in as a hairline. Offsets `0, 0.5, 0.25, 0.75` drop the new strokes into the gaps, so the hatch gets denser instead of only thicker. Crosshatch by sending layers 2 and 4 down the other diagonal. Ink does not add: a black pixel cannot get blacker. Track the paper that remains.

```wgsl
let amount = clamp((g - threshold) / 0.22, 0.0, 1.0);
paperLeft *= 1.0 - stroke_cover(s - offset, width * amount, fw);
let ink = 1.0 - paperLeft;
```

Round the stroke count to an integer. On a surface where `u = 1` meets `u = 0`, an integer period lands on the same line, so the seam does not show.

Where the strokes live:

- Mesh `uv`, scaled so the two axes have a similar gap. The strokes stick to the surface when the camera moves. They also stretch wherever the `uv` stretches, packed at a pole and sparse on a wide face.
- Screen pixels. The gap is even, and the strokes stay on the screen while the object slides under them.
- Screen pixels minus the projected object center, scaled by that center's `w`. The field follows the object and keeps its size better than raw pixels.

A silhouette in this same shader is `dot(n, v) / fwidth(dot(n, v))`, which is roughly the distance to the edge in pixels. Mix the ink over a paper color. A little high-frequency noise in the paper is enough. It is not a second lighting term.

## Let grain catch the dark

Charcoal does not lay lines on a grid. Tone sets a pressure. Paper grain decides which pixels receive it.

Half-Lambert keeps a gradient on the dark side. A contrast curve then empties the lights and fills the darks. The pivot stays at `0.5`:

```wgsl
fn contrast(x: f32, k: f32) -> f32 {
  let a = pow(x, k);
  let b = pow(1.0 - x, k);
  return a / max(a + b, 1e-6);
}
let x = clamp((dot(n, l) * 0.5 + 0.5) * exposure, 0.0, 1.0);
let pressure = 1.0 - contrast(x, k); // 0 is clean paper
```

`k = 1` is a straight line. Larger `k` pushes values away from `0.5`. Guard the division: a large `k` can round both powers to zero.

Paper height `h` is value noise in screen pixels, several octaves, stretched off `0.5` so the range actually reaches the peaks and valleys. Charcoal sticks where the grain is higher than `1 - pressure`. Light pressure hits only the peaks. Heavy pressure fills the valleys. Soften the threshold. If `h` is uniform in `0..1`, the average coverage comes back to the pressure, so the tone stays correct.

```wgsl
fn grain_cover(h: f32, pressure: f32, soft: f32) -> f32 {
  return clamp((h - (1.0 - pressure)) / soft + 0.5, 0.0, 1.0);
}
```

A small `soft` is hard charcoal on rough paper. A large `soft` is a pencil. Screen-space grain stays on the page while the drawing moves across it. Divide by the device pixel ratio when the grain should not shrink on a dense screen.

A stroke is value noise stretched along a direction. Split the sample point into the part along `d` and the part across it, then scale them by different frequencies:

```wgsl
fn streak(p: vec3f, d: vec3f, freq: f32, stretch: f32) -> f32 {
  let across = freq;
  let along = freq / stretch;
  let q = p * across + d * (dot(d, p) * (along - across));
  return value_noise(q);
}
```

Sample `p` in object space, not `uv`, so a torus seam and a sphere pole do not cut the strokes. `stretch = 1` is a round blob. Raise it and the blob becomes a long mark. Turn the noise into a mask with `smoothstep`, then multiply pressure by something whose average is about `1` (`mix(1, 0.5 + mask, strength)`). The strokes redistribute pressure. They do not change the average tone, and the grain still punches holes inside a stroke.

The direction should follow the form. Take a tangent projected onto the surface, or the light direction with the normal removed, and quantize it to a handful of fixed directions. A brand-new direction at every pixel looks like noise, not a hand. Object-space strokes stay put when the camera zooms. Screen-space grain should not: the paper is the page.

A smudge ignores the grain and fills by darkness alone, like a finger rub. Extra pressure where `dot(n, v)` is small darkens the outer edge. Add that before the grain test.

## Draw the same mesh again as a shell

A cartoon outline can be a second draw. Inflate every vertex along its normal, cull front faces, and let the depth test hide the middle. What remains is the rim. No edge list.

The body pipeline uses `cullMode: "back"`. The shell uses the same buffers with `cullMode: "front"`. Both write depth with `depthCompare: "less"`. `frontFace` must match the mesh. WebGPU's default is `"ccw"`. If the outline covers the object, the winding and the cull mode disagree. Draw the body first, then the shell, in one pass.

```wgsl
let q = p + n * (widthMeters * weight * stretch);
```

"Out" is out of the surface. On the inner ring of a torus the normal points toward the axis, so that ring grows inward. Width `0` makes the shell match the body and the line disappears.

A width in meters shrinks as the object recedes. For a constant pixel width, offset after projection. The GPU divides `xy` by `w`, so multiply the offset by `w`.

```wgsl
var c = viewProj * vec4f(q, 1.0);
if (c.w > 0.0) {
  let dirPx = to_pixels(viewProj * vec4f(p + n * 0.01, 1.0), resolution)
    - to_pixels(viewProj * vec4f(p, 1.0), resolution);
  if (dot(dirPx, dirPx) > 1e-8) {
    let push = normalize(dirPx) * pixelWidth;
    c = vec4f(c.xy + push / (0.5 * resolution) * c.w, c.z, c.w);
  }
}
```

`0.01` only samples the normal's direction. `resolution` comes from the render context.

A hard corner stores several vertices on one position, one normal per face. Inflating each copy along its own normal tears the shell and the line breaks. Keep the split normals for lighting. Weld copies that share a position and average their normals, weighted by corner angle, into a second normal used only for the push. A box corner then moves along the diagonal, and the line thins there. Restore it:

```wgsl
stretch = 1.0 / max(dot(normalize(smoothNormal), normalize(faceNormal)), 0.5);
```

The clamp at `0.5` stops a sharp corner from throwing the vertex more than twice the width.

The shell fragment returns one color, computed per vertex: a constant ink, the surface color times `0.3`, or a mix toward the background by view distance. Multiply the width by a weight. `0` drops the line. Read the weight from a vertex attribute, or from `textureSampleLevel` in the vertex shader. `textureSample` needs derivatives, which exist only in the fragment stage. A weight that jumps from `0` to `1` across one triangle makes a meter-wide shell cut through the surface.

The same draw makes internal lines where one part of the mesh covers another. At the end of that line the depth gap goes to zero and the test flickers. Push the point away from the camera along its view ray so the screen position stays:

```wgsl
q += normalize(q - eye) * zOffset;
```

Start near `0.01` to `0.03` meters. A large offset deletes internal lines and also sinks the outline into a floor. A shell does not draw a crease that faces the camera, or the line where two separate meshes intersect, or a useful outline on an open card.

## Find edges from the finished picture

After the meshes are drawn, one fullscreen pass can ink every object, including where one mesh passes through another. The mesh shader writes color and a world normal. Store linear view depth in meters in another target. A hardware depth value is not linear: a small step near the camera is a large step far away, so compare meters.

In Ritween that is two passes inside `render`. The first writes the textures you created in `setup`. The second reads them and writes `target`. Do not filter the depth or normal sample. A blend of a surface and the background is a distance in mid-air. Treat a stored normal of length near zero as background, and substitute the center pixel's normal so the sky is not a crease. The silhouette against the sky comes from depth.

A silhouette is a jump between a pixel and its neighbors. A threshold in meters marks distant surfaces, because a pixel covers more meters as distance grows, and it misses small gaps up close. Divide the jump by the pixel's own distance:

```wgsl
let jump = max(abs(left - c), abs(right - c), abs(up - c), abs(down - c));
let strength = jump / (c * relativeThreshold);
```

A steep floor still trips a relative test. Compare against a straight line through the opposite neighbors. A flat plane is nearly straight. A silhouette is not.

```wgsl
let bend = max(abs(left + right - 2.0 * c), abs(up + down - 2.0 * c));
let strength = bend / (c * relativeThreshold);
```

That also ignores a smooth convex curve, which is what you want. It misses a crease whose two sides are at the same distance, such as a box edge facing the camera. Those come from normals.

Two unit normals differ by an angle whose chord is `sqrt(2 - 2 * dot(a, b))`, equal to `2 * sin(angle / 2)`. Divide by the chord of the angle limit. A 90-degree box edge crosses a 35-degree limit. A 1-degree step on a smooth surface does not. Roberts or Sobel on the three normal components is the same test with a wider footprint. Skip the test where the stored normal is empty.

Take the max of the depth strength and the normal strength. Sampling neighbors `r` pixels away makes the line about `2r` pixels thick. `smoothstep` the strength through `1` for a soft edge. Scale the threshold up with distance when far lines should fade.

Use this pass when every object, and every intersection, needs an outline and you can pay for the extra targets. Use a shell when one closed mesh needs a constant rim and you want no extra buffers. Use `dot(n, v)` when a soft hint of an edge is enough and a flat face does not need a line. Creases that face the camera need either this normal test or the edge ribbons in [vertex.md](vertex.md).
