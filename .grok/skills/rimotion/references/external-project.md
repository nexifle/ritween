# Tutorial: a project outside the repo

Use this when the video is not the demo in `src/project/`. The CLI compiles the manifest you pass. It does not load that project's Vite config. Scene code runs as part of the tool.

A directory is a project when it contains one of these, first match wins:

`src/project/manifest.ts`, `.tsx`, `.js`, then `project/manifest.ts` or `.js`, then `manifest.ts`, `.tsx`, `.js`, or `.mjs`.

A file argument is used as the manifest when it ends in `.ts`, `.tsx`, `.js`, `.jsx`, or `.mjs`. The module exports `project` or a default `Project`. Import types from `rimotion`. The CLI resolves that name to its engine. Other package imports must be installed in the external project. `shaderScene` is not part of that public entry. Build the pipeline in the scene, or copy the helper into the project.

## Layout

```
my-video/
  manifest.ts
  scenes/wash.ts
```

`my-video/scenes/wash.ts`:

```ts
import type { Scene } from "rimotion";

export default function createWash(): Scene {
  let pipeline: GPURenderPipeline;
  let uniform: GPUBuffer;
  let bind: GPUBindGroup;

  return {
    async setup({ device, format }) {
      uniform = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const module = device.createShaderModule({
        code: `
          struct Params { time: f32, progress: f32, pad: vec2f }
          @group(0) @binding(0) var<uniform> u: Params;
          @vertex fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
            var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
            return vec4f(p[i], 0.0, 1.0);
          }
          @fragment fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
            let x = position.x / 1280.0;
            let band = smoothstep(u.progress - 0.02, u.progress + 0.02, x);
            return vec4f(0.05, 0.08 + 0.4 * u.progress, 0.16 + 0.5 * (1.0 - band), 1.0);
          }
        `,
      });
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter((message) => message.type === "error");
      if (errors.length) {
        throw Error(errors.map((message) => message.message).join("\n"));
      }
      pipeline = await device.createRenderPipelineAsync({
        layout: "auto",
        vertex: { module, entryPoint: "vertex" },
        fragment: {
          module,
          entryPoint: "fragment",
          targets: [{ format }],
        },
        primitive: { topology: "triangle-list" },
      });
      bind = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniform } }],
      });
    },
    render({ device, encoder, target, localTime, progress }) {
      device.queue.writeBuffer(
        uniform,
        0,
        new Float32Array([localTime, progress, 0, 0]),
      );
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: target.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      pass.draw(3);
      pass.end();
    },
    dispose() {
      uniform?.destroy();
    },
  };
}
```

`my-video/manifest.ts`:

```ts
import type { Project } from "rimotion";
import createWash from "./scenes/wash";

export const project: Project = {
  name: "Wash",
  resolution: [1280, 720],
  aspectRatio: [16, 9],
  duration: 4,
  scenes: [
    {
      id: "wash",
      name: "Wash",
      source: "scenes/wash.ts",
      start: 0,
      duration: 4,
      create: createWash,
      transition: { type: "cut" },
    },
  ],
};
```

`resolution / aspect` must match within `0.001`. `1280/720` and `16/9` do. That pair is the 16:9 example. When the request names another frame, set both fields to that frame. Export sizes are in [command-sessions.md](command-sessions.md). Sound, when this project has any, is `audioTracks` on that same object. Follow [audio.md](audio.md). Import `AudioClipSource` from `rimotion`.

The fragment above divides by `1280` because this manifest's base width is 1280. Export presets change the target size. Prefer `resolution` from the render context, written into the uniform, whenever the same scene is exported at more than one preset. The in-repo helper already does that with `u.resolution`.

`setup` may be async. `render` returns immediately. Do not read `Date.now()`, `performance.now()`, or unseeded `Math.random()` to choose a color. Two calls at the same `localTime` draw the same image.

## Run it

```sh
rimotion preview /path/to/my-video --open
rimotion frame --project /path/to/my-video --time 2 -o /tmp/wash.png --json
rimotion export --project /path/to/my-video/manifest.ts -o /tmp/wash.mp4 --json
```

At 30 FPS the export reports `frames: 120` and `duration: 4`. Time `2` is progress `0.5`.

`public/` next to the project directory is served for that directory. A WGSL file beside the scene can be imported as `` import wash from "./wash.wgsl?raw" ``.
