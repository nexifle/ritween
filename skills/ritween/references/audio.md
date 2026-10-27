# Audio reference — Ritween 0.1.0

Audio belongs to project tracks, independently of visual scenes. Each track contains clips with `id`, `name`, `start`, `duration`, and a `create` factory returning an `AudioClipSource`.

## Procedural tone

```ts
import type { AudioClipSource } from "ritween";

export function tone(): AudioClipSource {
  return {
    schedule(host) {
      const start = host.at(0);
      const end = host.at(host.duration);
      const oscillator = host.context.createOscillator();
      const gain = host.context.createGain();
      oscillator.frequency.value = 440;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.12, start + 0.01);
      gain.gain.setValueAtTime(0.12, end - 0.02);
      gain.gain.linearRampToValueAtTime(0, end);
      oscillator.connect(gain).connect(host.destination);
      oscillator.start(start);
      oscillator.stop(end);
    },
  };
}
```

Use this example for clips longer than 0.03 seconds; shorten the attack/release proportionally for shorter clips so automation remains ordered. Add it to a project with duration at least two seconds:

```ts
audioTracks: [{
  id: "music",
  name: "Music",
  clips: [{
    id: "tone-1",
    name: "Tone",
    start: 0,
    duration: 2,
    create: tone,
  }],
}],
```

## Scheduling rules

- `host.at(clipLocalTime)` converts clip-local seconds to composition time. Use it for source start/stop and automation; do not use wall-clock time.
- Return fresh source instances. `schedule` may be asynchronous; await asset decoding before completing it.
- Track IDs are unique. Clip IDs are unique across all tracks.
- Clips stay within project duration and cannot overlap within one track. Different tracks may overlap.
- Use `host.destination` as a connection target; do not mutate it as though it were your own gain node.
- The supplied context is a managed facade, not unrestricted Web Audio. It supports common oscillator/gain/buffer/filter and other managed nodes; unsupported APIs throw. Its `currentTime` is zero. Do not assume audio worklets, microphone input, or arbitrary context methods are available.
- For file audio, fetch the asset from the consumer project's public directory, check the response, and await promise-based `decodeAudioData`. Handle failed requests explicitly.

## Optional sound references

Read only what the soundtrack needs: [sound synthesis](sound-synthesis.md) for voices and samples, [sound arrangement](sound-arrangement.md) for scores and routing, [pattern sequencing](pattern-sequencing.md) for tracker-style projects, and [mix loudness](mix-loudness.md) for balance, ducking, and measurement. These are authored project techniques, not built-in instruments or sequencers.

## Preview versus export

Preview uses a live audio clock and lookahead. Export mixes offline, stereo at 48 kHz, aligned to exported video frame count. Preview volume and master mute do not change export; project track mute does. Check actual exported audio rather than inferring it from preview volume.

For the versioned settings shape, track mute is stored as:

```ts
settings: {
  version: 1,
  audioTracks: { music: { muted: true } },
},
```

If mixing fails, inspect clip bounds, unsupported context calls, asset errors, and resource size before retrying. Do not silently remove requested audio to make export succeed.
