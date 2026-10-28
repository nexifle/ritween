# Ritween technical guide

A code-first video framework. External AI agents write scene modules and register them in a manifest; the browser evaluates, previews and exports the composition. No chatbot, backend, DOM capture, or multimedia dependencies.

## Run

Requires Node.js 22.18.0+, a current Chrome/Edge with WebGPU and H.264 WebCodecs encoding, and GPU acceleration.

```sh
npm install
npm run dev
```

Open http://localhost:5173. WebGPU needs localhost or HTTPS. Vite hot reloads scene and manifest changes. `npm run build` compiles the runtime into `dist` and declarations into `types`; `npm run preview` opens the built studio with the bundled demo. The npm package excludes framework sources; Vite compiles only user-authored project modules at runtime.

## CLI

Install the Node executable, then run it from any directory. Node.js 22.18.0+ stays on the machine; Chrome stays external.

```sh
npm install -g ritween
ritween preview --open
ritween frame --time 5.2 -o artifacts/frame.png
ritween export -o artifacts/video.mp4
```

From this checkout, `npm install -g .` installs the same command. `npm run cli -- <arguments>` runs it without a global install. Pass `--project /path/to/project` to render another codebase or `--demo` for the bundled example. See [CLI commands and automation](../CLI.md).

## Use

Play/pause with Space. Seek using the scrubber; step with the transport buttons or arrow keys. The scene timeline is read-only. Choose an export size that keeps the project aspect, and 24, 30 or 60 FPS, choose an automatic or explicit video bitrate, then Export Video. The steps use a short side of 360, 720 or 1080 when that frame fits H.264 Level 4.2. On a 16:9 project those sizes are still named 360p, 720p and 1080p. Default: the 720 step at 30 FPS. Export progress reports submitted frames; download follows encoder flush and muxing. Cancel discards the partial export. A completed download stays available until the next successful export or page unload.

## Persisted project settings

Track mute buttons save to `manifest.settings.json` next to `manifest.ts` (or the
same filename stem for other manifest modules). Commit this file with the project:
preview, CLI exports, and production builds load it automatically. Studio changes
require the development server (`npm run dev` or the CLI preview server); a static
production preview cannot write source files and reports save failures.

```json
{
  "version": 1,
  "audioTracks": {
    "voice": { "muted": true },
    "music": { "muted": false }
  },
  "export": {
    "resolution": [720, 1280],
    "fps": 30,
    "bitrate": "auto",
    "latencyMode": "quality",
    "keyFrameInterval": 2
  }
}
```

Keys are stable track IDs, independent of display names or track order. Omitted
mute values default to audible. Authored defaults can also be supplied as
`project.settings`; the sidecar overrides them per track and per property.
Explicit `false` overrides an authored mute. SDK callers who import a raw manifest
should import the sidecar and use `mergeProjectSettings(project.settings, saved)`
to assign the resulting `settings` before rendering.

Muted tracks are omitted before offline source construction, scheduling, and
mixing. If every track is muted, MP4 output has no audio track. Preview uses live
gain buses for immediate mute/unmute without recompiling audio; master mute and
preview volume remain listening controls and do not affect exports.

Export controls save per property in the same document, preserving audio settings.
Resolution uses `[width, height]`, bitrate uses bits/second or `"auto"`, and
keyframe interval uses seconds. Auto bitrate is recalculated for the chosen size
and FPS. Omitted export properties use framework defaults (short-side 720, 30 FPS,
auto bitrate, quality mode, and a two-second keyframe interval).
CLI export precedence is explicit flags, then project settings, then framework
defaults. `--bitrate auto` explicitly overrides a saved numeric bitrate. Frame/PNG
commands keep their existing resolution and FPS defaults. SDK integrations can use
`projectExportSettings` and `resolveExportRequest` to apply the same precedence.
These choices are project data; they are not stored in localStorage.

The schema, entity policy, disk commands, and studio integration live in
`src/engine/project-settings-schema.js`, `src/engine/project-settings.ts`,
`cli/project-settings.ts`, and `src/preview/state/use-project-settings.ts`.
Audio mute and export controls are implemented. Future scene controls can add their own
`scenes[id]` settings and commands, with separate policies for visibility and
inclusion in the timeline. They must define timing behavior explicitly; audio
mute currently preserves project duration. Writes preserve unrelated fields and
use an atomic replacement; failed saves retain the last saved state in the UI.

## Browser studio preferences

The studio remembers theme, timeline zoom, preview volume/master mute, the Code
view, and the collapsed state of the export/source panels in localStorage under
`ritween-studio-preferences` (version 1). Existing `ritween-theme` values migrate
on first use. Theme is applied before React starts to avoid a color flash.

Divider sizes use the existing `react-resizable-panels:ritween-*` keys, including
the timeline layer-name divider. Desktop rows/columns and the mobile stack keep
separate layouts. Resizing the window does not overwrite user-chosen sizes.
Stored values are validated, and unavailable/full storage leaves controls usable
for the current session.

Preferences belong to the browser origin and are shared by projects opened on
that origin. Playback position, active playback, export jobs, source pinning, and
export results are not restored. Track mute and export options remain project
settings in the source-controlled sidecar, independent of these preferences.

## Architecture

- `src/engine/types.ts`: reusable Scene, Project, RenderContext and future Compositor contracts.
- `src/engine/timeline.ts`: stateless absolute-time evaluation, frame schedules and manifest validation.
- `src/engine/render/renderer.ts`: GPU lifecycle and renderer shared by preview and export. Each renderer owns independent scene instances and device resources.
- `src/engine/render/audio.ts`: export and preview compile the same managed clip schedule. Preview prepares once alongside GPU initialization, then keeps a short lookahead of live nodes. Preview track mutes use gain buses; export omits muted tracks.
- `src/engine/export/formats/mp4/export-mp4.ts`: WebGPU → OffscreenCanvas → VideoFrame → native H.264 VideoEncoder, plus AAC from that mix, → MP4.
- `src/engine/export/formats/mp4/muxer.ts`: custom ISO BMFF muxer. AVC configuration is preserved in `avcC`. An optional AAC track stores `esds`, sample sizes, chunk offsets and durations. Video uses Baseline AVC I/P frames, real sync-sample tables, and fast-start metadata.
- `src/project/manifest.ts`: the entire composition, independent of the engine.
- `src/project/scenes/`: separate TS, TSX and JS example modules. Fullscreen WGSL shaders render procedural orbital geometry and GPU bitmap lettering.

Export evaluates frame `i` at `i / FPS`. VideoFrame timestamps are rounded microseconds with adjacent durations computed from the next timestamp. MP4 uses FPS as its timescale and one tick per video sample, giving exact duration. Video uses a two-second GOP and requests keyframes at scene cuts; Baseline AVC avoids reordered/B frames. Output timestamps are validated before muxing. Audio is a separate timeline: clips live on audio tracks, not inside scenes. Export renders the mix once with `OfflineAudioContext` at 48 kHz and encodes it as AAC. Preview plays the same clips through a lookahead of live nodes, from a user gesture, and does not wait for that offline render. Track mute is part of the exported mix. The preview volume is not. Export defaults to quality-mode VBR, with a target scaled by pixels and FPS (6 Mbps at Full HD 60 FPS; minimum 500 kbps). Targets are not file-size limits. The browser may copy GPU data internally; this implementation makes no zero-copy claim and performs no manual GPU readback for encoding.

See [AI Authoring Guide](../src/project/manifest.ts) to create a different video entirely through source files.

## Validation

```sh
npm test
npm run build
npm run test:preview
npm run test:project-settings
npm run test:studio-preferences
# With npm run dev running and Google Chrome installed:
npm run test:browser
```

`CHROME_CHANNEL` and `BASE_URL` can override the browser channel and server address. The browser test uses actual WebGPU, H.264, and AAC encoding. It exports the default eight-second composition, parses its MP4, decodes all 240 video samples with native VideoDecoder, decodes the AAC track, verifies exact eight-second media duration, opens the MP4 in a native video element and seeks to 0.5, 5.2 and 7.5 seconds. It also checks identical GPU canvas screenshots when revisiting 5.2 seconds, transport actions, cancellation, browser errors, and mobile overflow. Artifacts are written to ignored `artifacts/` (including the actual MP4 and validation report). Screenshot use is limited to tests; no screenshot enters the export pipeline.

Unit tests cover cut boundaries, scene timing, invalid manifests, frame timing at every supported FPS, MP4 table consistency and rejected muxer inputs. Synthetic sample bytes in unit tests only test box structure; the browser test verifies real encoded media.

## MVP limits

Sequential, gapless, hard-cut scenes only. A Compositor interface reserves a path to rendering active scenes to intermediate textures and blending transitions; overlapping transitions are not implemented. Base preview resolution is specified by the manifest. Export sizes keep that aspect: even scales with a short side of 360, 720 or 1080, within H.264 Level 4.2. A size with a different aspect is rejected. There is no letterboxing. Projects keep compressed samples in memory; files of 4 GiB or more are rejected. Encoding is asynchronous on the UI thread with bounded queues and cooperative yields, not a worker. Long or GPU-intensive compositions may reduce preview responsiveness during export.

No microphone input, DOM/HTML rasterization, clip dragging, or automatic TSX-to-GPU conversion. Setup may fetch resources, but rendering must be synchronous and seekable. Use trusted scene code only: scene modules execute as part of the application. GPU/codec availability varies by platform; unsupported configurations display errors rather than substitute a different rendering or recording pipeline.

API references: [WebCodecs AVC registration](https://www.w3.org/TR/webcodecs-avc-codec-registration/), [WebCodecs](https://www.w3.org/TR/webcodecs/), [WebGPU](https://gpuweb.github.io/gpuweb/).

## Export benchmark

Run `npm run benchmark:export` while Vite is running. It benchmarks all nine presets with three runs each after one warm-up and writes timing, throughput, output sizes, and environment details to `BENCHMARK.md` and `artifacts/benchmark-export.json`. See measured results. Override `BENCH_REPEATS` to change the run count.

See export audio performance for profiling, automatic graph scheduling, and memory limits.
See preview startup research and measurements for first-play preparation, idle behavior, and the Web Audio course review.

Audio and video export run concurrently by default. See the pipeline benchmark for the sequential comparison and validation.

### Export encoding controls

```ts
import { exportVideo, type ExportOptions } from "ritween";

const result = await exportVideo(project, {
  width: 1080,
  height: 1920,
  fps: 60,
  bitrate: 6_000_000, // bits/second; omit for resolution/FPS-scaled Auto
  latencyMode: "quality", // default; "realtime" is available for low latency
  keyFrameInterval: 2, // seconds; scene cuts also request keyframes
});
```

Default GOP export preserves resolution, FPS, the mixed AAC soundtrack and its priming edit list. The muxer writes metadata before media for progressive playback and avoids a second sample copy in the export path. Output still retains encoded chunks in memory; it does not yet stream directly to disk. Returned `bitrate`, `latencyMode` and `keyFrameInterval` report resolved settings, not measured bitrate or a guarantee of encoder quality.
