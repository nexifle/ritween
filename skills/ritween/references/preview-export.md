# Preview and export — Ritween 0.2.4

The examples assume `ritween` is available on `PATH`, normally after `npm install -g ritween`. Run from the consumer project; replace paths with the actual manifest and output locations. Create the output directory first if needed. For an intentionally local dependency, use a package-manager script that exposes its executable.

```sh
ritween --help
ritween preview --project ./manifest.ts --open
ritween frame --project ./manifest.ts --time 0.5 -o ./artifacts/frame.png
ritween frame --project ./manifest.ts --frame 15 --fps 30 -o ./artifacts/frame-15.png
ritween export --project ./manifest.ts -o ./artifacts/video.mp4 --json
```

There is no scaffold command. Do not pass `--time` or `-o` to `preview` expecting a studio at that time: these options switch it to a frame operation.

## Studio export lifecycle

Exporting from `ritween preview` runs in headless Chrome/Chromium on the server,
not in the Studio tab. Refreshing or closing the tab does not cancel the job;
reopen the same server to follow progress or download a completed result.
The **Exports** tab lists retained jobs and offers download, cancel, and delete.

Server files are temporary: download videos you want to keep before stopping the
server. Normal shutdown deletes managed files, including recovered results, but
never deletes copies already downloaded elsewhere. After a crash, completed files
still on disk are recovered when preview starts again for the same manifest path;
unfinished encoding does not resume. The server retains at most 4 GiB of completed
videos and 50 job records per session; delete older entries when capacity is full.
One job renders at a time, with at most three active jobs. Source and settings are
bundled per job; public media files are not copied, so leave them unchanged while
exporting. Headless execution does not guarantee reduced total memory/GPU use.

## Imported MP4 loading

Check `ritween --help` for `--media-loading` before using it; older installed
packages may not expose the option. Preview, frame, and export default to
`--media-loading full`. Opt into `range` when requested or when evaluating startup
and download costs for large footage:

```sh
ritween preview --project ./manifest.ts --media-loading range
ritween frame --project ./manifest.ts --media-loading range --time 0.5 -o ./artifacts/range-frame.png --json
ritween export --project ./manifest.ts --media-loading range -o ./artifacts/range-video.mp4 --json
```

The option affects imported MP4 video and linked AAC, not standalone audio files.
It does not change the manifest or increase the 128 MiB per-asset limit. Do not
set internal globals or invent an SDK loading parameter to activate it. See
[media loading limits](media-assets.md#loading-mode-and-budgets) for fallback and
cache behavior.

For frame/export, inspect JSON `mediaLoading` and `mediaRequests`.
`rangeRequests` counts MP4 responses to requests carrying a Range header;
`partialResponses` counts `206` responses and `fullResponses` counts `200`
responses. Requested mode alone is not proof of incremental loading: a small file
may fit entirely in the initial partial response, and unsupported servers may
fall back to full downloads. For preview, inspect browser requests and responses.

When comparing modes, use the same asset, timestamp, output settings, and
validation checks with distinct output paths. Compare actual frames and exported
audio, not only request counts. Report measured timing and response bytes only
when captured; response counts are not byte measurements. Range can reduce
startup downloads for large footage but may be slower for short files or
high-latency access. Do not promise a universal speedup or a total RAM limit.

## Validation sequence

1. Validate manifest structure and run available typechecking.
2. Render and inspect frames near the start, within animation, around cuts, and near the end. Actually inspect images for the requested content, framing, and clipping.
3. Open preview to inspect motion, audio, and backward/forward seeking. For moving animation, use the same browser session and renderer: render a time, seek backward, and return to the first time. The repeated frames should match while the earlier frame should differ where motion is expected; see [the seeking check](authoring.md#deterministic-motion-and-seeking). Do not present isolated CLI frame renders as proof of in-session seeking.
4. Export when requested. Wait for command completion: the last rendered frame does not mean encoder flush and MP4 muxing have finished.
5. Inspect the resulting file. Check dimensions, duration, frame count, playback, and presence of requested audio using available tools. Record unavailable checks as unverified rather than successful.

## Environment and output constraints

Chrome/Chromium, GPU acceleration, WebGPU, and WebCodecs are needed. The CLI uses `playwright-core` and defaults to the `chrome` channel; it does not imply a browser binary has been installed. `--browser PATH` or `--channel` can select another installation. If startup fails, report the error and check CLI help and browser availability instead of claiming a render.

Existing outputs are refused unless `--force` is supplied. Choose fresh filenames or ask before overwriting. The default frame/export command timeout is 120 seconds and includes server/browser startup. Studio jobs have no render time limit unless preview is started with an explicit `--timeout SECONDS`; that limit excludes source bundling and queueing. JSON results use stdout and progress uses stderr.

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
