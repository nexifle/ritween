# Declarative Layout Hardening — Implementation and Decision Plan

Status: Proposed. This document specifies implementation work, prerequisite checks, decision branches, and release gates. It contains no implementation code.

## 1. Goal and Completion Contract

Make content-driven motion graphics predictable to author, measurable to inspect, and robust against variable text, state changes, motion, cameras, and clipping. Reduce manual coordinate arithmetic without promising automatic art direction.

This is an end-to-end plan, not a first-iteration proposal. Every workstream has a completion outcome or an explicit permanent capability boundary. An unmet prerequisite means **repair the named prerequisite and rerun its gate**, not silently omit the work or create a new plan.

Three outcomes must remain separate:

1. **Engine correctness:** implementation matches its documented measurement and rendering contracts.
2. **Layout compliance:** author-declared insets, gaps, alignments, and containment rules pass.
3. **Design quality:** hierarchy, density, readability, and optical balance receive human visual review.

Passing one category does not imply passing the other two.

## 2. Evidence and Ownership

Observed problems come from the logging-best-practice consumer project and its Gemini session: independent absolute positions, confused alignment axes, incorrect padding/frame order, backgrounds mistaken for constraints, exhausted Spacers, underestimated text height, weak inspection, and overconfident verification reports.

Basic alignment arithmetic has not been proven generally defective. Fix reproduced defects, not assumptions.

Primary implementation surfaces:

- `src/authoring/nodes.ts`: public nodes, modifiers, immutable options.
- `src/authoring/layout.ts`: measurement, allocation, placement, evaluated metadata.
- `src/authoring/renderer.ts`: paint behavior and debug visualization parity.
- `src/authoring/stage.ts`, `stage-entry.ts`, and `composition.ts`: evaluation lifecycle, clocks, inspection forwarding.
- `src/authoring/shared-elements.ts`: IDs and modifier traversal.
- `src/authoring/index.ts` and package root exports: public API propagation.
- `src/authoring/grid.ts`, charts, media traversal: compatibility checks for new wrappers.
- `cli/`, `bin/`, runtime entry points, engine renderer lifecycle: inspection integration; exact files must be recorded by Gate G0.
- `tests/`, existing authoring/browser validation scripts, package declarations and build tooling.
- `docs/authoring.md`, `CLI.md`, public skill references, and repository examples.

Do not modify the external consumer project without separate authorization. Put reusable regression fixtures in the repository; generated projects, comparisons, and evaluation reports belong under ignored `artifacts/`.

## 3. Scope Boundaries

These are permanent boundaries of this project, not unfinished work:

- No DOM renderer, CSS implementation, general constraint solver, or new layout dependency.
- No automatic aesthetic scoring, font shrinking, content deletion, or implicit clipping.
- No stock dashboard/window/terminal library.
- No automatic exhaustive discovery of branches in arbitrary author callbacks.
- No automatic error classification for all intersecting siblings.
- No node-level inference for arbitrary raw GPU Scene implementations.
- No exact CPU reconstruction of pixels produced by arbitrary shaders, image alpha, or irregular masks.

Where exact pixel behavior matters, this plan requires browser-rendered verification. Inspection must state its geometric accuracy instead of pretending conservative rectangles are exact visible shapes.

## 4. Execution Protocol

Each gate records: commit/artifact identity, tests executed, measured results, pass/fail status, and unresolved blockers. Keep generated evidence under `artifacts/`; do not commit reports unless requested.

A failed gate has only these outcomes:

- **Repair:** perform the specified prerequisite work, then rerun the gate.
- **Environment blocked:** stop affected validation, report the missing resource and exact command to resume. Do not claim completion.
- **Operator decision required:** stop for approval of a compatibility change, perceptual baseline, or resource budget. Do not silently weaken acceptance criteria.

Independent work may continue only when it does not depend on the failed contract. Do not release the feature set until all mandatory gates pass.

API names in this document are targets. Before publishing a new name, check for collisions. If a name already exists with different semantics, stop for an explicit naming decision and record that decision in this document; do not create aliases opportunistically.

### Approved API and CLI decisions

Operator approval recorded on 2026-11-04:

- Preserve the existing `StageScene.inspect()` name and return contract. Extend inspection to the `Scene` boundary through an optional structurally compatible capability, without aliases or engine imports from authoring.
- Follow the actual public `frame` CLI time validation: reject times outside the project duration instead of introducing clamping in `inspect`. Report requested and effective time for valid requests. This approved decision supersedes the clamping assumption in the G1 CLI contract; existing `frame` behavior remains unchanged.
- `ViewNode.background()` is a new method, distinct from Stage background options. Directional object padding extends the existing numeric method as specified, without adding aliases.

## 5. G0 — Inventory, Reproductions, and Baselines

### Required work

1. Trace CLI frame rendering from manifest loading through browser runtime, engine frame preparation, active scenes, project overlay, and render completion.
2. Record the actual files and public/internal interfaces required for inspection. Identify ownership and disposal of each Scene instance.
3. Search all callers of node-spec switches, tree traversal, evaluated-frame serialization, shared matching, and public types that will change.
4. Add characterization tests for legacy frame alignment, stack axes, modifier order, text height, fixed sibling overflow, Spacer exhaustion, Group isolation, Grid cells, offset without reflow, and nested Composition clocks.
5. Build a small regression fixture with search typing, variable title/status lengths, expanded and compact windows, warning text, scrolling logs, and an alert.
6. Give important nodes stable IDs. Store explicit state times and transition boundaries with the fixture.
7. Capture current geometry, selected frames, GPU pass counts, and performance baselines before changes.
8. Establish a reproducible browser/font environment and record browser version, GPU backend, output resolution, fonts, and dependency artifact.

### Gate

Proceed only when surprising legacy behaviors have explicit tests, the inspection integration route is known, and baseline measurements can be reproduced.

If a suspected bug cannot be reproduced, classify it as unproven and keep the reproduction attempt as evidence. Do not change arithmetic speculatively. If a real bug is found, add a failing test, fix its shared root cause, inspect every caller, and rerun the baseline suite before G1.

## 6. Compatibility Rules

### Operator-approved scope revision

The operator clarified that declarative-composition APIs on this branch have never been published to production. Compatibility requirements below apply to previously published engine/CLI behavior, not to obsolete intermediate declarative APIs within this branch. Unreleased declarative representations may be simplified directly without legacy adapters, aliases, or migration/version decisions. Preserve useful characterization tests as correctness evidence, but do not preserve an obsolete representation solely for compatibility. This decision supersedes conflicting compatibility requirements elsewhere in this plan; it does not waive correctness, validation, or release gates.

- Existing projects retain geometry and failure behavior unless a separately approved bug fix requires otherwise.
- New APIs validate new inputs strictly. Do not incidentally reject previously accepted legacy combinations.
- Newly detected legacy conflicts produce diagnostics by default, not new exceptions.
- Preserve `EvaluatedFrame.warnings` as strings. Preserve established messages/order where practical; add structured diagnostics without making old callers construct new mandatory fields.
- Existing frame, padding, offset, scale, clip, stack, Grid, and clock semantics are not redefined.
- Inspection fields are additive. Expensive inspection is opt-in; ordinary rendering does not serialize trees or run geometric rules.
- Any unavoidable legacy behavior change requires a minimal reproduction, migration guidance, and an explicit release-version decision before implementation continues on that change.

## 7. G1 — Structured Diagnostics and Inspection Transport

Implement observability before adding layout behaviors.

### Diagnostics contract

Each structured diagnostic contains a stable code, severity, semantic ID if available, exact path, evaluation-local clock, project clock when available, coordinate-space ID, explanation, relevant bounds, and numeric excess/deficit where applicable.

Initial codes: offered-size overflow, fixed-allocation deficit, unavailable inspection, ambiguous/missing rule target, and unsupported geometry operation. Later gates add unused-flex and rule failures.

Paths must be globally qualified by scene instance, nested Composition instance, and node path. IDs are scoped; repeated IDs in different Worlds are not globally unique. JSON serialization must preserve this distinction.

### Lifecycle integration

1. Define one optional scene-inspection capability at the existing scene boundary, avoiding implementation-class checks.
2. Forward authoring inspection through StageEntry/Shot creation without changing resource ownership.
3. Expose an engine/runtime snapshot of all active inspectable scenes and the persistent project overlay after normal frame preparation/rendering.
4. Associate the snapshot with the exact requested frame. Never return a previous render's tree after a failed or cancelled preparation.
5. Include raw Scene entries as unavailable with a reason, not empty successful trees.
6. Keep nested composition clock mappings, scene-local clocks, and project time distinct.
7. Release temporary browser/runtime resources using existing cancellation and disposal conventions.

### CLI contract

Add `ritween inspect` with existing project discovery and explicit `--project`, required finite `--time`, JSON on stdout, optional `--output`, and existing `--force` overwrite protection. Logs go to stderr. Use the normal frame command's time-range validation and report both requested and effective time (see the approved decision in Section 4).

Output includes schema version, package version, scene identities, clocks, capabilities, trees, and diagnostics. Serialize metadata, not texture resources or private media objects. Reject non-finite serialized geometry.

Initial output limit is 64 MiB UTF-8 for stdout or file output. If exceeded, fail clearly and suggest inspecting a narrower target; do not silently truncate. Add an exact node-target filter that retains ancestor/coordinate-space context. File output is atomic and does not destroy an existing file on failure.

Exit codes: 0 for successful inspection, 1 for runtime or selected validation failure, 2 for malformed command/rules input. Plain diagnostics do not change success unless `--fail-on error` is selected. Later assertion-rule failures return 1 by default when rules were explicitly requested.

### Gate

A public CLI invocation must return real-font geometry for a consumer manifest, both active scenes during overlap, and project overlay metadata. Cancellation and unsupported raw scenes must be tested.

If lifecycle access is missing, implement the optional capability and forwarding first. Do not bypass this with internal globals, deep imports, or a separate renderer script. If a transition projection is not yet available, publish capability metadata and continue to G3; final completion still requires G3 coverage.

## 8. G2 — Additive Authoring Primitives

### 8.1 Frame axes

Add `alignX` and `alignY` accepting start/center/end. Axis-specific values override legacy `align`; otherwise legacy `align` applies; otherwise center applies. HStack/VStack `align` remains cross-axis. Test each axis, fallback, mixed precedence, and negative remaining space from oversized content.

### 8.2 Directional padding

Keep numeric padding unchanged. Add top/right/bottom/left options with zero defaults and finite non-negative values. Normalize internally to four insets. Child proposals subtract insets with a floor of zero; external measured size adds them back. Oversized children remain oversized and diagnosable.

### 8.3 Content-sized background

Add a background modifier accepting fill, radius, stroke, and stroke width, not width/height. It paints the wrapper's measured bounds before its child, changes no measurement, and does not clip or isolate.

Modifier order is significant: inner padding is painted; outer padding is not. Stroke extents follow the renderer's actual stroke convention, confirmed in G0. Retain primitive opacity semantics. No additional offscreen pass is permitted.

A background command must not duplicate its child's shared-element match. Before choosing ID forwarding, test existing matching behavior; keep one semantic target per declared ID and expose paint-role metadata for assertions. If current matching cannot represent this safely, extend matching identity handling first and prove existing transitions unchanged.

### 8.4 Weighted flexible slots

Add `flex(weight)` with default 1 and finite positive weight. Flex participates at the nearest enclosing sequential stack child boundary; it does not search into descendant stacks.

Define the boundary chain as the outer child and its single-child modifier wrappers, ending at the first drawable, sequential/overlay stack, Group, or Composition content node. Offset, opacity, scale, background, clip, frame, padding, and flex are inspected on this chain only. Do not traverse container children to find flex metadata.

Allocation contract:

1. Reserve all gaps and measure fixed siblings using legacy behavior.
2. Divide remaining non-negative main-axis space among flexible slots by weight.
3. Allocate an **outer slot**, then measure its wrapper chain inside that allocation.
4. Padding on the boundary chain is included in the slot budget, regardless of whether it appears before or after flex. Internal padding shrinks the content proposal; it never silently enlarges the assigned slot.
5. Flex is parent-allocation metadata, not another coordinate transform. Modifier order still controls backgrounds, clipping, and content placement.
6. Flexible cross-axis size is content-driven unless an explicit frame controls it.
7. Fixed children do not shrink. A deficit gives flexible slots zero and emits an allocation diagnostic.
8. Child content exceeding a slot remains visible unless clipped explicitly, with an overflow diagnostic.

Combination table:

| Boundary-chain combination                  | Result                                           |
| ------------------------------------------- | ------------------------------------------------ |
| Flex plus main-axis fill frame              | Valid; explicit flex weight wins                 |
| Flex plus numeric main-axis frame           | Invalid new-API combination; path-specific error |
| Flex plus numeric cross-axis frame          | Valid                                            |
| More than one flex wrapper                  | Invalid; no hidden weight multiplication         |
| Spacer without explicit flex                | Legacy weight 1                                  |
| Fill frame without explicit flex            | Preserve legacy allocation behavior              |
| Flex outside HStack/VStack                  | No allocation effect; unused-flex diagnostic     |
| Nested VStack/HStack containing flex/Spacer | Inner container owns its descendants' allocation |

Do not reinterpret legacy wrapped Spacer/fill behavior in projects without explicit flex. When mixed with flex siblings, characterize legacy wrappers and test the allocation adapter; do not let an implementation shortcut silently change old dimensions.

For text offered width zero, preserve existing wrapping and line-height behavior. No division by zero or infinite loop is allowed; any non-empty glyph extent beyond the zero slot is reported. Empty text retains its documented legacy line-box behavior.

### Gate

Proceed when the fixture can express padded cards, variable search content beside a fixed button, and vertically related cards without duplicated background dimensions or per-card Y arithmetic. Test all table combinations, both main axes, unequal weights, negative scale, clip order, and wrapper traversal.

If flex requires changing legacy allocation, isolate the new path to explicit-flex usage first. If isolation is impossible, stop for the compatibility decision in Section 6; do not remove flex from scope or silently change legacy behavior.

## 9. G3 — Geometry Spaces, Visibility, and Transition Parity

### Geometry model

Preserve legacy bounds/transforms. Add offered size, layout slot, content bounds, projected paint bounds, and visibility metadata in the optional inspection snapshot.

Every geometry value names its space. Use scoped space IDs and parent mappings for node layout, World, composition viewport, stage viewport, and final output pixels. Layout assertions use layout geometry; visual assertions use projected paint geometry. Never apply design-pixel tolerances directly to output-pixel coordinates without conversion.

Do not assume child bounds start at zero: existing placement may store positions in a shared parent space. Derive mappings from actual placement/render conventions, not type names.

Paint roles distinguish background from content. An aggregate content target can exclude background paint so a container's background does not make every inset appear zero.

### Transform and visibility requirements

- Match renderer order for offset, scale anchors, nested cameras, design-to-output scaling, composition viewport clipping, Group isolation, and project overlay.
- Normalize negative-scale extents. Zero-scale or zero-area paint has no positive-area visibility.
- Include stroke extents and text line-box geometry. Label line-box bounds separately from glyph ink; optical centering is not inferred from line boxes.
- Rectangular clipping can produce exact rectangular extent intersections. Rounded, circular, path, and image masks use conservative extents unless exact supported geometry is implemented and verified.
- Record accuracy as exact-rectangle, conservative, or unavailable. Occlusion by unrelated opaque siblings is not reconstructed.
- Opacity zero means no visible contribution. Near-zero nonzero opacity is not silently treated as zero.

### Transition coverage

Inventory every built-in transition and shared-element path. For cut, crossfade, slide, zoom, and wipe, expose the actual transform, opacity, and clipping used by the compositor. Shared-element inspection must distinguish scene output from separately animated shared paint and avoid double-counting hidden sources.

Reuse transition evaluation data where possible; do not maintain an independent approximation. For arbitrary custom shader transitions, expose exact pre-transition scene geometry and unavailable final shader geometry. This is a permanent capability boundary, not an incomplete built-in implementation.

### Gate and corrective branches

- If paint bounds disagree with renderer placement, fix transform composition before implementing assertions on that space.
- If a built-in transition has no inspectable representation, first refactor its existing evaluation into reusable internal data without changing its visual output, then add projection and browser parity tests.
- If a mask cannot provide exact shape coverage, retain conservative geometry and route exact visible-overlap questions to rendered verification. Do not report a false geometric failure as proven pixel overlap.
- G3 passes only when every built-in path has verified metadata and every intentional unavailable case has a tested capability result.

## 10. G4 — Assertion Engine and Safe Areas

### Assertion rules

Add a pure rule evaluator and CLI `--rules` JSON input. Validate schema, input size, rule IDs, finite thresholds, target syntax, allowed bounds kinds, and coordinate spaces. Set a 1 MiB rules-file limit and 10,000-rule limit; reject excess explicitly.

Targets use scoped IDs or exact qualified paths. Missing and ambiguous targets are errors. Pair comparisons convert to a shared supported space or return unsupported. Each rule selects layout-slot, content, or projected paint geometry explicitly.

Rules: containment, per-edge minimum inset, directional minimum gap, edge/center alignment, and explicit-pair non-overlap. Directional gap means signed separation on the named axis; it does not imply cross-axis overlap. Non-overlap excludes edge-touching from positive-area intersection.

Results are pass, fail, indeterminate, or not-applicable, with measured values, thresholds, accuracy, space, time, and involved targets. Not-applicable is reserved for inactive temporal scopes and must be counted separately from successful checks. Missing targets and unsupported operations cannot pass. Requested rules with fail or indeterminate return CLI status 1.

For conservative geometry, containment can pass only when the target's outer bound fits inside an exact container rectangle or a proven inner bound of the container. Containment inside another conservative outer bound is not sufficient proof. Non-overlap can pass when outer bounds are disjoint; intersecting outer bounds alone are indeterminate. Minimum gap can pass when outer bounds prove the requested separation; alignment of conservative bounds proves only bounds alignment, not ink alignment, and the result must state that distinction. A possible violation becomes indeterminate unless exact supported geometry proves it. Do not convert conservative intersections into proven pixel collisions.

Default tolerance is 0.01 units of the explicitly selected space. Allow a finite non-negative override per rule. Report the unit; pixel comparisons in browser validation use a separate tolerance.

### SafeArea node

Implement SafeArea as layout only, separating it from automatic visual policing. It occupies the parent proposal and offers its child the inset remainder, aligned at the safe rectangle origin. Insets are explicit finite non-negative values; excessive sums are invalid new input. Zero remaining size is allowed and can produce content overflow.

It does not clip or automatically warn about every descendant. It exposes a named safe rectangle for ordinary rules. Authors select which content IDs must remain inside it and at which sample times. Decoration can remain outside without suppression flags. Nested SafeAreas expose independent scoped rectangles.

Parent motion moves this local rectangle and its content together. Output-screen safety requires a separate rule against an output-space rectangle. No platform defaults are hard-coded.

### Temporal rule scope

Rules may apply to one inspection time or declare project-time start/end intervals and explicit sample times. Intervals default to [start, end); an explicit includeEnd boolean permits a final endpoint check. Start/end must be finite with end greater than start; sample times must be finite, unique, sorted, and inside the declared interval. The CLI still evaluates one time per invocation. Extend existing reusable authoring validation tooling to execute the rules file's authored schedule, reuse a browser/renderer session, aggregate results by rule and time, and fail when any scheduled check fails or is indeterminate. Outside an interval a rule is not-applicable, not pass. Missing targets inside an active interval fail. A scheduled rule with no executed applicable samples is a coverage failure, not successful validation.

### Gate

The regression fixture must prove exact insets/gaps at settled states, detect deliberately broken cases, and distinguish expected entrance/shake excursions by rule timing. Include layout-valid but visually poor fixtures to prove compliance is not presented as aesthetic judgment.

If rule targets include backgrounds accidentally, correct paint-role/target selection before relaxing thresholds. If a rule is indeterminate, obtain supported exact geometry or separately recorded browser evidence; do not silently ignore it. Browser evidence does not rewrite a CPU result to pass. Record rule ID, sample time, project/package identity, capture, verification method, and reviewer decision in the gate evidence. Any remaining indeterminate rule requires explicit operator acceptance as an exception; release reports must distinguish that exception from a geometric pass.

## 11. G5 — Typography and Browser Truth

1. Use redistributable deterministic fixture fonts with recorded license and preload path. Do not add test fonts to public runtime payloads unnecessarily.
2. Verify the intended font face is actually present and loaded; `document.fonts.check` alone must not be treated as proof that the named family exists rather than falling back.
3. Compare measurement and rasterization using the same font, weight, tracking, line height, and wrapping.
4. Test long words, explicit newlines, empty strings, combining characters, emoji fallback, mixed sizes, and delayed fonts introduced by conditional content.
5. If late conditional fonts fail readiness, implement explicit public font preloading/registration through Stage options before changing readiness behavior. Preserve deterministic frame preparation; never render a fallback frame and replace it asynchronously after capture.
6. Test scrolling with content moving inside a stationary frame/clip at fractional positions. Fix fixture modifier order, not the renderer, when the frame itself was accidentally animated.
7. Validate text raster clipping and stroke bounds against GPU output, with separate expectations for line-box geometry and actual ink.

Gate: no silent fixture font fallback, no stale font geometry, no content leak beyond the intended viewport, and repeatable geometry/pixels in the controlled environment. If font licensing, browser availability, or GPU acceleration is missing, report environment-blocked and resume this gate after provisioning; release remains blocked.

## 12. G6 — Documentation, Examples, and Agent Evaluation

Update authoritative docs, CLI help, public skill, and one realistic content-driven example together. Keep code/comments/English documentation in English.

Required explanations: alignment axes; frame versus clip; padding order; content background; fixed versus flexible slots; zero-width/overflow behavior; local safe area versus output safety; layout versus paint bounds; conservative versus exact geometry; transition/custom Scene capability limits; stationary scroll viewport; state/time validation.

Agent workflow must:

1. Confirm public package exports and types.
2. List states, content variants, motion boundaries, and rule sample times.
3. Establish spacing scale and typography, then build the content-driven skeleton.
4. Assign scoped semantic IDs and inspect real-font geometry.
5. Run explicit rules and inspect diagnostics.
6. Render individual frames/contact sheets for all states and visually review hierarchy, readability, density, contrast, and optical alignment.
7. Test forward/backward seeking in one renderer instance.
8. Export only after failures are fixed or the operator explicitly accepts a named exception.
9. Report measured results separately from subjective judgments and unsupported checks.

Add an evaluation brief covering variable row content, padded cards, content-height changes, safe areas, scrolling, and state changes. Use identical brief/skill/assertions in local and installed modes through the documented skill runner. Agents may not deep-import source, use internal globals, or write replacement renderers.

Run at least three baseline and three candidate trials with the same model/settings when agent execution is authorized and available. Record failures, number of repair iterations, geometry-rule outcomes, and visual review notes; do not infer general reliability from one success. If agent execution is unavailable, deterministic gates can continue, but label the agent evaluation unverified and obtain operator approval before claiming agent-reliability improvement. Do not delegate automatically without operator authorization.

## 13. G7 — Performance and Resource Budget

Establish the gate from measured noise rather than an arbitrary percentage.

1. Before implementation, capture two independent baseline batches of five runs each in the same browser/GPU environment. For each run warm 60 frames and measure at least 300 frames. For candidate comparison, use five runs per variant with alternating baseline/candidate order and preserve the baseline artifact so it remains executable.
2. Include representative fixtures and a 1,000-node stress fixture. Record tree size, text diversity, rendering passes, and output dimensions.
3. Report median/p95 layout CPU time, total frame time, measurement calls, surfaces/passes, and normal versus inspection-enabled cost separately.
4. For each summary metric, define the batch summary as the median of its five run values. Define noise as the absolute difference between the two unchanged baseline batch summaries. Compare median-of-five candidate and contemporaneous baseline summaries; flag a regression when the increase exceeds both twice that noise and 5% of the contemporaneous baseline summary. If either batch cannot be reproduced under the recorded environment, repair the benchmark environment before applying the gate.
5. A flagged regression blocks the gate until profiling identifies the cause and either a fix removes it or the operator approves the measured absolute cost and reason. Store the approved budget with the benchmark fixture; do not quietly adjust thresholds.
6. Background/layout wrappers add no GPU surfaces. Normal rendering performs no JSON serialization, geometric rule evaluation, or all-pairs collision search.
7. Optimize only measured bottlenecks. Any cache must have bounded ownership, size, invalidation, and disposal tests; no unbounded global text cache.

Inspection output size and latency are reported separately. If the 64 MiB limit is routinely reached, implement target filtering and verify it before seeking approval for a larger budget.

## 14. G8 — Package, Integration, and Release

Required validations:

- `npm test` and `npm run build`.
- Relevant authoring/browser checks with real WebGPU/WebCodecs where required.
- Unit tests for all new branches, malformed inputs, immutable options, compatibility behavior, serialization, cancellation, and determinism.
- Browser fixtures at state boundaries, motion samples, nested cameras, masks, all built-in transitions, project overlays, and scroll phases.
- In-session seek A → B → A with matching final geometry and controlled pixel tolerance; distinct A/B must prove real motion occurred.
- Isolated tarball install under `artifacts/`: public imports/types, inspect/rules exit behavior, frame, preview, and export through actual CLI entry points.
- Verify installed documentation, runtime bundles, declarations, and all exported new APIs. Do not change global links or installations.
- Verify preview inspection/debug integration uses the same geometry snapshot. Any UI exposure belongs in its owning preview feature and follows `src/preview/README.md`; no broad studio redesign.

Pixel comparison uses a controlled browser/font environment. Calibrate a tolerance with repeated unchanged renders, record it before candidate comparisons, and require review of changed baselines. Do not claim cross-machine exact pixel equality.

A package-only failure must be fixed in exports/build/packaging and retested from a newly created tarball. Checkout success is not a substitute.

## 15. Dependency and Failure Matrix

| Gate | Requires                                 | If blocked or failed                                                                            | Resume condition                                                         |
| ---- | ---------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| G0   | Repository and fixture access            | Inventory missing callers; minimize reproduction; provision browser/fonts                       | Reproducible baseline and complete integration map                       |
| G1   | G0                                       | Add optional lifecycle capability and safe serialization; fix stale snapshot/resource ownership | Actual public CLI inspection passes                                      |
| G2   | G0 and G1 diagnostics                    | Complete wrapper/allocation tests; isolate explicit-flex path; resolve compatibility decision   | New primitives and legacy snapshots pass                                 |
| G3   | G1 and G2 specs                          | Repair transform parity; expose compositor evaluation; mark permanent shader limits honestly    | All built-in projections verified                                        |
| G4   | G3                                       | Fix target spaces/roles; implement missing exact support or rendered verification               | Rules and SafeArea pass positive/negative tests                          |
| G5   | G2–G4                                    | Provision fonts/GPU; fix preparation or rasterization; correct fixture ordering                 | Real-font/render parity passes                                           |
| G6   | G1–G5                                    | Correct docs/examples; resolve deterministic failures before agent retries                      | Public workflow succeeds; agent evidence or explicit unverified approval |
| G7   | G0 baseline and completed engine changes | Profile and repair; request explicit measured budget approval                                   | No unexplained regression and no extra wrapper surfaces                  |
| G8   | All mandatory gates                      | Fix specific build/runtime/package/browser failure and rerun affected prerequisites             | Complete release checklist passes                                        |

There is no unspecified backlog for flex, SafeArea, visibility, or built-in transition inspection. They are required work behind the prerequisites above. Exact arbitrary shader/mask pixels remain a declared boundary with an explicit browser-verification route.

## 16. Final Acceptance Checklist

The feature set is complete only when:

- Legacy contracts and failure behavior are preserved or explicitly migrated.
- Content-sized cards do not duplicate background dimensions.
- Variable row content receives deterministic flexible allocation.
- Frame axes and directional insets are unambiguous.
- Every CLI rule has applicable executed sample coverage or is explicitly reported outside the requested scope; no empty schedule is counted as success.
- Any accepted indeterminate result remains labeled as an operator-approved exception, with evidence, rather than a geometric pass.
- Safe areas expose local layout rectangles and support explicit temporal/output rules.
- Layout, content, paint, visibility accuracy, and coordinate spaces are distinct.
- All built-in camera/transition paths have verified projection metadata.
- Custom/irregular unsupported exact geometry cannot silently pass assertions.
- Public CLI inspection, JSON rules, targeting, limits, cancellation, and exit codes work from an installed tarball.
- Typography, scrolling, state changes, and in-session seeking pass controlled browser checks.
- Agent guidance prevents the observed misuse and separates measured compliance from design review.
- Performance evidence and resource counts pass G7.
- Full tests/build/package gates pass and no required work is hidden behind a “later” label.

Known limits remain explicit: text may exceed a fixed budget; authors must resolve the design conflict. Geometry does not infer aesthetics. Finite samples do not prove every possible procedural-time state. Raw GPU scenes and arbitrary shader pixels require their own rendering evidence. These limits must appear in documentation and inspection capability metadata, not be discovered only after an agent has claimed success.
