---
name: rimotion
description: >
  Author a Rimotion video by writing seekable WebGPU scene modules, audio
  tracks, and a project manifest, then preview, render a PNG frame, and
  export MP4 with the rimotion CLI. Use when the user wants a Rimotion video,
  a new scene, a minimalist clean motion graphic, a shader scene, a chart in a video, sound, music, an audio
  track, a tracker pattern, a still frame, an MP4 export, or runs /rimotion.
---

# Rimotion

You write the picture the request describes, and, when the cut needs sound, the audio tracks. A flat motion graphic and a procedural shader are both valid. Pick from the request. The fragment in [references/author-a-scene.md](references/author-a-scene.md) shows how a scene is wired. It is not the look to copy. Scene factories, clip factories, and the manifest are the video. `render` is a pure function of the timestamp the framework passes in. Sound is scheduled on a clip, not inside `render`.

## Which reference

Read the one that matches the task and follow it. Use a second reference when the task crosses it.

- Add or change a scene in this repository: [references/author-a-scene.md](references/author-a-scene.md)
- Add or move sound: [references/audio.md](references/audio.md)
- Shape a tone, a drum, a filter, or a sample: [references/audio-voices.md](references/audio-voices.md)
- Mix a grid, a room, a bus, or a placed sound, and match the picture to it: [references/audio-mix.md](references/audio-mix.md)
- Play a tracker pattern, with ticks and effects, inside the video: [references/audio-tracker.md](references/audio-tracker.md)
- Author a project outside this repository: [references/external-project.md](references/external-project.md)
- Preview, render a PNG, or export: [references/command-sessions.md](references/command-sessions.md)
- The command failed, the manifest was rejected, or the frame looks wrong: [references/failures.md](references/failures.md)
- Move vertices, build them from indices, morph shapes, draw edge ribbons, or vary instances: [references/vertex.md](references/vertex.md)
- Toon bands, warm and cool light, strokes, paper grain, a shell outline, or a screen-space edge: [references/npr.md](references/npr.md)
- Place data on a scale and draw ticks, labels, and a quiet grid: [references/chart-scales.md](references/chart-scales.md)
- Choose a mark and draw bars, lines, areas, points, bins, or slices: [references/chart-marks.md](references/chart-marks.md)
- Stroke a thick series, reduce a long series, or show density: [references/chart-series.md](references/chart-series.md)
- Move a chart across the shot: [references/chart-motion.md](references/chart-motion.md)

Audio schedules run through Rimotion's managed graph compiler for preview and export. Use the supported API and resource limits in [references/audio.md](references/audio.md); do not add project-level lazy scheduling, `host.defer`, custom export loops, or separate audio contexts. Fix rejected schedules within that contract. Performance scheduling belongs in the engine.

Types are `src/engine/types.ts`. Timeline checks are `src/engine/timeline.ts`. Flags are `rimotion --help` and `CLI.md`.

## Loop

1. Follow the reference. Keep scenes ordered, gapless, and hard-cut. Keep each audio clip inside the composition, and keep clips on one track from overlapping.
2. Render a PNG on each side of every cut you touched, and one timestamp inside the scene. Seek backward as well as forward.
3. Set the manifest resolution to the frame the request names, and pass that same size to `export --resolution`. The size names are in [references/command-sessions.md](references/command-sessions.md). Export with `--json`. A nonzero exit, or stderr `{"event":"error",...}`, is a failed export.
4. Fix the scene or the manifest. Edit `src/engine/` only when the task is the framework.
