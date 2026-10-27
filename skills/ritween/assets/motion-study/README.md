# Motion study: mechanics, not a design preset

A six-second, 640×360 study: three distinct squares follow curved paths, close into a compact triangular group, then move together to a new position. The 28-pixel squares keep their size and colors throughout. Light curved guides establish their routes; colored strokes trace their travel. During assembly the curves stay attached to their squares, then their tails shorten as the group moves to the right. It uses WebGPU geometry, persistent readable text rasterized to a texture, and two quiet procedural sound cues. Every frame is evaluated from timeline time rather than previous renders.

## Run

With `ritween` installed and available on `PATH`, run from this example directory:

```sh
mkdir -p artifacts
ritween preview --project ./manifest.ts --open
ritween frame --project ./manifest.ts --time 1.3 --resolution 640x360 -o ./artifacts/travel.png
ritween frame --project ./manifest.ts --time 2.8 --resolution 640x360 -o ./artifacts/assembly.png
ritween frame --project ./manifest.ts --time 3.5 --resolution 640x360 -o ./artifacts/group.png
ritween frame --project ./manifest.ts --time 4.6 --resolution 640x360 -o ./artifacts/handoff.png
ritween frame --project ./manifest.ts --time 5.6 --resolution 640x360 -o ./artifacts/end.png
ritween export --project ./manifest.ts --resolution 640x360 --fps 30 -o ./artifacts/motion-study.mp4
```

Chrome/Chromium with WebGPU and native H.264 encoding is required. No external fonts, assets, or additional rendering libraries are required. A framework checkout is not required.

## What to learn

- `manifest.ts`: one continuous scene can contain several visual beats.
- `scene.ts`: distance-normalized curve travel overlaps gathering (1.85–3.4 s) and group translation (2.85–5.2 s), avoiding a stop between beats. Quintic easing keeps boundary acceleration continuous; WebGPU 4× MSAA softens geometry edges. Positions are evaluated on the CPU; WebGPU renders and resolves the multisampled image. Text remains a stable reading anchor. Textures and pipelines are prepared in setup; rendering stays synchronous and seekable.
- `audio.ts`: modest procedural cues mark the group's assembly and its arrival after the handoff without replacing visual communication.

## What not to copy

Read the user's brief before selecting any technique here. The subject, title, six-second duration, palette, font choice, layout, labels, sound cues, trajectories, and beat order are not recommendations for a new video. Reuse only the implementation mechanism your chosen direction needs. A library event should not become a film titled "From motion to form" merely because that wording exists in this example.

This is a small mechanics study, not a quality ceiling, brand identity, default template, or demonstration of every WebGPU capability. Do not stretch it to fill a longer brief or add shader effects as a substitute for a subject-specific concept. Review the actual result at delivery size and speed; a running example alone does not establish good art direction.
