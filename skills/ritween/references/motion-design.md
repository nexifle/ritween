# Motion design: from brief to moving image

Treat a video as a message unfolding over time, not a decorated slide or a web page with everything animated. A strong result has a subject-specific visual identity, a readable sequence, and motion that directs attention. Technical correctness is necessary but does not establish visual quality.

## 1. Extract a usable brief

Before choosing an aesthetic, identify:

- **Subject and audience:** what is being explained or presented, and to whom?
- **Single takeaway:** what should the viewer remember or do after watching?
- **Context:** aspect ratio, delivery platform, duration, viewing size, and whether sound can be assumed.
- **Content:** actual copy, claims, brand constraints, supplied assets, and any required closing message.
- **Scope:** new direction, refinement of an existing identity, or a narrowly requested edit.

Reuse established brand decisions and the existing project's visual language unless redesign is requested. Fill nonblocking gaps with explicit, reasonable assumptions. Ask only when missing information materially changes the message, production method, or deliverable. Do not invent product facts, testimonials, or performance claims to fill a composition.

For a small task, a few sentences are enough. Do not turn a simple video into a lengthy approval process or generate planning files unless useful or requested.

### Intent before spectacle or examples

The brief is the authority; reference material supplies techniques, not a replacement brief. Before opening an example, extract the intended message, style constraints, readability needs, and audio expectations. Do not copy its subject, copywriting, palette, duration, or sequence merely because its code is convenient.

Words such as "dynamic," "outstanding motion designer," or "showcase your strength" describe ambition, not a request for psychedelic shaders, dense particle fields, camera turbulence, or distorted text. When a subject or aesthetic is missing, choose and briefly state a coherent, low-risk direction: clean hierarchy, readily readable text when text is used, and expressive coordinated motion. This is a fallback for ambiguity, not an override of an explicit experimental, maximalist, or text-free brief. If clean text and sound are requested, treat both as deliverables, not optional decorations.

For example, "Create a 15-second dynamic motion video that showcases your strength" can reasonably become a concise typographic-and-geometric study with a stated theme, connected transformations, and a restrained soundtrack if the user authorizes or requests audio. It does not imply a shader-effects reel. Do not silently infer a preference for sound from the word "dynamic" alone. Keep copy short and purposeful rather than inventing marketing claims.

Shader code is a rendering technique, not an art direction. Choose effects because they communicate the concept; do not distort or obscure essential text to demonstrate GPU capability. Put expressive movement around a stable reading region rather than forcing viewers to decode moving, warped letters.

## 2. Choose art direction from the subject

Adapt the subject-led approach of frontend design, not its page structure or interaction patterns. Draw from the subject's materials, tools, processes, forms, and vocabulary. A botanical explainer, a precision instrument launch, and a community event should not receive the same visual system with different accent colors.

Make a compact direction before coding:

| Decision | Specify |
|---|---|
| Thesis | One sentence connecting the visual treatment to the subject and message |
| Palette | A small set of named colors with exact values and roles: background, foreground, accent, supporting tones |
| Typography | Display and supporting roles, hierarchy, weights, and spacing; one family can serve both roles when appropriate |
| Composition | Focal point, alignment, negative space, safe area, and relationships between elements |
| Signature | One memorable visual idea rooted in the brief |
| Motion language | How elements arrive, develop, settle, and leave; how energetic or restrained the piece feels |
| Emotional intent | What the audience should feel, and which timing, path, and amplitude choices support it |

Use real copy while composing, not placeholder text that hides wrapping and reading-time problems. Confirm that intended fonts and assets are available and usable; do not download assets or send content to external generation services without authorization. Choose a deliberate fallback when an asset is unavailable and state meaningful substitutions.

Be bold in one place. A distinctive transformation, unusual crop, typographic treatment, or material motif can carry the identity while surrounding elements remain disciplined. Do not require novelty at the expense of an explicit brief. Familiar aesthetics are valid when they serve the subject; they are weak when used automatically.

Avoid defaulting to gradients, glowing particles, floating cards, arbitrary counters, or decorative numbering. These can be appropriate, but each should explain or reinforce something. Numbering implies a real sequence; a visual connector implies a real relationship.

Match complexity to the direction. Minimal work needs precise spacing and timing; maximal work needs enough crafted detail to feel intentional. Neither is an excuse for generic output.

## 3. Storyboard the message as beats

Describe the order in which the viewer understands the idea. Do not force every video into an opening headline, three feature cards, and a logo end card. A demonstration, reveal, comparison, or continuous transformation may tell the story better.

Use a short beat sheet:

| Time range | Viewer learns | Visual focus | Motion and handoff | Reading/settling time | Audio cue |
|---|---|---|---|---|---|

Populate it with actual content, not labels such as "cool intro." Use absolute composition times, ensure ranges fit the requested duration, and reserve time for reading and recognition after entrances. If content does not fit, shorten the copy or reduce beats before accelerating everything.

A beat is not necessarily an engine scene. Several beats can live in one continuous scene. Choose scene boundaries for meaningful cuts or resource organization, not for every animated element.

For each beat, specify the initial state, the evolving relationship, the stable reading anchor, and the final state that feeds the next beat. "Fade in title, wait, fade out" describes visibility, not development. Prefer connected transformations over repeatedly emptying and rebuilding the frame when continuity serves the message. State the motion thesis in one sentence, for example: "Separate parts find a shared path, assemble into a useful whole, and become the anchor of the closing message." That thesis must fit the current brief; it is not a universal story.

### Example direction, not a reusable template

Brief: a six-second silent social clip for a bicycle repair workshop, showing how a bent rim returns to alignment. Proposed direction: workshop precision, pale metal surfaces, dark graphite labels, and one spoke-orange accent. Signature: an off-center wheel outline settles into a true circle.

| Time range | Viewer learns | Visual focus | Motion and handoff | Reading/settling time | Audio cue |
|---|---|---|---|---|---|
| 0–1.2 s | The wheel is out of alignment | Offset rim and the short line "A wobble?" | A restrained wobble establishes the problem, then settles for inspection | Keep the phrase visible beyond its entrance | None required |
| 1.2–4 s | The workshop corrects the alignment | Rim converging on a stationary guide | One controlled correction transfers focus to the centered form; avoid competing text entrances | Allow the corrected shape to register | Optional subtle mechanical accent |
| 4–6 s | Where to act | The corrected wheel and "Book a wheel check" | Hold the wheel still; reveal the closing line without restarting the whole composition | Keep the final message readable through the ending | Optional soft resolution |

These timings and motifs belong to this example. Adapt the structure to each brief rather than reproducing its look or sequence. A silent-first brief must remain understandable with no soundtrack.

## 4. Choreograph attention

For each beat, decide what the viewer notices first, what changes, and where attention lands next. Establish one dominant focus, not a one-moving-object limit. Supporting elements may move together along paths, adjust in response, or maintain a restrained rhythm while a focal transformation leads. Avoid several unrelated events competing at equal visual strength.

- **Entrance:** establish the focal element before secondary explanation. An opacity or position reveal is useful only if it improves the reading order.
- **Development:** animate the property that explains the idea. Changing length can express growth; alignment can express correction; a connector can express dependency. Decorative bouncing explains none of these by itself.
- **Hold:** allow text, shape, or relationship to be understood. Entrance time is not equivalent to unobstructed reading time. Keep the reading anchor settled while coordinated supporting motion can continue outside it. Freeze the whole composition only when stillness has a purpose; do not fill the hold with arbitrary ambient noise just to keep pixels changing.
- **Exit or handoff:** move attention to the next idea while preserving an anchor such as position, shape, scale, or color where useful. A clean cut is often stronger than an elaborate transition.

Choose easing by intent: a smooth deceleration for arrival, a more even progression for an explanatory sweep, a restrained overshoot only when the subject calls for elasticity. Avoid giving every element the same generic spring or making every beat land on a beat of music. Vary rhythm at the level of the story while keeping a small, coherent motion vocabulary.

Use stagger to encode order or grouping, not automatically for every letter, line, and icon. Group elements that belong together; do not make the viewer chase text while reading it.

Design at the intended output size. Check line length, contrast over moving backgrounds, edge margins, and whether fine strokes survive compression. Essential meaning must not depend on color alone. Avoid rapid high-contrast flashes and unnecessary camera movement. Where a low-motion treatment is requested, use calmer reveals and holds rather than assuming a browser preference automatically changes the exported video.

Treat audio as a second channel, not a repair for unclear visuals. Use accents sparingly for meaningful events, leave space, and keep speech intelligible if supplied. Do not fabricate a voiceover or add music when it contradicts the brief.

### Give the movement character and physical logic

Connect three decisions: what the viewer should feel, what change tells the story, and what movement makes that change believable. Calm can come from measured paths and controlled acceleration; excitement can come from decisive changes and contrast without making every element bounce. These are contextual choices, not universal emotion-to-easing formulas.

Define a small motion vocabulary for the project: a few timing roles such as accent, travel, and settle; related easing behaviors; and an approach to weight or elasticity. Keep related objects consistent while varying rhythm for narrative emphasis. Do not map "dynamic" automatically to a preset with aggressive overshoot.

Borrow animation principles selectively:

- **Anticipation:** a brief preparatory movement can make a substantial action easier to follow. Omit it when it delays comprehension or becomes a repetitive wind-up.
- **Follow-through and overlap:** related parts can trail a primary movement and settle at slightly different times. Derive those offsets from timeline time; do not introduce playback-dependent simulation.
- **Arcs and material behavior:** organic subjects may suit curved paths; mechanical processes may need straight travel. Weight can be suggested by acceleration and settling without arbitrary distortion.
- **Secondary action:** let attached or related elements respond to the main event, such as a connector tightening as objects align. The response should have a visible cause; unrelated ambient wobble is not a substitute.
- **Staging and restraint:** distinguish focal, supporting, and optional ambient movement through contrast, amplitude, and placement. These are roles, not a requirement to add three animated layers to every composition.
- **Pose-to-pose planning:** establish clear starting, turning, and resolving states before interpolating them. Check the intermediate silhouettes and relationships, not just attractive endpoints.

Time for the film, not a UI response table. Choose durations from travel distance, perceived weight, reading load, output FPS, and available story time. A UI rule such as "all stagger below 500 ms" is not a video rule. At 30 fps a 50 ms event spans only about one or two frames; preview at the delivery FPS before relying on such a small gesture. Keep procedural spring-like or oscillatory motion analytically seekable or explicitly precomputed.

Use easing when it expresses the action; constant-speed movement is appropriate for conveyor travel, scans, or other deliberately uniform motion. Likewise, avoid fixed quotas on the fraction of moving elements or distance traveled: a coordinated group crossing the frame can remain clear. Judge grouping, attention, and reading stability instead.

### Choose motion mechanisms by meaning

These are techniques to implement, not built-in Ritween APIs or an effects checklist. Select only what serves the brief.

| Mechanism | Useful meaning | Readability guardrail |
|---|---|---|
| Continuous shape transformation | Change of state, simplification, evolution | Keep the silhouette and correspondence between states understandable |
| Coordinated paths | Journey, flow, sequence, shared direction | Keep paths away from essential text and establish a clear destination |
| Assembly / disassembly | Components, structure, cause and result | Preserve part identity and avoid every part arriving at once without hierarchy |
| Fields or particles | Distribution, aggregation, collective behavior | Prefer meaningful grouping over decorative density |
| Depth and parallax | Spatial relationships, layers, scale | Move layers coherently; avoid gratuitous camera travel |
| Material or light evolution | Surface qualities, changing conditions | Keep luminance changes behind text controlled |
| Kinetic typography | Emphasis, rhythm, relationships between words | Let words become fully readable; use distortion only when the brief supports it |
| Persistent anchors and handoffs | Continuity between ideas | Retain a recognizable element while its role or surroundings change |

Do not maximize the number of techniques, shaders, particles, or moving elements. Simple WebGPU geometry with precise timing can outperform elaborate effects. Fade and slide remain useful supporting devices; a film made only of entrances and long pauses usually needs a stronger motion thesis.

## 5. Translate the plan into Ritween

Keep design decisions independent of the renderer, then check that the chosen production method is actually available:

- Use [authoring](authoring.md) for lifecycle, public contracts, and seekable time evaluation. Express motion directly from timeline time rather than playback history.
- Match storyboard cuts to supported scene cuts. Continuous transformations, fades, and internal overlapping elements can be drawn within a scene; do not invent an overlapping scene-transition API.
- Typography needs a real rendering path, such as a prepared text texture with an available font, or another explicitly implemented WebGPU-compatible technique. DOM text, TSX, and CSS animations do not automatically appear in exported frames. Verify the chosen path at output resolution.
- Prepare and load fonts, textures, and other assets before synchronous rendering. A drawn placeholder is not completion of a requested illustration or type treatment.
- Use context resolution for layout so preview/export sizing does not break the composition. Different aspect ratios may need recomposition rather than a uniform scale.
- Use [audio](audio.md) for actual clip scheduling. Visual beat boundaries and audio clip boundaries are related design choices, not automatically the same thing.

If a desired technique is unavailable, prefer a feasible treatment that preserves the concept. Explain material compromises instead of claiming the renderer supports an imaginary component or effect. Do not expand the framework or install a new rendering stack unless that work is part of the user's request.

### Optional runnable mechanics study

After choosing a direction from the actual brief, consult [the motion study](../assets/motion-study/README.md) only if you need an example of coordinated paths, assembly, persistent text textures, or procedural audio. It is a six-second technical study, not a template, aesthetic authority, or quality ceiling. Select a mechanism to learn, then implement it in the user's own direction. Do not copy its title, palette, duration, typography, labels, trajectories, or beat order by default; do not merely stretch its timeline to satisfy a longer request. It demonstrates one approach, not a requirement to use assembly animation.

## 6. Critique frames and motion separately

Before implementation, compare the direction to the brief: would the same plan fit an unrelated subject with just a name swap? If yes, revise the signature or visual language. Do not expose every discarded option; present the chosen direction and meaningful assumptions concisely.

After implementation, use [preview and export](preview-export.md) for technical checks and review both:

**Keyframes:** inspect the opening, the most informative moment of each beat, handoffs, and the ending. Check subject-specific identity, focal hierarchy, typography, margins, contrast, and whether the actual requested content is present. Remove decoration that competes with the message.

**Playback:** watch at intended speed. Check reading time, continuity, easing, pacing, settling time, and audio relationships. Identify stretches that merely wait after an entrance, repeated fade/reset patterns, or identical motion applied to every beat. Check that active supporting motion does not make the reading anchor harder to follow. A beautiful contact sheet does not demonstrate good timing. A moving render does not demonstrate good composition. Pixel differences can flag static intervals, but noise can also change every pixel: frame-change scores do not establish good choreography. If playback or listening is unavailable, report that limit instead of asserting it feels polished.

Evaluate success through questions, not arbitrary aesthetic scores:

- Can the intended audience state the main message after one viewing?
- Does the visual direction belong to this subject and respect supplied brand constraints?
- Does each major motion clarify an idea or hand attention to the next one?
- Can text be read at the delivery size without pausing?
- Does the final moment resolve the piece and leave the intended takeaway?

Use human feedback for taste and communication quality. Pair it with objective checks for timing, content, clipping, and export integrity; passing those checks alone does not prove the video is compelling.
