# Voices

A voice is a short graph scheduled inside a clip. The host, the 0.2 level, and the rule against `currentTime` are in [audio.md](audio.md). This file is how the tone itself is built. A grid of notes that share samples is [audio-tracker.md](audio-tracker.md).

The mix is 48000 Hz, stereo, float samples. Read `host.context.sampleRate`. Do not open a second context, and do not assume 44100.

## Level, pitch, and the sample clock

A sample is one number from −1 to 1. Frequency is how often the wave repeats. Doubling it raises the note one octave. Amplitude is how far it swings. Doubling amplitude is not "twice as loud".

```ts
export const dbToGain = (db: number) => 10 ** (db / 20);
export const gainToDb = (gain: number) =>
  gain > 0 ? 20 * Math.log10(gain) : Number.NEGATIVE_INFINITY;
```

−6 dB is about half. −20 dB is a tenth. 0 dBFS is amplitude 1. Stay under that before the master limiter. A full-scale sine has RMS `1 / Math.SQRT2`, about −3 dB.

Nyquist is half the sample rate: 24000 Hz in this mix. A frequency above that comes back as a lower tone, folded at Nyquist.

```ts
export const aliasOf = (freq: number, rate: number) => {
  const m = ((freq % rate) + rate) % rate;
  return m <= rate / 2 ? m : rate - m;
};
```

`OscillatorNode` is already band-limited. A buffer you fill yourself is not. Keep every partial under Nyquist, or the fold becomes part of the note. A naive saw or square written as a sharp jump will alias. Use `OscillatorNode`, or add sines only up to `floor(nyquist / fundamental)`.

Quantizing to `bits` is a deliberate crush, not the mix format. The step is `2 / 2 ** bits`. Hold that value for N samples and the tone also loses rate. Sixteen bits is already quiet hiss. The exported file is AAC on top of the float mix. Do not pre-quantize the master.

MIDI note 69 is A4 at 440 Hz. One semitone is `2 ** (1 / 12)`. One cent is `2 ** (1 / 1200)`.

```ts
export const midiToFreq = (note: number, a4 = 440) => a4 * 2 ** ((note - 69) / 12);
export const detuned = (freq: number, cents: number) => freq * 2 ** (cents / 1200);
```

Two close notes beat at the difference of their frequencies. 440 Hz against 443 Hz beats three times a second. A few cents of detune between saws is a wide pad. Detune the `detune` parameter, in cents, so the width is the same in every octave. Fifty cents is half a semitone.

## Shaping one note

The ear hears pitch and loudness as ratios. Glide a frequency with `exponentialRampToValueAtTime`. Glide a gain toward silence with `setTargetAtTime`. An exponential ramp to 0 throws. A linear frequency glide from 220 to 880 sounds fast at the start, because 220 to 440 is already an octave.

`setTargetAtTime(value, time, tau)` covers about 63% of the remaining gap in one tau, and is within about 1% after five tau.

An envelope whose note-off time is known can be written in full during `schedule`. Attack and decay are times. Sustain is a level. Release is a time.

```ts
function adsr(
  gain: AudioParam,
  time: number,
  off: number,
  peak: number,
  env: { attack: number; decay: number; sustain: number; release: number },
) {
  gain.cancelScheduledValues(time);
  gain.setValueAtTime(0, time);
  gain.linearRampToValueAtTime(peak, time + env.attack);
  gain.setTargetAtTime(env.sustain * peak, time + env.attack, Math.max(0.001, env.decay / 5));
  gain.setValueAtTime(env.sustain * peak, off);
  gain.setTargetAtTime(0, off, Math.max(0.001, env.release / 5));
  gain.setValueAtTime(0, off + env.release);
}
```

If the note can end during the attack, set the value at `off` to the envelope height at that moment, then release from there. A jump in the gain clicks.

A click is a discontinuous sample. The usual causes are a gain that snaps from 0 to full, `stop()` while the wave is away from 0, and `disconnect` in the middle of a note. Open and close over 5 to 20 ms. The clip bus already fades about 5 ms at its own edges. That does not cover note edges inside the clip.

Every source may `start` once. The next note is a new oscillator or a new buffer source. Call `stop` just after the release reaches 0. A source left running still costs the render.

`sine`, `triangle`, `square`, and `sawtooth` share a fundamental and differ in partials. A saw uses every partial at about `1/n`, with alternating sign. A square uses odd partials at `1/n`. A triangle uses odd partials at `1/n²`, so a handful of partials already sounds like the builtin. `createPeriodicWave` takes those sine weights in `imag`. Index 0 is unused. The wave is normalized.

## Drums

Render a drum into a buffer once per `schedule`, or build it from nodes at `host.at(t)`. Same samples in, same buffer out. Seed the noise from the hit index.

A kick is a sine that falls exponentially, then a very short highpassed noise click so a small speaker still speaks. 150 Hz down to 45 Hz in 80 ms is a punch. Stretching that fall toward 250 ms turns it into a pew.

```ts
osc.frequency.setValueAtTime(150, time);
osc.frequency.exponentialRampToValueAtTime(45, time + 0.08);
```

A snare is highpassed noise (around 1200 Hz) plus a short triangle that falls toward about 180 Hz. A closed hat is noise through a highpass around 7000 Hz, a short decay near 50 ms, and a small peak around 10 kHz. An open hat is the same noise with a decay near 0.4 seconds. When the closed hat hits, ramp the open hat's gain to 0 in about 10 ms. Do not `stop()` it raw.

A clap is three noise bursts about 11 ms apart and one longer tail, bandpassed near 1200 Hz. A tom is the kick fall, higher, with almost no click.

Hits that share a buffer should start at different offsets so they are not identical. Pick the offset from a seeded hash of the step index, not from `Math.random`.

## Filter and modulation

`BiquadFilterNode` types: `lowpass` and `highpass` drop one side, `bandpass` and `notch` keep or remove a band, `peaking`, `lowshelf`, and `highshelf` use `gain` in dB. The others ignore `gain`. Move `frequency` with an exponential ramp or with `detune` in cents. A linear sweep of Hertz spends too long in the low octaves.

Q is resonance. A lowpass Q around 8 to 15 is a sharp wah. Automate `filter.detune` from an LFO, not `filter.frequency`, when the sweep should cover equal octaves. A subtractive voice is a bright wave, often a saw, into a lowpass whose cutoff opens with the note and then falls.

An LFO is an oscillator connected through a gain into an `AudioParam`.

- Vibrato connects to `detune`. Depth is in cents. Bring the depth up over the first part of a long note if it should sound sung.
- Tremolo connects to a gain. Keep the base gain at least as large as the depth, so the gain never goes negative. Negative gain flips the wave. Past about 20 Hz the pulse becomes new tones. That is ring modulation.
- Wah connects to a bandpass `detune`.

FM is the same patch as vibrato, with the modulator in the audio range, connected to `carrier.frequency` through a gain. That gain is the deviation in Hertz. Name the recipe by ratio and index, so it survives transposition:

```ts
const fm = ratio * carrierHz;
const deviation = index * fm;
modulator.connect(depth).connect(carrier.frequency);
```

Sidebands sit at `carrier ± k * fm`. An integer ratio is harmonic. A ratio such as 3.5 sounds like a bell. Most of the energy stays inside about `2 * fm * (index + 1)` Hertz. If that crosses Nyquist, the extra partials fold back in tune with nothing. Lower the index on high notes.

Ring modulation is a bipolar signal into a gain parameter with no extra offset, or a multiply of two buffers. You hear the sum and the difference, and the carrier disappears. Tremolo is the slow, offset version of the same patch.

## Played samples

`decodeAudioData` belongs in `schedule`. It returns a promise, which `schedule` may return. Pitch a buffer by `playbackRate`: one octave up is rate 2, and the sample also lasts half as long. `detune` on a buffer source is the same shift in cents.

`loopStart` and `loopEnd` are seconds inside the buffer. A one-shot leaves `loop` false. Start at `host.at(t)`. Stop after the envelope, or let a non-looping buffer end on its own.

A tonal sample has a root note. `playbackRate` for another note is `2 ** ((note - root) / 12)` when the buffer was rendered at the mix rate and sounds like `root` at rate 1. A tracker period uses a different division. That formula is in [audio-tracker.md](audio-tracker.md). Do not apply both.
