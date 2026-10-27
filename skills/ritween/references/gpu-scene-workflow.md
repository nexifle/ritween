# Custom WebGPU scenes in a consumer project

Read this when the minimal clear-color example is insufficient. Use [authoring](authoring.md) for the manifest and lifecycle contract, and [motion design](motion-design.md) to choose what to draw before choosing a shader technique.

## Own the pipeline, not the framework

Import `Scene` and `Project` from `ritween`. Keep scene modules beside the consumer manifest. The framework demo's `shaderScene`, bitmap font, uniform layout, and effects are not public APIs. A new consumer scene must implement the pipeline it needs; do not import checkout paths or assume the demo's font can render arbitrary text.

The CLI compiles the selected manifest without requiring a consumer Vite configuration. Prefer `--project ./manifest.ts` over relying on discovery. A named `project` export or default `Project` is supported; the named export takes precedence. Other runtime dependencies must be resolvable from the consumer project. Assets under its `public/` directory can be served by the CLI; prepare them before rendering.

Choose the smallest rendering mechanism that serves the brief:

- Flat geometry and prepared text textures for clean typography and motion graphics.
- Vertex buffers, instancing, and depth testing for meshes or repeated geometry.
- Fullscreen fragment shading for an intentionally procedural field or compositing pass, not as the default aesthetic for every video.
- Multiple passes only when the concept needs intermediate images, outlines, or postprocessing.

## Build resources in setup

`setup({ device, format, resolution })` may await fonts, fetches, shader diagnostics, and pipeline creation. Create buffers, textures, samplers, and bind groups for this scene instance. Keep immutable CPU data reusable, but never share device-owned GPU resources between renderer instances.

Call `getCompilationInfo()` on shader modules when diagnosing compilation. Await `createRenderPipelineAsync()` in setup when asynchronous validation is useful. Report shader diagnostics rather than hiding them behind a replacement render path.

For text, rasterize the actual supplied copy into a texture using an available font, or implement an atlas with all required glyphs. Inspect digits, punctuation, accents, and non-Latin text. DOM elements do not appear in export. Do not describe a missing glyph as a font styling choice.

## Upload the current frame's controls

A fullscreen shader can receive this project-defined uniform layout:

```wgsl
struct Frame {
  resolution: vec2f,
  localTime: f32,
  progress: f32,
};
@group(0) @binding(0) var<uniform> frame: Frame;
```

Allocate 16 bytes and write `[width, height, localTime, progress]` as four float32 values in `render`. Both sides must agree on ordering and alignment. This is an example layout, not a Ritween-provided binding.

Use the render context's resolution rather than a hardcoded width in WGSL. Convert reference-layout coordinates deliberately; a different aspect ratio may need recomposition. Every time-varying control comes from `time`, `localTime`, or `progress`, not wall-clock time or the last frame.

## Record passes on the supplied encoder

Create a view of `target`, clear or load deliberately, bind the pipeline and resources, issue draws, and end the pass. The engine finishes and submits the encoder. Compute passes can precede rendering on that same encoder; end one pass before starting another.

For depth testing, create a depth texture and matching `depthStencil` pipeline state. The engine does not attach a depth buffer for you. Match dimensions, format, and sample count to the render attachments.

For 4× MSAA, use pipelines with `multisample.count: 4`, draw into a scene-owned multisampled color texture, and set the single-sampled `target` view as `resolveTarget`. Match depth sample count if depth is used. Recreate attachments if target dimensions change. MSAA improves geometric edges; it does not repair timing, low frame rate, or aliasing generated inside a fragment shader.

For postprocessing, draw into scene-owned sampleable textures, then composite into `target`. Do not sample from the same texture subresource that the active pass writes. A pass that only reads an intermediate image cannot assume the previous requested frame produced it: regenerate intermediate content for the current timestamp.

## Register and inspect the scene

Use a unique scene ID, a factory returning a fresh instance, and a `source` path relative to the manifest directory. The source path supports inspection; `create` is what executes. Keep entries consecutive with `cut` transitions and update the composition duration when appending a scene. Audio does not automatically move when a visual cut moves.

Render just before, exactly at, and after a changed cut. At the cut the next scene owns the frame; composition end selects the final scene at progress 1. Then perform the same-renderer backward-seek check in [authoring](authoring.md#deterministic-motion-and-seeking). Separate CLI invocations are useful frame inspections, not proof of in-session seeking.

Destroy scene-owned buffers and textures in `dispose`; allow cleanup after partially completed setup. Never destroy the engine's device, target, or encoder. Use [render diagnostics](render-diagnostics.md) for failures and [preview/export](preview-export.md) for delivery checks.
