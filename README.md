# Rimotion

A code-first video framework. External AI agents write scene modules and register them in a manifest; the browser evaluates, previews and exports the composition. No chatbot, backend, DOM capture, or multimedia dependencies.

## Run

Requires Node.js 22.12+ (or 20.19+), a current Chrome/Edge with WebGPU and H.264 WebCodecs encoding, and GPU acceleration.

```sh
npm install
npm run dev
```

Open http://localhost:5173. WebGPU needs localhost or HTTPS. Vite hot reloads scene and manifest changes. `npm run build` creates `dist`; `npm run preview` serves that build.

## CLI and standalone executable

```sh
npm run cli -- preview --open
npm run cli -- frame --time 5.2 -o artifacts/frame.png
npm run cli -- export -o artifacts/video.mp4
npm run build:binary
```

The host executable is created under `release/`. It embeds the runtime and dependencies; Chrome remains external. Pass `--project /path/to/project` to render another codebase or `--demo` for the bundled example. See [CLI commands, binary packaging, and automation](CLI.md).

## Use

Play/pause with Space. Seek using the scrubber; step with the transport buttons or arrow keys. The scene timeline is read-only. Choose 360p, 720p or 1080p and 24, 30 or 60 FPS, then Export Video. Default: 720p30. Export progress reports submitted frames; download follows encoder flush and muxing. Cancel discards the partial export. A completed download stays available until the next successful export or page unload.

## Architecture

- `src/engine/types.ts`: reusable Scene, Project, RenderContext and future Compositor contracts.
- `src/engine/timeline.ts`: stateless absolute-time evaluation, frame schedules and manifest validation.
- `src/engine/renderer.ts`: GPU lifecycle and renderer shared by preview and export. Each renderer owns independent scene instances and device resources.
- `src/engine/export.ts`: WebGPU → OffscreenCanvas → VideoFrame → native H.264 VideoEncoder → MP4.
- `src/engine/mp4.ts`: custom video-only ISO BMFF muxer. AVC configuration is preserved in `avcC`; sample sizes, chunk offsets, durations and sync sample tables are written explicitly.
- `src/project/manifest.ts`: the entire composition, independent of the engine.
- `src/project/scenes/`: separate TS, TSX and JS example modules. Fullscreen WGSL shaders render procedural orbital geometry and GPU bitmap lettering.

Export evaluates frame `i` at `i / FPS`. VideoFrame timestamps are rounded microseconds with adjacent durations computed from the next timestamp. MP4 uses FPS as its timescale and one tick per sample, giving exact duration. Every sample is a keyframe; there are no reordered/B frames or audio. This deliberately favors muxer simplicity and seeking over compression. The browser may copy GPU data internally; this implementation makes no zero-copy claim and performs no manual GPU readback for encoding.

See [AI Authoring Guide](AI_AUTHORING.md) to create a different video entirely through source files.

## Validation

```sh
npm test
npm run build
# With npm run dev running and Google Chrome installed:
npm run test:browser
```

`CHROME_CHANNEL` and `BASE_URL` can override the browser channel and server address. The browser test uses actual WebGPU and H.264 encoding. It exports the default eight-second composition, parses its MP4, decodes all 240 samples with native VideoDecoder, verifies exact eight-second media duration, opens the MP4 in a native video element and seeks to 0.5, 5.2 and 7.5 seconds. It also checks identical GPU canvas screenshots when revisiting 5.2 seconds, transport actions, cancellation, browser errors, and mobile overflow. Artifacts are written to ignored `artifacts/` (including the actual MP4 and validation report). Screenshot use is limited to tests; no screenshot enters the export pipeline.

Unit tests cover cut boundaries, scene timing, invalid manifests, frame timing at every supported FPS, MP4 table consistency and rejected muxer inputs. Synthetic sample bytes in unit tests only test box structure; the browser test verifies real encoded media.

## MVP limits

Sequential, gapless, hard-cut scenes only. A Compositor interface reserves a path to rendering active scenes to intermediate textures and blending transitions; overlapping transitions are not implemented. Base preview resolution is specified by the manifest. Export presets are 16:9 and do not implement automatic letterboxing for other project ratios. Projects keep compressed samples in memory; files of 4 GiB or more are rejected. Encoding is asynchronous on the UI thread with bounded queues and cooperative yields, not a worker. Long or GPU-intensive compositions may reduce preview responsiveness during export.

No audio, DOM/HTML rasterization, editor, or automatic TSX-to-GPU conversion. Setup may fetch resources, but rendering must be synchronous and seekable. Use trusted scene code only: scene modules execute as part of the application. GPU/codec availability varies by platform; unsupported configurations display errors rather than substitute a different rendering or recording pipeline.

API references: [WebCodecs AVC registration](https://www.w3.org/TR/webcodecs-avc-codec-registration/), [WebCodecs](https://www.w3.org/TR/webcodecs/), [WebGPU](https://gpuweb.github.io/gpuweb/).

## Export benchmark

Run `npm run benchmark:export` while Vite is running. It benchmarks all nine presets with three runs each after one warm-up and writes timing, throughput, output sizes, and environment details to `BENCHMARK.md` and `artifacts/benchmark-export.json`. See [measured results](BENCHMARK.md). Override `BENCH_REPEATS` to change the run count.
