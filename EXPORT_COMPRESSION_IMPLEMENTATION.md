# GOP export implementation

Implemented 2026-10-27, following [the compression research](EXPORT_COMPRESSION_RESEARCH.md).

The production exporter now encodes Baseline H.264 I/P frames with a two-second GOP and requests additional keyframes at scene cuts. It uses quality-mode VBR and a resolution/FPS-scaled target: 6 Mbps at Full HD 60 FPS, 3 Mbps at Full HD 30 FPS, and a 500 kbps floor. Portrait and landscape use the same pixel budget. Bitrate is a target, not a guaranteed size or quality level.

The SDK `ExportOptions`, CLI and export panel expose bitrate, latency mode and keyframe interval. SDK results and CLI JSON include resolved settings. Explicit controls are validated before encoding work. CLI flags use integer bits/second and seconds; incompatible commands reject export-only flags. Defaults keep existing calls working.

The existing muxer now stores actual sync-sample indices, accepts delta frames after the initial keyframe, and verifies output timestamps against every expected frame. It fails on reordered, duplicate or missing frames rather than silently muxing an incorrect constant-frame-rate timeline. Baseline AVC is retained to avoid B-frame reordering. Final sample count validation remains in the exporter.

The MP4 writer puts `moov` metadata before `mdat` and calculates video/audio offsets in two passes. AAC priming edit lists are retained. Ownership of fresh encoded buffers is transferred to the export muxer, avoiding the prior second sample copy. The default muxer API still copies inputs, protecting other callers from mutation. Blob parts preserve typed-array offsets and lengths.

Output remains memory-based. This implementation does not add HEVC/AV1 encoders, native FFmpeg rendering, a direct-to-disk streaming sink, worker migration, QP controls, or remove GPU synchronization fences. Those are separate follow-up optimizations; the current change addresses the measured compression problem with the existing browser codec and no new dependency.

## Validation

- 30 unit tests pass, including sparse sync-sample tables, fast-start offsets, timestamp-order rejection, safe sample ownership, option defaults/validation and CLI flags.
- TypeScript and production build pass.
- `npm run test:compression` decodes actual AVC/AAC exports at 24, 30 and 60 FPS. It verifies frame count/duration, delta frames, a non-integer-frame scene cut, browser seeking around that cut and near the end, and decoded audio against the cached PCM input.
- Audio pulse comparisons at the beginning, middle and end yield **zero-sample offset** at all three FPS settings; normalized correlation is above **0.9999**. AAC tail padding is bounded to one codec frame.
- `npm run test:export` passes cancellation, sibling failure, GPU cleanup, no mux on failed export, sequential/parallel modes and late-author-error checks.
- `npm run test:cli` passes external project loading, custom bitrate/keyframe flag propagation, actual MP4 playback and seeking, overwrite protection, timeout cleanup, preview source reload and signal shutdown.
- Browser UI validation checks explicit bitrate/interval controls reach the encoder and decodes 240 actual I/P frames, verifies exact duration/timestamps, AAC, native seeking, cancellation, mobile layout and existing managed-audio behavior. Artifacts are under `artifacts/`.

## Full production export: video9

Production CLI, external video9 manifest unchanged, default encoding settings with explicit 1080×1920/60 FPS. Measured once on Apple M1 / Chrome 155.0.8059.86:

- Final audiovisual MP4: **67,063,130 bytes (67.06 MB / 63.96 MiB)**.
- **5400 frames, 90.000 seconds**, 1080×1920 at 60 FPS.
- H.264 Baseline: **5,842,112 bps actual**; AAC-LC: **115,425 bps actual**. Both streams have 90-second presentation duration.
- **39.26 seconds end-to-end**, including startup, audio mixing/encoding, rendering, video encoding, muxing and file save. This is a single run, not a performance guarantee or a controlled before/after benchmark.
- FFmpeg fully decoded both tracks without errors. All **5400 decoded video-frame pixel hashes match the validated research configuration exactly**; this confirms the production muxer preserves those encoded frames, not that compression is lossless relative to the renderer. Details: `artifacts/video9-gop-frame-comparison.json`.
- Native Chrome seeking passed at 0.5, 11.9, 12.1, 25.9, 26.1, 53.9, 54.1 and 89.5 seconds.

Output: `artifacts/video9-gop-1080p60.mp4`. CLI result, independent ffprobe report and seek results: `artifacts/video9-gop-1080p60.json`, `artifacts/video9-gop-1080p60-probe.json`, `artifacts/video9-gop-seeking.json`.

The research sample baseline was all-intra and about 51 Mbps actual; this does not establish the exact percentage saved against the user's missing original 600 MB file. Quality validation is based on the documented renderer snapshots and functional decode/seek/audio checks, not a claim of lossless encoding.

## Usage

```bash
node bin/ritween.mjs export ../video9 \
  --resolution 1080x1920 --fps 60 \
  --bitrate 6000000 --keyframe-interval 2 --latency-mode quality \
  -o video.mp4
```

Omitting the last three encoding flags uses those settings automatically at this resolution/FPS. Default resolution and FPS remain the existing short-side 720 and 30 FPS; choose Full HD 60 FPS explicitly when needed.
