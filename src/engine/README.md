# Engine: rendering, codecs, and media

Built-in video scenes support the CLI opt-in `--media-activation active-only`
(default: `eager`). Inactive videos retain lightweight scene state only; the
renderer releases their media before preparing the next scene. Frame preparation
stays ordered for export. Images, custom scenes, and audio keep their existing
contracts. See [activation details](../../CLI.md#imported-video-activation).

Rendering produces pixels. Codecs turn those pixels or mixed audio into encoded
samples. Format implementations orchestrate tracks and package the result. Keep
these responsibilities separate so a new output format does not change the GPU
renderer or the existing MP4 path.

```text
codecs/                    Shared codec definitions; no rendering/export dependencies
  aac.ts                   AAC-LC constants and decoder configuration
  h264.ts                  AVC codec strings and decoder configuration
  hevc.ts                  HEVC configuration validation and codec strings
  av1.ts                   AV1 configuration validation and codec strings
decode/                    Encoded input → decoded frames / PCM
  formats/mp4.ts           Defensive MP4 demuxing and input validation
  audio-file.ts            Audio decode scheduling and PCM placement
  video-resource.ts        Video decode scheduling, seeking and frame ownership
render/                    Decoded media + scenes → pixels / mixed audio
  renderer.ts              GPU scene rendering for preview and offline output
  frame-source.ts          Offline canvas lifecycle and GPU completion
  visual.ts                Media textures and footage scenes
  audio.ts                 Offline audio rendering and preview audio transport
  live-mix.ts              Shared audio graph scheduling and resource limits
media/                     Shared asset/project integration, not a decoding layer
  resource.ts              Asset fetching, cancellation and caching
  byte-range.ts            HTTP Range and resource version validation
  byte-source.ts           Shared ownership and cross-resource byte LRU
  mp4-metadata.ts           Header/moov reads without downloading the entire mdat
  project.ts               Media clip validation and footage audio track mapping
export/
  types.ts                 Existing MP4 export options and stage callbacks
  stage.ts                 Stage start/completion notifications
  pipeline.ts              Parallel/sequential jobs, cancellation and cleanup
  encoder-queue.ts         WebCodecs backpressure
  settings.ts              Video encoding controls and validation
  encoders/
    aac.ts                 PCM → AAC samples
    h264.ts                Rendered frames → AVC samples via EncodedVideoSink
  formats/mp4/
    export-mp4.ts           MP4 orchestration and codec capability checks
    muxer.ts               ISO BMFF container writer
    sizes.ts               MP4/H.264 export presets and size constraints
```

## Entry points

The package exports `Renderer`, `FrameSource`, and `exportMp4`. `exportVideo` is
an alias of `exportMp4`, preserving the existing SDK behavior and result shape.
Import implementations directly from the directories above. There are no flat
compatibility modules; public SDK exports are declared in `src/index.ts`.

## Codec boundaries

Both import and export use `codecs/`. Shared codec modules describe the supported
bitstream and build decoder configurations without depending on the container or
export pipeline. Encoder implementations live in `export/encoders/`, while
`decode/` owns decode scheduling, seeking, cancellation, and output lifetime.
Input container parsing lives in `decode/formats/`; output muxing lives in
`export/formats/`. MP4 input supports H.264 (`avc1`/`avc3`), HEVC
(`hvc1`/`hev1`), AV1 (`av01`), and optional AAC-LC. Decoder configuration preserves
its input codec; actual availability is checked through WebCodecs on the current
browser/device. AV1 samples carry their sequence headers; its container `av1C`
record is validated but is not passed as AVC/HEVC decoder extradata. Export
remains H.264/AVC with optional AAC-LC; no new encoders or runtime dependencies
are added.

Input remains non-fragmented, unencrypted, and limited to two media tracks with
one description each. Both full and metadata-only parsing accept `stsz` or
compact `stz2` sizes and validate `sdtp` without replacing `stss` sync flags.
AAC `roll`/`prol` descriptions (`sgpd` v0/v1/v2, `sbgp` v0/v1) support backward
or zero recovery distances. Audio decoding always submits samples from the
track start through the clip end, so those dependencies are already included;
PCM trimming and edit-list mapping remain unchanged. Positive recovery distances,
unknown/video sample groups (including encryption groups), malformed indexes,
and unsupported transforms still fail explicitly.

Dependency direction is `export → render → decode → codecs`, with shared
`media/` integration available where needed. Decode must not import rendering
or export, rendering must not import export, and codec definitions must not
import any of these layers. `tests/engine-boundaries.test.ts` checks these direct
import boundaries. Project types, timeline, and project settings remain shared
at the engine root.

## Adding another output format

1. Add a format entry point under `export/formats/<format>/`. Define its own
   options and validation; `ExportOptions` currently describes the MP4 path.
2. Use `FrameSource.create(project, { width, height, signal })` for offline
   pixels. Await `source.render(time)` and consume the returned canvas before
   requesting another frame: all frames reuse the same canvas. Dispose the
   source in `finally`. FrameSource does not require WebCodecs.
3. Reuse `frameCount` and `frameTiming` from `timeline.ts` to preserve the export
   clock. Add format-specific timing conversion where necessary.
4. Reuse a codec only when the format supports it. For example, GIF needs its
   own palette/encoding and frame-delay handling, without AAC or the H.264
   dimension constraints. H.264 emits samples to a sink without importing MP4.
5. Keep format-specific setup, muxing, and result metadata in the format entry
   point. Use the pipeline helper for concurrent tracks when applicable.
6. Export the new entry point from `src/index.ts`, then connect CLI and preview
   controls. Add format behavior tests and real browser export validation.

No dynamic plugin registry is needed for one implemented format. Introduce a
registry when runtime format discovery becomes an actual requirement.

## Resource ownership

The caller of `FrameSource.create` owns its disposal. Codecs own native encoders
and close each submitted AudioData/VideoFrame in `finally`. Encoder queues are
bounded. MP4 owns the encoded sample buffers passed to its muxer. The pipeline
waits for both jobs to clean up and preserves the first failure or cancellation
reason before returning. Stage completion callbacks run even when a stage fails.

Imported video builds a PTS/keyframe index once per resource. Tracks with strictly
increasing microsecond PTS use persistent decoding when twelve source-sized RGBA
frames fit within 96 MiB. Sessions read at most eight samples beyond the target,
retain at most twelve frames / 96 MiB estimated RGBA bytes, and restart on backward
seeks or incompatible discontinuities. Reordered tracks and larger frames use
random-access decoding. A sequential failure releases the session and retries via
random access; codec errors from that path remain visible. These budgets exclude
native decoder memory, caller-owned frame clones, and GPU textures. EOF drains the
decoder; disposal aborts active work and releases retained payload and frames.

`AudioClipSource.dispose()` is optional and runs after source scheduling finishes,
including error/cancellation, in both preview and offline compilation. It releases
source-owned caches, not buffers already owned by scheduled nodes. Existing sources
with only `schedule()` remain supported. AAC preroll is decoded on a non-negative
clock and mapped back to movie timestamps before PCM trimming.
