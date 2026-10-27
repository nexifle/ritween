# Authoring reference — Ritween 0.1.0

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
  scenes: [{
    id: "main",
    name: "Main",
    source: "scenes/main.ts",
    start: 0,
    duration: 3,
    create: main,
    transition: { type: "cut" },
  }],
};
```

`source` is inspector metadata relative to the manifest directory, not an import instruction. Import the scene module separately. Keep source paths inside that directory.

## Minimal runnable scene

This example intentionally uses a changing clear color to verify the pipeline. Replace it with actual WebGPU drawing for a substantive visual brief.

```ts
// scenes/main.ts
import type { Scene } from "ritween";

export default function main(): Scene {
  return {
    setup() {},
    render({ encoder, target, progress }) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: target.createView(),
          clearValue: { r: 0.05 + 0.3 * progress, g: 0.08, b: 0.25, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      pass.end();
    },
    dispose() {},
  };
}
```

For real geometry, create shader modules, pipelines, buffers, and textures in `setup({ device, format, resolution })`. Record draws into the provided encoder in `render`. Update uniforms from context time. Destroy scene-owned buffers/textures in `dispose`; do not destroy the shared device or target and do not submit the encoder yourself. All scenes are set up at renderer creation, not lazily when first active.

## Timeline invariants

- Project resolution contains positive integers and matches `aspectRatio`.
- Scene IDs are unique; durations are positive.
- Scenes start at zero and fill the project duration consecutively without gaps or overlaps.
- Only `{ type: "cut" }` is supported.
- `time` is composition time, `localTime` is time since the active scene started, and `progress` is local time divided by scene duration.
- Intervals are `[start, end)`: exactly at a cut, the following scene is active. Exactly at project end, the final scene has progress 1.
- `evaluate(project, time)` clamps finite time to the composition range. `validateProject(project)` validates the structure.

When changing a duration, recompute subsequent starts and total project duration together. Recheck audio clip boundaries too.

## Deterministic motion and seeking

Compute positions directly, for example `x = from + (to - from) * easedProgress`. Use explicit clamp/easing functions rather than assuming the framework exports animation helpers. Do not increment position on each render.

For moving animation, test a time inside the scene, then an earlier time, then the first time again within the same browser session and renderer instance. The first and third frames must match; choose times where the geometry or animation visibly differs so the middle frame also confirms that the scene is not static. Compare canvas pixels or hashes when automating this check. Separate CLI frame renders and GPU mocks do not prove in-session seeking; report them as narrower checks if browser verification is unavailable. Also inspect the beginning, each cut, and the final frame. A frame counter or accumulated delta can look correct during playback but fail during seeking and export.

## Consumer tooling

The Ritween CLI supplies the browser bundler; a direct Node import is not a browser renderer. For standalone typechecking, import from `ritween` and use the installed package's public type entry with the consumer project's TypeScript tooling and WebGPU declarations (for example `@webgpu/types` when needed). Do not deep-import framework modules or redirect type resolution to framework source.

Do not enable `allowJs` or weaken strict checking merely to suppress missing declarations inside Ritween. Check the installed package version and its type entry, record the actual diagnostic, and report a package typing issue if declarations are missing. The checkout has an automatic declaration-generation fix, but it has not yet been published; do not assume an npm installation labeled `0.1.0` contains that fix. Keep consumer typechecking separate from whether preview or export succeeds.

The CLI accepts a direct manifest path or discovers common names such as `manifest.ts` in a project directory. Prefer explicit `--project ./manifest.ts` when discovery is uncertain. Do not assume the CLI loads the consumer's `vite.config`; it creates its own Vite server.
