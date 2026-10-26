# Guide: when a render fails

Read the `message` in the stderr JSON. Change the scene or the manifest to match the check. Do not add another encoder, a canvas capture path, or a multimedia library to get past it.

## Manifest messages

| Message | What to change |
|---|---|
| `Project needs a name and positive duration.` | Set `name` and a finite `duration` greater than 0. |
| `Invalid project resolution or aspect ratio.` | Integer pixel size, positive aspect, and `width/height` within `0.001` of `aspect[0]/aspect[1]`. |
| `Invalid sequential scene: <id>` | That entry has a duplicate or empty id, a non-positive duration, a `start` that is not the previous end (tolerance `1e-8`), or a transition other than `cut`. |
| `Scene durations must fill the composition.` | The last `start + duration` is not `project.duration`. |
| `Manifest must export project or a default Project.` | Export `project` or `export default` the project object. |
| `No project manifest found in ...` | Pass `--project` to a manifest file, or add one of the filenames in [external-project.md](external-project.md). |
| `Frame time 12s exceeds composition duration 8s.` | Pick a time from `0` through `duration`, inclusive. |
| `Frame index must be less than N for this composition at 30 FPS.` | Valid indexes are `0 .. ceil(duration * fps) - 1`. |
| `Use frame for a single timestamp; export renders the whole composition.` | Drop `--time` and `--frame` from `export`. |
| `Export 1920×1080 does not match the project aspect 9:16 (1080×1920).` | The export size and the manifest aspect differ. Use the matching size in [command-sessions.md](command-sessions.md). `1080p` is 1920×1080. |
| `Output exists: ... Pass --force to replace it.` | New path, or `--force`. |
| `Could not launch Chrome/Chromium...` | Install Chrome, or pass `--channel` / `--browser`. |
| `Export dimensions must be even.` | Both sides of an export size are even. |
| `Export dimensions must be even and fit H.264 Level 4.2` | The frame is too large. Use a shorter side. The limits are in [command-sessions.md](command-sessions.md). |
| `No export size keeps this project aspect within H.264 Level 4.2.` | No 360, 720, or 1080 step of this aspect fits. |
| `Export exceeds 4 GiB; choose a smaller resolution.` | Lower the size or shorten the composition. |

A Vite overlay on the preview page is a scene compile error. The CLI copies that overlay text into the error message. Fix the module it names.

`shaderScene` turns WGSL compile errors into `WGSL <line>:<column>: <message>`. The line number includes the helper prelude, so a small line number can point at `shaderHeader` in `shaderScene.ts`. A line past that header is your fragment.

## The PNG is the wrong picture

Render the timestamp twice. If the files differ, the scene is using the clock, `Math.random()` without a fixed seed, or values remembered from an earlier `render`. Drive the image from `time`, `localTime`, and `progress` only.

If both files match and both are wrong:

- Black frame: `render` never drew, the pass cleared and did not `draw`, or the shader discarded every pixel. The engine submits the encoder. Finishing it inside `render` throws.
- Frozen frame: the uniform is written in `setup` and not again in `render`, so `localTime` never arrives.
- Cut lands on the previous scene: `start` is still the old end. At time `8` with a scene that starts at `8`, that new scene is active. The previous scene owns `7.999`.
- Text missing: the title uses a character outside the helper font. The map is uppercase `A–I`, `L–P`, `R–W`, `Y`, and space.
- Export is cropped or stretched against the preview: the shader used a hardcoded width. Write `resolution` from the render context into the uniform. Preview base size and the export preset differ.
- Preview and export disagree for the same time: GPU state was stored on the module instead of inside the object `create()` returns. Each renderer calls `create()` and gets its own device.

## The MP4 is the wrong length

Compare stdout `duration` and `frames` with `ceil(project.duration * fps)`. A mismatch means the export you opened is from an older file, or `--fps` was not the rate you think. `bytes` does not encode duration.

`npm test` covers timeline math and the muxer tables. `npm run test:browser`, with `npm run dev` already running, decodes the shipped 8 second demo. After you change that demo's duration, update the expected frame count and the seek times `0.5`, `5.2`, and `7.5` in `scripts/validate-browser.mjs` or the test is checking the old film.
