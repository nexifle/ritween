# Export audio performance

Investigation: 2026-10-26, local Chrome on macOS, using `../video9`.

The MP4 path is already memory-based: WebGPU canvas → VideoFrame → WebCodecs
H.264 → MP4 Blob. PNG conversion is only used by the single-frame command.

## Diagnosis and measurements

`video9` schedules a 90-second synthesizer arrangement with many independent
oscillators, envelopes and filters. Creating the native graph for the entire
arrangement before rendering makes offline DSP expensive, even for the first
seconds of the timeline. The short demo does not expose this workload.

Measured during diagnosis (single runs, not a statistical benchmark):

| Workload | Time |
| --- | ---: |
| Full 90-second narration mix, isolated | 0.40 s |
| Full 90-second SFX mix, isolated | 5.42 s |
| First 2 seconds of BGM, eager native graph | 4.85 s |
| First 2 seconds of BGM, deferred native graph | 0.076 s |
| First 8 seconds of BGM, eager / deferred (concurrent with an export) | 25.24 / 0.338 s |
| Full 90-second combined mix, deferred BGM | 12.05 s |
| Full 90-second AAC encoding, bounded queue | about 0.63 s |
| Complete CLI export, 360×640 / 24 FPS | 20.99 s |
| Complete CLI export, 720×1280 / 30 FPS | 29.49 s |

The eager full BGM render was still running after a minute and was interrupted;
there is no completed full-project before/after speedup claim. Some isolated
measurements ran concurrently, so compare the short controlled PCM comparison
rather than treating these rows as an additive timing breakdown. Complete export
numbers include startup and saving the download. Subsequent encoder changes use
`dequeue` backpressure instead of intermediate flushes; timings above precede
that final change. The final dequeue-based 720×1280 / 30 FPS export completed
in 36.40 s while the eager 8-second comparison ran concurrently. Its 2,700 video
frames and both 90-second streams were checked with ffprobe; ffmpeg decoded the
complete result without errors.

The first two seconds of deferred versus eager BGM had maximum absolute sample
difference 2.24e-8 and RMS difference 1.75e-9. This checks the PCM before AAC;
An additional eight-second comparison had maximum difference 5.96e-8. A native
browser regression with shared delay and notes around suspension boundaries was
sample-identical, and also checked cache reuse, mute, abort and callback failure.
These tests do not prove bitwise identity for the full 90 seconds or all browsers.

## Implementation

- `AudioHost.defer(contextTime, callback)` optionally queues independent voices.
  Events are sorted once, then consumed with a cursor: O(V log V) preparation
  and O(V) dispatch. Offline rendering suspends every 250 ms while future voices
  remain, with a 500 ms lookahead. It follows the offline audio clock, independent
  of wall-clock speed. The existing absolute start times and automation remain.
- Shared routing, feedback, filters and effects are created immediately and stay
  connected throughout. No periodic reset, chunk concatenation, or tail truncation
  is involved. Already-created voices retain their normal native lifecycle.
- The video9 synthesizer helpers use deferred construction when available and
  run immediately for older hosts and the preview recorder. No musical notes,
  effect parameters or durations are changed.
- One successful PCM mix is cached per immutable project object and mute/FPS
  setting. Switching settings replaces that entry; project objects are weak keys.
  HMR creates a new project/module. Do not mutate an existing project in place.
- AAC and video queues use `encodeQueueSize` plus `dequeue`, with final `flush()`
  once per encoder. AudioData and VideoFrame handles are closed after submission.
  Cancellation and codec failure reject a blocked capacity wait.
- UI/CLI report audio mixing, audio encoding, scene setup, video encoding and muxing.
  Preview playback is stopped before export so it does not compete with export.

PCM is still a full stereo 48 kHz Float32 buffer: about 33 MiB for 90 seconds.
The MP4 muxer retains compressed chunks until finalization. This is memory-based,
but not constant-memory output streaming. Very long compositions would benefit
from a streaming muxer/file sink and an explicitly designed incremental PCM API.
The current all-keyframe H.264 muxer also creates relatively large video files.

## Authoring independent voices

```ts
schedule(host) {
  // Create shared buses/effects immediately.
  const bus = new GainNode(host.context, { gain: 0.2 });
  bus.connect(host.destination);

  for (const note of notes) {
    const when = host.at(note.time);
    const schedule = () => {
      const osc = new OscillatorNode(host.context, { frequency: note.frequency });
      osc.connect(bus);
      osc.start(when);
      osc.stop(when + note.duration);
    };
    if (host.defer) host.defer(when, schedule);
    else schedule();
  }
}
```

Callbacks must be synchronous and create independent voice subgraphs. Fetch and
decode assets before registering callbacks. Shared buses must not be deferred;
other voices may need them before their first audible output. Passing an invalid
negative/nonfinite context time rejects export.

## Research and choice of APIs

- [Web Audio: OfflineAudioContext suspend/resume](https://webaudio.github.io/web-audio-api/#dom-offlineaudiocontext-suspend)
  defines render-quantum-aligned suspension and allows graph changes before
  resuming. Lookahead absorbs that alignment while source times remain exact.
- [Google: A tale of two clocks](https://web.dev/articles/audio-scheduling)
  explains overlapping lookahead windows and scheduling against the audio clock.
  Offline export uses scheduled suspensions instead of wall-clock timers.
- [WebCodecs: AudioEncoder](https://www.w3.org/TR/webcodecs/#audioencoder-interface)
  defines encodeQueueSize/dequeue for pending requests and flush for completion.
  Repeated flushes are unnecessary for queue limiting and can change codec padding.
- [Google: Audio worklet design pattern](https://developer.chrome.com/blog/audio-worklet-design-pattern)
  covers custom DSP, WASM, ring buffers and Workers. Those are useful for custom
  processing, but replacing these native oscillators and filters with a custom
  engine would require reimplementing and validating their sound. The measured
  issue here is addressed by graph scheduling, with no extra DSP dependency.

## Reproduce

```sh
node scripts/diagnose-export.mjs ../video9
node scripts/diagnose-export.mjs ../video9 vo
node scripts/diagnose-export.mjs ../video9 sfx
node scripts/diagnose-export.mjs ../video9 bgm 2 --compare
node bin/rimotion.mjs export ../video9 --resolution 720x1280 --fps 30 -o /tmp/video9.mp4
npm test
# With a preview server on localhost:5173:
npm run test:browser
```

The optional seconds argument limits only diagnostic PCM output; all original
score events are still scheduled. `--compare` additionally renders an eager graph
and checks maximum PCM difference ≤ 1e-4. The diagnostic logs per-clip scheduling,
mixing, AAC, setup, 24 GPU frames and event-loop heartbeat delay.
