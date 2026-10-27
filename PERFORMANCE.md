# Managed audio and export performance

Investigated 2026-10-26 on local Chrome/macOS, using `../video9`.

MP4 export already uses memory: WebGPU canvas → VideoFrame → WebCodecs H.264 →
MP4 Blob. PNG conversion belongs only to the single-frame command.

## Diagnosis

The 90-second video9 score creates many oscillators, envelopes and filters. An
eager native graph contains all future voices before offline rendering begins.
Their future automation makes this workload much more expensive than the small
eight-second demo. Audio mixing and AAC also preceded the first video progress
update, making a busy audio renderer look like a stalled export.

The optimization now belongs entirely to Ritween. The earlier project-specific
`host.defer` change was reverted in video9, and that optional API was removed.
Ordinary existing schedules are automatically compiled for preview and export.

## Engine behavior

1. Run `schedule(host)` against a managed context facade. Constructors and the
   corresponding context factories record node descriptions, connections, exact
   automation operations, source starts/stops and decoded buffers. The project
   does not need to provide a scheduler or special voice annotations.
2. Trace source reachability and group independent source subgraphs. Union/find
   classification avoids the previous repeated whole-graph scans per voice.
   Overlapping clusters that cannot be separated keep shared state; effect cycles
   are never duplicated into separate voices. Traversal has an enforced budget.
3. Build shared routing and effects once. Sort voices by start and advance a
   cursor over 500 ms lookahead windows. Offline rendering suspends every 250 ms
   while future voices remain. Every voice replays its original absolute times.
   All native effect state and tails remain throughout the offline render.
4. Cache one successful PCM mix per immutable project object and mute/FPS setting.
   A new project object/HMR invalidates the weak-key cache. Do not mutate a
   project in place after preparing it.
5. Run audio mixing/AAC and WebGPU/H.264 concurrently, then mux once both succeed.
   The API retains `pipeline: "sequential"` for comparison. A failure or user
   cancellation aborts the sibling job and waits for cleanup, including pending
   scene setup. Encode through WebCodecs with bounded queues (`encodeQueueSize` / `dequeue`),
   closing each AudioData/VideoFrame after submission. Flush once at the end.
   UI and CLI show audio mix, AAC, setup, video and mux stages immediately.

Recording sessions are serialized so asynchronous asset decoding cannot race
changes to constructor interception. The facade closes after preparation;
retained hosts, node handles and parameter mutations cannot schedule extra work
later. Unsupported APIs and budget violations reject the schedule with a clip
identifier, rather than falling back to an unbounded native renderer.

## Contract and limits

The authoring contract is in [.grok/skills/ritween/references/audio.md](.grok/skills/ritween/references/audio.md).
`AUDIO_LIMITS` in `src/engine/live-mix.ts` is authoritative.

| Resource | Limit |
| --- | ---: |
| Recorded nodes | 16,000 |
| Connections | 64,000 |
| Automation operations | 200,000 |
| Graph traversal steps | 1,000,000 |
| Source buffers / curve storage | 128 MiB |
| Output PCM | 256 MiB |
| Delay capacity | 30 s per node, 60 s aggregate |
| Async preparation per clip | 30 s |

Scheduled builtin oscillators, buffers, gains, filters, stereo panning, delays,
wave shaping, compression and convolution are supported. Custom worklets, IIR,
3D PannerNode/listener control, and external-context routing are outside the
contract. The compiler rejects unsupported methods/properties. A general
JavaScript program is not sandboxed: an infinite loop or arbitrary external
allocation is still outside these protections. The skill requires finite,
deterministic scheduling and bounded asset work.

PCM remains a full 48 kHz stereo Float32 buffer: about 33 MiB for 90 seconds.
The muxer retains compressed chunks until finalization. Export is memory-based,
but not constant-memory streaming. Very long compositions require an incremental
PCM API and streaming muxer/file sink. H.264 now uses GOP compression (two-second
keyframe interval plus scene cuts) and quality-mode VBR. The export path hands
owned encoded buffers to the muxer without a second sample copy. Metadata
precedes media for progressive playback. These changes reduce output size and
copy overhead but do not make output constant-memory. Historical benchmark
measurements below predate this encoding change.

## Validation and measurements

Measured single runs, not a statistical benchmark:

- Original video9 BGM, first eight seconds: eager native mix 16.67 s; managed
  graph mix 0.503 s, including recording and classification. The original project
  code was unchanged. Maximum PCM difference was 4.47e-8, RMS 2.22e-9.
- Entire original 90-second narration/music/SFX mix: 15.07 s during simultaneous
  demo browser testing; AAC 0.57 s. Event-loop heartbeat delay peaked at 38.4 ms.
- Complete export of unchanged video9: 90 s, 720×1280 at 30 FPS, 2,700 frames,
  completed in 28.95 s including startup and writing the file.
- The original full eager BGM render was interrupted after exceeding a minute.
  There is no completed full-project before/after speedup claim.

Browser regressions compare managed output against an independent eager native
renderer. Boundary notes, shared delay tails, context factories, default filter
parameters, periodic waves, convolution, parameter modulation, curves and
cancellation operations produced sample-identical PCM in the synthetic tests.
Additional checks cover mute, mix-cache reuse, cancellation, callback failure,
unsupported API rejection, node/buffer limits, retained-host rejection and
constructor restoration across concurrent preparations. Real MP4 tests decode
240 demo frames and check audio, seeking and cancellation. These checks do not
prove bitwise identity for every browser, possible graph, or the full video9 PCM.

## Research

- [Web Audio: OfflineAudioContext suspend/resume](https://webaudio.github.io/web-audio-api/#dom-offlineaudiocontext-suspend)
  supports graph changes at scheduled render-quantum boundaries. Lookahead absorbs
  that alignment while original source timestamps and effect state remain.
- [Google: A tale of two clocks](https://web.dev/articles/audio-scheduling)
  explains scheduling against the audio clock with overlapping windows. Export
  uses offline suspension, independent of wall-clock rendering speed.
- [WebCodecs: AudioEncoder](https://www.w3.org/TR/webcodecs/#audioencoder-interface)
  provides pending-queue/dequeue notifications and final flush semantics. Repeated
  flushes are unnecessary for backpressure and can change encoder padding.
- [Google: Audio worklet design pattern](https://developer.chrome.com/blog/audio-worklet-design-pattern)
  describes custom DSP, WASM and ring buffers. Reimplementing native oscillators
  and filters would require validating a new sound engine; graph scheduling
  addresses the measured issue while retaining native DSP.

## Reproduce

```sh
node scripts/diagnose-export.mjs ../video9
node scripts/diagnose-export.mjs ../video9 bgm 8 --compare
node bin/ritween.mjs export ../video9 --resolution 720x1280 --fps 30 -o /tmp/video9.mp4
npm test
# With a demo preview server on localhost:5173:
npm run test:browser
```

The optional seconds argument limits diagnostic PCM length; authored score events
are unchanged. `--compare` uses the test-only `scripts/audio-reference.mjs` eager
renderer and checks maximum PCM difference ≤ 1e-4. It does not disable the managed
compiler in production. Diagnostic output includes per-clip preparation, mixing,
AAC, scene setup, 24 GPU frames and event-loop heartbeat delay.

See [the parallel-versus-sequential benchmark](EXPORT_PIPELINE_BENCHMARK.md) for repeated timing, first-frame latency, audio repeatability, and decoded media checks.
