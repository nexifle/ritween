# WGSL vertex concepts

These run in the vertex shader. The vertex buffer stays the rest pose. `time` from the scene is the only clock, so a seek redraws the same frame.

`shaderScene` is a fullscreen triangle. A mesh, an edge list, or instancing needs your own pipeline and, when the depth test matters, your own depth texture. An inflated outline that culls front faces is in [npr.md](npr.md).

## Deform a point, then rebuild the normal

Any formula may move a vertex before it is projected. A 24-vertex box will not bend: only the corners move, and the faces stay flat triangles. Use a dense grid.

Lighting uses the normal. Moving the position and keeping the old normal leaves `dot(n, light)` describing the rest pose.

**Example, twist.** Rotate around Y by an angle that grows with height. The base stays put. Distance to the axis does not change.

```wgsl
fn rot_y(p: vec3f, theta: f32) -> vec3f {
  let c = cos(theta);
  let s = sin(theta);
  return vec3f(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}

fn twist(p: vec3f, k: f32, baseY: f32) -> vec3f {
  return rot_y(p, k * (p.y - baseY)); // k is radians per meter
}
```

Rotating the normal by the same angle is almost enough. The angle changes with height, so the side becomes a screw. Tilt the normal before rotating it:

```wgsl
let tilt = k * (p.z * n.x - p.x * n.z);
let fixed = rot_y(vec3f(n.x, n.y - tilt, n.z), k * (p.y - baseY));
```

**Example, bend.** Replace the straight axis with a circular arc. Curvature `kappa` is `1 / radius`. A point at height `y` travels `kappa * (y - baseY)` radians along the arc. The center keeps its length. The inside shortens, the outside lengthens.

```wgsl
fn bend(p: vec3f, kappa: f32, baseY: f32) -> vec3f {
  if (abs(kappa) < 1e-4) {
    return p; // radius would be huge
  }
  let r = 1.0 / kappa;
  let theta = kappa * (p.y - baseY);
  return vec3f(r - (r - p.x) * cos(theta), baseY + (r - p.x) * sin(theta), p.z);
}
```

Keep the radius larger than half the thickness, or the inside passes through the center and the surface flips. Rotate the normal by `theta` around Z. Stretch `s = 1 - kappa * p.x` scales the X and Z components of the normal first.

**Example, wave and inflate.** A sideways offset that is `0` at the base and full at the tip keeps the base planted: `p.x + amp * h * sin(freq * p.y - speed * time)`, with `h` from 0 to 1 along the height. The normal only needs the slope: `n.y - slope * n.x`.

Inflate with `p + n * h`. A constant `h` does not change the normal. A pulse that varies along the surface does: tilt the normal away from the rising slope. Split normals at a hard corner inflate apart and leave fins. Push along one smooth normal. The same split is what breaks a shell outline. See [npr.md](npr.md).

**Example, a normal for any formula.** Step a small distance `e` along the tangent and the bitangent, deform those three rest points, and cross the results.

```wgsl
let q = deform(p, n);
let b = cross(n, tangent.xyz);
let dt = deform(p + tangent.xyz * e, n) - q;
let db = deform(p + b * e, n) - q;
let fixed = normalize(cross(dt, db));
```

`e` near `0.001` of the object size tracks the surface. Much larger jumps over the bend. Much smaller loses precision. Call `deform` with the rest position, or the offsets stack. Normalize before lighting.

## Build geometry from the two indices

`vertex_index` picks a point on one copy. `instance_index` picks which copy. Nothing is stored per copy. The CPU sends `time` and a few controls. The pose is recomputed every frame, so the shape has no memory of the previous frame.

**Example, a tapered strip.** One instance is one strip. A new instance starts a new strip, so copies do not connect. Seven rows, left and right, is 14 vertices: `row = vi / 2`, `t = row / 6` from root to tip, `across = (vi % 2) * 2 - 1`. Width `1 - t * t` stays wide through the lower half and meets at the tip. `1 - t` is a triangle.

Place the root from the instance id: `column = i % columns`, `row = i / columns`, then jitter inside the cell. Hash the id, not `time`, or the copy jumps every frame. A second integer keeps height, facing, and phase from sharing one number.

```wgsl
fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn unit_rand(i: u32, channel: u32) -> f32 {
  return f32(pcg(i + pcg(channel)) >> 8u) * (1.0 / 16777216.0);
}
```

The value is in `0 .. 1` and never quite reaches 1.

**Example, a bend that keeps the root planted.** Shift a point by `lean * height * w(t)`.

- `w = t` leans a straight stick. The root pivots.
- `w = t * t` barely moves the base and curves the tip.

A sideways shift lengthens the shape. Scale the point so its distance to the root stays `height * t`. The tip gets lower instead of longer. The derivative of `t * t` is `2t`, so the tangent is upright at the root.

```wgsl
fn bend_point(lean: vec2f, h: f32, t: f32) -> vec3f {
  let p = vec3f(lean.x * h * t * t, h * t, lean.y * h * t * t);
  return p * (h * t / max(length(p), 1e-5));
}

fn bend_tangent(lean: vec2f, t: f32) -> vec3f {
  return normalize(vec3f(lean.x * 2.0 * t, 1.0, lean.y * 2.0 * t));
}
```

One `sin(time)` moves every copy together. Give each instance its own phase, frequency, and stiffness from separate hash channels, and divide the lean by stiffness.

A field of gusts is value noise on the ground, sampled at the root and shifted along the wind by `time`. Sample once per instance, not once per vertex. A local pusher adds a direction away from a point, full at the center and zero at twice its radius: `saturate(1 - dist / (2 * radius))` squared, then added to `lean`.

`normal = cross(side, bend_tangent)`. Flip it toward the camera when the strip is visible from both sides.

## Morph through one domain

Two meshes with different vertex counts cannot be lerped. Drop the grid positions and keep `uv` in `0..1`. Every shape is a function of that same `(u, v)`. `u` travels around the axis (`theta = u * TAU`). `v` runs from top to bottom. The seam `u = 0` and `u = 1` must be the same point in every shape.

A sphere has no hole and a torus has one, so the surface has to open somewhere. Put that opening on a row that is a single point on one shape and a ring on the other. If a value depends on the vertex index instead of `uv`, the seam splits.

**Example, three functions of `(u, v)`.**

```wgsl
fn sphere_dir(uv: vec2f) -> vec3f {
  let theta = uv.x * TAU;
  let phi = uv.y * PI;
  return vec3f(sin(phi) * cos(theta), cos(phi), sin(phi) * sin(theta));
}

fn cube_at(uv: vec2f, half_: f32) -> vec3f {
  let d = sphere_dir(uv);
  let big = max(abs(d).x, max(abs(d).y, abs(d).z));
  return d / big * half_; // same direction as the sphere, pulled to a face
}

fn torus_at(uv: vec2f, ringR: f32, tubeR: f32) -> vec3f {
  let ring = vec3f(cos(uv.x * TAU), 0.0, sin(uv.x * TAU));
  let psi = PI * (1.0 - 2.0 * uv.y); // v = 0 and v = 1 meet on the inner ring
  let n = cos(psi) * ring + vec3f(0.0, sin(psi), 0.0);
  return ringR * ring + tubeR * n;
}
```

**Example, a mix that keeps the bulk.** `mix(a, b, t)` travels in a straight line. When `a` and `b` point different ways, the line cuts inward: `mix((1,0,0), (0,1,0), 0.5)` has length `0.707`. Mix direction and length separately.

```wgsl
let dir = mix(a / length(a), b / length(b), t);
let p = normalize(dir) * mix(length(a), length(b), t);
```

`mix` of two unit normals is shorter than 1, so the mid frame goes dark. `normalize` fixes the brightness and still guesses. Step `uv` on both axes through the same mix and cross the deltas. Skip the normalize when the cross is zero, which happens where a whole row is one point.

```wgsl
let e = 0.001;
let du = morph(uv + vec2f(e, 0.0), t) - morph(uv - vec2f(e, 0.0), t);
let dv = morph(uv + vec2f(0.0, e), t) - morph(uv - vec2f(0.0, e), t);
```

A linear `t` starts and stops at full speed. `smoothstep` eases it. A per-vertex delay makes the change sweep the surface:

```wgsl
fn ease(t: f32) -> f32 {
  let x = clamp(t, 0.0, 1.0);
  return x * x * (3.0 - 2.0 * x);
}

fn vertex_t(uv: vec2f, globalT: f32, span: f32) -> f32 {
  let delay = uv.y * span;
  return ease(clamp((globalT - delay) / max(1.0 - span, 1e-3), 0.0, 1.0));
}
```

`span` in `0..1` is how much of the transition the sweep occupies. Drive `globalT` from scene `time`.

## Turn an edge into a ribbon

WebGPU has no geometry shader, and `line-list` is one pixel wide. A silhouette edge is one whose two triangles disagree about facing the camera. Build the edge list once. Each frame, expand the selected edges into ribbons.

Store one `vec4u` per edge: vertex `a`, vertex `b`, left triangle, right triangle. An open border uses `0xffffffff` for the missing triangle and is always an outline. Weld vertices that share a position first, or a UV seam and a box corner look open. A closed mesh with `T` triangles has `3T / 2` edges.

Draw `edgeCount * 6` vertices and no vertex buffer. Vertex `vi` owns edge `vi / 6` and corner `vi % 6`. Load positions through the same world matrix as the body, so a deformation moves the lines. The neighbor list does not change when the mesh bends.

```wgsl
fn faces_eye(n: vec3f, center: vec3f, eye: vec3f) -> bool {
  return dot(n, eye - center) > 0.0;
}
```

`n` is `normalize(cross(p1 - p0, p2 - p0))`, with winding that matches the mesh. Use `eye - center` per triangle. One camera-forward vector slides the outline at the edge of a perspective frame. Flipping every normal flips both answers, and the test still works. On a coarse mesh the line jumps from one edge ring to the next.

Both ends of a selected edge go to pixels. The ribbon direction is the line. `vec2f(-dir.y, dir.x)` is 90 degrees to it. Shift each corner by half the width in pixels, divide by half the resolution, and multiply by `w` to get back to clip space. If the edge is not selected, put all six vertices on one point. Skip an edge when either end has `w <= 0`.

Half the ribbon sits on the surface and loses the depth test. Push each end toward the camera by about the width in meters at that distance. Extend each end by half a width along the line so corners do not gap. In the fragment shader, fade the last pixel: `clamp(halfWidth + 0.5 - abs(across), 0.0, 1.0)`.

A crease faces the camera, so both triangles pass the eye test. Draw it when `dot(nA, nB) < cos(angleLimit)`. A small limit draws every shallow bend.

A halo fin grows out from the same silhouette edge, perpendicular to the view:

```wgsl
let side = n - dot(n, view) * view;
let p = endPoint + normalize(side) * (s * finLength); // s = 0 at the edge, 1 at the tip
```

`n` is the sum of the two face normals. Where that sum agrees with the vertex normal, use the vertex normal so neighboring fins meet. Do not do that on a sharp corner. Fade with `(1 - s) * (1 - s)` and blend additively. Drop a fin that faces the camera straight on. It has no sideways direction.

## Vary copies of one mesh

One instanced draw can place many copies. When they only need to look different and stay put, do not store a buffer per copy. Hash `instance_index`. The same index and seed always return the same numbers.

A value that changes per object, such as something walking, belongs in an instance buffer. A hash cannot remember a new position.

**Example, one channel per trait.** Using `0, 1, 2, ...` directly makes a ramp across the grid. One shared hash ties the traits together: the large copies are also the bright ones and face the same way. Hash the index, add a channel, hash again. `pcg(i + channel)` collides with the next instance.

```wgsl
fn rand(i: u32, channel: u32, seed: u32) -> f32 {
  let h = pcg(pcg(i + seed * 7919u) + channel);
  return f32(h >> 8u) * (1.0 / 16777216.0);
}
```

Name the channels so two traits cannot share one. Mix `seed` in when a second patch must not repeat the first.

**Example, scale, then rotate, then slide.** Do this before the cell offset. Scale first so the copy grows from its root. Scale after the slide also scales the slide, and the copy leaves the ground.

```wgsl
let h = 1.0 + scaleRange * (rand(i, HEIGHT, seed) * 2.0 - 1.0);
let w = h * (0.85 + 0.3 * rand(i, WIDTH, seed));
let angle = rand(i, ANGLE, seed) * TAU;
let p = rotate_y(rest * vec3f(w, h, w), angle) + vec3f(jitter.x, 0.0, jitter.y);
```

Let the width follow the height, with a little extra variation. Jitter inside the cell until the rows disappear. Keep `jitter + radius` inside half the spacing when the copies are solid.

Rotate the normal with the copy. Non-uniform scale stretches the surface, so divide the normal by the scale and then normalize. A round mesh shows no yaw. Put an uneven feature on one side.

**Example, color and phase.** Three random RGB channels look unrelated. Start from one base color and move a short way in brightness and toward a second color, or pick from a short list: `pal[min(u32(rand * count), count - 1)]`. Repeat an entry in the list when it should appear more often.

`sin(time)` bows every copy together. Add a phase in `0 .. TAU` and a speed near `1`. Weight the offset by `y * y` so the root stays planted.

```wgsl
let wave = sin(time * 2.0 * speed + phase);
let offset = vec3f(strength * y * y * wave, 0.0, 0.0);
```
