# Tutorial: add a scene in this repo

The shipped composition is `src/project/manifest.ts`: intro `0–2`, main `2–6`, outro `6–8`, `duration: 8`. This tutorial appends a 2 second scene and moves the duration to 10. Adapt the names and the picture to the request. Leave `src/engine/` alone.

Match the picture to what was asked for. Every scene is still a WebGPU draw. `shaderScene` is only the fullscreen triangle in this repo. It is not a look.

- A title, a logo, a lower third, a layout, or any clean motion graphic is a few flat marks. One paper color, one ink color, and motion of position, size, opacity, or a wipe. The example below is that.
- A chart, a mesh, or a drawn shading model uses the chart, vertex, or NPR reference. Draw the marks that shot needs.
- A procedural field is for a request that asks for a shader, a generative image, neon, a tunnel, or the shipped intro. `background()` and `orbit()` in `src/project/scenes/shaderScene.ts` are that field. Copy `src/project/scenes/intro.ts` when that is the request.

`shaderScene(fragment, title, mode)` supplies the triangle and the uniform `u`. `u.time` is scene-local seconds. `u.progress` is `localTime / duration`. `u.resolution` is the target size in pixels. The bitmap font draws uppercase `A–I`, `L–P`, `R–W`, `Y`, and space. Any other character is a blank cell. `text(uv, center, height)` comes from that file's prelude.

## 1. Add the module

Create `src/project/scenes/hold.ts`:

```ts
import { shaderScene } from "./shaderScene";

export default function createHold() {
  return shaderScene(
    /* wgsl */ `
    @fragment fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
      let uv = position.xy / u.resolution;
      let paper = vec3f(0.96, 0.96, 0.95);
      let ink = vec3f(0.12, 0.13, 0.15);
      let panel = step(uv.x, u.progress);
      var color = mix(paper, vec3f(0.90, 0.91, 0.93), panel);
      let glyph = text(uv, vec2f(0.5, 0.5), 0.05);
      color = mix(color, ink, glyph);
      return vec4f(color, 1.0);
    }
    `,
    "HOLD",
    0,
  );
}
```

The panel edge is `u.progress`, so time 8.0 is paper only and time 10.0 is the full gray field. "HOLD" uses only letters in the font. Move a shape by mixing its center from a start to an end with `u.progress`. A second mark needs a reason in the request.

A `.tsx` module uses this same factory shape. JSX in that file is not drawn. Copy `src/project/scenes/main.tsx` when you want that module shape, and keep the drawing in the WGSL string.

For a pipeline of your own, follow [external-project.md](external-project.md). Own every `GPUBuffer` you create and `destroy` it in `dispose`, including when `setup` fails after the buffer exists.

## 2. Register it

In `src/project/manifest.ts`, import the factory and append one entry. `source` is a label. `create` is what runs.

```ts
import createHold from "./scenes/hold";

// project.duration becomes 10
// previous last scene still ends at 8
{
  id: "hold",
  name: "Hold",
  source: "scenes/hold.ts",
  start: 8,
  duration: 2,
  create: createHold,
  transition: { type: "cut" },
}
```

Each `start` equals the previous scene's end. The last end equals `project.duration`. `transition` stays `{ type: "cut" }`. At the cut, the next scene is active. At exactly `duration`, the last scene runs at progress `1`.

## 3. Look at the frames

From the repo:

```sh
rimotion frame --time 7.9 -o /tmp/rimotion-before.png --json --force
rimotion frame --time 8 -o /tmp/rimotion-cut.png --json --force
rimotion frame --time 9 -o /tmp/rimotion-mid.png --json --force
rimotion frame --time 8 -o /tmp/rimotion-cut-again.png --json --force
```

Time `7.9` is still the outro. Time `8` is the first instant of Hold, still paper. Time `9` is progress `0.5`, so the gray panel covers the left half. The two renders at time `8` are the determinism check: they match. Open the PNGs.

Then export the whole composition:

```sh
rimotion export -o /tmp/rimotion-hold.mp4 --json --force
```

`frames` is `ceil(10 * 30) = 300` at the default 30 FPS. `duration` in the result is `10`.

`npm run test:browser` still expects the original 8 second, 240-frame demo. Update that script's duration, frame count, and seek times when this composition stays. Skip that update when the scene was only an experiment and you restore the manifest.

More command transcripts: [command-sessions.md](command-sessions.md).
