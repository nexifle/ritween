# Declarative authoring foundation

Stage is an additive authoring layer over the existing `Scene` contract. Existing
WebGPU scenes, media helpers, timeline, audio, preview, and export remain unchanged.
The authoring layer provides Stack layout, Text, Box, immutable modifiers,
deterministic motion, Camera 2D, reusable Worlds, nested Compositions, timeline
Shots, overlap transitions, Circle/Line shapes, Group/ForEach, Image/Video nodes,
motion presets, geometric clipping, image/luminance masks, media crop, and a
CPU-inspectable tree/display list and chart components.

## A complete project

```ts
import { Stage, Text, Box, VStack, type Project } from "ritween";

export const project: Project = {
  name: "Hello Stage",
  resolution: [1920, 1080],
  aspectRatio: [16, 9],
  duration: 3,
  scenes: [
    {
      id: "hello",
      name: "Hello",
      source: "manifest.ts",
      start: 0,
      duration: 3,
      transition: { type: "cut" },
      create: () =>
        Stage(
          ({ theme }) =>
            VStack(
              [
                Text("Make ideas move.", { size: 96, color: theme.textColor }),
                Box({
                  width: 360,
                  height: 12,
                  radius: 6,
                  fill: theme.colors.accent,
                }),
              ],
              { gap: 32 },
            )
              .offset(0, { from: 28, to: 0, duration: 0.8 })
              .opacity({ from: 0, to: 1, duration: 0.8 })
              .frame({ width: "fill", height: "fill" }),
          { designSize: [1920, 1080] },
        ),
    },
  ],
};
```

Save as `manifest.ts`, then run `ritween preview --project . --open` or
`ritween frame --project . --time 1.5 -o frame.png`.

The checkout has a title-card/bar-chart example in `examples/authoring/manifest.ts`:

```sh
npm run build
node bin/ritween.mjs preview --project examples/authoring --open
node bin/ritween.mjs frame --project examples/authoring --time 4.2 -o artifacts/authoring-cli.png
```

## Shapes, groups, and data-driven lists

```ts
import { Circle, Line, Group, ForEach, HStack, Box, Motion } from "ritween";

const bars = HStack(
  ForEach(
    [
      { id: "sales", value: 80 },
      { id: "cost", value: 45 },
    ],
    (item) => item.id,
    (item, index) =>
      Box({ width: 24, height: item.value }).scale(
        1,
        Motion.stagger(index, 0.08, Motion.fade()),
        [0.5, 1],
      ),
  ),
  { gap: 12, align: "end" },
);
const badge = Group([
  Circle({ radius: 40, fill: "#4268EC" }),
  Circle({
    radius: 40,
    stroke: "#FFFFFF",
    strokeWidth: 6,
    trim: [0, Motion.fade()],
  }),
])
  .opacity(Motion.fade())
  .offset(0, Motion.slide());
const connector = Line({
  from: [0, 0],
  to: [200, 60],
  width: 4,
  color: "#4268EC",
  progress: Motion.fade(),
});
```

`Group(children)` occupies **one layout slot**, overlays children at its top-left,
and has no fill of its own. Its size is the largest child width/height, like a
start-aligned ZStack. Children are painted into an isolated transparent surface;
`.opacity()` fades the combined result once, including overlapping children.
A child's own opacity is preserved inside that result. Nested Groups compose
in the same way: child alpha first, inner Group alpha next, outer Group alpha last.

For example, two opaque overlapping Boxes inside `Group([...]).opacity(0.5)`
produce a half-opacity overlap, not two independently faded Boxes. `ZStack` keeps
its existing per-primitive opacity behavior if that is what you need.

Group paint bounds include offset/scaled children even outside its layout box;
Group does not implicitly clip them. Rendering reuses Composition's premultiplied
offscreen painter, cache cleanup, and shared 256 MiB surface budget. Each non-empty
Group adds an offscreen pass, even at opacity 1; Group isolation nesting is limited
to 32 levels. Cameras and shared-element transforms follow the same surface path.

`ForEach(items, key, view)` returns a frozen array of keyed nodes; pass it directly
to a Stack or spread it alongside other children. Keys must be unique non-empty
strings and should come from data, not array position. Each item keeps its key
even when the returned node ends in modifiers.

Circle uses a radius in design units. Trim is `[start, end]` in clockwise turns
from twelve o'clock, with `0 <= start <= end <= 1`; use stroke/strokeWidth for a
ring or donut. `strokeOnly: true` suppresses fill and uses the theme accent (or
text color when no accent exists) if stroke is omitted; an explicit stroke wins.
Stroke is inside the radius. A filled partial circle is a sector.
Line endpoints are local coordinates: its layout box normalizes their minimum
coordinates and includes stroke width. Line has butt caps; progress reveals the
segment without changing its layout bounds. Position either shape with modifiers.
Both use the existing GPU Path painter. Circle arcs use 96 segments per arc;
very large close-ups may reveal faceting. No separate shape pipeline is created.

`Motion.fade`, `Motion.slide`, and `Motion.scale` return frozen tween descriptors,
not running animations. Defaults are respectively 0→1, 32→0, and 0.9→1, with a
0.6-second ease-out. Override `from/to/duration/delay/ease`. Apply them with
`.opacity()`, `.offset()`, or `.scale()`. `Motion.stagger(index, interval, track)`
shifts a tween/keyframe track in scene-local seconds; `Motion.keyframes` and
`keyframes` use the same evaluator. Negative stagger indices/intervals are rejected.

## Image and Video nodes

```ts
import { Group, Image, Video, World, Shot, videoResource } from "ritween";

const footage = videoResource({
  id: "interview",
  name: "Interview",
  url: "/media/interview.mp4",
  start: 0,
  duration: 4,
  offset: 2,
  volume: 0.8,
});
const world = World(
  () =>
    Group([
      Video(footage, { width: 1920, height: 1080, fit: "cover" }),
      Image({
        url: "/media/logo.png",
        width: 160,
        height: 80,
        fit: "contain",
      }).offset(80, 80),
    ]),
  { size: [1920, 1080] },
);
const shot = Shot({
  id: "interview-shot",
  source: "manifest.ts",
  start: 0,
  duration: 4,
  world,
  mediaClips: [footage],
});
```

Use explicit positive `width/height` in design units so CPU layout never depends
on asynchronous metadata. `contain` centers the whole image inside those bounds;
`cover` crops UVs to fill them. Cameras, modifiers, nested Compositions, shared
transitions, and persistent Overlays use the same media painter. URLs follow the
engine's same-origin HTTP(S), byte, and texture budget restrictions.

Video receives the same immutable clip descriptor used by `mediaClips`; do not
repeat trim/timing values in the node. **Video uses project time**, including inside
a World whose clock is frozen/reversed/remapped. It paints during the clip interval
and reserves its layout size outside it. Opacity does not mute audio or deactivate
an otherwise present video. Use distinct clip IDs/timing for independent playback;
multiple nodes referencing one clip share its prepared texture within a Stage.

Use `StageEntry` for a view directly on the timeline, or `Shot` for a reusable
World. Both wire a **single** `mediaClips` declaration to Stage resources and the
footage audio resolver; no manual list forwarding is needed:

```ts
import { StageEntry, Video, videoResource } from "ritween";

const footage = videoResource({
  id: "intro-video",
  name: "Intro video",
  url: "/media/intro.mp4",
  start: 0,
  duration: 4,
  offset: 2,
});
const entry = StageEntry({
  id: "intro",
  source: "manifest.ts",
  start: 0,
  duration: 4,
  mediaClips: [footage],
  view: () => Video(footage, { width: 1920, height: 1080, fit: "cover" }),
});
// Use entry in project.scenes. Audio is registered and linked to "intro".
```

`StageEntry` accepts Stage options plus `id`, optional `name` (defaults to ID),
`source`, `start`, `duration`, optional `transition`, and `view`. It snapshots clip
metadata and creates an independently owned Stage on every `create()`. Clip times
remain project-relative; the helper does not shift them by the entry start.
Scene-linked audio follows existing transition envelopes. Keep view callbacks pure
and use immutable `videoResource` descriptors rather than mutating captured data.

Manual `SceneEntry` + `Stage` remains a low-level escape hatch and requires forwarding
the same clips to both entry and Stage. Prefer `StageEntry` instead. Persistent
Overlay audio still requires clips in `project.mediaClips`. Node discovery alone
never creates audio tracks.

All Stages and Overlays use async frame preparation: use
`await renderer.renderAsync(t)`, even for media-free trees. FrameSource, preview,
and export already do this; custom low-level Scenes without `prepareFrame` retain
synchronous rendering. A prepared frame's evaluated tree is reused for rendering
and shared-element inspection. Images appearing later are discovered and loaded
at the requested time, including a direct seek, without a separate declaration.
`Stage(..., { images: [url] })` (also available on Shot/Overlay) is optional preload
only. Videos must still be declared in `mediaClips` for resource/audio integration,
including ones introduced later in a conditional tree.

Each Stage owns its resources; nodes remain immutable CPU data. Eager mode loads
declared clips during setup. `--media-activation active-only` loads videos when
needed, releases videos absent from the current frame and inactive scenes, and
retains both active scenes across transitions. Images absent from the current
frame are released in either mode. Disposal, cancellation, and partial loading
failures clean up owned resources; scene reactivation reloads released videos.

Run `examples/authoring-media/manifest.ts` for shapes, keyed bars, motion presets,
and an image node together. The Video example above expects your own footage.

## Crop and clipping

Image and Video accept `crop: { x?, y?, zoom? }`. Focal coordinates are normalized
0..1 (default center); zoom is at least 1 and defaults to 1. All three values
accept tween/keyframe tracks in the local animation clock. Crop uses cover fitting,
keeps the layout viewport fixed, and clamps sampling at source edges:

```ts
Video(footage, {
  width: 600,
  height: 600,
  crop: { x: 0.7, y: 0.5, zoom: { from: 1, to: 1.4, duration: 3 } },
}).clip({ shape: "rect", radius: 32 });
```

All nodes support `.clip()` (rectangle), `.clip({ shape: "rect", radius: 24 })`,
`.clip({ shape: "circle" })`, `.clip({ shape: "path", outline, fillRule? })`, and
image masks:

```ts
video.clip({ shape: "image", url: "/media/alpha-mask.png" });
video.clip({ shape: "image", url: "/media/luma.png", mode: "luminance" });
```

`mode` defaults to `alpha` (the mask's alpha channel). `luminance` uses Rec.709
weights on the sampled RGB, then multiplies by alpha. The mask image stretches to
the clip bounds; it is not contain/cover fitted. Same-origin HTTP(S) URL, byte, and
texture limits match other images. Masks appearing later are discovered during
frame preparation; `images` remains optional preload. A JPEG/opaque PNG used with
`alpha` stays fully visible—use `luminance` for black-and-white mattes.
Circle uses the largest centered circle inside the bounds. Paths use local design
coordinates and support nonzero/evenodd fill rules, including holes.

Clip uses the node's current layout bounds without changing its size. To select
a viewport, apply `.frame({ width, height }).clip()`; frame alone does not clip.
Modifier order matters: `.scale(2).clip()` clips enlarged content, while
`.clip().scale(2)` scales the clipped result. Multiple clips can be nested.
Clipping flattens content into a transparent offscreen surface, so it costs an
additional render pass and uses the existing bounded composition surface budget.
Stage boundaries remain clipped independently. Large zooms after clipping can
soften the intermediate surface; use media crop for source pan/zoom when possible.

## Time and environment

The Stage callback receives `time` (composition seconds), `localTime` (scene
seconds), `progress` (scene progress), output `resolution`, `designSize`, and
`theme`. All tween descriptors use **scene-local seconds**. Compute every visual
value from these inputs; do not increment counters or use unseeded randomness.
The callback is also evaluated at local time zero during setup to discover fonts.
It must not create side effects or GPU resources.

`designSize` defaults to the composition resolution, not the preview resolution.
Output scaling preserves aspect ratio using contain/letterboxing; no nonuniform
stretch is applied. Drawing is clipped at the Stage boundary. Layout stays in
design units and does not change when output resolution changes.

Theme is a copied, frozen environment with `font`, `textColor`, and named `colors`.
There is no token resolver: read `theme.colors.accent` in the view factory. Colors
must be explicit browser-supported colors, not `currentColor` or CSS variables.
Bundle fonts with the project for consistent typography across machines.

## Nodes and reusable components

- `Text(content, style)` supports font family, size, weight, color, wrap, maxWidth,
  alignment, tracking, and lineHeight. Size, tracking, and lineHeight use design
  units; lineHeight is an absolute distance, not a multiplier.
- `Box({ width, height, fill, radius, stroke, strokeWidth })` draws a rounded
  rectangle. Stroke is inside its bounds. Width and height accept numbers or tweens.
- `HStack(children, { gap, align })` arranges left to right.
- `VStack(children, { gap, align })` arranges top to bottom.
- `ZStack(children, { align })` overlays children in input/paint order.
- `Spacer()` consumes an equal share of remaining space on a Stack's main axis.

Reuse is just a function returning a `ViewNode`. Array `.map()` is sufficient for
this first slice; call `.id(item.id)` on the final child node for useful paths and
stable explicit identity. Duplicate sibling IDs throw. There is no reconciler or
component lifecycle. Do not construct `ViewNode` specs manually; use the factories.

### Layout contract

Parents offer finite width/height; children report their size; parents place them.
Stacks measure non-flexible children first. Spacers and children whose main-axis
frame is `"fill"` divide remaining space equally. Fixed content does not shrink;
excess is reported in inspection warnings. This is intentionally not CSS flexbox:
there is no layout priority, weighted growth, baseline alignment, or constraint solver.

Stack `align` controls the cross axis (`start`, `center`, `end`); ZStack applies it
to both axes. Empty stacks have zero intrinsic size. Spacer's cross-axis intrinsic
size is zero. Use an explicit frame when a container should fill its offered space.
A flexible child's own padding remains part of the space it consumes.

### Ordered, immutable modifiers

Each modifier wraps its input and returns a new node:

| Modifier                                             | Semantics                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `.padding(x, y = x)`                                 | Adds horizontal/vertical space to layout size.                                                                                              |
| `.padding({ top, right, bottom, left })`             | Same, per edge. Omitted edges are zero; values must be finite and non-negative.                                                             |
| `.frame({ width, height, align })`                   | Number fixes an axis, `"fill"` uses offered space, omission keeps intrinsic size. Alignment defaults to center on both axes. Does not clip. |
| `.background({ fill, radius, stroke, strokeWidth })` | Paints the node's measured bounds behind it. Sets no size, clips nothing, adds no surface.                                                  |
| `.flex(weight = 1)`                                  | Proportional main-axis slot inside HStack or VStack. Finite positive weight. Does not reflow outside stacks.                                |
| `.offset(x, y = 0)`                                  | Translates paint without moving siblings or changing layout size.                                                                           |
| `.scale(x, y = x, anchor = [0.5, 0.5])`              | Scales paint around a normalized local anchor; does not reflow.                                                                             |
| `.opacity(value)`                                    | Fades a Group/Composition as one combined image; otherwise multiplies descendant primitive alpha.                                           |
| `.id(key)`                                           | Names the resulting node for sibling identity and inspection.                                                                               |

`Text("A").padding(20).frame({ width: 200 })` differs from
`Text("A").frame({ width: 200 }).padding(20)`. Transform order also matters.
Opacity on ordinary Stacks is **per primitive**: overlapping children are faded
separately. Group and Composition are isolation boundaries: descendants are blended
first, then the boundary's opacity is applied to their combined image.

### Frame alignment axes

`align` applies to both axes. `alignX` and `alignY` override it per axis; an axis
with neither value is centered. Precedence is axis value, then legacy `align`, then
center, so existing frames keep their geometry. Negative remaining space (content
larger than the frame) still shifts the child past the frame edge, including on the
axis-specific offsets. Stack `align` is unrelated: it stays cross-axis alignment for
HStack/VStack.

### Directional padding and content backgrounds

Directional padding normalizes to four insets and behaves exactly like numeric
padding per edge: the child proposal subtracts the insets with a floor of zero, and
the wrapper's measured size adds them back. A child larger than the remaining space
stays oversized and keeps its overflow diagnostic rather than being clipped.

`.background()` paints a box on the wrapper's own measured bounds, before the child's
paint. It changes no measurement, never clips or isolates, and adds no offscreen
pass, so it is not an isolation boundary like Group. Stroke follows the Box
convention: inside the bounds. Because modifiers are ordered, padding applied inside
the background is painted while padding outside it is not:

```ts
const card = Text("Row", { size: 20 }).padding({
  top: 8,
  bottom: 8,
  left: 12,
  right: 12,
});
card.background({ fill: "#FFFFFF", radius: 8 }); // fills the padded card
card.padding(4).background({ fill: "#FFFFFF" }); // padding 4 stays transparent
```

Modifier order also decides which ID owns the target. `.id()` on the draw leaf
(`box().id("card").background(...)`) keeps the leaf's identity. `.id()` on the
background wrapper (`box().background(...).id("card")`) is published on the
background paint as `matchId`, so the declared ID still yields exactly one shared
element — the wrapper's measured bounds — without duplicating the child's identity.
An inner leaf ID and an outer wrapper ID are two different declared IDs and each
keeps its own single target. Other modifier wrappers (`padding`, `frame`, `offset`,
`scale`, `opacity`) still expose only layout-node identity, not shared-element
targets.

The background is published in inspection commands with `paintRole: "background"` so
rules and targets can exclude decorative paint from content geometry.

Matching identity and paint correction are separate. `sharedId`/`matchId` decide
_whether_ a transition has a pose for a declared ID; `correctionIds` decides _which_
paints receive it. Every paint in a declared modifier chain publishes the same
ordered candidate list, innermost declaration first, so a background and the content
it decorates travel together and cannot split mid-transition. Only the first
candidate the transition actually supplies is applied — one pose per paint, never
two — so an inner ID that this transition did not match falls back to a matched outer
one instead of pinning the element. A clip or Group is corrected once as an isolated
surface, and its contents are suppressed only when that surface actually resolves a
pose: an unmatched wrapper ID never pins a matched descendant, and the pose is still
never applied twice. A corrected descendant must stay inside the surface's layout
bounds, so give an isolated container enough size for the travel it receives.

### Weighted flexible slots

`.flex(weight = 1)` assigns a proportional main-axis slot inside the nearest enclosing
sequential `HStack` or `VStack`. Weight must be a finite, positive number. Flex
participates at the stack boundary only and does not search into descendant stacks.

Allocation contract:

1. Fixed siblings and gaps reserve space first using standard measurement.
2. Remaining non-negative main-axis space is divided among flexible slots by weight.
3. Fixed siblings do not shrink. If fixed siblings exceed available space, flexible
   slots receive zero and emit a structured `fixed-allocation-deficit` diagnostic.
4. The assigned outer slot includes all boundary padding regardless of modifier order:
   `.padding(10).flex(1)` and `.flex(1).padding(10)` produce identical outer bounds
   without expanding the slot budget.
5. Flexible cross-axis size is content-driven unless an explicit frame controls it.
6. Content exceeding the slot remains visible unless clipped explicitly with `.clip()`,
   and emits an `offered-size-overflow` diagnostic.
7. Combinations:
   - Flex plus main-axis fill frame: valid; explicit flex weight wins.
   - Flex plus numeric main-axis frame: invalid combination; throws a path-specific error.
   - Flex plus numeric cross-axis frame: valid; cross axis uses the frame, main axis stays flexible.
   - Multiple flex wrappers on the same boundary chain: invalid; throws a path-specific error.
   - `Spacer()` or `frame({ ...: "fill" })` without explicit flex: participates with weight 1 in mixed stacks; preserves legacy behavior when no explicit flex is present.
   - Flex outside `HStack`/`VStack` (e.g. at root, in `ZStack`, or in `Group`): no allocation effect; emits an `unused-flex` diagnostic.
   - Nested stack containing flex: the inner stack owns its descendants' allocation.
8. Zero offered text width wraps graphemes without infinite loops or division by zero,
   preserving line height and empty line boxes.

## Motion

An animated number is a number, `{ from, to, duration, delay?, ease? }`, or
`keyframes([{ at, value, ease? }, ...])`.
Duration must be positive. Values clamp to `from` before delay and `to` after the
end. Easing is `"linear"`, `"ease-in"`, `"ease-out"` (default), or `"ease-in-out"`;
nonlinear curves are cubic. `motion(descriptor, localTime)` exposes the same pure
evaluator for custom calculations. Offset, scale, opacity, and Box dimensions accept
these descriptors. Stagger can be expressed as `delay: index * 0.1`; named motion
presets are deferred. Keyframe times are strictly increasing scene-local seconds.
Values clamp outside the track; repeat a value at a later time to hold. Each
keyframe's easing describes the segment **arriving at that keyframe**. The default
is ease-out; use ease-in-out for smooth start/stop camera moves.

## Camera 2D

A camera changes the view of the world **after layout**, before output scaling and
letterboxing. It does not shrink/reflow Stack contents or change overflow warnings.
World content can extend outside `designSize`; the viewport, not the world, is
clipped. Place connected beats in one Stage for a continuous reveal/refocus.
For multiple engine scenes with continuity or overlap, use World and Shot below.

```ts
import { Camera, Stage, keyframes } from "ritween";

const camera = Camera({
  x: keyframes([
    { at: 0, value: 400 },
    { at: 1, value: 400 },
    { at: 2.4, value: 1360, ease: "ease-in-out" },
    { at: 3.2, value: 1360 },
    { at: 4.6, value: 2320, ease: "ease-in-out" },
  ]),
  y: keyframes([
    { at: 0, value: 220 },
    { at: 1, value: 220 },
    { at: 2.4, value: 780, ease: "ease-in-out" },
    { at: 3.2, value: 780 },
    { at: 4.6, value: 1340, ease: "ease-in-out" },
  ]),
  zoom: keyframes([
    { at: 0, value: 1.7 },
    { at: 1, value: 1.7 },
    { at: 2.4, value: 0.55, ease: "ease-in-out" },
    { at: 3.2, value: 0.55 },
    { at: 4.6, value: 1.8, ease: "ease-in-out" },
  ]),
});
// `world` is your ViewNode or a pure function returning one.
const createScene = () =>
  Stage(() => world, {
    designSize: [1920, 1080],
    camera,
    textResolution: 2,
  });
```

A complete nine-card example is in `examples/camera/manifest.ts`:

```sh
npm run build
node bin/ritween.mjs preview --project examples/camera --open
node bin/ritween.mjs export --project examples/camera -o artifacts/camera.mp4
```

### Pose and coordinates

`Camera(options)` returns an immutable snapshot. Stage also accepts an inline
camera object. Every numeric property accepts constants, tweens, or keyframes:

| Property   | Meaning / default                                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `x`, `y`   | World point held at the viewport anchor; default design center.                                                                    |
| `zoom`     | Positive magnification; 1 is original size, 0.5 zooms out, 2 zooms in.                                                             |
| `rotation` | Camera roll in radians, clockwise in Y-down coordinates; default 0. The world rotates in the opposite direction.                   |
| `anchor`   | Normalized viewport position `[x, y]`; default `[0.5, 0.5]`. Components can animate independently; values outside 0–1 are allowed. |

The mapping is `view = anchor * designSize + zoom * R(-rotation) * (world - position)`.
Position stays pinned to the anchor at every zoom/rotation. Increasing camera X
moves the world left. Rotation interpolates literal radians, not the shortest arc,
so authored multi-turn moves work. Unwrap angles yourself when crossing ±π.

For tracking, paths, shake, or a custom interpolation, use a pure callback:

```ts
Stage(() => world, {
  camera: ({ localTime, designSize }) => ({
    x: designSize[0] / 2 + Math.sin(localTime * 0.5) * 80,
    y: designSize[1] / 2,
    zoom: 1.2,
    rotation: Math.sin(localTime * 0.3) * 0.02,
  }),
});
```

Callbacks receive the same StageContext as the view. Do not integrate deltas, read
wall-clock time, or use unseeded randomness. There is no imposed speed, world-bound
clamping, or smoothing state; motion is fully authored and seekable.

### Framing and debugging

`fitCamera(worldBounds, designSize, { padding?, rotation? })` returns a centered
camera pose that contains the rectangle, including its rotated extent. Padding is
in design viewport units. Bounds must already include any node paint transforms;
raw layout bounds are not necessarily world-space visible bounds. You can use the
returned pose as keyframe endpoints. This helper does not look up IDs or create
layout/camera feedback loops.

`evaluateCamera(options, localTime, designSize)` evaluates a pose without the
browser or GPU. `worldToView(state, point)` and `viewToWorld(state, point)` convert
points in design units, not output pixels. `stage.inspect().camera` exposes the
last rendered state, including its affine matrix and inverse. Layout bounds and
node transforms stay in world coordinates. Debug bounds use the same camera as
visible primitives.

### Text during zoom

`textResolution` is a fixed Stage raster-quality multiplier (default 1, minimum 1).
For a shot that zooms to 2×, use 2 to raster text at twice output density. This
keeps static text cached while zoom animates instead of rerasterizing every frame.
Memory grows approximately with the square of this multiplier; existing text
cache/device limits still apply. It does not add motion blur or antialiasing
supersampling for boxes, which are rendered analytically on the GPU.

## Worlds, compositions, and shots

These are distinct concepts, not aliases:

- **World** is pure reusable content with its own layout size. It owns no GPU
  state and can be viewed by multiple shots/cameras at once.
- **Composition** is a node embedding a World in a clipped viewport. It can have
  its own camera, local clock mapping, theme, and screen-space overlay. Place it
  inside Stacks, apply modifiers, and nest other compositions inside its World.
- **Shot** is a normal `SceneEntry`: it views a World for a timeline interval,
  using an independent camera and independent renderer-owned resources.
- **Stage** remains the low-level adapter from a view factory to Scene. Shot uses
  it internally; custom scenes and existing Stage code remain valid.

```ts
import { World, Shot, Composition, Camera, Text, Box, ZStack } from "ritween";

const world = World(
  ({ localTime }) =>
    ZStack([
      Box({ width: 2000, height: 1000, fill: "#FFFFFF" }),
      Text("One world, multiple shots", { size: 64 }).offset(localTime * 10, 0),
    ]),
  { size: [2000, 1000] },
);

const scenes = [
  Shot({
    id: "wide",
    source: "manifest.ts",
    start: 0,
    duration: 5,
    world,
    camera: Camera({ x: 1000, y: 500, zoom: 0.8 }),
    overlay: () => Text("SCREEN-SPACE TITLE").padding(48),
  }),
  Shot({
    id: "close",
    source: "manifest.ts",
    start: 4,
    duration: 4,
    world,
    worldOffset: 4,
    camera: Camera({ x: 1000, y: 500, zoom: 1.5 }),
    transition: { type: "crossfade", duration: 1 },
  }),
]; // Project duration is 8 seconds, not 9.

// A reusable viewport node, suitable for placing inside another World:
const inset = Composition(world, {
  size: [640, 360],
  camera: { x: 1000, y: 500, zoom: 0.3 },
}).offset(48, 48);
```

### Clocks and continuity

World callbacks receive `localTime = shotLocalTime * worldRate + worldOffset`.
`worldRate` defaults to 1; zero freezes and negative values reverse the World.
Set `worldOffset` to the shot's timeline start to keep World animation continuous
across shots (when rate is 1). This is explicit so Worlds can also be replayed,
frozen, or reused elsewhere. Camera tracks and overlays use **shot-local time**,
not World time. `time` remains absolute project time and `progress` remains shot
progress; a World does not have an inferred duration of its own.

Within a nested Composition, the corresponding properties are `offset` and `rate`.
Its camera/overlay use the parent's local clock; only its World clock is remapped.
World callbacks see World layout dimensions in `designSize`; camera/overlay
callbacks see viewport dimensions. Theme inherits unless explicitly overridden.

A camera path can continue through a cut by supplying matching end/start poses,
or by returning a camera pose derived from absolute `time`. Reusing a World does
not automatically match cameras, object identity, or animation clocks.

### Overlays and subcomposition rendering

An overlay is drawn after its World and does not inherit that composition's camera.
It remains part of the composition, so an outer composition's camera/modifiers
still affect it. Shot overlays participate in that shot's transition; for an overlay
that must remain completely unchanged across a boundary, include the same overlay
in both shots or keep the sequence in an enclosing composition.

Composition uses an isolated transparent offscreen surface: clipping, nested
cameras, and alpha are resolved before painting into the parent. Applying opacity
to a Composition therefore fades its flattened result, unlike per-primitive opacity
on a normal Stack. Surface pixels are premultiplied internally; nested alpha is
handled explicitly. This requires an additional pass per composition/overlay.
Nesting is limited to 32 composition levels; shared offscreen surfaces are bounded
at 256 MiB per Stage. Limits fail explicitly instead of allocating without bounds.
Subcomposition surfaces are rasterized at their viewport output resolution; very
large parent camera zooms can soften the whole surface, not only text.

### Timeline transitions

The **incoming scene** owns its transition. A non-cut transition overlaps the end
of its predecessor by its declared duration:

```text
A: 0 ───────── 5
B:         4 ───────── 8
Overlap:   4 ─ 5       (duration 1)
```

Both scenes render at their actual local times during overlap. There is no hidden
preroll or negative local time. `cut` retains the original sequential timing.
Validation rejects gaps, first-scene transitions, invalid durations/directions,
non-increasing starts, and triple overlaps. Audio clips linked with `sceneId` automatically follow the incoming/outgoing
transition envelope. Unlinked tracks remain independent, so music beds do not
fade at every shot. Set `audioCrossfade: false` on a transition to opt out.

Built-in transition data:

- `{ type: "cut" }`
- `{ type: "crossfade", duration }`
- `{ type: "wipe", duration, direction?: "left" | "right" | "up" | "down" }`
- `{ type: "slide", duration, direction?: ... }`
- `{ type: "zoom", duration }` — center zoom plus crossfade, not a shared-element match.

Direction describes the movement of the reveal/slide, default left. These also
work on legacy WebGPU scenes and built-in footage scenes because the compositor
receives their output textures. Both async scenes are prepared before rendering;
active-only media retains both active resources during overlap.

`evaluate(project, time)` returns the incoming scene during overlap for inspection.
`evaluateActive(project, time)` exposes both scene-local clocks and transition
progress. The renderer uses that same evaluator for sync, async, preview, and export.
Two full-output transition textures are allocated only for projects that use
non-cut transitions, with a 256 MiB budget. Custom shaders and automatic shared-element matching are described below.

Run `examples/composition/manifest.ts` for camera continuity across two Shots,
a nested badge World, screen-space overlays, and a crossfade to another World:

```sh
node bin/ritween.mjs preview --project examples/composition --open
node bin/ritween.mjs export --project examples/composition -o artifacts/composition.mp4
```

### Persistent project overlay

`Shot.overlay` is screen-space relative to its World camera, but it is still part
of that scene's texture: full-frame transitions transform/fade it with the scene.
For logos, watermarks, subtitles, or a HUD that must survive scene transitions,
use `Project.overlay` with the `Overlay` helper:

```ts
import { Overlay, Text } from "ritween";

const project = {
  // ...name, resolution, aspectRatio, duration, scenes
  overlay: () =>
    Overlay(
      ({ localTime, progress }) =>
        Text("RITWEEN", { size: 28, color: "#FFFFFF" }).padding(40),
      { designSize: [1920, 1080] },
    ),
};
```

The factory creates one independently owned layer per renderer. It is set up once,
prepared when needed, rendered **once after** the active scene or transition, and
disposed with the renderer, including failed/cancelled initialization. The overlay
uses clamped project time for both `time` and `localTime`; `progress` spans the whole
project, not the incoming shot. Tween/keyframe times therefore use project seconds.
It does not inherit scene cameras, shared-element corrections, or transition zoom.

`Overlay` reuses Stage layout/text/paint but loads existing output pixels instead
of clearing them. It accepts `designSize`, `theme`, `textResolution`, and
`debugBounds`; there is no background or camera option. Scaling/letterboxing follows
Stage, using composition resolution by default. Draw a Box if the overlay needs its
own backing panel. Custom node animations and nested Compositions are still allowed.

For low-level rendering, `Project.overlay` can return a custom `Scene`. Its render
passes **must preserve the target** (`loadOp: "load"`) and blend appropriately;
ordinary `Stage`, `imageScene`, or another clearing scene is not an overlay helper.
Async `prepareFrame` is supported via `renderAsync`; synchronous `render` rejects
an async overlay. Media audio remains declared through existing project media/audio
tracks. No separate timeline entry or overlay transition is created.

Run `examples/project-overlay/manifest.ts` to see a fixed HUD and continuous progress
bar while the two scenes undergo a zoom transition. This does not automatically
choreograph scene text: exit/entrance timing remains part of the scene design.

### Automatic shared elements

Use `transition: { type: "shared", duration: 1 }` and give matching drawable nodes
semantic IDs with `.id("hero")` in both scenes. The renderer matches IDs, measures
their output-space poses (including cameras, nested viewport transforms, and
letterboxing), and smoothly interpolates position/scale/affine pose while
crossfading their appearance. No previous frame is used. Unmatched elements use
an ordinary crossfade; duplicate shared IDs fail explicitly.

IDs belong to drawable nodes, including Group and Composition. Apply `.id()` to a
Group to match the whole flattened group as one element. A tagged Group or
Composition is flattened as one element; its descendants are not matched again.
Normal Stack IDs remain layout keys, not group isolation. Apply an ID to the
primitive before modifiers, e.g. `Box({...}).id("hero").offset(100, 20)`.

This interpolates current affine poses, not glyph outlines or arbitrary topology.
Content changes crossfade; clipped content remains clipped by its viewport.
Zero-area/singular shared poses are rejected. Opposite rotations/scales can
collapse during affine interpolation; use compatible poses or a custom transition.
Legacy scenes can implement `Scene.sharedElements(context)` and apply the
`context.sharedTransforms` output-space affine corrections in their own renderer.

### Path and glyph outline morphs

Use `Path` when geometry itself must change, rather than two appearances fading.
Outlines are absolute SVG-style command tuples: `M`, `L`, `Q`, `C`, and `Z`.

```ts
const square = [
  ["M", 0, 0],
  ["L", 100, 0],
  ["L", 100, 100],
  ["L", 0, 100],
  ["Z"],
] as const;
const diamond = [
  ["M", 50, 0],
  ["L", 100, 50],
  ["L", 50, 100],
  ["L", 0, 50],
  ["Z"],
] as const;
Path(square, {
  width: 100,
  height: 100,
  fill: "#4268EC",
  to: diamond,
  progress: { from: 0, to: 1, duration: 1 },
});
```

`progress` accepts the same deterministic number/tween/keyframe as other
animated properties. `morphPath(from, to, progress)` exposes CPU-only interpolation.
Coordinates use the declared width/height viewport; overflowing contours are clipped.

For font outlines, use `Glyph({ outline, advance }, { width, height, toGlyph,
progress, fillRule: "evenodd" })`. This morphs the actual supplied glyph contours,
including holes, without double-image crossfading. Supply outlines extracted from
fonts in advance, normalized to the same coordinate system. Browser Text remains
font-shaped text; Glyph is explicit outline artwork, not a text shaping engine.

Matching command topology preserves exact Bézier interpolation. Mismatched topology
is normalized automatically by flattening curves, matching contours by winding and
area, resampling arc length, and aligning start points. Missing contours collapse
to a point, allowing holes to appear/disappear. Set `topology: "strict"` to reject
mismatches, or call `normalizePaths(from, to, samples = 64)` explicitly. Automatic
matching is a geometric heuristic, not semantic recognition; complex silhouettes
may need hand-authored correspondence. It supports up to 32 contours and 8..256
samples per contour; input outlines remain bounded at 4096 commands.

Path/Glyph no longer use Canvas Path2D, raster textures, or texture uploads. CPU
adaptive subdivision converts Béziers to edges (0.25 outline-unit tolerance, at most
32768 points), then the WebGPU fragment shader evaluates winding/parity and edge
coverage directly at output resolution. Text still uses its existing rasterizer.
This is direct GPU edge rendering, not triangle tessellation; fragment cost grows
with edge count and covered viewport area. Extreme zoom can expose the curve
subdivision tolerance; nested compositions still have their own offscreen surfaces.
Morph geometry inside a World and optionally use shared transitions to move that
World/element between shots. The `shared` transition does not infer outline pairs.

AI selection: use **shared** for layout/pose continuity, **Path** for geometric
shape morphs, **Glyph** for pre-extracted letter contours, and **custom WGSL** for
pixel-based effects. Automatic font-file parsing and shaping remain deferred.

### Custom WGSL transitions

```ts
transition: {
  type: "custom",
  duration: 1,
  shader: `
    fn transition(uv: vec2f, progress: f32) -> vec4f {
      let a = textureSample(outgoing, samp, uv);
      let b = textureSample(incoming, samp, uv);
      return mix(a, b, smoothstep(0., 1., progress));
    }
  `,
}
```

The snippet defines `transition(uv, progress)` and may include helper functions.
The compositor provides `outgoing`, `incoming`, and `samp`; UV is top-left-origin,
progress is linear 0..1. Return a texture-space RGBA color and preserve endpoints.
Shaders compile during renderer setup, with WGSL diagnostics surfaced on failure;
identical shader source reuses one pipeline per renderer. Shader source is limited
to 64 KiB. WGSL is trusted project code, not a sandbox for untrusted user shaders.

### Automatic audio crossfades

Add `sceneId: "close"` to an AudioClip to link its bus to that SceneEntry. Clips
remain explicitly placed on the project timeline; linking never shifts notes or
changes source offsets. Scene-local footage audio is linked automatically; global
`project.mediaClips` remains independent. Use separate audio tracks for overlapping
clips (the existing no-overlap-within-one-track rule still applies).

The engine applies complementary linear amplitude fades across each overlap,
on top of the source's own gain automation, identically in preview, seeking, and
offline export. Linked audio is gated to its scene interval. Uncorrelated sources
can dip in perceived power at the midpoint; this is not an equal-power mix.
`audioCrossfade: false` disables transition fading but keeps scene gating.

## Inspection and tests

Keep a reference to the Stage returned by a scene factory. After rendering,
`stage.inspect()` returns the last successful `EvaluatedFrame`:

- `tree`: paths, kinds, layout bounds, cumulative transforms, and children.
- `commands`: paint order, source paths, styles/text runs, and opacity. Group
  commands contain an isolated child frame and its combined opacity; Composition
  commands contain their own evaluated World/overlay frames (and cameras). A
  background modifier's own paint carries `paintRole: "background"` and, when the
  wrapper declared an ID, `matchId`; every paint of a declared chain publishes
  `correctionIds`. Content paints without a declared chain omit the field; contents of
  a clip/Group keep their own list, and the renderer suppresses it only when that
  surface resolves a pose.
- `warnings`: content exceeding offered layout bounds, including local time.

Bounds are before paint transforms; transform is `[scaleX, scaleY, translateX,
translateY]`. Enable `{ debugBounds: true }` on Stage for rendered bounds outlines.
Inspection data is diagnostic output: do not mutate it.

`evaluateView(node, { time, width, height, theme?, measureText })` runs without a
browser/GPU. Supply a deterministic text measurer with `(text, font, tracking)`;
use the same font/spacing semantics as your renderer. Tests can compare full output
for direct seeks, forward playback, and backward seeks.

```sh
npx tsx --test tests/authoring.test.ts
node scripts/validate-authoring.mjs
```

The browser validator starts its own temporary Vite server and Chrome, checks
seek-identical pixels, overlap alpha, bounds inspection, letterboxing, camera
pan/zoom/rotation, card-world seek determinism, and short MP4 export. Screenshots are written under ignored `artifacts/authoring/`.

## Internal boundaries and current limits

`composition.ts` owns World/Composition/Shot authoring; `nodes.ts` owns immutable
declarations; `motion.ts` resolves animated values;
`layout.ts` measures/places and emits a display list; `stage.ts` adapts the existing
scene lifecycle; `renderer.ts` owns GPU buffers/textures, isolated Group surfaces,
and painting. GPU ownership
is per scene instance; no GPU resources are stored in the authoring tree.

Box uses a GPU rounded-rectangle shader. Text is shaped/rasterized with Canvas 2D
and cached as textures; moving/fading static text does not rerasterize it. Text
cache capacity is 128 distinct active runs or 64 MiB per Stage, with device texture
limits checked. Entries not used by the current frame are released. Fonts in the
initial tree are awaited in setup; fonts introduced only later must be preloaded
before renderer creation. Unsupported/unready fonts fail rather than silently
changing layout later.

This is not yet a glyph atlas or a high-throughput thousands-of-labels renderer.
There is one draw per primitive and bind groups are rebuilt per frame. Measure real
workloads before adding batching, incremental layout, or shared caches. Scaling
text far above its original raster resolution can soften it. Text advance bounds
are not a full typographic ink-bounds model; unusual font overhangs may clip.

### Explicit grids and charts

`Grid(cells, options)` uses zero-based row and column coordinates. Supply positive
integer `columns` and `rows`, positive fixed `cellWidth` and `cellHeight`, and
optional non-negative `columnGap` and `rowGap`. Each cell has a unique `id`, a
`view`, and optional positive `columnSpan` and `rowSpan`; spans must fit the
grid. Cells paint in input order, may overlap, and do not clip their contents.
Oversized content produces the usual layout warning.

```ts
Grid(
  [
    { id: "title", row: 0, column: 0, columnSpan: 2, view: Text("Sales") },
    {
      id: "plot",
      row: 1,
      column: 0,
      columnSpan: 2,
      view: BarChart(
        [
          { id: "north", value: 12 },
          { id: "south", value: -3 },
        ],
        { width: 400, height: 180, progress: Motion.fade() },
      ),
    },
  ],
  { columns: 2, rows: 2, cellWidth: 200, cellHeight: 180, columnGap: 8 },
);
```

`BarChart`, `LineChart`, and `DonutChart` accept `{ id, value, color? }` data;
`ScatterChart` accepts `{ id, x, y, color? }`. IDs must be unique and numbers
finite. All chart constructors snapshot their inputs and return ordinary nodes,
so existing transforms, theme defaults and layout apply. The progress parameter
is a number or motion track whose literal value, tween endpoints, or every
keyframe value must be finite and between zero and one (inclusive); invalid
tracks are rejected when constructing the chart. Tracks hold their endpoint
values outside their time range and evaluate independently of seek order. Bars use a
zero baseline, lines connect points in input order, and scatter axes include
zero. Empty datasets produce an empty fixed-size frame. A zero-only domain uses
0–1; single points are shown. Donut slices require non-negative values, and
zero values are omitted, including for zero-total data. `DonutChart` takes
`radius` and `thickness` instead of width and height; thickness cannot exceed
radius. Its stroke color uses datum color, then chart color, then the theme
accent (or text color). Slice progress reveals all slices simultaneously. Charts draw marks only: labels and axes can be
composed with the existing text and line primitives.

Line and scatter centers use an inset plotting rectangle: line marker radius is
`min(3, width/2, height/2)` and scatter radius is `min(4, width/2, height/2)`.
Line stroke width is `min(2, 2 * line radius)`. Each center ranges from its
radius to the corresponding dimension minus its radius, keeping full marks and
strokes inside the requested frame even in small or unequal dimensions. A single
line point is centered horizontally; zero-inclusive domains still determine its
vertical position. Progress scales markers about their centers and reveals line
segments without changing chart layout. Subsequent modifiers can move or scale
the chart; clipping remains explicit.

### Polyline, Polygon and Arrow

`Polyline(points, { width?, color? })` builds an open sequence of straight,
independently filled butt-capped segments; width defaults to 4. There is no
closing segment, join construction, trim, or progress option. Segment contours
can overlap; no miter or round joins are implied. Consecutive points must differ.
`Polygon(points, { fill?, fillRule? })` closes its straight outline. It accepts
concave and self-intersecting outlines: the existing Path GPU winding/parity
painter determines the result (`nonzero` by default, or `evenodd`), not a
triangle fan. Adjacent points, including the closing pair, must differ and the
vertices must not all be collinear. Retraced edges and self-intersections may
cancel under the selected fill rule; no simple-polygon validation is performed.

`Arrow(from, to, { width?, color?, headLength?, headWidth? })` uses a straight
butt-capped shaft and a filled triangular head. Width defaults to 4, head length
and width to 12; all must be positive and finite. Endpoints must be distinct,
and head length cannot exceed their distance (equal length omits the shaft).

All points must have finite coordinates. Polyline needs at least two points;
Polygon needs at least three. Inputs are snapshotted into immutable Path commands.
The resulting layout box normalizes the minimum painted coordinate to zero and
includes stroke/head extents; original coordinates do not position the node, so
use `.offset()` for placement. Omitted colors use the Path theme text color.
Modifiers and IDs work as for Path; use existing opacity/scale motion for a reveal
or construct a Path morph explicitly. These helpers do not animate geometry on
their own. Path's 4096-command limit applies (a Polyline uses five commands per
segment; a Polygon uses one per vertex plus close). GPU rendering is not verified
by CPU layout tests.


## Assertions and safe areas

`SafeArea(child, { top, right, bottom, left })` is a layout-only node. It occupies
its finite parent proposal and places the child at the inset origin. Omitted edges
are zero; insets must be finite and non-negative, and their sums cannot exceed the
proposal. Zero remaining width/height is allowed. It neither clips nor adds GPU
surfaces. Oversized content remains visible. Give the SafeArea an ID to select its
`safe-rectangle`; nested SafeAreas have independent rectangles. Parent motion moves
this local rectangle and content together, so local compliance does **not** prove
output-screen safety. There are no platform defaults or automatic descendant rules.

```ts
SafeArea(
  HStack([title.flex(), button], { gap: 12 }).id("row"),
  { left: 24, right: 24, top: 16, bottom: 16 },
).id("safe");
```

An inspection rules file has `schemaVersion: 1` and a `rules` array:

```json
{
  "schemaVersion": 1,
  "rules": [{
    "id": "row-inside-safe",
    "kind": "containment",
    "a": { "scope": "scene:main", "space": "layout", "id": "row", "bounds": "content" },
    "b": { "scope": "scene:main", "space": "layout", "id": "safe", "bounds": "safe-rectangle" },
    "space": "scene:main/layout",
    "tolerance": 0.01,
    "temporal": { "start": 1, "end": 4, "samples": [1, 2, 3] }
  }]
}
```

Targets require an exact scope and layout-space ID plus exactly one authored `id`
or exact `path`. Repeated IDs in different nested spaces are not ambiguous when
the space is explicit. Missing or ambiguous targets fail. Bounds selections are
`layout-slot`, `content`, `safe-rectangle`, or `projected-paint`. Layout comparisons
use a qualified `scope/space` (for example `scene:main/layout`); projected paint
uses `output-pixels`. Unsupported coordinate conversions return `indeterminate`,
not success. A safe rectangle is local layout geometry, not projected output ink.

Rules compare A against B:

- `containment`: all edges of A inside B.
- `minimum-inset`: `edge` (`left`, `right`, `top`, `bottom`) and `minimum`.
- `minimum-gap`: signed separation from A's end to B's start on `axis` (`x`/`y`),
  with `minimum`. No cross-axis overlap is required.
- `alignment`: `axis` and `align` (`start`, `center`, `end`).
- `non-overlap`: explicit pair only; touching edges are not positive-area overlap.

Default tolerance is 0.01 of the selected space's units, with a finite non-negative
per-rule override. This is unrelated to browser pixel-comparison tolerance.
Projected paint requires an explicit rule `assertionDomain`: use
`ideal-projected-bounds` for mathematical projected-quad bounds measurements, or
`pixel-contribution` for visual contribution questions. The latter remains
`indeterminate`: G3 does not reconstruct raster coverage, alpha or occlusion.
In particular zoom clamp-to-edge sampling can contribute outside the ideal quad.
No ideal quad is relabeled as a raster-conservative bound.

Paint targets default to subtree content, excluding backgrounds. Explicit
`paintSelection: "background"` selects exactly one background belonging to the
selected node (not arbitrary descendant backgrounds); absent or ambiguous selections
are errors. Bounds alignment measures start/center/end of the selected envelope,
including conservative envelopes; a mismatch is a bounds mismatch, not ink mismatch.
Containment/inset need an exact single container rectangle; an aggregate envelope
is not filled. Non-overlap checks the selected pair's leaves, preserving aggregate
holes. Conservative possible violations remain indeterminate except for explicitly
selected bounds alignment. Results record the domain, capability and provenance.

Layout comparisons can follow recorded `evaluateCamera` World-to-parent mappings
into a common qualified layout space, retaining binary64 provenance. Unsupported,
ambiguous or singular chains remain indeterminate. Conversion to output pixels is
not inferred from the design/output ratio. Output layout conversion requires one
recorded frame occurrence and a consistent uploaded descendant draw camera, then
uses the node transform, recorded surface chain and compositor placement. Missing,
ambiguous, singular, empty or custom mappings remain indeterminate. This conversion
projects the **unclipped layout rectangle**, not visible paint: clipping must never
manufacture an inner safe container or conceal content leaving a local safe area.
A separate stationary output-space target is required to establish screen safety.

Results include status, measured values, threshold, accuracy, unit, space, targets
and project time. Requested `fail` or `indeterminate` results exit 1. Only inactive
temporal scopes produce `not-applicable`; they are counted separately from passes.
Intervals are `[start, end)` unless `includeEnd: true`. Samples must be finite,
unique, sorted and inside the interval. `ritween inspect --time` still checks only
one time, not the whole authored schedule.

Checkout validation can execute the authored schedule in one browser/FrameSource:

```sh
node scripts/validate-rule-schedule.mjs --project ./manifest.ts --rules ./rules.json
```

Its report aggregates results by rule/time and fails for any failure, indeterminate
result, missing authored sample, empty authored schedule, or rule with no applicable
executed samples. Each temporal rule runs only at its own authored samples; another
rule's schedule does not add incidental checks during intentional motion. See
`scripts/inspect-fixture/manifest-safe-area.mjs` and `safe-area-rules.json` for a
reusable fixture with a deliberately narrow entrance gap and settled-state scope.
A passing layout can still have poor hierarchy, contrast, density or typography.
Compliance is not aesthetic review, and finite samples do not prove all times.
Browser evidence must be recorded separately; it never rewrites an indeterminate
CPU result to pass.
