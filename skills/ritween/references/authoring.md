# Authoring reference

Prefer the declarative authoring API when the installed package exports it. Check
package types, not only its version label. Read [composition](composition.md) for
World, Composition, Shot, transitions, clock mapping, and persistent overlays.

## Project contract

Import public types from `ritween`. Export a named `project` or a default project from `manifest.ts`; a named export takes precedence. All times are seconds.

```ts
// manifest.ts
import type { Project } from "ritween";
import main from "./scenes/main";

export const project: Project = {
  name: "Color study",
  resolution: [1280, 720],
  aspectRatio: [16, 9],
  duration: 3,
  scenes: [
    {
      id: "main",
      name: "Main",
      source: "scenes/main.ts",
      start: 0,
      duration: 3,
      create: main,
      transition: { type: "cut" },
    },
  ],
};
```

`source` is inspector metadata relative to the manifest directory, not an import instruction. Import the scene module separately. Keep source paths inside that directory.

## Declarative scenes

Prefer public authoring nodes for ordinary 2D scenes rather than writing shaders:
`Stage`, `Text`, `Box`, `HStack/VStack/ZStack`, `Spacer`, `Circle`, `Line`, `Group`,
`ForEach`, `Image`, and `Video`. Components are ordinary functions returning nodes.
Modifiers are immutable; layout, paint, and motion remain deterministic when seeking.

```ts
import { StageEntry, HStack, ForEach, Box, Motion } from "ritween";

const entry = StageEntry({
  id: "bars", source: "manifest.ts", start: 0, duration: 3,
  view: () => HStack(
  ForEach(
    [{ id: "first", value: 80 }, { id: "second", value: 120 }],
    (item) => item.id,
    (item, index) => Box({ width: 40, height: item.value })
      .scale(1, Motion.stagger(index, 0.08, Motion.fade()), [0.5, 1]),
  ),
  { gap: 16, align: "end" },
  ),
});
// Put entry in project.scenes; project.duration is 3 for this single entry.
```

`ForEach` returns an array for its parent Stack. `Group` overlays children in one
layout slot and fades its combined children with `.opacity()`, preserving each
child's own alpha. Overlap is composited before Group opacity; ordinary Stacks
retain per-primitive opacity. Groups use an extra bounded offscreen pass.
Circle trim uses fractions of a clockwise
turn from twelve o'clock. Line supports `from/to`, `width`, and animated `progress`.
Motion presets produce tween data for `.opacity()`, `.offset()`, and `.scale()`;
`Motion.keyframes` shares the same scene-local clock.

Image needs `url/width/height/fit`. Image/Video also accept `crop: { x, y, zoom }`
with normalized focal coordinates and zoom >= 1; tracks animate in local time.
All nodes support `.clip()` (rect), `.clip({ shape: "rect", radius: 24 })`,
`.clip({ shape: "circle" })`, `.clip({ shape: "path", outline, fillRule })`, or
`.clip({ shape: "image", url, mode?: "alpha" | "luminance" })`. Image masks stretch
to the clip bounds; `alpha` is the default, `luminance` is Rec.709 RGB × alpha.
Apply frame before clip for a fixed viewport; frame alone does not clip. Clip
uses an additional offscreen pass. Video takes an immutable `videoResource` clip
and `{ width, height, fit }`, using **project-clock** timing even in remapped Worlds.
Prefer `StageEntry({ id, source, start, duration, mediaClips, view })` for a direct
view, or `Shot({ ..., world, mediaClips })` for a reusable World. Declare clips once;
both helpers forward them to Stage resource ownership and scene-linked footage
audio. Manual SceneEntry + Stage is a low-level escape hatch requiring explicit
forwarding to both places. Overlay audio also needs `project.mediaClips`. Images introduced conditionally are discovered automatically at the requested time;
Stage/Shot `images` is optional preload only. All Stages and Overlays require
`renderAsync()`; CLI/preview/export already handle preparation. For the complete API see `docs/authoring.md` in the
checkout/package and `examples/authoring-media` in the checkout. These APIs are not
present in older installed packages; confirm the installed version before using.

## Minimal runnable low-level scene

This example intentionally uses a changing clear color to verify the pipeline. Replace it with actual WebGPU drawing for a substantive visual brief.

```ts
// scenes/main.ts
import type { Scene } from "ritween";

export default function main(): Scene {
  return {
    setup() {},
    render({ encoder, target, progress }) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: target.createView(),
            clearValue: { r: 0.05 + 0.3 * progress, g: 0.08, b: 0.25, a: 1 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      pass.end();
    },
    dispose() {},
  };
}
```

For real geometry, create shader modules, pipelines, buffers, and textures in `setup({ device, format, resolution })`. Record draws into the provided encoder in `render`. Update uniforms from context time. Destroy scene-owned buffers/textures in `dispose`; do not destroy the shared device or target and do not submit the encoder yourself. All scenes are set up at renderer creation, not lazily when first active.

For custom pipelines, uniforms, text assets, and multipass rendering, read [GPU scene workflow](gpu-scene-workflow.md). For paths, strokes, instancing, and deformation, read [geometry and motion](gpu-geometry-motion.md). These are implementation techniques, not extra framework APIs.

## Timeline invariants

- Project resolution contains positive integers and matches `aspectRatio`.
- Scene IDs are unique; durations are positive.
- Scenes start at zero and cover the project duration without gaps. Cuts are consecutive; non-cut transitions explicitly overlap the previous scene by the incoming transition duration. Triple overlaps are invalid.
- The incoming scene owns its transition. Built-ins include cut, crossfade, wipe, slide, and zoom; see [composition](composition.md#transitions-and-duration-arithmetic).
- `time` is composition time, `localTime` is time since the active scene started, and `progress` is local time divided by scene duration.
- Intervals are `[start, end)`: exactly at a cut, the following scene is active. Exactly at project end, the final scene has progress 1.
- `evaluate(project, time)` clamps finite time to the composition range. `validateProject(project)` validates the structure.

When changing a duration, recompute subsequent starts and total project duration together. Recheck audio clip boundaries too.

## Audio authoring

Define audio in project-level `audioTracks`, independently of visual scenes. Each track contains clips whose `create` factory returns an `AudioClipSource`; keep clip timing within the project duration.

Read the references according to the soundtrack needs:

- Start with the [audio reference](audio.md) for a procedural tone example, clip scheduling, track and clip constraints, audio file guidance, and preview versus export behavior.
- After the audio contract, read [sound synthesis](sound-synthesis.md) for procedural tones, envelopes, percussion, and sample pitch.
- After audio and synthesis, read [sound arrangement](sound-arrangement.md) for authored scores, track and bus routing, crossfades, effects, and picture synchronization.

Synthesis and arrangement are authored project techniques, not built-in instruments or sequencers.

## Deterministic motion and seeking

Compute positions directly, for example `x = from + (to - from) * easedProgress`. Use `Motion` tween/keyframe descriptors with declarative nodes; for custom GPU scenes use explicit clamp/easing functions. Do not increment position on each render.

For moving animation, test a time inside the scene, then an earlier time, then the first time again within the same browser session and renderer instance. The first and third frames must match; choose times where the geometry or animation visibly differs so the middle frame also confirms that the scene is not static. Compare canvas pixels or hashes when automating this check. Separate CLI frame renders and GPU mocks do not prove in-session seeking; report them as narrower checks if browser verification is unavailable. Also inspect the beginning, each cut, and the final frame. A frame counter or accumulated delta can look correct during playback but fail during seeking and export.

## Consumer tooling

The Ritween CLI supplies the browser bundler; a direct Node import is not a browser renderer. For standalone typechecking, import from `ritween` and use the installed package's public type entry with the consumer project's TypeScript tooling and WebGPU declarations (for example `@webgpu/types` when needed). Do not deep-import framework modules or redirect type resolution to framework source.

Do not enable `allowJs` or weaken strict checking merely to suppress missing declarations inside Ritween. Check the installed package version and its type entry, record the actual diagnostic, and report a package typing issue if declarations are missing. Keep consumer typechecking separate from whether preview or export succeeds.

The CLI accepts a direct manifest path or discovers common names such as `manifest.ts` in a project directory. Prefer explicit `--project ./manifest.ts` when discovery is uncertain. Do not assume the CLI loads the consumer's `vite.config`; it creates its own Vite server.
