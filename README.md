# Rimotion

A code-first video framework. External AI agents write scene modules and register them in a manifest; the browser evaluates, previews and exports the composition. No chatbot, backend, DOM capture, or multimedia dependencies.

## Run

Requires Node.js 22.12+ (or 20.19+), a current Chrome/Edge with WebGPU and H.264 WebCodecs encoding, and GPU acceleration.

```sh
npm install
npm run dev
```

Open http://localhost:5173. WebGPU needs localhost or HTTPS. Vite hot reloads scene and manifest changes. `npm run build` creates `dist`; `npm run preview` serves that build.

## CLI

Install the Node executable, then run it from any directory. Node.js 22.12+ (or 20.19+) stays on the machine; Chrome stays external.

```sh
npm install -g rimotion
rimotion preview --open
rimotion frame --time 5.2 -o artifacts/frame.png
rimotion export -o artifacts/video.mp4
```

From this checkout, `npm install -g .` installs the same command. `npm run cli -- <arguments>` runs it without a global install. Pass `--project /path/to/project` to render another codebase or `--demo` for the bundled example. See [CLI commands and automation](CLI.md).

## Use

Play/pause with Space. Seek using the scrubber; step with the transport buttons or arrow keys. The scene timeline is read-only. Choose an export size that keeps the project aspect, and 24, 30 or 60 FPS, then Export Video. The steps use a short side of 360, 720 or 1080 when that frame fits H.264 Level 4.2. On a 16:9 project those sizes are still named 360p, 720p and 1080p. Default: the 720 step at 30 FPS. Export progress reports submitted frames; download follows encoder flush and muxing. Cancel discards the partial export. A completed download stays available until the next successful export or page unload.

## Architecture

- `src/engine/types.ts`: reusable Scene, Project, RenderContext and future Compositor contracts.
- `src/engine/timeline.ts`: stateless absolute-time evaluation, frame schedules and manifest validation.
- `src/engine/renderer.ts`: GPU lifecycle and renderer shared by preview and export. Each renderer owns independent scene instances and device resources.
- `src/engine/audio.ts`: export renders one offline mix with `renderAudio`. Preview records that same clip schedule, then keeps only the notes inside a short lookahead as live nodes. Track mutes are arguments, not a second graph.
- `src/engine/export.ts`: WebGPU → OffscreenCanvas → VideoFrame → native H.264 VideoEncoder, plus AAC from that mix, → MP4.
- `src/engine/mp4.ts`: custom ISO BMFF muxer. AVC configuration is preserved in `avcC`. An optional AAC track stores `esds`, sample sizes, chunk offsets and durations. Video samples stay all-keyframe.
- `src/project/manifest.ts`: the entire composition, independent of the engine.
- `src/project/scenes/`: separate TS, TSX and JS example modules. Fullscreen WGSL shaders render procedural orbital geometry and GPU bitmap lettering.

Export evaluates frame `i` at `i / FPS`. VideoFrame timestamps are rounded microseconds with adjacent durations computed from the next timestamp. MP4 uses FPS as its timescale and one tick per video sample, giving exact duration. Every video sample is a keyframe; there are no reordered/B frames. Audio is a separate timeline: clips live on audio tracks, not inside scenes. Export renders the mix once with `OfflineAudioContext` at 48 kHz and encodes it as AAC. Preview plays the same clips through a lookahead of live nodes, from a user gesture, and does not wait for that offline render. Track mute is part of the exported mix. The preview volume is not. This deliberately favors muxer simplicity and seeking over compression. The browser may copy GPU data internally; this implementation makes no zero-copy claim and performs no manual GPU readback for encoding.

See [AI Authoring Guide](AI_AUTHORING.md) to create a different video entirely through source files.

## Validation

```sh
npm test
npm run build
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

Run `npm run benchmark:export` while Vite is running. It benchmarks all nine presets with three runs each after one warm-up and writes timing, throughput, output sizes, and environment details to `BENCHMARK.md` and `artifacts/benchmark-export.json`. See [measured results](BENCHMARK.md). Override `BENCH_REPEATS` to change the run count.
