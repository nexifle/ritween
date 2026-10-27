# Deterministic pattern and tracker sequencing

Read only for a requested tracker-style soundtrack, pattern display, or authorized module playback. This is a project-level sequencing architecture, not a built-in Ritween tracker or a promise of complete MOD compatibility. Use [audio](audio.md) for the host and [sound synthesis](sound-synthesis.md) for sources.

## Compile a score, not a live player

Represent patterns, order lists, channel state, and sample definitions as data. Walk the score from local time zero into a bounded event list before scheduling. Audio uses that list to start/retune/release sources; video uses it to determine the active row at any requested timestamp.

A common classic four-channel model has 64 rows per pattern, with note, sample, effect, and parameter fields in each cell. Choose and document the subset actually implemented. Other tracker formats and dialects use different rules. Ordinary step-sequencer music does not require emulating a legacy binary format.

Several channels can sound inside one clip graph. They are not overlapping clips on the same manifest track. Use separate tracks only when independent muting is needed.

## Keep tick and row clocks distinct

For the classic timing convention:

```ts
const tickSeconds = (bpm: number) => 2.5 / bpm;
```

At tempo 125 with speed 6, a tick is 0.02 seconds and a row is 0.12 seconds. Speed counts ticks per row; tempo changes tick length. A speed change can therefore change row/beat duration even when the tempo number stays the same.

Define when clock commands take effect, whether tick zero applies slides, and how simultaneous commands resolve. Compute events using those rules, not `setInterval`, `currentTime`, or a live lookahead queue. Reject zero/invalid timing and cap duration, rows, ticks, and output events so loops or pattern jumps cannot run forever.

For simple fixed-tempo patterns, index-based timing avoids accumulated floating-point error. For changing tempo, use a deterministic sequential walk and preserve its resulting event times. Measure the authored duration with that same walk, including the chosen release tail.

## Separate musical state from native nodes

Per channel, store the selected sample, base pitch/period, volume, effect parameters, and any remembered slide target/speed. Tick events can contain:

```ts
type TickEvent = {
  localTime: number;
  order: number;
  row: number;
  tick: number;
  channels: readonly {
    trigger: boolean;
    sample: number;
    playbackRate: number;
    gain: number;
  }[];
};
```

This is an example project type, not an SDK export. Generate it in a pure function. Keep empty cells, sample selection, new note attacks, and continuing effects distinct. Reading a scheduled `AudioParam.value` cannot substitute for authored future state.

On a new attack create a fresh buffer source; sources start once. Fade out replaced voices over a short bounded interval to avoid clicks, then stop them. Portamento can retune an existing voice without restarting it. Distinguish an intentionally stepped arpeggio from a smooth pitch glide.

A deliberately small effect subset might include arpeggio, tone portamento, volume slide, set volume, and speed/tempo. Test tick-zero behavior, parameter memory, clamping, note bounds, and end-of-order handling. Unknown effects must be reported as unsupported or explicitly documented as ignored; silently dropping them is not faithful playback. Do not restrict a new implementation to five effects merely because an earlier example did.

## Pitch must match the sample representation

For a tonal sample with a known root pitch, rate is `2 ** ((note - rootNote) / 12)`. Legacy period-based playback uses a hardware clock convention and the buffer's declared sample rate instead. Do not combine those two mappings accidentally.

When implementing a particular MOD dialect, verify its period/finetune rules rather than assuming a nearest-semitone approximation is exact. A PAL-style read-rate convention uses clock divided by twice the period, then divides that read rate by the PCM buffer rate to obtain playback rate. Changing a buffer's declared rate without resampling changes pitch.

Source loop offsets are buffer seconds, not output mix samples. Validate loop start/end against decoded length. Channel volume is not final loudness: allow headroom for channel sums, panning, and effects, then check the decoded export. Hard left/right legacy panning is a format/style choice, not the default for all soundtracks.

## Keep the picture on the same score

Use a shared clip start and binary-search the last event at or before composition time minus clip start. Before the clip starts, return an explicit inactive state; do not show the first row as already playing. Define the state after the score ends or while a tail rings.

The scene draws from this state using prepared text or a glyph atlas with all required digits and symbols. Do not import the framework demo's incomplete text helper or use an analyser as the row clock. Test seeking across tempo changes and order boundaries, including returning from a later row to an earlier timestamp.

## Treat module files as bounded untrusted input

Only use modules and samples the user supplies or authorizes. If supporting classic 31-sample `M.K.` files, validate the minimum header size, signature, song length, order indices, pattern byte count, sample byte lengths, finetune, volumes, and loops before allocation or reads. Reject unsupported signatures/dialects with a clear message. Header sample lengths and loop fields use 16-bit words, not bytes; sample PCM is signed 8-bit.

Do not assume padding in unused order entries is meaningful; document the selected dialect's pattern-count rule and verify that all referenced patterns fit the file. Bound decoded PCM and scheduled nodes/events against the managed audio budget. A valid binary parse is not proof of correct effect timing or lawful sample redistribution.

Test the pure event compiler separately from browser audio: tick times, pitch, voice replacement, loop bounds, and malformed input. Then export a short representative passage and check actual sound and picture synchronization. If listening was unavailable, state that limitation.
