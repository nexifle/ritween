# Geometry, deformation, and smooth movement

Read for mesh animation, instancing, curved paths, or explicit stroke geometry. These are techniques you implement in a custom pipeline, not additional Ritween APIs. See [GPU scene workflow](gpu-scene-workflow.md) for resource ownership and [stylized surfaces](stylized-surface-rendering.md) for lighting and outlines.

## Separate choreography from rendering cost

GPU rendering does not automatically make motion smooth: rendering performance and the motion's trajectory over time are separate concerns. For transitions intended to be smooth, check continuity of position, velocity, and, where appropriate, acceleration with respect to actual timeline time. Independent movement segments that each decelerate to zero speed produce repeated stops, even if their joins are mathematically continuous; zero speed at a join does not by itself imply a pause of nonzero duration. For uninterrupted travel, join segments with matching, nonzero velocity vectors at the boundary, accounting for each segment's duration rather than only matching derivatives with respect to a normalized curve parameter. Overlapping related actions can help the overall choreography flow, but does not by itself guarantee continuity of an individual object's motion. Preserve deliberate stops and pauses when they communicate something.

For a segment that should start and stop gently, this quintic easing has zero first and second derivatives at its endpoints:

```ts
const ease = (value: number) => {
  const t = Math.max(0, Math.min(1, value));
  return t ** 3 * (t * (6 * t - 15) + 10);
};
```

It is not a universal fix: applying it independently to every beat still creates stops. Constant-speed motion can be correct for a conveyor or scan. A cubic Bezier parameter is not distance; for controlled travel, precompute cumulative lengths from sufficiently dense samples and invert the table to map eased distance to curve parameter. Check the approximation at output scale. If the curve itself deforms, its lengths change; a table for the rest curve does not guarantee constant speed on the deformed curve.

At 30 fps, inspect displacement between adjacent frames and preview at delivery speed. A 60 fps export may help a suitable brief, but do not silently change a requested frame rate. Antialiasing addresses edge quality, not velocity discontinuities. Do not diagnose a CPU bottleneck without measurement; a few analytically positioned objects do not require a compute shader.

## Choose CPU and GPU responsibilities deliberately

For small object counts, CPU-evaluated positions uploaded to a vertex or instance buffer can be clear and adequate. For repeated meshes or many vertices, upload rest geometry once and evaluate deformation in the vertex shader from timeline uniforms. Both are WebGPU rendering. Do not claim shader-side animation when the CPU computes all positions.

Use `vertex_index` for geometry within one instance and `instance_index` for repeated copies. A six-vertex quad can be generated without a corner buffer. Upload attributes that genuinely vary per object, or derive fixed traits from a seeded integer hash. Keep separate hash channels for height, orientation, color, and phase so traits are not accidentally correlated. Hash identity, not time: changing the seed every frame produces flicker.

Apply scale, then rotation, then translation when a rooted object should remain rooted. Nonuniform scale requires inverse-transpose normal transformation; for a local diagonal scale, divide the normal by that scale, rotate it, then normalize. Keep all vectors used for lighting in a consistent space.

## Deform positions and normals together

A coarse box cannot bend smoothly; it needs subdivisions along the bending direction. A simple twist around Y is:

```wgsl
fn rotate_y(p: vec3f, angle: f32) -> vec3f {
  let c = cos(angle);
  let s = sin(angle);
  return vec3f(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}
fn twist(p: vec3f, strength: f32, base_y: f32) -> vec3f {
  return rotate_y(p, strength * (p.y - base_y));
}
```

The old normal is no longer generally correct, and rotating it alone misses the height-dependent shear. Use a deformation Jacobian or finite differences of the deformed surface. For tangent/bitangent offsets, deform all samples from the rest pose, cross the differences in the correct winding, and guard against a zero-length cross product. Include tangent handedness when constructing the bitangent. Choose the sample step relative to object scale rather than copying a fixed world-unit epsilon.

For a planted wave, multiply the offset by a height weight that is zero at the root. Different instances can share a motion field while varying phase and stiffness. A formula such as `sin(localTime * frequency + phase)` is seekable; incrementally accumulating positions is not. Secondary motion should respond to a visible cause, not add unrelated ambient wobble.

## Morph through a common parameterization

Do not lerp arbitrary buffers with different vertex counts. Define both surfaces on the same `(u, v)` domain, including seam correspondence, then evaluate both at each vertex. Changes in topology require explicit collapses or openings and may create degenerate triangles; plan and inspect them.

A linear position blend can lose apparent volume. Direction/radius interpolation sometimes helps, but requires guards for zero radius and opposite directions. It is not a general volume-preserving morph. Recompute normals from the actual blended surface rather than only blending endpoint normals. Keep essential text out of deformation unless the brief calls for it.

## Draw strokes as geometry

WebGPU hardware `line-list` primitives do not provide configurable wide strokes. Expand a segment into two triangles in pixel space, using a perpendicular to its direction. Guard zero-length segments. Convert the offset back to clip space; under perspective, multiply an NDC offset by clip `w` to retain pixel width.

Adjacent segments need a join policy: bevel, round, or miter with a limit. Add caps explicitly. Overlapping translucent segment quads can produce dark joints; tessellate a continuous stroke or handle coverage without double blending. For analytic antialiasing, pad the quad and compute coverage from signed distance in the fragment shader. Match straight versus premultiplied alpha to the blend state. MSAA is another option, not a substitute for valid joins or correctly filtered shader details.

For mesh silhouettes, preprocess an edge adjacency list and compare neighboring face orientation using deformed positions. Creases need an angle test, not just silhouette detection. Perspective requires the direction from each face to the eye. Handle open borders and near-plane crossings deliberately; skipping an edge with an endpoint behind the camera can visibly pop, so robust implementations clip it first.

## Verify the mechanism, not only endpoints

Inspect travel, turning points, assembly, and handoff. Check frame-to-frame displacement and one-sided velocity around transitions. Test return-to-time determinism on the same renderer. Confirm widths and text at multiple output resolutions. A test of numeric continuity supports the motion implementation; only playback establishes whether the chosen rhythm feels appropriate.
