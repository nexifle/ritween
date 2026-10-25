# Tutorial: add a scene in this repo

The shipped composition is `src/project/manifest.ts`: intro `0–2`, main `2–6`, outro `6–8`, `duration: 8`. This tutorial appends a 2 second scene and moves the duration to 10. Adapt the names and the shader. Leave `src/engine/` alone.

`shaderScene(fragment, title, mode)` in `src/project/scenes/shaderScene.ts` supplies a fullscreen triangle and the uniform `u`. `u.time` is scene-local seconds. `u.progress` is `localTime / duration`. `u.resolution` is the target size in pixels. The bitmap font draws uppercase `A–I`, `L–P`, `R–W`, `Y`, and space. Any other character is a blank cell. `text(uv, center, height)`, `orbit(p, t)`, and `background(uv)` come from that file's prelude.

## 1. Add the module

Create `src/project/scenes/hold.ts`:

```ts
import { shaderScene } from "./shaderScene";

export default function createHold() {
  return shaderScene(
    /* wgsl */ `
    @fragment fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
      let uv = position.xy / u.resolution;
      let p = (uv - vec2f(0.5)) * vec2f(u.resolution.x / u.resolution.y, 1.0);
      var color = background(uv);
      let edge = abs(p.x) - u.progress * 0.85;
      let band = exp(-abs(edge) * 90.0);
      color += vec3f(0.45, 0.55, 1.0) * band;
      let glyph = text(uv, vec2f(0.5, 0.5), 0.06);
      color = mix(color, vec3f(0.93, 0.94, 1.0), glyph);
      return vec4f(color, 1.0);
    }
    `,
    "HOLD",
    0,
  );
}
```

The bar width is `u.progress`, so time 8.0 is a thin line and time 10.0 is fully open. "HOLD" uses only letters in the font.

A `.tsx` module uses this same factory shape. JSX in that file is not drawn. Copy `src/project/scenes/main.tsx` when you want that shape, and keep the drawing in the WGSL string.

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

Time `7.9` is still the outro. Time `8` is the first instant of Hold. Time `9` is progress `0.5`, so the band sits near half of `0.85`. The two renders at time `8` are the determinism check: they match. Open the PNGs.

Then export the whole composition:

```sh
rimotion export -o /tmp/rimotion-hold.mp4 --json --force
```

`frames` is `ceil(10 * 30) = 300` at the default 30 FPS. `duration` in the result is `10`.

`npm run test:browser` still expects the original 8 second, 240-frame demo. Update that script's duration, frame count, and seek times when this composition stays. Skip that update when the scene was only an experiment and you restore the manifest.

More command transcripts: [command-sessions.md](command-sessions.md).
