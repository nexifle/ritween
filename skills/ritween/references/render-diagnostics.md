# Diagnose manifests, frames, audio, and exports

Read when a normal preview, frame, or export command fails or produces the wrong result. Use the installed CLI help and actual error message rather than assuming every diagnostic string is stable. Follow [preview/export](preview-export.md) for commands and delivery constraints.

## Find the failing stage

Run the ordinary CLI with the intended manifest and a fresh output path. With JSON output, keep stdout results separate from stderr diagnostics/progress. A successful progress count is not completion: wait for encoder flush, muxing, and the final result. Stage events such as scene setup, audio mixing/encoding, video encoding, and muxing help locate the problem.

Do not work around an unexplained failure by deleting requested audio, weakening TypeScript checks, replacing the encoder, or introducing canvas capture. Reproduce the smallest failing scene or clip. If a supported bounded project exposes a framework defect, report that defect rather than inventing a project-specific scheduler.

## Manifest and command checks

| Symptom                                  | Check                                                                                                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| No manifest found or wrong project opens | Pass an explicit `--project ./manifest.ts`; verify named `project` or default export and its imports. A named export takes precedence.        |
| Invalid resolution/aspect                | Positive integer base dimensions, positive aspect values, and matching ratios. Export dimensions must also satisfy the codec rules.           |
| Invalid sequential scene                 | Unique nonempty IDs, finite positive durations, first start zero, each next start at the previous end, and only `cut` transitions.            |
| Scenes do not fill the composition       | Last scene end equals project duration; changing a scene length requires retiming successors.                                                 |
| Invalid audio clip                       | Unique track IDs and globally unique clip IDs; nonnegative start, positive duration, end inside the composition; no overlap within one track. |
| Wrong timestamp or frame index           | Time is within the composition; indexed frames are below `ceil(duration * fps)`. Do not combine `--time` and `--frame`.                       |
| Preview exits after one image            | `preview` with time/frame/output options is a frame operation, not a persistent studio session.                                               |
| Export rejects timestamp options         | Export renders the composition; use `frame` for a single image.                                                                               |
| Output already exists                    | Choose another path. Use `--force` only with permission to replace that output.                                                               |
| Portrait export rejects `1080p`          | That preset is 1920×1080. Use explicit portrait dimensions matching the project and codec limits.                                             |
| Browser cannot launch                    | Check the installed browser and CLI `--browser`/`--channel` options. Do not claim rendering succeeded.                                        |

Project settings sidecars can alter exports. Inspect them before blaming the authored manifest; explicit CLI overrides take precedence. Preserve unrelated settings and stable IDs. See [preview/export](preview-export.md#settings).

## A frame is blank, frozen, or distorted

- **Compile overlay:** fix the named module or shader. A helper's prepended WGSL can shift line numbers; do not assume the reported line belongs to the fragment snippet alone.
- **Blank geometry:** confirm the render pass draws, viewport/scissor is correct, vertices are inside clip bounds, winding/culling agree, and depth state does not reject everything. The engine submits the encoder; calling `finish` or `submit` inside the scene is not a repair.
- **Frozen animation:** confirm current timeline uniforms are uploaded each render, not only in setup. Check that the shader reads the binding and field you actually update.
- **Missing text:** verify a real text texture/atlas exists, the requested glyphs are included, and alpha sampling/blending agree. TSX and DOM text are not GPU rendering.
- **Cropped/stretched output:** remove hardcoded target sizes or add explicit reference-layout scaling. Recompose for a different aspect rather than assuming uniform scaling solves it.
- **Jagged or shimmering lines:** inspect stroke tessellation, joins, coverage filtering, and sample counts. MSAA cannot fix high-frequency shader patterns or abrupt timing.
- **Movement stops at every beat:** inspect segment velocities and accumulated holds before blaming GPU throughput. Use [geometry and motion](gpu-geometry-motion.md).

Check the exact scene selected at a cut. The next entry owns the cut instant; the final entry owns the composition endpoint at progress 1. An old `start` value can make a correct renderer show the wrong authored scene.

## Preview and export disagree

Look for module-global GPU state, resources reused across devices, hardcoded dimensions, unseeded randomness, wall-clock inputs, and intermediate textures left over from prior frames. Each `create` must return a fresh scene instance.

For seeking, use one browser session and renderer: render A, render an earlier B, then return to A. Compare the repeated decoded pixels and confirm B differs when motion is expected. Separate CLI PNG renders are useful additional evidence, but they cannot expose every playback-history bug. Compare within the same GPU/browser environment before interpreting cross-device pixel differences.

## Audio is missing or fails scheduling

Check track mute settings, clip boundaries, node routing to `host.destination`, envelope levels, source starts/stops, asset decoding, and `host.at` conversion. Preview monitor mute differs from exported track mute. A PNG has no audio.

An unsupported managed-API error requires using supported nodes/operations, not another context. For resource-limit errors, share buffers, reduce unnecessary nodes/events, simplify routing, and bound duration/loops. The managed scheduler already handles ordinary upfront scheduling; do not add `host.defer`, manual graph windowing, or timers.

If audio is present but harsh, clipped, or masks speech, use [mix loudness](mix-loudness.md). Protective compression is not a guaranteed loudness or true-peak target. Decode the final AAC to check it; stream presence alone is not a listening test.

## The MP4 is the wrong duration or quality

Compare output metadata against `ceil(project.duration * fps)` frames and encoded duration `frames / fps`. Check the opened file path and actual selected settings before reworking the muxer. Bytes do not establish duration. Keyframe spacing is configurable; do not assume every frame is a keyframe. Successful seeking need not mean all samples are sync samples.

Check dimensions, aspect, FPS, frame count, audio streams, and representative decoded frames. If visual quality is poor, inspect bitrate and source detail as well as geometry. A successful build tests code compilation, not browser encoding, playback, or sound. Record exactly which checks ran and which remain unavailable.
