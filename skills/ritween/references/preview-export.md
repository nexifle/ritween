# Preview and export — Ritween 0.1.0

The examples assume `ritween` is available on `PATH`, normally after `npm install -g ritween`. Run from the consumer project; replace paths with the actual manifest and output locations. Create the output directory first if needed. For an intentionally local dependency, use a package-manager script that exposes its executable.

```sh
ritween --help
ritween preview --project ./manifest.ts --open
ritween frame --project ./manifest.ts --time 0.5 -o ./artifacts/frame.png
ritween frame --project ./manifest.ts --frame 15 --fps 30 -o ./artifacts/frame-15.png
ritween export --project ./manifest.ts -o ./artifacts/video.mp4 --json
```

There is no scaffold command. Do not pass `--time` or `-o` to `preview` expecting a studio at that time: these options switch it to a frame operation.

## Validation sequence

1. Validate manifest structure and run available typechecking.
2. Render and inspect frames near the start, within animation, around cuts, and near the end. Actually inspect images for the requested content, framing, and clipping.
3. Open preview to inspect motion, audio, and backward/forward seeking. For moving animation, use the same browser session and renderer: render a time, seek backward, and return to the first time. The repeated frames should match while the earlier frame should differ where motion is expected; see [the seeking check](authoring.md#deterministic-motion-and-seeking). Do not present isolated CLI frame renders as proof of in-session seeking.
4. Export when requested. Wait for command completion: the last rendered frame does not mean encoder flush and MP4 muxing have finished.
5. Inspect the resulting file. Check dimensions, duration, frame count, playback, and presence of requested audio using available tools. Record unavailable checks as unverified rather than successful.

## Environment and output constraints

Chrome/Chromium, GPU acceleration, WebGPU, and WebCodecs are needed. The CLI uses `playwright-core` and defaults to the `chrome` channel; it does not imply a browser binary has been installed. `--browser PATH` or `--channel` can select another installation. If startup fails, report the error and check CLI help and browser availability instead of claiming a render.

Existing outputs are refused unless `--force` is supplied. Choose fresh filenames or ask before overwriting. The default timeout is 120 seconds and includes server/browser startup. JSON results use stdout and progress uses stderr.

For failed commands, incorrect frames, seeking discrepancies, or missing audio, use [render diagnostics](render-diagnostics.md). For final audio balance and metering, use [mix loudness](mix-loudness.md); detecting an audio stream is not a listening test.

## Encoding and sizing

- Output is H.264 MP4, with AAC when audible audio is present.
- Supported FPS values are 24, 30, and 60.
- Frame count is `ceil(duration * fps)`, with frame `i` evaluated at `i / fps`. Encoded duration is frame count divided by FPS, so a non-frame-aligned requested duration can round upward.
- An indexed frame must be below the frame count. A timestamp may equal composition duration, selecting the last scene at progress 1.
- Keep export dimensions even and consistent with aspect ratio. H.264 Level 4.2 constraints also apply; arbitrary huge dimensions are not supported.
- The CLI's `720p` preset means 1280×720, not an adaptive portrait preset. For portrait use explicit sizes such as `--resolution 720x1280` after confirming the installed CLI syntax in help.

## Settings

CLI overrides take precedence over project settings, then defaults. The CLI automatically loads the manifest's settings sidecar, such as `manifest.settings.json`; do not discard user settings when editing a project. Track mute affects exports, unlike preview master mute/volume.

For SDK-based export, use public `resolveExportRequest(project, overrides)` before `exportMp4` to follow project settings policy. Inspect the installed types for the resolved request shape instead of inventing positional arguments. The low-level export options accept numeric bitrate or omission, not the settings string `"auto"`.

The normal user workflow does not require a custom SDK export script: prefer the CLI unless integrating into an application is part of the task.
