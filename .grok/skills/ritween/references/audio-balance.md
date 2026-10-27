# VO, music, SFX balance and loudness

Research checked: 2026-10-27. Read this when choosing levels, ducking, mastering, or matching scenes. Use [audio.md](audio.md) for the managed API and [audio-mix.md](audio-mix.md) for buses/effects. Source IDs below link to primary references at the end.

## Decision rules

For an explainer, make intelligible VO the anchor, then add music and effects around it. A music-led montage may have a different hierarchy. Follow an explicit delivery specification before any default here. Separate **published requirements/recommendations**, **software defaults**, and **Ritween starting heuristics**; do not present the last two as industry standards. No authoritative universal VO:BGM:SFX ratio was established by this research.

Measure the assets, not their fader settings. Equal gain values, equal sample peaks, and equal integrated LUFS across unrelated stems do not ensure perceived balance. Instrumentation, spectral masking, articulation, timing, channel layout, and playback device matter. Reduce competing layers or move an SFX out of a word before making the entire mix louder.

## Units and measurement windows

- dB gain is a relative change; dBFS is digital sample level; dBTP estimates intersample waveform peaks. A compressor threshold of −1 dB is not a verified −1 dBTP ceiling.
- LUFS/LKFS describe weighted loudness, not waveform amplitude. Integrated (I) measures the programme with gating; short-term (S) uses 3 seconds; momentary (M) uses 400 ms. Use BS.1770-compatible metering [S1, S2].
- Use I for the delivery file; S for sustained scene/phrase comparisons; M plus peak and listening for short transitions or hits. A 3-second window crosses short scene cuts, so it cannot isolate a one-second scene. Silence and gating can distort comparisons of separately measured clips.
- LRA is statistical loudness variation, not sample peak minus RMS, noise floor, or a direct scene-jump measurement. Do not impose an LRA target on short-form adverts/promos; R128 s1 explicitly rules that out [S4]. For longer content it is descriptive, not a universal pass/fail threshold [S5].
- Compare VO and background on the **same speech-active interval**, channel layout, and measurement method. Do not subtract full-song I from a speech-only I. An ungated RMS comparison is useful for background contrast; S/M stem comparisons are practical masking diagnostics, not proof of WCAG compliance.

## Published delivery and accessibility references

| Context | Published reference | Scope and application |
| --- | --- | --- |
| EBU broadcast production | −23 LUFS programme; maximum −1 dBTP for linear audio [S3] | Whole programme. QC loudness tolerance ±0.2 LU; ±1 LU only when attaining the target is impractical, e.g. live. Distribution may need lower peaks. |
| EBU short-form adverts/promos | −23 LUFS I; maximum −18 LUFS S; maximum −1 dBTP linear audio [S4] | Full mix, usually under 30 s, up to about 2 min. QC allowances: ±0.2 LU I, +0.2 LU S, ±0.3 dB peak measurement. Aim at the target, not tolerance edges. The old alternative −15 LUFS M was removed in 2016; do not apply it as current guidance. |
| EBU streaming of broadcast content | Preserve −23 LUFS with suitable metadata/playback; conditional interim distribution range −20 to −16 LUFS [S6] | The higher range addresses particular device/headroom situations without metadata management; it is not a universal web-video mandate. |
| AES internet audio guidance | AES describes −18 LUFS full-content normalization when speech cannot be measured separately [S7] | Useful context for speech-led online work; do not treat every AES audio recommendation as a platform-specific video upload rule. |
| Speech accessibility | Background at least 20 dB below foreground speech, or absent/switchable [S8, S9] | WCAG 1.4.7 is Level AAA and specifically covers qualifying prerecorded **audio-only** content; occasional 1–2 s sounds are excepted. For video, use the contrast voluntarily when clarity matters; do not claim this alone establishes video accessibility compliance. |

Platform playback normalization cannot repair masking, scene jumps, or clipped transients. Do not declare “YouTube requires −14 LUFS” or copy music-service targets into video delivery without checking the current recipient's own specification. A delivery target belongs to the final mix, not separately to every track.

## Ritween starting values: practical heuristics, not standards

Use these only when the brief has no recipient specification. They are an authored starting preset informed by the measurement and workflow sources, not numerical requirements quoted from those sources. Adjust after listening and measurement.

| Parameter | Start / useful adjustment range | How to decide |
| --- | --- | --- |
| Speech-led stereo web master | Start −16 LUFS I; consider −18 to −16 LUFS | Internal default. A deliberately energetic brief may choose −14 LUFS, but this is a creative choice. Internal QC aim ±1 LU of the chosen target; never substitute this tolerance for a delivery spec. |
| Final decoded AAC peak | Aim ≤ −2 dBTP initially; verify ≤ −1 dBTP unless recipient says otherwise | The extra 1 dB is an internal margin for codec overshoot, not a guarantee or standard. If exceeded, reduce gain and re-export/re-measure. |
| VO anchor | Start speech-active VO around the selected master target | Do not normalize each sentence independently to that I value. Balance comparable phrases, add other layers, then measure full-mix I again. |
| BGM during VO | Start 20 dB below VO average on matched active intervals | A creative 15–20 dB contrast may work for sparse instrumental music; 20–25 dB or no music may be needed for dense beds, difficult speech, or accessibility priority. The lower-contrast range does not meet the 20 dB accessibility reference. |
| Decorative SFX under VO | Start roughly 12–20 dB below VO on matched event windows | Brief hits need peak inspection and listening; a short click can be startling despite low averaged loudness. Never normalize a millisecond hit to the VO's integrated target. |
| Important transition/hero SFX | Place in a speech gap where possible | No universal absolute dBFS target. Set in context, inspect full-mix true peak and M, and avoid masking consonants. |
| BGM in a real narration gap | Initially raise 3–6 dB from its ducked level | Recheck full-mix loudness; do not automatically restore a full-volume music master. Music may become the anchor for a dedicated music-only passage. |
| Adjacent comparable VO phrases/scenes | Aim within about 1–2 LU S | Internal continuity check, not a standards limit. Investigate an unintended sustained jump over about 3 LU; allow deliberate story dynamics. Use M/ears for scenes too short for S. |
| Long-form speech-led dynamics | Optional initial LRA region 3–8 LU | Creative diagnostic only, if duration supports a meaningful LRA. Do not force this range on short videos, silence-led passages, or cinematic work. |

A lower background level is often better than increasingly heavy VO compression. Start with instrumental music with few competing vocal/midrange elements. If level alone fails, try a broad music cut around 1–4 kHz by 2–4 dB and listen; this is a heuristic, not a mandatory EQ curve. Keep VO near the centre and check mono compatibility. Filters can change peak levels, so meter after processing.

## Ducking without pumping

Audacity's documented software defaults are −12 dB duck amount, 1 s maximum pause, and 0.5 s fade-down/up settings [S10]. These are tool defaults, not universal mix specifications. Adobe documents amount, sensitivity, fade timing/position, and manual keyframe revision; slower fades suit VO beds [S11].

For Ritween, a useful **heuristic** is 6–12 dB extra reduction relative to the unducked bed, adjusted to reach the chosen VO/background contrast. This is not the same quantity as a 20 dB VO:BGM difference. If a quiet bed already meets the contrast, little or no extra ducking is needed.

Start fading 150–300 ms before speech so music is low by the first syllable; hold through the phrase, keep it down another 200–400 ms, then recover over 500–1000 ms. Merge adjacent speech regions when gaps are shorter than roughly 0.7–1.0 s, or when recovery plus the next fade-down would overlap. These are internal starting values. A fast energetic edit may need shorter ramps; a calm explanation may need longer ones. Avoid raising the music on every breath or punctuation pause.

Compute the entire envelope from known VO intervals before scheduling. Merge touching/overlapping duck windows and emit one chronologically ordered automation envelope, rather than letting separate ramps fight. Clamp times to the music clip, finish fades within its duration, initialize the correct level when speech begins at time zero, and never reset gain at a visual cut. Preview seeking must recover the same envelope state as continuous playback.

`DynamicsCompressorNode` has no external sidechain input. Use deterministic music `GainNode` automation through `host.at(localSeconds)`; do not pretend connecting VO to a normal compressor input creates sidechain ducking. Separate VO/BGM/SFX tracks permit independent muting; their schedule can share immutable composition-time speech regions converted to each clip's local times.

## Gain calculation and a worked example

```ts
const dbToGain = (db: number) => 10 ** (db / 20);
// Relative gain: −6 dB ≈ 0.501; −12 ≈ 0.251; −20 = 0.1.
// These are amplitude multipliers, not output LUFS or dBFS targets.
```

For an unchanged signal away from gates and dynamics processing, estimated gain correction in dB = desired measured level − current measured level. Re-measure after applying it. Do not multiply an arbitrary source by 0.1 and assume it is now 20 dB below a different source.

Example, using ungated RMS over the same speech-active interval and identical channel accounting: VO measures −20 dBFS RMS; music measures −14 dBFS RMS. A 20 dB contrast needs music at −40 dBFS RMS: music correction = −40 − (−14) = −26 dB, gain ≈ 0.0501. The gain is **not** simply 0.1 because the starting signals were unequal. If the music outside speech is set to −30 dBFS RMS, reaching −40 adds 10 dB ducking. These RMS numbers do not specify final integrated loudness. Sum all stems, measure full-mix LUFS/true peak, and make any final master change to all stems together; a shared gain preserves their pre-compressor contrast.

Do not sum dB values arithmetically. Two identical in-phase signals add about 6 dB; uncorrelated equal-power signals add about 3 dB. Leave headroom for overlapping SFX and crossfades. Final compression can change both balance and loudness.

## Scene continuity and Ritween constraints

Keep a continuous music clip across visual hard cuts when the music continues. Scene boundaries do not require audio cuts. For a new bed, level-match comparable passages before fading. Initial crossfade duration: 0.5–1.5 s, longer for calm material; respect musical phrases when practical. This timing is a heuristic.

Use equal-power fades for largely uncorrelated material; identical/coherent sources may rise at the midpoint and are often better served by complementary linear gains. Opposite polarity can cancel. Listen and meter the overlap. Overlapping clips require separate manifest tracks or sources within one clip graph; one track cannot hold overlapping clips. Extend clip duration to include reverb/release tails within the composition. The engine's small clip-gate ramps prevent clicks; they do not replace perceptual scene transitions.

Current `src/engine/audio.ts` and `src/engine/live-mix.ts` use a master `DynamicsCompressorNode` with threshold −1, knee 0, ratio 20, attack 0.002 s, release 0.12 s. It is a protective compressor, **not** a BS.1770 loudness normalizer or a certified true-peak brickwall limiter. Do not rely on it for final ceiling compliance; avoid driving it continuously. Preview monitor volume is not export gain. Recheck these implementation details when the engine changes.

The example per-voice gain `0.2` is a synthesis headroom starting point, never a VO/music/SFX balancing rule. Tune source/bus gain and automation in project audio factories; do not change the engine or add a separate audio context merely to balance a project.

## Measure, listen, and report

1. Record the chosen delivery profile, speech-active regions, baseline stem measurements, intended contrast, duck depth/timing, and deliberate dynamic exceptions. Without measurement tools, label settings provisional; do not invent measured LUFS/dBTP.
2. Balance VO phrases, add music, then SFX; check the most crowded overlap and each changed cut in context. Listen on headphones and a small speaker/phone, at a quiet monitoring level, and in mono. Every word should remain understandable.
3. Export the normal Ritween MP4. With FFmpeg available, analyze the **decoded final AAC**, not just source assets or a silent PNG [S12]:

   ```sh
   ffmpeg -hide_banner -nostats -i artifacts/video.mp4 -map 0:a:0 -af "ebur128=peak=true" -f null -
   ```

   Read the final I/LRA/true-peak summary and the M/S log around cuts. True-peak analysis needs a suitable FFmpeg build. For speech contrast, analyze aligned isolated stems before master dynamics, using the same intervals/method; the mixed MP4 alone cannot establish the individual levels. Separate muted exports may experience different master compression and are not exact pre-master stems.
4. If loudness is low but peaks are already high, correct rogue transients or phrase dynamics instead of raising everything into the limiter. An optional VO compressor starting point is ratio 2:1–3:1, attack 10–30 ms, release 80–200 ms, with threshold chosen for roughly 2–4 dB reduction on louder words. These are heuristics; do not copy an absolute threshold between unequal recordings. Prefer clip gain for isolated words.
5. Re-export after adjustments and measure again. Report chosen targets versus measured results, peak margin, masking/continuity listening checks, and unresolved limitations. Do not claim compliance from configuration values alone. Whole-program normalization cannot fix within-program balance.

## Primary sources and evidence boundaries

- **S1 — ITU-R BS.1770-5 (2023):** [measurement algorithm/status](https://www.itu.int/rec/R-REC-BS.1770). Defines loudness/true-peak measurement, not universal delivery targets.
- **S2 — EBU Tech 3341 (2023):** [metering specification](https://tech.ebu.ch/docs/tech/tech3341.pdf). I/S/M meter windows and behavior.
- **S3 — EBU R128 v5 (2023), recommendations h–m:** [official PDF](https://tech.ebu.ch/docs/r/r128.pdf). Broadcast target, tolerances, full-program scope, linear-audio peak limit.
- **S4 — EBU R128 s1 v3 (2020), recommendations b–g and history:** [official PDF](https://tech.ebu.ch/docs/r/r128s1.pdf). Current short-form targets; LRA limitation; removal of obsolete M alternative. Do not substitute the older 2014 search result.
- **S5 — EBU Tech 3342 (2023):** [LRA definition](https://tech.ebu.ch/docs/tech/tech3342.pdf). Statistical descriptor; does not mandate the heuristic 3–8 LU region above.
- **S6 — EBU R128 s2 v3 (2023), recommendations e–k:** [streaming PDF](https://tech.ebu.ch/docs/r/r128s2.pdf). Conditional distribution choices, metadata, device gain/headroom.
- **S7 — AES, Loudness Normalization:** [official explanation](https://aes.org/resources/audio-topics/loudness-project/loudness-normalization/). Accessible primary summary of TD1008. The directly indexed TD1008 PDF returned 404 during research; detailed numerical tables from that inaccessible PDF are not asserted here.
- **S8 — W3C WCAG 1.4.7 understanding:** [scope and exceptions](https://www.w3.org/WAI/WCAG21/Understanding/low-or-no-background-audio.html). AAA/audio-only limits matter when applying the 20 dB reference to video.
- **S9 — W3C G56:** [contrast technique and RMS example](https://www.w3.org/WAI/WCAG22/Techniques/general/G56). Supports matched average-level contrast; does not prescribe VO LUFS or gain-slider values.
- **S10 — Audacity Auto Duck:** [official parameter documentation](https://manual.audacityteam.org/man/auto_duck.html). Software defaults only; not the basis for a universal ducking standard.
- **S11 — Adobe Premiere Auto Ducking:** [official workflow](https://helpx.adobe.com/be_en/premiere/desktop/add-audio-effects/adjust-volume-and-levels/automatically-duck-audio.html). Supports context-sensitive fades and editable gain keyframes; does not establish our numeric timing ranges.
- **S12 — FFmpeg ebur128:** [official filter documentation](https://ffmpeg.org/ffmpeg-filters.html#ebur128). Analysis/logging and true-peak mode. It measures the output; it does not guarantee a good mix.

Recheck recipient/platform requirements when delivering; preserve source versions when revising. The internal preset, SFX contrast, continuity thresholds, EQ, compression, and transition timing above are explicitly adjustable engineering choices, not additional published standards.
