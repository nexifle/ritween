# Composition API

Use public imports from `ritween`. Confirm that the installed package exports these
APIs; a matching version label alone does not prove that an older published build
contains the current authoring layer. Do not deep-import framework source or
silently upgrade dependencies to make an example work.

## Choose the smallest abstraction

| Need | API |
| --- | --- |
| One view directly on the project timeline | `StageEntry({ ..., view })` |
| Reusable pure content with its own design dimensions | `World(view, { size })` |
| A timeline interval viewing a World | `Shot({ ..., world })` |
| A World embedded as a node in another view | `Composition(world, options)` |
| A watermark/HUD unaffected by scene transitions | `project.overlay: () => Overlay(view, options)` |
| Adapt a view to the low-level Scene lifecycle | `Stage(view, options)` |

Do not wrap every component in a World or Composition. Reusable cards, titles,
and chart marks can simply be functions returning nodes. Composition is for an
isolated viewport, clock, camera, or environment; it adds an offscreen render pass.
World owns no GPU state. Each Shot creates independently owned scene resources.
`Composition` is a node, not the project manifest or a timeline entry.

## Creative freedom and manual authoring

The composition API organizes content; it does not limit what content may be.
Do not reduce a brief to the built-in chart types or a sequence of stock layouts.

- Create custom components as ordinary functions returning nodes. Combine shapes,
  Text, Image, Video, and nested layouts into subject-specific visuals.
- Generate custom geometry with Path, Polyline, Polygon, or Arrow, and compute
  positions or other values directly from time and data. Tween presets are optional;
  deterministic procedural motion is valid. Absolute coordinates are valid for
  deliberate artwork; prefer layout for relationships that should adapt to content.
- For specialized shaders, 3D, or rendering that is better expressed directly,
  write a public `Scene` with setup/prepareFrame/render/dispose. Read
  [GPU scene workflow](gpu-scene-workflow.md) for the low-level contract.
- Mix Shot/StageEntry entries and custom SceneEntry factories in `project.scenes`.
  Timeline transitions work on scene output textures, including custom scenes.
  A raw Scene is not a ViewNode: do not put one inside a Stack or Composition or
  assume its render pass automatically composes with node children.

Choose the simplest implementation that fulfills the visual intent, not whichever
uses the most built-ins. Keep manual animation seekable and release owned GPU
resources. Reuse existing layout/text/media facilities where appropriate without
requiring every visual idea to fit a high-level preset.

## Organize real projects by responsibility

The single-file example below is only a minimal API demonstration, not the target
structure for a full video. For substantial work, keep `manifest.ts` focused on
project metadata, timeline assembly, and project-level wiring:

```text
manifest.ts
src/
  scenes/
    order-world.ts
    closing.ts
  components/
    process-step.ts
  data/
    orders.ts
  audio/
    soundtrack.ts
```

A scene module can export `World(...)` or a function creating a `StageEntry`/`Shot`.
The manifest imports those definitions and assembles their starts, durations, and
transitions. Pass timing/media dependencies into factories where needed; scene
modules must not import the manifest. Keep clip descriptors in one owning module
and reuse them rather than copying their timing. Set `source` to the real module
path (for example `src/scenes/order-world.ts`), relative to the manifest directory.

Extract repeated components and substantial datasets, but keep one-off helpers
local to their scene. Do not hide the whole video in a single imported mega-module,
or create a file per Box/Text. The goal is that a requested scene change has an
obvious owning file and does not require navigating thousands of manifest lines.

## Complete two-shot project

Save this as `manifest.ts`. This example demonstrates reuse and timing, not a
mandatory visual style. Use the user's brief for actual content and choreography.

```ts
import {
  World, Shot, Composition, Camera, Overlay,
  Box, Text, VStack, type Project,
} from "ritween";

const world = World(
  ({ theme }) =>
    VStack([
      Text("One world, two views", { size: 80, color: theme.textColor }),
      Box({ width: 480, height: 16, fill: theme.colors.accent }),
    ], { gap: 32 }).frame({ width: "fill", height: "fill" }),
  { size: [1920, 1080] },
);

export const project: Project = {
  name: "Two views",
  resolution: [1920, 1080],
  aspectRatio: [16, 9],
  duration: 8,
  scenes: [
    Shot({
      id: "wide", source: "manifest.ts", start: 0, duration: 5,
      world,
      camera: Camera({ x: 960, y: 540, zoom: 1 }),
    }),
    Shot({
      id: "close", source: "manifest.ts", start: 4, duration: 4,
      world, worldOffset: 4,
      camera: Camera({
        x: 960, y: 540,
        zoom: { from: 1, to: 1.2, duration: 4 },
      }),
      transition: { type: "crossfade", duration: 1 },
    }),
  ],
  overlay: () => Overlay(
    () => Text("STUDIO", { size: 24 }).padding(40),
    { designSize: [1920, 1080] },
  ),
};

// Optional inset: place this node in another view, not project.scenes.
const inset = Composition(world, {
  size: [480, 270],
  camera: { x: 960, y: 540, zoom: 0.25 },
}).clip({ shape: "rect", radius: 16 });
```

Run `ritween preview --project ./manifest.ts --open`, inspect playback and seeking,
then render frames/export with the normal CLI workflow. Do not create a custom
renderer script just to use this API.

## Clocks: keep these separate

- `time`: absolute project seconds; not remapped by World playback.
- Shot-local time: project time minus Shot start. Shot camera and `overlay` use it.
- World-local time: `shotLocalTime * worldRate + worldOffset`; defaults are 1 and 0.
  World view callbacks and their node motion use this remapped clock.
- Nested Composition uses `rate` and `offset`, relative to its parent's local clock.
  Its camera and overlay use the parent clock, not the remapped World clock.
- `progress` remains the enclosing scene's progress; World has no inferred duration.
- Persistent project Overlay uses project time for both `time` and `localTime`,
  and whole-project progress. Its tracks therefore use project seconds.
- Video always uses project time, even inside frozen, reversed, or remapped Worlds.

To continue World motion across Shots at rate 1, set each Shot's `worldOffset` to
its project start. Omit it to replay from World time zero; `worldRate: 0` freezes,
and a negative rate reverses from the selected offset. Reusing a World does not
automatically synchronize clocks or camera poses.

World `designSize` is its layout size. Camera/overlay callbacks receive viewport
dimensions. Composition accepts `size`, `camera`, `theme`, `offset`, `rate`, and
`overlay`; Shot uses `designSize`, `camera`, `worldOffset`, `worldRate`, and `overlay`
alongside timeline metadata and Stage options. Theme inherits unless overridden.

## Transitions and duration arithmetic

The incoming entry owns the transition:

- `cut`: `next.start = previous.start + previous.duration`.
- Non-cut: subtract the incoming transition duration from that end time.
- Project duration is the final entry's end, not the sum of overlapping durations.

Built-ins include `crossfade`, `wipe`, `slide`, and `zoom`, each with `duration`.
Wipe/slide accept `direction: "left" | "right" | "up" | "down"` (default left).
Use `cut` for the first entry. Transition duration must be positive and shorter
than both adjacent scenes. Starts must increase; gaps and triple overlaps are
invalid. Both scenes advance at their actual local times during overlap.

Scene-linked audio follows transition envelopes; unlinked music tracks do not.
Use `audioCrossfade: false` on the transition to disable its audio fading.
`evaluate(project, t)` selects the incoming entry during overlap;
`evaluateActive(project, t)` exposes both active clocks and transition progress.

For shared-element transitions, put the same stable `.id()` on drawable nodes in
both scenes and use `{ type: "shared", duration }`. IDs do not infer path morphs
or make an arbitrary layout wrapper drawable. Read the installed
`docs/authoring.md` before using shared matching, `morphPath`, or custom WGSL
transitions; use ordinary transitions unless the brief calls for those features.

## Overlay scope and resource ownership

`Shot.overlay` is unaffected by that Shot's World camera, but still participates
in the Shot transition. A Composition overlay is also affected by outer cameras
and modifiers. Use `Project.overlay` with `Overlay` for content that must stay fixed
across scene transitions. Do not use an ordinary clearing Stage as a persistent
overlay; it would erase the rendered scene.

Use one immutable `videoResource` descriptor for a clip. Pass it to `Video` and
declare it once in `Shot.mediaClips` or `StageEntry.mediaClips`; the helper connects
resource ownership and footage audio. Clip timing stays project-relative; helpers
do not shift it by Shot start. Persistent Overlay footage audio requires the clip
in `project.mediaClips`. Discovering a Video node alone does not register audio.
Images appearing conditionally are discovered during preparation; `images` is an
optional preload list, not a requirement for each Image node.

Keep callbacks pure. Do not create decoders or GPU textures in World callbacks,
share Scene instances across Shots, or mutate captured clip data. All Stages and
Overlays require async frame preparation; CLI/preview/export already handle it.

## Inspect before adding complexity

Use `debugBounds: true` on Stage/Shot for layout debugging. A Stage's `inspect()`
returns its last rendered evaluated tree/display list without GPU readback.
Inspect overflow warnings and modifier order before compensating with coordinates.
`frame()` does not clip; use `.frame(...).clip()` for an explicit viewport.

Composition, Group isolation, and clipping consume offscreen passes. Composition
nesting is limited to 32 levels, with a shared 256 MiB surface budget per Stage;
large camera zooms may soften rasterized subcompositions. Do not introduce nested
Compositions for ordinary spacing or assume arbitrarily deep trees are free.
