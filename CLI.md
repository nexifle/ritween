# Ritween CLI

Ritween serves source-authored video projects, renders a timestamp to PNG, and exports an entire composition to H.264 MP4. There is no remote service or LLM integration. Rendering remains native browser WebGPU; video encoding and MP4 muxing use the same engine as the web interface.

## Run from source

Requires Node.js 22.18.0+ and an installed Chrome. In a checkout, run `npm install` and `npm run build`, then:

```sh
# Serve the current project, with state-preserving live source updates
node bin/ritween.mjs preview --open

# PNG at an absolute timeline timestamp
node bin/ritween.mjs frame --time 5.2 -o artifacts/frame.png

# Equivalent preview-to-image command
node bin/ritween.mjs preview --time 5.2 -o artifacts/frame.png

# Zero-based frame 156 at 30 FPS = 5.2 seconds
node bin/ritween.mjs frame --frame 156 --fps 30 -o artifacts/frame.png --force

# MP4 of the complete project
node bin/ritween.mjs export -o artifacts/video.mp4 --resolution 1080p --fps 60
```

`npm run cli -- <arguments>` is equivalent. No command automatically installs a browser.

## Install the command

The published package ships compiled JavaScript in `dist/` and SDK declarations in `types/`, not the framework's `src/`. The SDK resolves to `dist/index.js`; the command runs `dist/cli.js`. Studio, renderer, and demo modules are built before publishing. Vite remains responsible for compiling user-authored TS/TSX projects, not framework sources. Built preview applies project and settings changes through a development-only HMR bridge, without reloading the studio. It preserves playback position, zoom/pan, layout, monitor controls, and surviving scene selections; shorter compositions clamp the playhead. A new runtime is prepared before replacing the active one, so syntax/import/setup errors leave the last working preview available. Rapid edits discard superseded candidates. Updates received during export are deferred until the export finishes. Changes to public assets or server configuration may still use Vite's full-reload/restart fallback.

The published package is a Node program. `npm install -g` links `ritween` to `bin/ritween.mjs`, which runs on the Node.js already on the machine. npm installs the runtime dependencies for that platform, including Vite, React, Tailwind, and Playwright Core. It does not download a browser and it does not embed a second JavaScript runtime.

```sh
npm install -g ritween
ritween --help
ritween --demo --open
ritween frame --demo --time 5.2 -o frame.png
ritween export --demo -o video.mp4
```

`--demo` and `--open` start a web preview when no command is given. `ritween preview --demo --open` is the same command.

From a checkout of this repository, `npm install -g .` installs the working tree the same way. `npm pack --pack-destination release` writes `release/ritween-0.1.0.tgz`; `npm install -g ./release/ritween-0.1.0.tgz` installs that tarball. Chrome/Chromium and a working GPU driver remain external requirements.

## Render another codebase

```sh
ritween preview /path/to/video-project --open
ritween frame --project /path/to/video-project --time 1.25 -o still.png --json
ritween export --project /path/to/video-project -o final.mp4 --resolution 720p --fps 30 --json
ritween export --project /path/to/manifest.ts -o final.mp4
```

A project is either a manifest module, or a directory containing `src/project/manifest.ts`, `.tsx` or `.js`, `project/manifest.ts` or `.js`, or `manifest.ts`, `.tsx`, `.js` or `.mjs`. It exports a named `project` or a default Project object implementing the existing scene interface. Use `--demo` to render the bundled example from any directory. The CLI does not silently substitute the demo when a project is absent.

External scenes can import the public engine API and types from `ritween`; the CLI resolves that name to its own engine during browser compilation. Relative scene imports and Vite resource imports such as `./effect.wgsl?raw` work. Project `public/` assets are served when selecting a project directory. Package imports used by a project's scenes must be installed in that project; the CLI does not install arbitrary dependencies. Source code is executed as trusted application code. The CLI supplies its own Vite configuration and does not load a project's Vite plugins/configuration.

```ts
import type { Project, Scene } from "ritween";
// Create your scene factories and export a Project; see AI_AUTHORING.md.
```

Web preview binds only to `127.0.0.1`, defaults to port 5173, and reports the actual URL if that port is busy. `--port 0` chooses an available port. Imported source changes trigger state-preserving HMR; public assets may trigger an automatic page reload. Ctrl+C closes the server. Frame and export commands start a temporary private server and headless browser, save the result and close both automatically.

## Studio export jobs and temporary files

With `ritween preview`, clicking **Export Video** submits a backend-owned job.
A separate headless Chrome/Chromium renders and encodes the MP4; the Studio tab
only follows status and downloads the result. Refreshing or closing the tab does
not cancel the job. Reopening the same running server restores progress through
an event stream, including stages, frame counts, elapsed time, and a throughput-based
ETA when available. The last rendered frame is not completion: progress stays below
100% until encoding, muxing, and file saving finish.

- One job renders at a time, with at most three preparing, queued, or running jobs
  per server. The Studio pauses preview playback during export.
- Each job bundles its source modules and captures the submitted project settings.
  Large `public/` media is read from the project rather than copied; do not replace
  or delete those files until export finishes.
- Chrome is required on the server machine, using the selected `--channel` or
  `--browser`. Studio exports have no render time limit by default; an explicit
  `--timeout SECONDS` bounds each headless render, not queueing or source bundling.
  Browser startup still has its own 120-second limit.
- Results are temporary under `~/.ritween/exports/<manifest-path-hash>/session-*`.
  The **Exports** tab lists jobs, file sizes, download links, cancellation, and deletion.
  Completed videos are limited to 4 GiB total and history to 50 job records per
  server session. Delete older entries to free capacity; existing videos are never
  silently evicted to make space for a new result. Source bundles, browser download
  staging, and a running partial output can temporarily use additional disk space.
- Ctrl+C or SIGTERM cancels active work and deletes that server session's managed
  files, including recovered artifacts. Download videos you want to keep before
  stopping. Copies already saved elsewhere are not deleted.
- After a crash, SIGKILL, or power loss, completed files still present on disk are
  discovered the next time preview starts for the same manifest path. They can be
  downloaded or deleted in Studio. Unfinished jobs become interrupted; encoding
  does not resume. Files belonging to another live server are left alone.

This isolates export from the user's Studio tab; it does not guarantee lower total
RAM/GPU usage or prevent system-wide resource exhaustion. The MP4 muxer still
buffers encoded samples in the headless browser. The control API is local,
same-origin, and intended for trusted projects, not a public multi-user render
service. A static Studio deployment without the backend cannot submit these jobs
and does not fall back to encoding in the user's tab.

## Imported video activation

Preview, frame, and export accept `--media-activation eager|active-only`.
The default remains `eager`. `active-only` opens built-in video scenes only when
an asynchronous frame needs them, releasing the previous scene's video texture,
decoder, and encoded-data owner before activating the next scene. Returning to a
scene reopens it; there is no prefetch, so scene boundaries can stall.

This option is independent of `--media-loading full|range`. Images and custom
scenes retain eager setup and their existing rendering contracts. Linked audio
preparation is unchanged and may still load future footage: this is not lazy
loading of the entire project. The shared 64 MiB media-texture budget is unchanged.

```sh
ritween frame /path/to/project --media-activation active-only --time 1.25 -o still.png
```

## Imported media loading

Preview, frame, and export accept `--media-loading full|range`. The default is
`full`; `range` opts into bounded HTTP Range loading for imported MP4 video and
linked AAC audio. Standalone audio loading is unchanged.

```sh
ritween preview /path/to/project --media-loading range
ritween frame /path/to/project --media-loading range --time 1.25 -o still.png
ritween export /path/to/project --media-loading range -o final.mp4
```

The CLI initializes the selected mode before studio or renderer modules run.
Range loading requires a strong ETag and valid partial responses; unsupported
servers use a bounded full-resource fallback. The per-asset limit remains
128 MiB. Range can reduce startup downloads for large footage, but may be slower
for short files on high-latency connections, so it is not the default.

JSON results include `mediaLoading`. Frame/export results also include
`mediaRequests`: counts of MP4 responses to Range requests, partial (`206`)
responses, and full (`200`) responses. These are response counts, not transferred
bytes or a guarantee that every asset used incremental loading.

## Output and automation

- `frame`: native WebGPU OffscreenCanvas → PNG via `convertToBlob`, at the project base resolution unless overridden with `--resolution WIDTHxHEIGHT` or 360p/720p/1080p. This is a single-image operation, not a screenshot-based video export.- `export`: the existing OffscreenCanvas → VideoFrame → H.264 VideoEncoder pipeline, plus a 48 kHz AAC mix from the project's audio tracks, written by the custom MP4 muxer. `360p`, `720p`, and `1080p` are only 640×360, 1280×720, and 1920×1080. Any other aspect uses even `WIDTHxHEIGHT` with the same aspect as the project. 9:16 full HD is `1080x1920`. Steps use a short side of 360, 720, or 1080 when the frame fits H.264 Level 4.2. Omitting `--resolution` exports the short-side 720 step at 30 FPS, which is not full HD. A mismatched aspect is an error. All frames are evaluated deterministically at frameIndex/FPS. A project with no audio tracks stays video-only. `frame` does not render audio.
- Output defaults to `frame.png` for frames, or a filename derived from the manifest's `project.name` for MP4 exports (for example, `Source to motion` → `source-to-motion.mp4`), in the invoking directory. Studio downloads use the same MP4 naming rule. Names are lowercased, separators and unsafe characters become hyphens, Unicode letters are preserved, and empty names fall back to `video.mp4`. Pass `-o` or `--output` to override the CLI output path. Parents are created automatically. PNG and MP4 extensions are enforced. An existing output fails unless `--force` is provided. Rendering happens before committing the completed output; a failed render does not replace an existing file.
- `--time` is in seconds, between zero and composition duration inclusive. `--frame` is a nonnegative, zero-based index divided by `--fps`; it cannot be combined with `--time`.
- Interactive exports update two lines on stderr: an adaptive progress bar with its percentage, followed by readable active stages, frame counts, elapsed time, and encoding speed/ETA when space permits. Narrow terminals shorten the bar and reduce the detail line rather than hiding the bar. The terminal cursor is hidden while progress is active; both lines are cleared and the cursor is restored on completion, failure, or cancellation. Audio and video stages can overlap. ETA estimates the remaining video frames, not audio completion, muxing, or file saving; 100% frames still requires finalization. The successful summary appears on stdout only after the output file is saved. Redirected output uses plain stage lines and ten-percent frame milestones without terminal control sequences.
- `--json` emits one successful result object on stdout. Export progress is JSON Lines on stderr, followed by a result including output path, dimensions, FPS, frames, duration, bytes and elapsed seconds. Errors emit an `event: "error"` object on stderr and exit nonzero. Web preview emits its URL and remains running.
- Exit codes: 0 success, 1 error/timeout, 130 cancelled frame/export. Ctrl+C on an idle web preview exits 0. `--timeout 120` bounds headless startup/render/export; browser resources are closed on timeout or interruption. Elapsed CLI time includes server/browser startup, rendering and file saving, unlike the earlier export-only benchmark.
- `--channel chrome` is the default. Use `--channel msedge`, `--channel chromium` with an installed Playwright Chromium, or `--browser /absolute/path/to/chrome`. Native WebGPU and H.264 capability errors are surfaced; no alternative multimedia renderer is substituted.

## Layout inspection

```sh
ritween inspect --project /path/to/project --time 1.5
ritween inspect . --time 1.5 -o artifacts/inspect.json --force
ritween inspect --project /path/to/project --time 1.5 --target scene:main#card --fail-on error
```

`inspect` renders one frame through the same engine as `frame` and prints a JSON layout snapshot to stdout. Logs go to stderr; `-o/--output` writes the same document to a `.json` file instead. Project discovery is the same as every other command (a directory, a manifest module, or the current directory), and a finite `--time` is required because a defaulted `0s` would be a guess. Time and frame-index validation match `frame` exactly: a time beyond the composition duration, or a frame index at that endpoint, is rejected rather than clamped. `--frame`/`--fps` work as they do for `frame`.

The document contains `schemaVersion` (`2`; consumers must reject any other version, and schema 1 is not accepted as an alias), `packageVersion`, the project identity, `time.requested` and `time.effective`, a `capability` block, one entry per inspected scope, and a flat `diagnostics` array. Each scope carries its `id`, `name`, `clock` (`time` = project clock, `localTime` = scene-local clock, `progress`), its `spaces`, the placed layout `tree`, paint `commands`, optional `paintRecords` and `finalPaintRecords`, `finalProjection`, and the unchanged legacy `warnings` strings.

Scopes are `scene:<entry id>` plus the persistent project `overlay`; node `id`s repeat across scopes and are only unique inside one scope. `spaces` is that scope's typed space descriptors, not a list of legacy space-name strings. Each descriptor has `id`, `kind` (`layout`, `clip-local`, `world`, `composition-overlay`, or `unavailable`), `parent`, and `mapping`. `parent` is `{status:"known",id}` or `{status:"unavailable",reason}`. The `layout` descriptor is the scope root. Its parent is `{status:"unavailable",reason:"scope layout root"}`, not a path parse. A known parent `id` names another descriptor in the same scope. Descriptors are the only `spaces` shape; schema 1's string list is not an alias. A composition overlay descriptor is not the project overlay scope. Node and diagnostic `space` values stay strings; an absent node `space` means that frame's `layout` space. `tree.path` values stay exactly as authored, relative to the node's `space`, so legacy paths are unchanged. A nested Composition stamps its own scoped `space` string on its tree and diagnostics, and deeper nesting extends that prefix instead of overwriting it. A diagnostic's `(space, path)` therefore names the same node as the tree. Kind and parent come from the descriptor fields, not from the id text.

A world descriptor whose evaluated camera is known publishes `mapping: {status:"mapped", kind:"world-to-composition-viewport", source:"evaluateCamera", precision:"binary64-evaluated", matrix}`. That matrix is the camera `evaluateCamera` returned when the composition mounted: binary64 evaluation, **not** a GPU uniform and **not** a raster capture, so it can differ from the float32 matrix the renderer uploads. A non-finite camera publishes the `unavailable` variant of the same shape with a `reason` and no matrix. Every other descriptor keeps `mapping: {status:"unavailable",reason:"not a captured GPU uniform; no layout affine is published"}` and has no matrix.

`frameOccurrences` and `surfaceOccurrences` are separate per-scope collections. Both are **absent** when the provider did not collect them and `[]` when collection found nothing — never treat a missing collection as empty.

- `frameOccurrences` is one record per renderer visit in that snapshot: the root, each World, each composition overlay, each Group, and each Clip. `id` is a counter local to one root render, allocated in visit order and separate from node and command ids. `layoutSpace` is `{status:"known",id}` or `{status:"unavailable",reason}`; the id is created when that frame is placed, not parsed from a path or inferred from a matrix. `targetResolution`, `designSize`, and the integer `scissor` describe the target that visit drew into. `parentSurface` is `{status:"known",occurrenceId}` when the visit rendered into a tagged surface, and the root visit reports `unavailable` with a reason. `baseFrameTransform` is `{status:"mapped", source:"computeFrameTransform", precision:"binary64", matrix}` from that render call's own `computeFrameTransform`, or `unavailable` with a reason; it is the pre-correction design/camera mapping, not an upload. `drawCameras` lists only commands that really drew, each with `commandId`, `ownerNodeId`, and `camera` copied from the float32 uniform row **after** it was written, as `{status:"mapped", source:"uploaded-uniform", precision:"float32", matrix}` or `unavailable`. That camera already contains the shared correction chosen for that command. A World and the overlay of the same composition may share one physical target and still get different frame ids, layout spaces, and transforms.
- `surfaceOccurrences` is one record per drawn tagged surface. `occurrenceId` is the **evaluation command id**, marked by `occurrenceIdKind: "evaluation-command"`; it is not a frame occurrence id. Each record also carries `ownerNodeId`, `path`, `surface` (`{kind:"clip",shape}`, `{kind:"group"}`, or `{kind:"composition"}`), `childResolution`, `parentResolution`, the copied float32 `uniform`, the integer `childScissor` when the child render set one, `parentOccurrenceId` when nested in another tagged surface, `parentFrameOccurrenceId` for the frame that drew it, and `worldFrameOccurrenceId`/`overlayFrameOccurrenceId` for the frames that rendered into it. `projection` is the existing resolver's result: `childPixelsToParent`, `parentToScene`, and `childPixelsToScene` when `mapped`, otherwise `unavailable` with a reason. Zero and singular matrices are valid and published; no inverse is computed. A surface drawn into an untagged parent reports `unavailable` rather than inventing a scene chain.

These collections are metadata, not raster evidence. Keep the three precisions apart: `spaces[].mapping.matrix` and `baseFrameTransform` are binary64 **evaluated** mappings from the camera and frame transform; `drawCameras[].camera.matrix` and `surfaceOccurrences[].uniform` are the float32 values actually **uploaded**; neither is raster coverage. Coverage is still unavailable: a shader's fragment output, a custom transition shader, image or path mask pixels, occlusion by unrelated opaque siblings, clamp-to-edge sampling, and GPU rounding are not published. `projection` and `baseFrameTransform` are ideal affine mappings; they do not model those either. Frame and surface ids are scoped to one snapshot and are never compared across CLI runs, targets, or processes. Every published number is finite; a non-finite value is unavailable rather than `NaN`/`Infinity`. A frame or surface collection longer than 1,000,000 entries is rejected before any index getter runs, and only records that are actually published are charged to the byte budget.

Node `id` is the author-declared `ViewNode.id()` value. Anonymous nodes have no `id` and their synthetic path segments (`box[0]`) are never treated as identifiers.

`paintRecords` are ideal pre-transition Box, Text, and Media draw quads in `scene-target-pixels`. `finalPaintRecords` are those leaves projected into `output-pixels` when `finalProjection.status` is `available`. Both are ideal quads, not mask pixels, occlusion, clamp-to-edge sampling, or fragment coverage. Built-in and direct transitions publish recorded-leaf output quads. Custom transition output stays unavailable, while pre-transition records remain. A recorded project overlay is identity in output pixels on the project clock and is not mixed by the scene transition. `capability.geometry.paint` is always `partial`, including when a scene publishes no recorded output; it has no `unavailable` state. `capability.transitions.projection` is separate: `partial` when any published retained scene has `finalProjection.status` of `available`, otherwise `unavailable`. A `--target` republishes that projection value from the retained scene alone. Use `--rules PATH` to evaluate explicit G4 assertions on the complete snapshot.

Diagnostics carry a stable `code` (`offered-size-overflow`, `fixed-allocation-deficit`, `unavailable-inspection` today), `severity`, `scope`, optional node `id`, exact `path`, `clock.local`/`clock.project`, `space`, `message`, and numeric `bounds` plus `excess`/`deficit` where they apply. They are authored where the layout conflict is detected, not parsed back out of warning strings.

The output is a whitelist of metadata: no GPU textures, media sources, image bitmaps, draw outlines, or text runs. Non-finite geometry is a hard error. Output over 64 MiB of UTF-8 fails with advice to narrow the target instead of truncating, and the size is measured during traversal so an oversized frame fails before its full JSON is allocated. A scene whose metadata throws while being read — a hostile getter, proxy or malformed tree — is published as unavailable with that reason, never as an empty tree and never as a failed run. `capability.geometry.layout` is `exact-rectangle`.

`--target SCOPE#ID` matches the authored node ID inside one scope and keeps only that node's ancestor chain, its own subtree, and the commands, warnings and diagnostics belonging to retained nodes. Everything else is dropped, so the narrowed payload is genuinely smaller; errors inside the retained subtree are still reported, so `--fail-on error` cannot miss one that is displayed. A missing target, an ambiguous ID, or an anonymous node fails.

`--fail-on error` exits 1 when any diagnostic has severity `error`; plain diagnostics never change the exit code. File output is atomic: the bytes land in a sibling temp file, the cancellation check runs immediately before the commit, and publication is a single rename (or a no-replace link without `--force`). A failed or cancelled write therefore never exposes a partial file and never destroys an existing one.

Exit codes: 0 successful inspection, 1 runtime, selected-diagnostic, or requested rule failure/indeterminate result, 2 malformed command or rules input. Rules files are limited to 1 MiB UTF-8 and 10,000 rules. `--rules` cannot be combined with the tree-pruning `--target` option.

```sh
ritween inspect --project ./manifest.ts --time 2 --rules ./rules.json
```

Rules use schema version 1 and are returned as `ruleResults` beside the inspection metadata. See [authoring rules](docs/authoring.md#assertions-and-safe-areas) for schema, geometry accuracy and temporal scope. An inactive temporal rule is `not-applicable`, never a successful check. A single inspect invocation checks only its requested time.

## Validation

```sh
npm test
npm run build
npm run test:cli
npm run test:preview-exports
```

`CLI_BINARY=/path/to/ritween npm run test:cli` runs the same suite against an installed `ritween` command instead of `node bin/ritween.mjs`. `test:preview-exports` also accepts `CLI_BINARY` and checks real Studio submission, no tab-side encoder creation, refresh/tab closure, playable MP4 download, crash recovery, deletion, cancellation, queue reuse, and graceful cleanup. It writes screenshots and media under `artifacts/preview-exports/`.

The CLI integration suite invokes commands from outside the repository, checks PNG dimensions and deterministic frame equivalence, renders an independent external TSX manifest with a JS scene, checks invalid timestamps and overwrite protection, tests timeout cleanup and web preview shutdown, and exports an eight-second 240-frame MP4 that is opened and sought using native Chrome playback. It writes artifacts under `artifacts/cli/`. The browser engine validation (`npm run test:browser` with Vite running) additionally decodes all 240 frames.

## Export compression

```bash
ritween export ../video9 --resolution 1080x1920 --fps 60 \
  --bitrate 6000000 --keyframe-interval 2 --latency-mode quality \
  -o video.mp4
```

Exports default to quality-mode variable bitrate and two-second GOPs, with keyframes also requested at scene cuts. Automatic bitrate scales with pixels and FPS: 6 Mbps at Full HD 60 FPS, 3 Mbps at Full HD 30 FPS, minimum 500 kbps. Omit `--bitrate` to use Auto. The value is integer bits/second, not Mbps or a hard file-size limit. `--latency-mode realtime` explicitly prioritizes low latency; it does not guarantee faster total export. `--keyframe-interval` accepts positive seconds up to 60; actual requests are rounded down to whole frames (minimum one frame). These flags apply to `export` only. JSON results include the resolved encoding settings.

MP4 contains Baseline H.264 I/P frames and optional AAC, with actual sync samples and fast-start metadata. The exporter validates sample order and count, and rejects missing/reordered frames instead of silently producing an invalid timeline.

## Content-driven authoring workflow

Follow the [nine-step public workflow](skills/ritween/references/layout-validation.md).
Confirm public exports/types, enumerate states/content variants/motion boundaries,
build a spacing/typography skeleton, inspect scoped real-font geometry, run rules at
every authored sample, render all-state contact sheets and visually review them, then
test forward/backward ABA in one renderer. Export only after repairs or an explicit
named operator exception. Report measured compliance separately from subjective
design quality and unsupported checks. A single `inspect` is not schedule coverage;
separate `frame` processes are not same-renderer seek evidence.

The packaged `examples/content-layout` includes a realistic example, rules and a
shared evaluation brief. Its README documents the skill runner: replace only the CLI
executable for local/installed evaluation, preserve cwd/arguments and assertions, and
select an isolated tarball installation on PATH (never implicit installs or global links).
