# Request context: content-driven layout

This is an implementation example, not a mandatory visual template. The story moves
from a short healthy query to a longer incident explanation and then recovery. Spacing
uses 8/16/24/48 units; primary heading 30/40, body 20/28 and events 18/26.
Cards derive their height from content + padding. Only the event viewport is fixed.
The search row has 3:1 flexible query/status slots and a fixed intrinsic button.

## States and boundaries

- 0–0.4: decelerating 16-unit entrance; sample 0, 0.2, 0.4.
- 0.4–2: compact; query changes at 1; sample 1 and 1.999.
- 2–4: expanded incident copy, increased content height, scrolling at 19.25 units/s;
  sample 2, 3 and 3.999.
- 4–6: recovery copy and continued fractional scrolling; sample 4, 5.875 and 6.

Stable IDs belong to `scene:requests`, `layout`. Event IDs use persistent data keys.
Rules select slot gaps, content containment, title inset and stationary viewport alignment.
The output rule compares content to the stationary screen, not to a moving local safe
rectangle. These are ideal geometry rules, not glyph ink, raster clipping or aesthetic proof.

Fonts are Inter Regular/Bold, SIL OFL (license beside the assets), preloaded through
StageEntry with a project-owned family. No external FontFace registration is needed.
StageEntry snapshots descriptors and creates fresh owned scenes; do not mutate captured
content or share GPU resources. See the authoritative font ownership/conflict contract.

## Public workflow

From this directory, with the package CLI on PATH:

```sh
ritween inspect --project manifest.ts --time 2 --rules rules.json -o inspection.json
ritween frame --project manifest.ts --time 2 -o expanded.png
ritween preview --project manifest.ts --open
# Only after failures are repaired / named operator exceptions and visual review:
ritween export --project manifest.ts -o review.mp4 --resolution 480x360 --fps 24
```

Use new output paths or obtain overwrite permission before adding `--force`.
Run all authored samples, not just time 2. In the checkout, reusable browser validation:

```sh
node scripts/validate-rule-schedule.mjs --project examples/content-layout/manifest.ts --rules examples/content-layout/rules.json --output artifacts/g6/schedule.json
```

The runner records captures, coverage and same-FrameSource ABA. Review all state frames
and a contact sheet for hierarchy/readability/density/contrast/optical alignment. Passing
rules does not authorize an aesthetic claim; human approval must be recorded separately.
The nine-step [skill workflow](../../skills/ritween/references/layout-validation.md) applies.

## Identical local / isolated installed evaluation

Use [the evaluation brief](evaluation-brief.md) unchanged in both modes. Keep this
example, fonts, rules, public skill and assertions byte-identical. From the same caller
cwd replace only `ritween` with:

```sh
node /absolute/path/to/ritween/scripts/skill-cli.mjs local <arguments>
node /absolute/path/to/ritween/scripts/skill-cli.mjs installed <arguments>
```

Installed mode requires PATH prefixed with an isolated fresh tarball installation's
`node_modules/.bin`; no npm link or fallback. Runner preserves cwd and arguments, never
installs. Generated projects/evidence belong under ignored `artifacts/`, not the skill.
No independent agent trials may be claimed from deterministic script runs.
