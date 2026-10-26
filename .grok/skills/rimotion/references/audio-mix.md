# Mix, space, and picture

Several voices become one clip graph. The clip still ends at `host.destination`. Manifest tracks are separate mute rows and may overlap. Clips on one track may not. That split is in [audio.md](audio.md). Tones and drums are in [audio-voices.md](audio-voices.md). A pattern with ticks and effects is in [audio-tracker.md](audio-tracker.md).

Schedule every event from a time you computed, then pass it through `host.at`. Do not wake a timer to play the next note.

## A beat grid

For a drum machine that is not a tracker, one step is a fraction of a beat:

```ts
export const stepSeconds = (bpm: number, stepsPerBeat = 4) =>
  60 / bpm / stepsPerBeat;
```

Sixteen steps at 120 BPM are 2 seconds. The hit time is `stepSeconds * index`, from the start of the clip, not from the previous hit. Adding a duration onto "now" walks any error forward. Computing `index * step` does not.

Swing lengthens the even step and shortens the odd one. A swing amount `s` from 0 to 0.5 delays each odd step by `s * stepSeconds`. At `s = 1/3` the even:odd pair is 2:1. Apply it to the time you pass to `start`. Do not add swing on top of a tracker tick clock. Tracker tempo is a different grid.

Humanize with a seeded hash of the step, not `Math.random`. A preview render and an export render must match. Shift time by only a few milliseconds, and keep the result inside the clip. Shifting level by a decibel or two does more for a hat than a large timing error. Past about 20 ms of timing scatter the part sounds late, not human.

A closed hat cuts an open hat by ramping that voice's gain to 0 at the closed hat's time. The choke time is on the grid. It is not a guess from loudness.

## Buses inside the clip

A manifest track is one mute switch for every clip on it. A bus is a `GainNode` inside a clip: drums into one gain, music into another, both into `host.destination`. Use a bus when one fader should move a group and the group should not be a separate mute row. Use a second manifest track when the preview's M button must drop that group from the file.

The engine already limits the sum at about −1 dB. A compressor on a bus is extra. Threshold and ratio are in dB and a ratio. Above the threshold, output is `threshold + (input - threshold) / ratio`. Ratio 20 is another limiter. Attack around 10 to 30 ms lets a drum transient through. A very fast attack, and a release under about 50 ms, pumps. Makeup gain after the compressor puts the average back. Do not stack makeup so high that the master limiter is always in reduction.

Equal-power is the crossfade that holds energy. A linear fade of two gains through 0.5 dips to half energy, about −3 dB.

```ts
export const equalPower = (x: number) => ({
  a: Math.cos((x * Math.PI) / 2),
  b: Math.sin((x * Math.PI) / 2),
});
```

Layers of one piece of music (pad, bass, drums) can all be scheduled for the whole clip, each into its own gain. The story only changes those gains. Start the change on a bar boundary when the edit should sound intentional. One bar at 120 BPM is 2 seconds. Write the curve with `setValueCurveAtTime` from the equal-power fade. The layers stay in phase because they never stop.

Duck music under a line you already placed. At the line's `host.at`, ramp the music bus down, hold, and ramp back. You know the time, so you do not need a sidechain. `DynamicsCompressorNode` has no sidechain input.

## Effects

Build the chain in `schedule`. Order matters. Distortion then reverb reads as a sound in a room. Reverb then distortion grinds the tail. Delay then reverb puts each repeat in the room. A compressor at the end of a chain also grabs the reverb tail and can pump it.

Delay is a `DelayNode` whose output returns through a gain under 1. Feedback of 1 or more runs away. Slapback is about 80 to 120 ms with no feedback. An echo is about 300 to 600 ms with feedback around 0.4. Sync the delay to the grid: one beat is `60 / bpm`. Put a lowpass in the feedback loop if the repeats should darken.

Chorus is a delay near 20 ms with an LFO on `delayTime` and no feedback. Flanger is a delay around 3 to 7 ms with feedback. Keep the modulated delay time positive.

`WaveShaperNode` maps each sample through a curve. A straight line is clean. A curve that flattens is soft clip. A flat top is hard clip. Drive is a gain in front of the shaper. A symmetric curve adds odd harmonics. An asymmetric curve also adds even ones, which sit an octave up and sound warmer. Set `oversample` to `2x` or `4x` so those harmonics are filtered instead of folded at Nyquist. Follow an asymmetric curve with a highpass around 20 Hz to drop the DC it adds.

A room is a `ConvolverNode`. Build the impulse in a float buffer: wait `2 * meters / 343` seconds, then noise that falls as `10 ** ((-3 * t) / rt60)`. That is −60 dB at `rt60` seconds. Raise a one-pole lowpass as the tail goes on so the end is dull. Use a seeded generator, a different seed per channel. Leave the convolver's normalize on, or a longer tail is also a louder tail. Wet and dry are two gains. The room for a shot is chosen in the score. If it must change at a known time, start a second convolver and crossfade the gains at `host.at`. Do not swap `buffer` on the node that is already ringing.

## Place

`PannerNode` is per voice. `host.context.listener` is one listener for the whole mix, shared by every clip. Only one place in the project should write the listener. Two clips both automating it will fight.

Web Audio is right-handed, and the listener faces −Z. If the scene treats forward as +Z, negate Z on the way in. Do that for position and for forward, up, and source orientation.

```ts
export const toAudio = (x: number, y: number, z: number) => ({ x, y, z: -z });
```

Write positions with `setValueAtTime` or a short `setTargetAtTime` along the clip. A jumped position clicks the same way a jumped gain does. Take the positions from the same function the scene uses for the camera. Composition time `t` goes in, a position comes out. The scene calls it with `time`. The clip calls it with `host.start + local`.

`equalpower` only pans left and right, and it mirrors behind to in front. `HRTF` is heavier and reads front and back on headphones. Equal-power gains at azimuth 0 are both `Math.SQRT1_2`. A straight 0.5 and 0.5 split is quieter in the center because the energies sum to 0.5.

Distance, with `ref` the distance that is still gain 1:

- inverse: `ref / (ref + rolloff * (d - ref))`. Doubling distance at rolloff 1 drops about 6 dB. It never hits 0.
- linear: `1 - rolloff * (d - ref) / (max - ref)`, then hold. Rolloff 1 is silent at `max`.
- exponential: `(d / ref) ** -rolloff`.

Clamp `d` to at least `ref`, or a camera that crosses the source spikes. Pick `ref` from the size of the object: under a meter for a person, several meters for a large machine.

A cone is the source's facing. Inside half the inner angle the gain is 1. Outside half the outer angle it is `coneOuterGain`. Between them it is a straight mix. The default cone is 360 degrees, which is no cone.

`PannerNode` does not apply Doppler. Project both velocities onto the unit vector from the source to the listener. Positive means moving along that vector. Closing speed raises pitch:

```ts
const rate = (343 - vListener) / (343 - vSource);
```

Keep the denominator away from 0. Multiply the buffer `playbackRate`, or the oscillator frequency, by `rate`. Do it from the same motion function as the picture, at the sample's start, or on a curve if the pass lasts a long time.

## What the picture uses

The frame pass does not receive the audio buffer. An analyser, a beat detector, or a meter node will not move a shader. Drive the picture from the score: the same step times, the same envelope, the same listener function.

If a playhead must sit on a hit, store the hit times in the module the clip schedules, and read them with composition `time`. Output latency matters for live speakers. It does not move the MP4. The file is aligned in the muxer. Do not subtract `outputLatency` inside a scene.

Skip these in a clip. They are live-page tools:

- `getUserMedia`, a microphone meter, and recording the mic.
- Web MIDI and `AudioContext.currentTime` as the playhead.
- A voice pool that steals a slot at runtime. You already know every hit. Schedule those hits. A cap is just how many notes you wrote.
- `AudioWorklet` for a saw, a delay, or a drum. Builtin nodes and a filled buffer already seek. A worklet is only for sample-by-sample work that has no node, and it has to be registered inside `schedule` and given every parameter up front. No message that depends on the wall clock.
- An FFT visualizer as the source of motion. Draw the spectrum from the notes you scheduled if the shot needs one.
