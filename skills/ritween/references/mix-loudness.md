# Speech, music, effects, and delivery loudness

Read for balancing a soundtrack, ducking music, matching cuts, or checking a final audio delivery. Use [audio](audio.md) for scheduling and [sound arrangement](sound-arrangement.md) for routing. Distinguish a published delivery specification, a software default, and a creative starting value. They are not interchangeable.

## Start with the listening hierarchy

For speech-led work, preserve intelligible words first, then place music and effects around them. A music-led film can use a different hierarchy. Follow the actual recipient specification before choosing a default target. There is no universal VO:music:SFX gain-slider ratio.

Measure the assets rather than assuming equal gains or peaks imply equal perceived loudness. Spectral masking, articulation, stereo layout, and event timing matter. Reducing a competing layer or moving an effect away from a syllable can help more than heavier speech compression. Keep essential speech understandable in mono and on a small speaker.

## Keep units and windows separate

- **dB gain:** a relative amplitude adjustment, `10 ** (dB / 20)`.
- **dBFS:** sample level relative to digital full scale.
- **dBTP:** an estimate of intersample true peaks, including peaks decoding can introduce.
- **LUFS/LKFS:** weighted loudness; not obtainable from a gain setting alone.
- **Integrated loudness:** whole-program measurement with the relevant gating rules.
- **Short-term/momentary loudness:** useful for local comparisons, conventionally three-second and 400 ms windows in EBU metering.
- **LRA:** a statistical loudness-range descriptor, not peak minus RMS or a universal pass/fail measure for short videos.

Compare VO and music over the same speech-active intervals and channel accounting. Subtracting integrated values for an entire song and a short isolated phrase does not establish their contrast during speech. A very short effect needs peak inspection and listening; normalizing it to the VO's full-program LUFS target is inappropriate.

## Choose provisional values honestly

When no recipient target is specified, one possible starting choice for a speech-led stereo web film is −18 to −16 LUFS integrated, with deliberate headroom for codec overshoot. This is a creative/engineering heuristic, not a Ritween default or universal upload requirement. A first-pass true-peak aim around −2 dBTP can leave margin, but only measurement after AAC decoding establishes the result.

Start music substantially below speech over matched active intervals—around 20 dB average contrast can be a useful intelligibility-oriented trial. Adjust from actual material and listening. Sparse music, difficult speech, and dense vocal music need different treatment. Set SFX in context, placing prominent transitions in speech gaps where possible rather than assigning every effect the same absolute peak.

Do not label these heuristics as broadcast compliance. EBU R128's broadcast context uses a −23 LUFS programme reference; apply its full relevant document and version only when that delivery profile is requested. WCAG's 20 dB background-audio reference has specific Level AAA/audio-only scope and exceptions; voluntarily adopting its contrast for a video does not establish overall video accessibility compliance.

Do not assert a platform requires −14 LUFS without checking that recipient's current specification. Playback normalization cannot repair masking, clipping, or unintended jumps within a programme.

## Calculate gain from matched measurements

For an unchanged signal before nonlinear processing, an estimated correction is `desired dB level - measured dB level`; remeasure afterward.

Example using the same speech-active RMS window: speech is −20 dBFS RMS and music is −14 dBFS RMS. A 20 dB contrast would place music at −40 dBFS RMS, so its correction is −26 dB, or a gain of about 0.0501. Multiplying by 0.1 would not establish that contrast because the starting signals are unequal. These RMS values do not specify final integrated loudness.

Signals sum before master processing. Identical in-phase signals can add about 6 dB; uncorrelated equal-power sources about 3 dB. Leave headroom for overlaps. Master compression can alter the balance, so separate muted exports are not guaranteed to equal pre-master isolated stems.

## Author ducking from known speech regions

Build one ordered gain envelope from all known speech intervals. Convert composition intervals into the music clip's local time and schedule every event through `host.at`. Merge overlapping fade/hold windows so recovery on one phrase does not fight the next fade-down.

A provisional starting treatment is to fade down 150–300 ms before speech, hold through short pauses, and recover over 500–1000 ms after a short post-speech hold. An additional 6–12 dB reduction may be useful, but it is not the same quantity as a 20 dB VO/music contrast. An already quiet bed may need little extra ducking. These timings and depths are adjustable heuristics, not standards.

Clamp the envelope to the clip, initialize the right value if speech begins at zero, and preserve continuity across visual cuts. Do not raise music on every breath. Short speech gaps may warrant staying ducked. The managed compressor has no external sidechain input; deterministic gain automation is the straightforward mechanism for an authored film.

Keep a continuous bed across cuts when appropriate. For a bed change, level-match comparable passages and choose a crossfade from the actual signal relationship. Do not rely on the engine's short boundary gate as an artistic transition.

## Measure the decoded final file

The engine uses protective master compression, not a certified true-peak limiter or BS.1770 loudness normalizer. Preview monitor volume is not an exported master level. Do not infer compliance from compressor settings.

With a suitable FFmpeg build available, analyze decoded audio from the exported MP4:

```sh
ffmpeg -hide_banner -nostats -i artifacts/video.mp4 -map 0:a:0 -af "ebur128=peak=true" -f null -
```

Inspect integrated loudness, true peak, and local changes around cuts. For stem contrast, measure aligned source/stem intervals separately with a consistent method; the mixed file cannot identify each component's level by itself. Do not fabricate LUFS, true-peak, or intelligibility results when measurement or listening is unavailable.

Listen to the busiest overlap, quiet speech, cue attacks, and changed cuts. If peaks are high but average level is low, repair isolated transients or phrase dynamics before pushing the entire mix into compression. Re-export and remeasure after adjustments. Report the chosen target, measured result, listening checks, and any unverified requirement separately.

## Primary references to consult for a delivery profile

These are pointers carried forward from the earlier skill, not a claim of a fresh standards audit. Check the current document/version and recipient scope before asserting compliance:

- [ITU-R BS.1770](https://www.itu.int/rec/R-REC-BS.1770): loudness and true-peak measurement algorithms, not universal delivery targets.
- [EBU R128](https://tech.ebu.ch/docs/r/r128.pdf): broadcast loudness recommendation.
- [EBU R128 short-form supplement](https://tech.ebu.ch/docs/r/r128s1.pdf): specific short-form scope; do not reuse obsolete alternatives from older editions.
- [EBU metering specification](https://tech.ebu.ch/docs/tech/tech3341.pdf) and [LRA definition](https://tech.ebu.ch/docs/tech/tech3342.pdf).
- [W3C low or no background audio](https://www.w3.org/WAI/WCAG21/Understanding/low-or-no-background-audio.html) and [G56 technique](https://www.w3.org/WAI/WCAG22/Techniques/general/G56): read the applicability and exceptions.
- [FFmpeg ebur128 filter](https://ffmpeg.org/ffmpeg-filters.html#ebur128): analysis behavior and true-peak options.
