# Content-driven layout and evidence workflow

Use this workflow for variable content, not a collection of independently positioned boxes.
The complete contracts are in the packaged `docs/authoring.md` and `CLI.md`.

1. Confirm the installed public exports and declarations before naming APIs. Typecheck
   imports from `ritween`; do not deep-import source, use internal browser globals,
   invent aliases, or write a replacement renderer.
2. List states, short/long/empty content variants, branch boundaries, entrance/exit,
   scroll phases, and explicit rule sample times. Include just-before/at/after changes.
3. Establish spacing (for example 8/16/24/48) and typography. Build a content-driven
   skeleton: content + padding + background, not a Box height guessed from text.
4. Assign stable semantic IDs, scoped by scene and nested layout space. Inspect actual
   real-font geometry, qualified paths, spaces, clocks and paint roles before rules.
5. Run rules and inspect diagnostics. A single invocation checks one time only:

   ```sh
   ritween inspect --project manifest.ts --time 2 --rules rules.json -o inspection.json
   ```

   Execute every authored sample and aggregate per-rule coverage. Outside an interval
   is not-applicable, not pass. Empty/unexecuted applicable coverage fails. Missing or
   ambiguous IDs fail; unsupported geometry is indeterminate. Fix rather than hide it.
6. Render frames/contact sheets for **all** states, then review hierarchy, readability,
   density, contrast and optical alignment. Rules cannot judge those properties.

   ```sh
   ritween frame --project manifest.ts --time 2 -o expanded.png
   ritween preview --project manifest.ts --open
   ```

7. In one public renderer/FrameSource instance test forward/backward A → B → A.
   Calibrate unchanged captures first; require repeated A geometry/pixels to match and
   distinct B to demonstrate real motion. Independent CLI processes are not this proof.
8. Export only after failures are fixed or the operator explicitly accepts a **named**
   exception with rule/time/evidence. Browser evidence never rewrites CPU indeterminate.

   ```sh
   ritween export --project manifest.ts -o review.mp4
   ```

9. Report engine correctness, measured layout compliance and subjective design quality
   separately. Identify unsupported checks, human-review status and exceptions. Finite
   samples are not exhaustive proof of procedural states or general agent reliability.

## Contracts that prevent common mistakes

- Frame `alignX`/`alignY` use start/center/end on each axis, overriding `align`, then
  defaulting to center. HStack/VStack `align` is **cross-axis**, not main-axis alignment.
  Frame sizes/places; clip restricts paint. Oversized children do not implicitly shrink.
- Modifiers wrap in order. `text.padding(24).background(...)` paints the padding;
  `text.background(...).padding(24)` leaves outer padding transparent. Directional
  padding defaults omitted edges to zero. Background takes no width/height and adds
  no surface or clipping. Do not change renderer behavior to repair modifier order.
- Fixed siblings and gaps reserve space first; `.flex(3)` and `.flex(1)` divide remaining
  nonnegative main-axis space 3:1. Boundary padding stays within the outer slot.
  Fixed content never shrinks; a deficit yields zero flex slots and diagnostics.
  Zero-width text retains line-height/wrapping behavior and may overflow visibly.
  Explicit clip is required. Numeric main-axis frame + flex, duplicate flex and invalid
  weights reject; flex outside sequential stacks has no allocation effect and warns.
- SafeArea occupies the proposal and offers an inset local rectangle, without clipping,
  platform defaults or automatic policing. Parent motion moves it too. Screen safety
  needs a separate stationary target in output space. Decoration may remain outside.
- `layout-slot` is allocation, `content` excludes decorative background, and
  `projected-paint` is projected ideal paint geometry. Do not confuse line boxes with
  glyph ink or optical alignment. Select background explicitly when needed.
- Read exact-rectangle/conservative/unavailable accuracy **per operation**. Containment
  requires a proven inner container; disjoint outer envelopes can prove non-overlap
  and minimum gap, but intersecting conservative envelopes do not prove collision.
  Bounds alignment is not ink alignment. Aggregate envelopes need not be filled.
  `ideal-projected-bounds` is not `pixel-contribution`; shaders, alpha, irregular masks,
  occlusion and raster filtering cannot be universally reconstructed by CPU rules.
- IDs are not globally unique. Use exact scope + layout space + ID or qualified path.
  Nested Composition/World clocks differ from project time; rule intervals use project
  time. Layout units and output pixels require recorded supported mappings, not guessed
  design/output ratios. Missing, ambiguous or singular mappings are indeterminate.
- Built-in cut/crossfade/slide/zoom/wipe and shared paint expose compositor metadata;
  both active scenes and persistent overlay retain distinct scopes. Custom transitions
  expose pre-transition geometry but may lack final shader geometry. Raw Scene node
  inspection may be unavailable; never report an empty successful authoring tree.
- Preload all conditional families/weights through Stage/StageEntry/Shot/Overlay `fonts`.
  StageFont descriptors are snapshotted; StageEntry creates fresh independently owned
  scenes/resources, not a shared mutable Stage. Normal style only; numeric weights.
  Concurrent owners of a family must declare the identical complete weight/source
  configuration. External CSS/FontFaceSet competition is outside ownership guarantees.
  Verify intended loaded faces, not `document.fonts.check()` alone. Supply licensed fonts.
- Stationary scroll: `rows.offset(0, y).frame({width, height, alignX:"start",
  alignY:"start"}).clip()`. Offsetting after frame/clip moves the viewport itself.
- Rules intervals default to [start,end); includeEnd explicitly includes the endpoint.
  Samples must be finite, sorted, unique and within the interval. CLI times must be
  within duration. Rules input: 1 MiB/10,000 rules; inspection output: 64 MiB, no
  truncation. Malformed input exits 2; runtime/selected diagnostics/requested fail or
  indeterminate exits 1; success 0. Atomic file output preserves old files on failure;
  overwrite requires permission and `--force`. Logs go to stderr.

