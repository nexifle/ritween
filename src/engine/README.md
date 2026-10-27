# Engine: rendering and export

Rendering produces pixels. Codecs turn those pixels or mixed audio into encoded
samples. Format implementations orchestrate tracks and package the result. Keep
these responsibilities separate so a new output format does not change the GPU
renderer or the existing MP4 path.

```text
render/
  renderer.ts              GPU scene rendering, shared by preview and offline output
  frame-source.ts          Offline canvas lifecycle and GPU completion
export/
  types.ts                 Existing MP4 export options and stage callbacks
  stage.ts                 Stage start/completion notifications
  pipeline.ts              Parallel/sequential jobs, cancellation and cleanup
  encoder-queue.ts         WebCodecs backpressure
  settings.ts              Video encoding controls and validation
  codecs/
    aac.ts                 AAC encoding and priming constants
    h264.ts                AVC encoding into an EncodedVideoSink
  formats/mp4/
    export-mp4.ts           MP4 orchestration and codec capability checks
    muxer.ts               ISO BMFF container writer
    sizes.ts               MP4/H.264 export presets and size constraints
```

## Entry points

The package exports `Renderer`, `FrameSource`, and `exportMp4`. `exportVideo` is
an alias of `exportMp4`, preserving the existing SDK behavior and result shape.
The original flat engine modules remain compatibility re-exports; add new
implementation code under the directories above. Internal callers should use
the canonical paths rather than the compatibility modules.

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
