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

- `frame`: native WebGPU OffscreenCanvas → PNG via `convertToBlob`, at the project base resolution unless overridden with `--resolution WIDTHxHEIGHT` or 360p/720p/1080p. This is a single-image operation, not a screenshot-based video export.
- `export`: the existing OffscreenCanvas → VideoFrame → H.264 VideoEncoder pipeline, plus a 48 kHz AAC mix from the project's audio tracks, written by the custom MP4 muxer. `360p`, `720p`, and `1080p` are only 640×360, 1280×720, and 1920×1080. Any other aspect uses even `WIDTHxHEIGHT` with the same aspect as the project. 9:16 full HD is `1080x1920`. Steps use a short side of 360, 720, or 1080 when the frame fits H.264 Level 4.2. Omitting `--resolution` exports the short-side 720 step at 30 FPS, which is not full HD. A mismatched aspect is an error. All frames are evaluated deterministically at frameIndex/FPS. A project with no audio tracks stays video-only. `frame` does not render audio.
- Output defaults to `frame.png` for frames, or a filename derived from the manifest's `project.name` for MP4 exports (for example, `Source to motion` → `source-to-motion.mp4`), in the invoking directory. Studio downloads use the same MP4 naming rule. Names are lowercased, separators and unsafe characters become hyphens, Unicode letters are preserved, and empty names fall back to `video.mp4`. Pass `-o` or `--output` to override the CLI output path. Parents are created automatically. PNG and MP4 extensions are enforced. An existing output fails unless `--force` is provided. Rendering happens before committing the completed output; a failed render does not replace an existing file.
- `--time` is in seconds, between zero and composition duration inclusive. `--frame` is a nonnegative, zero-based index divided by `--fps`; it cannot be combined with `--time`.
- `--json` emits one successful result object on stdout. Export progress is JSON Lines on stderr, followed by a result including output path, dimensions, FPS, frames, duration, bytes and elapsed seconds. Errors emit an `event: "error"` object on stderr and exit nonzero. Web preview emits its URL and remains running.
- Exit codes: 0 success, 1 error/timeout, 130 cancelled frame/export. Ctrl+C on an idle web preview exits 0. `--timeout 120` bounds headless startup/render/export; browser resources are closed on timeout or interruption. Elapsed CLI time includes server/browser startup, rendering and file saving, unlike the earlier export-only benchmark.
- `--channel chrome` is the default. Use `--channel msedge`, `--channel chromium` with an installed Playwright Chromium, or `--browser /absolute/path/to/chrome`. Native WebGPU and H.264 capability errors are surfaced; no alternative multimedia renderer is substituted.

## Validation

```sh
npm test
npm run build
npm run test:cli
```

`CLI_BINARY=/path/to/ritween npm run test:cli` runs the same suite against an installed `ritween` command instead of `node bin/ritween.mjs`.

The CLI integration suite invokes commands from outside the repository, checks PNG dimensions and deterministic frame equivalence, renders an independent external TSX manifest with a JS scene, checks invalid timestamps and overwrite protection, tests timeout cleanup and web preview shutdown, and exports an eight-second 240-frame MP4 that is opened and sought using native Chrome playback. It writes artifacts under `artifacts/cli/`. The browser engine validation (`npm run test:browser` with Vite running) additionally decodes all 240 frames.

## Export compression

```bash
ritween export ../video9 --resolution 1080x1920 --fps 60 \
  --bitrate 6000000 --keyframe-interval 2 --latency-mode quality \
  -o video.mp4
```

Exports default to quality-mode variable bitrate and two-second GOPs, with keyframes also requested at scene cuts. Automatic bitrate scales with pixels and FPS: 6 Mbps at Full HD 60 FPS, 3 Mbps at Full HD 30 FPS, minimum 500 kbps. Omit `--bitrate` to use Auto. The value is integer bits/second, not Mbps or a hard file-size limit. `--latency-mode realtime` explicitly prioritizes low latency; it does not guarantee faster total export. `--keyframe-interval` accepts positive seconds up to 60; actual requests are rounded down to whole frames (minimum one frame). These flags apply to `export` only. JSON results include the resolved encoding settings.

MP4 contains Baseline H.264 I/P frames and optional AAC, with actual sync samples and fast-start metadata. The exporter validates sample order and count, and rejects missing/reordered frames instead of silently producing an invalid timeline.
