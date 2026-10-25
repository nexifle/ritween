---
name: rimotion
description: >
  Author a Rimotion video by writing seekable WebGPU scene modules and a
  project manifest, then preview, render a PNG frame, and export MP4 with the
  rimotion CLI. Use when the user wants a Rimotion video, a new scene, a
  shader scene, a still frame, an MP4 export, or runs /rimotion.
---

# Rimotion

You write the picture. Scene factories and the manifest are the video. `render` is a pure function of the timestamp the framework passes in.

## Which reference

Read the one that matches the task and follow it. Use a second reference when the task crosses it.

- Add or change a scene in this repository: [references/author-a-scene.md](references/author-a-scene.md)
- Author a project outside this repository: [references/external-project.md](references/external-project.md)
- Preview, render a PNG, or export: [references/command-sessions.md](references/command-sessions.md)
- The command failed, the manifest was rejected, or the frame looks wrong: [references/failures.md](references/failures.md)
- Move vertices, build them from indices, morph shapes, draw edge ribbons, or vary instances: [references/vertex.md](references/vertex.md)
- Toon bands, warm and cool light, strokes, paper grain, a shell outline, or a screen-space edge: [references/npr.md](references/npr.md)

Types are `src/engine/types.ts`. Timeline checks are `src/engine/timeline.ts`. Flags are `rimotion --help` and `CLI.md`.

## Loop

1. Follow the reference. Keep scenes ordered, gapless, and hard-cut.
2. Render a PNG on each side of every cut you touched, and one timestamp inside the scene. Seek backward as well as forward.
3. Export with `--json`. A nonzero exit, or stderr `{"event":"error",...}`, is a failed export.
4. Fix the scene or the manifest. Edit `src/engine/` only when the task is the framework.
