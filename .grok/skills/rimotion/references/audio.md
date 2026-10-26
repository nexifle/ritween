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

`host.context` is a `BaseAudioContext`. The same `schedule` runs for preview and for export. `host.destination` is this clip's bus. `host.start` and `host.duration` are composition seconds. `host.at(local)` is `start + local`. Schedule every `start`, ramp, and `stop` with `host.at`. Do not read `performance.now`, `AudioContext.currentTime`, or the video playhead.

`schedule` may return a promise. `decodeAudioData` and `audioWorklet.addModule` belong there. `getUserMedia` does not.

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

`rimotion frame` is a silent PNG. `rimotion export` mixes every unmuted track with `OfflineAudioContext` at 48 kHz and muxes AAC next to the H.264 track. Play the MP4 and seek it. A green `npm test` does not prove the mix.
