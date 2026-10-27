# Arrangement, buses, and picture synchronization

Read after [audio](audio.md) and [sound synthesis](sound-synthesis.md). For speech/music balance and metering use [mix loudness](mix-loudness.md). A complete song or arrangement can live in one clip graph; overlapping manifest clips still require separate tracks.

## Use an authored score

Keep event times, note data, and meaningful visual cues in a shared pure module. Compute each event's local time directly, then schedule it with `host.at`. A straightforward sixteenth-note grid is:

```ts
const stepSeconds = (bpm: number, stepsPerBeat = 4) => 60 / bpm / stepsPerBeat;
const hitTime = (index: number, bpm: number) => index * stepSeconds(bpm);
```

Validate positive finite BPM and step count. Apply swing or seeded humanization to those predetermined events, keeping times ordered and inside the clip. Do not wake a timer for each note or accumulate wall-clock timing error. A tracker tick grid is a separate convention; see [pattern sequencing](pattern-sequencing.md).

The frame renderer does not receive the live mix. An `AnalyserNode` is not the scene's clock. For audio-reactive work, use the shared score or precomputed analysis of authorized audio prepared before rendering. State whether visuals are score-driven or derived from actual measured audio. Do not label a decorative sine wave as a measured spectrum.

Convert composition times to clip-local times explicitly: `local = compositionTime - clipStart`. `host.at(local)` maps back to the audio timeline. A scene's local time and a clip's local time may start at different composition positions.

## Choose tracks for muting, buses for routing

A manifest track gives the user an independent mute row. A bus is a gain node within a clip graph. Use separate VO/music/SFX tracks when independent muting is useful. Use buses to group sources that should share level, filters, or effects. Preview monitor volume is not an exported master gain.

Keep a continuing bed in a clip that spans visual cuts. Scene boundaries do not require new audio clips or resetting the music envelope. Extend duration to contain release/reverb tails without passing the composition end. A visual retime requires explicit review of audio timing; the engine does not move it automatically.

The engine's protective master compressor does not normalize loudness or guarantee a true-peak ceiling. Avoid driving it continuously. Do not expand engine limits or add a replacement audio renderer to compensate for a needlessly large project graph.

## Crossfade according to signal relationship

For largely uncorrelated material, equal-power gains are a useful starting point:

```ts
const fadeGains = (value: number) => {
  const t = Math.max(0, Math.min(1, value));
  return [Math.cos((t * Math.PI) / 2), Math.sin((t * Math.PI) / 2)];
};
```

Identical in-phase signals can gain level at the midpoint with that curve; complementary linear gains may be better. Opposite polarity can cancel. Measure and listen to the actual overlap. Overlapping sources may share one clip graph, or separate manifest tracks; do not place overlapping clips on one track.

For music layers that must remain phase-aligned, start them from the same score origin and automate their gains instead of restarting them at every visual beat. Use musical boundaries only when they support the story; not every animation should land on a drum hit.

## Effects remain within the managed graph

Create supported effects during scheduling and keep their parameters deterministic. Useful patterns include a lowpass to make repeats recede, a delay with feedback gain safely below one, and a seeded impulse buffer for a restrained room. Bound impulse duration and memory. Feedback gain below one is not a complete stability proof when other nodes in the loop amplify frequencies; inspect the whole loop and leave margin.

Keep modulated delay time nonnegative and within its allocated maximum. Reverb and delay tails need time inside the clip. Crossfade two prepared effect paths when changing a ringing room rather than replacing its impulse abruptly. Normalize and level-check generated impulses; a longer buffer is not automatically a better room.

A waveshaper's curve, drive, and oversampling alter peak levels. A compressor has no external sidechain input. For known speech, schedule music gain automation from speech intervals instead of pretending a normal compressor connection creates sidechain ducking.

The managed API provides stereo panning, not `PannerNode`, HRTF, or listener control. If a moving object's pan and attenuation matter, compute both from shared pure motion data, then schedule a bounded parameter curve. Clamp pan to −1..1 and avoid gain jumps. Do not create another context to obtain unsupported spatial APIs.

## Check the rendered relationship

Export and listen across clip edges, visual cuts, cue attacks, and the busiest overlap. Confirm audio exists by decoding the exported stream. Verify picture cues against the shared score after retiming. Do not subtract live speaker output latency from MP4 timestamps; muxed audio/video alignment is not a browser monitoring delay.

Report listening and measurement separately. A waveform or successful build does not demonstrate a good arrangement, and a silent PNG says nothing about the soundtrack.
