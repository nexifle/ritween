# Procedural voices and sample playback

Read [audio](audio.md) first for the managed host contract. Read this file for tones, envelopes, percussion, and sample pitch. These are authored sound recipes, not extra Ritween audio APIs. Choose sounds from the brief rather than adding a soundtrack merely because synthesis is possible.

## Use the managed context

Create supported nodes through `host.context.create*()` and connect them to managed nodes, parameters, or `host.destination`. Schedule the complete graph before `schedule` returns; it may return a promise for asset preparation. Use `host.at(localSeconds)` for source starts, automation, and stops. Do not create a second context, use `currentTime` as the composition clock, or install timers.

Supported node families include oscillator, buffer source, constant source, gain, biquad filter, stereo panner, delay, waveshaper, dynamics compressor, and convolver. Supported assets include PCM buffers, promise-based decoding, and periodic waves. Worklets, IIR filters, spatial listeners, and HRTF panners are outside the managed contract. The TypeScript `BaseAudioContext` type does not imply every native method is supported at runtime.

Use `host.context.sampleRate`; do not assume a source buffer's sample rate equals the mix rate. The normal engine mix is 48 kHz stereo, but correct recipes account for the actual source rate. Resource limits apply to the complete graph; reuse immutable sample buffers and keep all loops and allocations bounded.

## Pitch and gain have different units

```ts
const dbToGain = (db: number) => 10 ** (db / 20);
const midiToFrequency = (note: number, a4 = 440) =>
  a4 * 2 ** ((note - 69) / 12);
const rateForNote = (note: number, rootNote: number) =>
  2 ** ((note - rootNote) / 12);
```

A gain multiplier is not a loudness target. A per-voice gain such as 0.2 is only a possible headroom starting point; it is not the correct level for every voiceover, music bed, or effect. Leave room for simultaneous voices and measure the final mix using [mix loudness](mix-loudness.md).

One octave doubles frequency. `detune` uses cents; `playbackRate` multiplies sample read speed and also changes duration. Do not apply both a root-note ratio and a tracker period conversion to the same sample unless that combined shift is intentional.

## Shape note edges

Abrupt source cuts and discontinuous gain cause clicks. Give internal notes their own attack/release; the clip boundary gate does not repair every note edge. Fit the envelope and source stop inside the clip duration, including its release tail.

This complete voice factory uses a short linear envelope whose durations scale down for small clips:

```ts
import type { AudioClipSource } from "ritween";

export function tone(frequency: number): AudioClipSource {
  return {
    schedule(host) {
      const oscillator = host.context.createOscillator();
      const gain = host.context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, host.at(0));
      oscillator.connect(gain).connect(host.destination);
      const attack = Math.min(0.012, host.duration * 0.2);
      const release = Math.min(0.04, host.duration * 0.3);
      gain.gain.setValueAtTime(0, host.at(0));
      gain.gain.linearRampToValueAtTime(0.08, host.at(attack));
      gain.gain.setValueAtTime(0.08, host.at(host.duration - release));
      gain.gain.linearRampToValueAtTime(0, host.at(host.duration));
      oscillator.start(host.at(0));
      oscillator.stop(host.at(host.duration));
    },
  };
}
```

Use `create: () => tone(440)` in a clip. Validate frequency and other recipe inputs before using untrusted values.

For longer envelopes, attack/decay/release are durations and sustain is a level. If note-off interrupts attack or decay, release from the analytically evaluated current level rather than jumping to the nominal sustain value. During upfront scheduling, reading `.value` does not tell you the value of future automation. Keep event order explicit. Exponential ramps need positive endpoints; use a linear ramp or a target followed by a final zero for silence.

Each oscillator or buffer source starts once. Allocate another source for another note. Stop modulation sources after their release as well; inaudible nodes still consume resources.

## Design timbre without accidental aliasing

Built-in oscillators provide band-limited waveforms. A hand-filled saw or square buffer does not automatically receive that protection. Keep synthesized harmonics below Nyquist, especially at high pitches or under FM. Waveshaper oversampling can help its nonlinear harmonics, but does not make every synthesis method alias-free.

For a periodic wave, index zero is DC and the arrays encode harmonic coefficients. For vibrato, connect a low-frequency oscillator through a depth gain to detune in cents. For tremolo, keep the carrier gain's offset large enough to avoid unintended negative gain. High-rate modulation creates new frequencies; select it because the sound calls for it, not as a default embellishment.

Useful starting ideas, not fixed presets:

- A kick can combine a falling sine frequency and a very short filtered click.
- A snare can combine filtered noise and a short pitched body.
- Hats use highpassed noise with different decay lengths; a closed hat can fade an active open hat rather than hard-stop it.
- A bell can use decaying partials or restrained FM; reduce high-frequency energy when aliasing becomes audible.

Seed procedural noise by stable note/sample identity. Reuse buffers when appropriate; deterministic small changes in level or offset can avoid mechanical repetition without making preview and export disagree.

## Decode and pitch authorized assets

Fetch and decode supplied or authorized audio inside asynchronous `schedule`, before it resolves. Retain decoded buffers only within a safe ownership/cache strategy; do not refetch on every video frame. Use source offsets and loop endpoints in buffer seconds. Check the root pitch, buffer rate, loop seam, and time needed for the release.

Do not promise a natural instrument or intelligible voice from a generic oscillator. If a required asset is missing, explain the substitution. A non-silent AAC stream proves audio presence, not timbre, balance, or listening quality.
