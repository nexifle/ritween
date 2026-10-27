# Audio tracks

Sound is not part of a scene. `render` stays a pure function of the video timestamp. A clip schedules Web Audio nodes against `host.at`. Placement lives on the manifest.

The shipped demo is the pattern. `src/project/audio/phrase.ts` is one factory. `src/project/manifest.ts` places it twice: A1 from `0` for `4` seconds at 220 Hz, A2 from `2` for `6` seconds at 330 Hz. Those two calls overlap in time because they sit on different tracks. Copy that shape. Leave `src/engine/` alone.

## Contract

Types are `AudioHost`, `AudioClipSource`, `AudioClip`, and `AudioTrack` in `src/engine/types.ts`.

```ts
import type { AudioClipSource } from "../../engine/types";

export function tone(frequency: number): () => AudioClipSource {
  return () => ({
    schedule(host) {
      const osc = new OscillatorNode(host.context, { type: "sine", frequency });
      const amp = new GainNode(host.context, { gain: 0 });
      osc.connect(amp).connect(host.destination);
      const time = host.at(0);
      amp.gain.setValueAtTime(0, time);
      amp.gain.linearRampToValueAtTime(0.2, time + 0.01);
      amp.gain.setTargetAtTime(0, time + host.duration * 0.7, 0.03);
      osc.start(time);
      osc.stop(host.at(host.duration));
    },
  });
}
```

`host.context` is a managed facade with the supported subset of `BaseAudioContext`. The same `schedule` runs for preview and for export. `host.destination` is this clip's bus. `host.start` and `host.duration` are composition seconds. `host.at(local)` is `start + local`. Schedule every `start`, ramp, and `stop` with `host.at`. Do not read `performance.now`, `AudioContext.currentTime`, or the video playhead.

`schedule` may return a promise for fetching and `decodeAudioData`. It must finish scheduling within 30 seconds. Do not register timers, retain the host for later scheduling, create a second audio context, start an offline render, or use `audioWorklet`, `getUserMedia`, `MediaRecorder`, or analyser-driven timing.

Ritween records this schedule as data, groups independent voices and creates native nodes automatically near their start times. Shared effects retain their state. Write ordinary loops over all notes; no `host.defer`, manual chunking, project-specific scheduler, or export workaround is required.

### Supported API and enforced limits

- Nodes: `OscillatorNode`, `AudioBufferSourceNode`, `ConstantSourceNode`, `GainNode`, `BiquadFilterNode`, `StereoPannerNode`, `DelayNode`, `WaveShaperNode`, `DynamicsCompressorNode`, `ConvolverNode`. Both `new Node(host.context, options)` and the matching `host.context.create*()` factories are supported. Connect only these managed nodes, their managed audio parameters, or `host.destination`.
- Parameters: `.value`, `setValueAtTime`, `linearRampToValueAtTime`, positive `exponentialRampToValueAtTime`, `setTargetAtTime`, `setValueCurveAtTime`, `cancelScheduledValues`, `cancelAndHoldAtTime`. Times and values must be finite; times must be nonnegative. Curves contain 2..65,536 samples.
- Assets: `createBuffer`, promise-based `decodeAudioData`, and `createPeriodicWave`/`setPeriodicWave`. Fetch and decode assets inside `schedule` before it returns. Samples and noise must be deterministic.
- Sources start once. Use `host.at` for timing and stop voices after their release. Sources without a stop end at the clip boundary. The clip bus gates output to its own duration.
- Per mix: at most 16,000 nodes, 64,000 connections, 200,000 automation events and 1,000,000 graph traversal steps. Source PCM buffers total at most 128 MiB; output PCM at most 256 MiB. Delay storage is at most 30 seconds per node and 60 seconds across nodes.

The implementation in `src/engine/live-mix.ts` (`AUDIO_LIMITS`) is authoritative. Unsupported API calls and resource-limit violations fail with a diagnostic instead of silently falling back to an unbounded native graph. `PannerNode`, listener control, custom worklets, and IIR filters are outside this contract; use supported nodes or generate a deterministic PCM sample. Do not merely increase a timeout to conceal an error. General JavaScript is not sandboxed: keep loops finite and asset requests bounded.

Keep each voice near `0.2`. The mix sums tracks and then limits at −1 dB. A jump in gain clicks, so open and close with `linearRampToValueAtTime` or `setTargetAtTime`.

One factory can be placed on many clips. Pass pitch, buffer, or notes into the factory. Do not close over a manifest `start`.

## Register tracks

`audioTracks` is optional. Omit it and the picture stays silent. Add it beside `scenes`:

```ts
import { tone } from "./audio/tone";

audioTracks: [
  {
    id: "a1",
    name: "A1",
    clips: [
      { id: "bed", name: "Bed", start: 0, duration: 4, create: tone(220) },
    ],
  },
  {
    id: "a2",
    name: "A2",
    clips: [
      { id: "answer", name: "Answer", start: 2, duration: 6, create: tone(330) },
    ],
  },
]
```

`name` is the row label. `create` is what runs.

`validateProject` rejects a bad clip with `Invalid audio clip: …`. These are the checks:

- Track ids are unique. Clip ids are unique across every track.
- `start` is at least `0`. `duration` is positive. `start + duration` does not pass `project.duration`.
- On one track, the next clip starts at or after the previous clip ends. Touching at one instant is valid. Overlap on one track is not.
- Two tracks may occupy the same times. They sum.

Gaps on a track are silent. Clips do not move when a scene cut moves. Lengthening the composition means editing `duration` and every scene end, then extending any clip that should fill the new time.

## Preview and export

The timeline draws V1, then one row per audio track. M on a row drops that track from the mix you hear and from the next export. The transport speaker and its volume are preview only. They are not in the file.

`ritween frame` is a silent PNG. `ritween export` mixes every unmuted track with `OfflineAudioContext` at 48 kHz and muxes AAC next to the H.264 track. Play the MP4 and seek it. A green `npm test` does not prove the mix.

## Sound beyond a phrase

A tone, a drum, a filter, or a played sample is [audio-voices.md](audio-voices.md). A beat grid, a room, buses, and a sound placed in the scene are [audio-mix.md](audio-mix.md). A pattern of notes, samples, and effects is [audio-tracker.md](audio-tracker.md). That pattern is still this contract: one clip schedules the whole grid, because the columns play together.
