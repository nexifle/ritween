# Tracker pattern

A tracker song is a grid plus a handful of short samples. The grid says which note, which sample, and which effect. The samples are stored once and replayed faster or slower. The mix is assembled when the clip schedules, not recorded ahead of time.

The grid is still one audio clip. Read [audio.md](audio.md) for `host.at`, track placement, and the 0.2 voice level. Four columns play at the same time, so they cannot be four clips on one manifest track.

Share one pure walk between the clip and the scene. The scene draws the row that the walk says is active. It does not listen to the mix.

## The grid

A pattern is 64 rows and 4 channels. Each cell is four numbers:

| Field | Empty | Range | Meaning |
| --- | --- | --- | --- |
| note | 0 | 1..36 | C-1 is 1, C-2 is 13, C-3 is 25, B-3 is 36 |
| sample | 0 | 1..31 | Which stored sample. 0 keeps the channel's current sample |
| effect | 0 | 0..15 | See the five effects below |
| param | 0 | 0..255 | Two hex digits, `xy` |

An order list is the song: a run of pattern indexes. Playing pattern 0 twice stores that pattern once and lists it twice. The restart index is where a loop goes; a video usually plays the list once, or wraps it until `host.duration`.

One channel is one voice. A new note replaces that channel's voice. The other three keep going.

## Clock

The player counts ticks, not rows. Speed is how many ticks make one row. Tempo is how long a tick is.

```ts
export const tickSeconds = (bpm: number) => 2.5 / bpm;
```

At the usual start, speed is 6 and tempo is 125. One tick is `2.5 / 125 = 0.02` seconds. One row is `6 * 0.02 = 0.12` seconds. Sixty-four rows are 7.68 seconds. Four rows are one beat, so the beat really is 125 per minute. Speed 8 at the same tempo makes the row 0.16 seconds. The beat slows. The tempo number did not change.

`Fxx` on tick 0 of a row changes the clock:

- `param === 0`: ignore.
- `param < 32`: that number becomes the speed, in ticks per row.
- `param >= 32`: that number becomes the tempo, in BPM.

The new tempo sizes the gap after the current tick. The new speed is already in force when this row decides whether it has finished. `F03` on tick 0 leaves this row only three ticks long. `F96` is 150 BPM, not a speed.

Walk every tick yourself, from local time 0 up to `host.duration`:

```ts
let local = 0;
while (local < host.duration - 1e-9) {
  const ev = nextTick(player); // may change player.bpm and player.speed
  playTick(voices, song, ev, host.at(local));
  local += tickSeconds(player.bpm);
}
```

`nextTick` returns the tick it just applied, then advances. Do not use `setInterval`, `setTimeout`, or a 100 ms lookahead. Those exist for a live page. Here the whole song is known, and `OfflineAudioContext.currentTime` is not the composition clock. A tempo that depends on the previous tick is still deterministic: the walk is a pure function of the song.

To measure a clip, run the same walk with no nodes until the order list ends once, and take the last `local`. Add a short tail, about 0.2 seconds, if the last sample should ring inside the clip. The clip's `start + duration` must stay inside `project.duration`.

## Pitch

A note is stored as a period. A smaller period reads the sample faster, so the pitch is higher. The period table is three octaves, C-1 through B-3:

```ts
export const PERIODS = [
  856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453,
  428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240, 226,
  214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120, 113,
];
export const PAL_CLOCK = 7_093_789.2;
export const periodToHz = (period: number) => PAL_CLOCK / (period * 2);
```

C-2 is period 428, about 8287 Hz of sample reading. C-3 is 214, twice that, one octave up. B-3 is 113, the top of the table.

Finetune on a sample is an integer from −8 to 7. One step is one eighth of a semitone:

```ts
export const finetunePeriod = (period: number, finetune: number) =>
  period * 2 ** (-finetune / 96);
```

Create the `AudioBuffer` at a fixed rate, 22050 is the usual choice, even though the mix runs at 48000. `AudioBufferSourceNode` resamples. The playback rate is the Amiga read rate divided by that buffer rate:

```ts
export const periodToNote = (period: number) => {
  let best = 1;
  let gap = Infinity;
  for (let i = 0; i < PERIODS.length; i++) {
    const d = Math.abs(PERIODS[i] - period);
    if (d < gap) {
      gap = d;
      best = i + 1;
    }
  }
  return best;
};

export const playbackRateFor = (period: number, finetune: number, bufferRate: number) =>
  periodToHz(finetunePeriod(period, finetune)) / bufferRate;
```

C-3 at finetune 0 into a 22050 buffer is `16574 / 22050 ≈ 0.75`.

If you synthesized the sample at 48000, create the buffer at 48000 and use that rate in the division. Do not leave the samples at 22050 spacing and then label the buffer 48000. That plays the sample sharp.

Volume on a channel is an integer 0..64. Map 64 to about 0.2, the same ceiling as one voice in [audio.md](audio.md). Four channels at 64 then sum near 0.8, and the master limiter is not doing all the work.

```ts
export const gainOf = (volume: number) => (volume / 64) * 0.2;
```

A sample loops when its loop length is more than 2 bytes. `loopStart` and `loopEnd` on the buffer source are in seconds: byte index divided by the buffer rate. A loop length of 2 or less plays once.

Channels sit in the Paula layout: 0 and 3 hard left, 1 and 2 hard right. A `StereoPannerNode` at −1 or +1 is enough. Those panners sum into `host.destination`.

## One tick

Keep this state per channel: sample index, period, volume, effect, param, portamento target, portamento speed.

On tick 0, read the cell:

1. Remember the effect and the param.
2. A non-zero sample selects that sample and sets the volume back to the sample's own volume (0..64).
3. A non-zero note becomes the period. Effect `3` with a period already playing does not restart the sample. It stores the note as the portamento target. Any other note restarts the sample from the beginning.
4. Effect `3` with a non-zero param stores that param as the slide speed. Param 0 keeps the old speed.
5. Effect `C` sets the volume to `min(64, param)` after the sample volume, so it wins over step 2.

On later ticks of the row, only the continuing effects move.

Replacing a voice ramps the old gain to 0 in about 5 ms and stops that source just after. A hard cut clicks. Use the volume you stored, not `gain.value`, because scheduled automation has not run yet during `schedule`.

```ts
function release(voice: Voice, time: number) {
  voice.gain.gain.cancelScheduledValues(time);
  voice.gain.gain.setValueAtTime(gainOf(voice.volume), time);
  voice.gain.gain.linearRampToValueAtTime(0, time + 0.005);
  voice.src.stop(time + 0.01);
}
```

Starting a voice sets `playbackRate` and gain at `time`, then `src.start(time)`. Arpeggio and portamento write a new `playbackRate` with `setValueAtTime` at the tick. The pitch is supposed to jump once per tick. Volume slides use `setTargetAtTime` with a time constant around 0.002 so the step is not a click.

## Five effects

These are the effects the walk plays. Any other effect number is left in the cell and does nothing. Do not invent a vibrato, a retrigger, or a pattern break beside them.

`0xy`, arpeggio. Tick 0, 3, 6, … play the base note. Tick 1, 4, … play `x` semitones up. Tick 2, 5, … play `y` semitones up. `037` is a minor chord. `047` is a major chord. The channel period stays on the base note. Only the period you hear changes, so the next row starts from the base. Step the note index, then look up the table again, and stop at B-3.

```ts
export function arpeggioPeriod(period: number, param: number, tick: number) {
  const step = tick % 3;
  const semis = step === 0 ? 0 : step === 1 ? param >> 4 : param & 15;
  if (semis === 0 || period === 0) return period;
  const note = Math.min(36, periodToNote(period) + semis);
  return PERIODS[note - 1];
}
```

`3xx`, tone portamento. The note in the cell is a target, not a new attack. Each tick after tick 0 moves the period by `xx` toward the target and stops exactly on it. Period 214 (C-3) toward 180 (D#3) with speed `0x0C` goes 214, 202, 190, 180. It does not pass the target.

```ts
export function portamento(period: number, target: number, speed: number) {
  if (period < target) return Math.min(target, period + speed);
  if (period > target) return Math.max(target, period - speed);
  return period;
}
```

`Axy`, volume slide. On each tick after tick 0, if `x` is not 0 add `x`, otherwise subtract `y`. Clamp to 0..64. `A04` from volume 10 across a 6-tick row slides on five ticks and lands on 0, not on −10.

`Cxx`, set volume. On tick 0 the volume becomes `xx`, clamped to 64. `C00` is silence. The sample keeps running.

`Fxx`, speed or tempo, as in the clock section.

A slide or an arpeggio with no current voice does nothing. An empty cell does not restart the sample and does not move the period. Tick 0 still writes the cell's effect and param, so an empty cell sets the effect to 0 and the slide or arpeggio stops. The note that was already playing continues.

## Walk

```ts
type Cell = { note: number; sample: number; effect: number; param: number };
type Tick = {
  time: number;
  order: number;
  row: number;
  tick: number;
  channels: { trigger: boolean; sample: number; period: number; volume: number }[];
};

export function takeTicks(song: Song, seconds: number, loop = false): Tick[] {
  const player = createPlayer(song); // speed 6, bpm 125, order 0, row 0, tick 0
  const out: Tick[] = [];
  let time = 0;
  while (time < seconds - 1e-9) {
    const ev = nextTick(player);
    out.push({ time, ...ev });
    time += tickSeconds(player.bpm);
    if (player.ended && !loop) break;
  }
  return out;
}
```

`createPlayer` and `nextTick` are the tick rules above, written as plain data. No `AudioContext` in this function. Call it from `schedule` and from the scene.

On each event, `trigger` means start the sample from the top at `host.at(ev.time)`. Otherwise, if period or volume changed, write the new playback rate or the new gain on the voice that is already running.

Seed any noise inside a synthesized sample from the sample index. `Math.random` makes the preview buffer and the exported file differ.

## Clip

```ts
export function songClip(song: Song): () => AudioClipSource {
  return () => ({
    schedule(host) {
      const rate = 22050;
      const buffers = song.samples.map((s) => toBuffer(host.context, s, rate));
      const pans = [-1, 1, 1, -1].map((value) => {
        const p = new StereoPannerNode(host.context, { pan: value });
        p.connect(host.destination);
        return p;
      });
      const voices = [0, 1, 2, 3].map(() => null as Voice | null);
      for (const ev of takeTicks(song, host.duration, true)) {
        ev.channels.forEach((ch, c) => {
          const when = host.at(ev.time);
          if (ch.trigger) {
            const current = voices[c];
            if (current) release(current, when);
            voices[c] = startVoice(host, buffers, pans[c], song, ch, when);
            return;
          }
          retune(voices[c], ch, when);
        });
      }
    },
  });
}
```

Put that factory on one clip. `start` is where the pattern begins in the composition. `duration` is how much of the walk you want. A second pattern that must be muted alone goes on a second manifest track, with its own walk, not as a second overlapping clip on this track.

## Picture

Import `takeTicks` from the same module the clip uses. The row under the playhead at composition time `time` is the last event with `clipStart + event.time <= time`.

```ts
export function rowAt(events: Tick[], clipStart: number, time: number) {
  let hit = events[0];
  for (const ev of events) {
    if (clipStart + ev.time > time) break;
    hit = ev;
  }
  return hit;
}
```

`clipStart` is the clip's `start` in the manifest. Keep that number in the shared module and use it in both places. Draw four cells for `hit.row`. The builtin `text()` glyph set has no digits, so a row number uses the digit atlas in [chart-scales.md](chart-scales.md), or you draw the active cell as a bar and skip the numeral.

Do not read an `AnalyserNode` to place the playhead. The frame render never sees the mix. The walk already knows the row.

## A `.mod` file

Use this only when the user gives you a module they are allowed to use. Many old modules carry samples you cannot ship.

The file is big-endian. Layout:

- 20 bytes, title.
- 31 sample headers, 30 bytes each. Name 22, length in 16-bit words, finetune in the low 4 bits as a signed nibble (−8..7), volume, loop start in words, loop length in words.
- Byte 950, song length. Byte 951, restart. Bytes 952..1079, 128 order indexes. Bytes 1080..1083, the mark `M.K.`. Reject other marks. This player is four channels.
- Header is 1084 bytes.
- Each pattern is 1024 bytes. The count is not stored. It is one more than the largest index in all 128 orders, not only the used song length.
- Sample bytes follow the patterns, signed 8-bit, in header order. Length in the header is words, so the byte count is twice that.

One cell in the file is 4 bytes: `sssspppp pppppppp sssseeee xxxxyyyy`. The 12-bit period is looked up to the nearest table note. The sample number is the top 4 bits of byte 0 and the top 4 bits of byte 2.

```ts
const period = ((b0 & 0x0f) << 8) | b1;
const sample = (b0 & 0xf0) | (b2 >> 4);
const effect = b2 & 0x0f;
const param = b3;
```

Convert sample bytes with `n / 128`. Keep the buffer rate you chose and the playback-rate division in agreement. Effects outside the five stay silent. The video does not need to write a `.mod` back out.
