# AI Authoring Guide

You are the video author. Write files, import scenes into `src/project/manifest.ts`, and edit the manifest. Do not change the engine to change video content. Start Vite, then source changes update the preview automatically.

## Scene contract

A module exports a factory returning a fresh `Scene` instance. `.ts`, `.tsx`, and `.js` modules all use this contract. See `src/engine/types.ts` for the definitive interface.

```ts
import type { Scene } from "../../engine/types";
export default function createScene(): Scene {
  return {
    async setup({ device, format, resolution }) {
      // Compile WGSL, create GPU buffers, pipelines, textures and bind groups.
      // This is the place to load assets. Throw on failure.
    },
    render({ device, encoder, target, resolution, time, localTime, progress }) {
      // time: absolute project seconds
      // localTime: time - scene.start
      // progress: localTime / scene.duration, clamped by timeline evaluation
      // Record render/compute commands into encoder, targeting target.
      // The engine submits encoder after render returns. Do not finish it here.
    },
    dispose() {
      // Destroy owned buffers/textures and release other resources.
    },
  };
}
```

The complete ready-to-render example below uses the shipped shader helper:

```ts
// src/project/scenes/pulse.ts
import { shaderScene } from "./shaderScene";
export default function createPulse() {
  return shaderScene(
    /* wgsl */ `
    @fragment fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
      let uv = position.xy / u.resolution;
      let p = (uv - .5) * vec2f(u.resolution.x / u.resolution.y, 1.);
      let ring = exp(-abs(length(p) - (.18 + .05 * sin(u.time * 3.))) * 120.);
      let color = background(uv) + vec3f(.3, .6, 1.) * ring;
      return vec4f(color, 1.);
    }
  `,
    "PULSE",
    0,
  );
}
```

The helper provides a fullscreen triangle, uniform values (`u.resolution`, scene-local `u.time`, `u.progress`), optional GPU bitmap text, and deterministic shader utilities. Its small uppercase font is intentionally limited to the demo vocabulary; extend the font map or implement a GPU texture atlas for other text. New scenes can use their own pipelines instead of this helper.

## Register and compose

Import `createPulse` into `src/project/manifest.ts`. Replace or append entries and update duration:

```ts
import createPulse from './scenes/pulse';
// Example fourth scene, following the current 8-second demo:
{ id: 'pulse', name: 'Pulse', source: 'scenes/pulse.ts',
  start: 8, duration: 2, create: createPulse, transition: { type: 'cut' } }
// Set project.duration = 10.
```

`source` is a display label, while `create` is the real registration. `name`, `resolution`, `aspectRatio`, duration, imports, sequence order, start times and transition metadata all belong to the manifest. Entries must be ordered, unique, finite, positive in duration, contiguous from time zero, and end exactly at the project duration. Overlaps and gaps fail validation. At a cut timestamp the next scene is selected. At composition end the last scene evaluates at progress 1. Export keeps `resolution`'s aspect. The steps use a short side of 360, 720 or 1080 when the frame fits H.264 Level 4.2. A size with a different aspect is rejected.

## Audio tracks

Sound is not part of a scene. Add `audioTracks` to the project. Each track has clips placed on the composition clock. Clips on one track cannot overlap. Tracks sum. A clip module schedules Web Audio nodes against `host.at(localTime)` and does not read the playhead.

```ts
import { phrase } from "./audio/phrase";
audioTracks: [
  { id: "a1", name: "A1", clips: [
    { id: "bed", name: "Bed", start: 0, duration: 4, create: phrase(220) },
  ]},
]
```

`phrase` is one factory used with different pitches. Placement stays on the clip. The preview timeline draws these rows under V1. The M button on a row omits that track from preview and from the next export. Preview volume does not enter the file. Keep peaks modest; the mix runs through a limiter at −1 dB. Schedule on the audio clock (`start(time)`, ramps). Do not trigger notes from `setTimeout`.

Write the complete deterministic audio schedule using supported Web Audio nodes and `host.at`. Rimotion compiles the graph and creates native voices near their start automatically; no project-level `host.defer` or custom scheduler is needed. Use the managed subset and enforced resource limits in [.grok/skills/rimotion/references/audio.md](.grok/skills/rimotion/references/audio.md). Unsupported APIs fail explicitly. Fetch/decode may be awaited during scheduling; timers, retained hosts and separate audio contexts are outside the contract. See [export audio performance](PERFORMANCE.md) for implementation details.

## Determinism rules

Derive every animated value directly from supplied time and a fixed seed. Use analytic easing or fixed seeded hashing. Never use `Date.now()`, `performance.now()`, unseeded `Math.random()`, accumulated frame deltas, or mutable particle positions to determine the image. Rendering 5.2 seconds must work as the first render and after any other seek.

Keep instance GPU state inside the factory. Preview and export create separate devices and instances; do not cache GPU resources globally. Render synchronously; complete asynchronous loading during setup. Resolution and texture format come from the renderer and differ between export presets. Use normalized or resolution-aware coordinates. Dispose all owned resources, even if setup fails partway through.

TSX can organize scene logic, but React elements do not become GPU primitives. Draw text/graphics with GPU geometry, storage buffers, sampled textures, or WGSL. Store assets under `public/` or import Vite-resolved asset URLs. Optional HTML can serve as a supplementary shell; arbitrary HTML/CSS is not video content.

## Check your work

Run `npm test` and `npm run build`. Preview each cut and seek in a nonsequential order. Export at the target resolution and FPS. `npm run test:browser` validates the shipped eight-second demo; update its expected duration/frame count and seek targets if you change the composition. Do not claim encoding succeeds based on a successful build alone.

## Terminal workflow for agents

Use `rimotion preview --project /path/to/project` for live browser review, `rimotion frame --project /path/to/project --time 5.2 -o frame.png --json` to inspect one GPU-rendered PNG, and `rimotion export --project /path/to/project -o video.mp4 --json` for the full composition. The same commands run from source through `node /path/to/rimotion/bin/rimotion.mjs`. Pass `--force` explicitly to replace files. Read [CLI.md](CLI.md) for install, errors, and all options.
