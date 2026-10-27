---
name: ritween
description: >-
  Create, modify, inspect, and export videos using Ritween. Use this skill
  whenever the user mentions Ritween or works on a Ritween project: manifests,
  WebGPU scenes, animation and timing, audio, seeking, previews, PNG rendering,
  or MP4 export, even without an explicit request for a skill. Not intended for
  developing framework internals or working with other video frameworks.
metadata:
  ritween-version: "0.1.0"
---

# Creating videos with Ritween

Help the user produce a runnable project, not just code snippets. This skill targets Ritween 0.1.0. Check the installed version before using examples; for a different version, inspect its types and CLI help. Do not automatically change the user's dependency version.

## Workflow

1. Inspect the existing project and the brief: message, duration, aspect ratio, assets, audio, and output location. Reuse the existing project where possible. Choose simple defaults for nonblocking details; ask about unresolved creative decisions or destructive changes.
2. Check that the `ritween` command is available on `PATH`. Use it directly in the normal user workflow. If missing, explain global installation with `npm install -g ritween` and obtain authorization before installing. Do not assume the user has a framework checkout.
3. For new videos or changes to visual direction, storytelling, or motion, read [motion design](references/motion-design.md): turn the brief into a subject-specific direction, a short beat sheet, and purposeful choreography before coding. Preserve existing brand decisions for narrow edits; skip this reference for purely technical fixes. Read the [authoring reference](references/authoring.md) for contracts and a minimal example. Create the manifest and scenes using public imports from `ritween`, not deep imports into `src/engine`.
4. Arrange scenes consecutively without gaps or overlaps, and derive animation from timeline time. For audio, read the [audio reference](references/audio.md). Jika pengguna menyediakan gambar, BGM/SFX, atau footage, baca [aset media lokal](references/media-assets.md); utamakan aset tersebut, bukan menggantinya dengan synth atau visual prosedural.
5. Run manifest validation and the project's available typecheck. Follow [preview and export](references/preview-export.md): inspect keyframes for composition and legibility, review playback for pacing and choreography, verify seeking, then export MP4 when requested. Technical success alone does not establish visual quality.
6. Report changed files, run commands, output locations, actual validation results, and blockers. Distinguish typechecked code from browser-verified output. Do not claim success when export fails.

## Motion quality and intent

- User intent and supplied references outrank bundled examples. Treat examples as implementation mechanics, not presets for palette, copy, subject, duration, or beat order. Read the brief before selecting an example; reuse only the technique it needs.
- Design motion, not a slideshow. For motion-graphics briefs, let spatial relationships, geometry, typography, or coordinated movement visibly develop the message. Fade/slide entrances support the concept; they are not the whole concept. Use full-frame stillness as intentional contrast, not empty waiting between reveals.
- Choose a motion thesis before coding: what changes, what it communicates, and how it hands attention to the next beat. A list of entrances is not a motion concept.
- Interpret broad words such as "dynamic," "outstanding," or "showcase your strength" as requests for craft, not permission for unreadable text or shader spectacle. Without a contrary style direction, favor clear typography, disciplined composition, and lively coordinated motion. Add sound when requested; otherwise state a modest audio assumption or ask when material to the brief.
- Keep reading anchors stable while purposeful supporting motion continues. One focal event does not mean only one element may move; a reading hold does not require freezing the entire image. Neither constant movement nor shader complexity is a quality metric.

## Correctness rules

- `setup` may be asynchronous; `render` is synchronous. Load assets and prepare resources before rendering. Resource video menyiapkan frame dalam `prepareFrame` asinkron; gunakan `Renderer.renderAsync` untuk scene tersebut.
- Scenes must be seekable: rendering the same time produces the same image independently of previous frames. Do not integrate deltas, use `Date.now()`, or use unseeded randomness for animation.
- Each `create` factory returns a fresh instance. GPU state belongs to one renderer instance; release scene-owned resources in `dispose`.
- Use `device`, `format`, `resolution`, `encoder`, and `target` from the context. The renderer submits the command buffer.
- TSX is a module format; JSX and DOM elements do not automatically become GPU graphics. Do not invent text components, layout systems, or drawing APIs that Ritween does not export.
- The reference version supports only `cut` transitions. Implement fades within a scene rather than overlapping scene entries or inventing transition APIs.
- The CLI provides only `preview`, `frame`, and `export`; there is no `init` or `create` command.
- Do not overwrite output files or use `--force` without the user's permission.

## Optional implementation references

Read only the references needed for the current task, not the entire collection. These describe techniques to implement with public contracts, not additional built-in Ritween APIs. Choose techniques from the brief; do not let a reference dictate the video's subject or aesthetic.

| Task                                                                   | Reference                                                            |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Custom GPU pipelines, uniforms, text assets, and resource lifecycle    | [GPU scene workflow](references/gpu-scene-workflow.md)               |
| Curved paths, smooth timing, mesh deformation, instancing, and strokes | [Geometry and motion](references/gpu-geometry-motion.md)             |
| Illustrative lighting, hatching, and 3D outlines                       | [Stylized surfaces](references/stylized-surface-rendering.md)        |
| Data scales, labels, layout, and chart geometry                        | [Data layout and marks](references/data-layout-and-marks.md)         |
| Animated chart windows, linked views, and dense time series            | [Data animation and series](references/data-animation-and-series.md) |
| Tones, envelopes, percussion, and pitched samples                      | [Sound synthesis](references/sound-synthesis.md)                     |
| Musical scores, buses, effects, and audiovisual synchronization        | [Sound arrangement](references/sound-arrangement.md)                 |
| Tracker-style patterns and bounded module interpretation               | [Pattern sequencing](references/pattern-sequencing.md)               |
| Speech/music balance, ducking, and final audio metering                | [Mix loudness](references/mix-loudness.md)                           |
| Failed commands, incorrect frames, seeking, or audio/export problems   | [Render diagnostics](references/render-diagnostics.md)               |

## Starting an empty project

Use a small structure that requires neither framework source files nor a custom Vite configuration:

```text
my-video/
  package.json
  manifest.ts
  scenes/
    main.ts
  public/       # Optional user assets
```

Use `ritween` directly after global installation with `npm install -g ritween`. A global CLI can run a consumer manifest without a framework checkout. If the project intentionally uses a local dependency, expose its executable through a package-manager script instead; local installation alone does not put `ritween` on the interactive shell's `PATH`. Do not build an installer or template generator for an ordinary video task.

The reference clear-color scene checks the rendering pipeline; it is not a visual quality target. For real videos, implement composition, typography/assets, and motion appropriate to the brief using a genuine WebGPU pipeline. Do not claim visual elements exist merely because they appear in the final report.
