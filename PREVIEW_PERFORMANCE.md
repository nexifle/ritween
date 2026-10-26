# Preview startup and Web Audio research

Investigated 2026-10-26 on local Chrome/macOS with the unchanged 90-second
`../video9` composition, plus the bundled demo. Course pages were fetched as
Markdown through Tinyfish: all 116 lessons across chapters 0–15 were accessible
and reviewed, including their displayed examples. This was a review of the
lesson content, not an inspection or performance benchmark of the deployed demos.

## Diagnosis and decision

Previously, the first Play called `LiveMix.prepare`, recording every clip,
fetching/decoding narration, generating procedural buffers, and classifying
the complete score before playback. The picture intentionally waited for this
work. Replay reused the result, explaining why only the first Play was slow.
Mute settings also invalidated that preparation and reran authored schedules.

The right fit for this engine is early preparation and reuse with native Web
Audio lookahead. Replacing the DSP with AudioWorklet would introduce another
engine and module initialization without eliminating fetch/decode/compilation.
Prerendering the whole composition into PCM would add startup work and memory.

The course's [one-shot](https://bsw.kadcom.dev/webaudio/sampel/one-shot/) and
[drum pad](https://bsw.kadcom.dev/webaudio/sampel/pad-drum/) lessons prepare
expensive buffers once when opening the demo, then reuse them for cheap triggers.
Its [lookahead scheduler](https://bsw.kadcom.dev/webaudio/penjadwalan-waktu/penjadwal-lookahead/)
separates filling the native audio schedule from visual updates. These patterns
apply directly to Rimotion's existing graph compiler.

## Implemented behavior

- Start score preparation alongside WebGPU scene setup. Enable Play after both
  are ready; initialization explicitly says it is preparing picture and audio.
  Download/decode time still exists during loading, before the transport is enabled.
- Keep the context suspended before the first gesture. Call `resume()` inside
  the Play gesture and await its completion before starting the audio clock.
  Suspend after three idle seconds; retain the score and decoded buffers.
- Share in-flight preparation for the same immutable project. Invalidate on a
  different project object, abort on disposal/replacement, and disconnect buses
  after preparation failures or stale completion. Failed preparation can retry.
- Compile all preview tracks once. Smooth separate mute gains instead of
  rebuilding the score or interrupting the transport/effects. Export continues
  to omit muted tracks from its offline mix. Cached source memory is therefore
  bounded by all tracks, including muted ones, and the existing resource limits.
- Sort independent voices by start time and advance a cursor over the 350 ms
  lookahead every 50 ms. Reset on seek, including voices spanning the new offset.
  Replace repeated shared-node array searches with a map. Shared effect routing
  and its native DSP remain intact.
- Memoize the source panel and syntax tokens, stabilize its callbacks, and cache
  ruler calculations. Load the export module only when Export is clicked.
- Silent projects do not create an audio context. Stopped playback has no rAF
  playback loop; idle suspension also stops audio device work.

## Measurements

Single instrumented runs, not statistical benchmarks. The diagnostic runs the
real project schedules in an isolated page, with a real gesture for first Play.
`playMs` ends when the score is armed after context resume. `heardMs` ends when
the latency-adjusted composition clock exceeds 10 ms, sampled by rAF; it is not
a physical microphone measurement or a GPU frame benchmark.

| Operation | Before | After |
| --- | ---: | ---: |
| First Play, `playMs` | 746.6 ms | 19.4 ms |
| First Play, `heardMs` | 823.5 ms | 129.4 ms |
| Replay, `playMs` | 4.9 ms | 5.1 ms |
| Play with first track muted, `playMs` | 80.4 ms | 3.2 ms |
| Play unmuted again, `playMs` | 127.5 ms | 3.0 ms |
| Schedule calls during first Play / replay / mute / unmute | 9 / 0 / 2 / 9 | 0 / 0 / 0 / 0 |
| Explicit preparation before first Play | none | 377.3 ms |

A separate earlier after-change run measured first `playMs` at 13.0 ms and
preparation at 410.7 ms. Differences include browser warmup and scheduling.
The before/after numbers do not establish an improvement in total page-load time.
Preparation overlaps scene setup in the actual preview.

The demo's production initial JS decreased from 388.43 kB / 126.58 kB gzip to
381.87 kB / 124.26 kB gzip despite the new lifecycle logic. Export now has an
8.61 kB / 3.48 kB gzip chunk requested on demand. This is a modest bundle saving;
the main improvement is avoiding audio preparation and static UI work on Play.

This removes the first-play **preparation stall**, not every millisecond of
audio startup. The existing 50 ms scheduling lead protects note scheduling.
Context resume, the browser/output device, and display refresh still introduce
latency. Bluetooth can add more. The course's [latency lesson](https://bsw.kadcom.dev/webaudio/masuk-dan-keluar/latensi/)
and [AudioContext latency documentation](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/baseLatency)
describe why zero physical output latency cannot be guaranteed. The current
latency-sum fallback is retained; output timestamp mapping is a separate possible
clock-accuracy improvement, not necessary to remove the measured preparation stall.

## Full course coverage

Each chapter was reviewed; the following are original summaries of its relevance.

| Chapter | Lessons | Findings for this preview |
| --- | ---: | --- |
| 0: Introduction | 6 | Retain one context, resume in a gesture before awaiting, use monitor gain and suspend when idle. |
| 1: Sound as numbers | 7 | PCM storage scales with channels × samples × four bytes; lowering fidelity is not a transparent startup fix. |
| 2: Audio graph | 6 | Native DSP runs separately from UI; use audio time, release sources and disconnect unused routing. |
| 3: Oscillators/envelopes | 7 | Schedule AudioParams; gain ramps avoid clicks; sources are one-shot objects. |
| 4: Scheduling | 7 | Use bounded overlapping lookahead; maintain scheduled event time independently of timer jitter. |
| 5: Samples | 9 | Prepare buffers once, share them, create fresh sources per trigger; decoding is initialization work. |
| 6: Filters | 7 | Native biquads preserve per-voice state; bus filters differ from independent voice envelopes. |
| 7: Modulation | 8 | Native parameter connections are part of the graph; UI-rate parameter updates cannot substitute for them. |
| 8: Effects | 7 | Preserve shared delay/feedback/reverb state; reuse IRs/curves and smooth routing changes. |
| 9: Analysis/visualization | 8 | Reuse working arrays, let visuals read the audio clock, stop unnecessary draws. |
| 10: AudioWorklet | 8 | Custom DSP requires bounded work without per-block allocations; it does not eliminate asset preparation. |
| 11: Spatial audio | 7 | HRTF and scene/listener mapping are extra features and costs, unrelated to this startup stall. |
| 12: Game audio | 7 | Mix groups with gain buses; bound active voices, but do not steal/drop authored video notes. |
| 13: Input/output | 8 | Distinguish offline rendering from playback; cancel stale async startup; account for output latency. |
| 14: Groovebox | 9 | Separate persistent engine resources from transport; share scheduling logic between live and offline. |
| 15: Mini tracker | 5 | Reuse sample banks and pure event evaluation across live lookahead and offline output. |

The [course](https://bsw.kadcom.dev/webaudio/) synthesizes its sounds rather than
loading narration recordings, so its demo speed alone cannot establish how to
optimize narration download/decode. No voice stealing, sample-rate reduction,
8-bit conversion, or custom DSP replacement was introduced.

## Reproduce and verify

```sh
npm run benchmark:preview -- ../video9
npm run test:preview
npm run test:preview -- ../video9
npm test
npm run build
# With the bundled demo at localhost:5173:
npm run test:browser
```

The preview regression uses strict gesture autoplay policy and real native audio:
suspended prewarm, first resume, idle suspend/resume, single-flight preparation,
audible/muted/unmuted PCM, future notes declared out of order, seeking into a
sustained note, backward seek, immutable project identity, failed preparation
retry, cancellation, retained-host rejection, constructor restoration, silent
projects, and Play/seek/pause racing preparation. It runs in its own server.

The existing browser suite also verifies independent eager-versus-managed offline
PCM, effects and tails, export/mute/cache/abort/limits, deterministic GPU seeking,
a real MP4 export with 240 decoded frames and AAC, cancellation, and mobile layout.
