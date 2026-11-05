/**
 * Browser checks for the G2a additive authoring primitives
 * (docs/plans/declarative-layout-hardening.md §8.1–8.3): per-axis frame alignment,
 * directional padding, and content-sized backgrounds.
 *
 * Reusable, not a one-off script: validate-authoring.mjs calls it next to the other
 * authoring pixel checks. Two contracts are proven here that CPU layout cannot prove:
 *   - background paint order (behind the child), per-primitive opacity, negative scale,
 *     and clip order match the renderer's actual output;
 *   - a background adds no GPU render pass, measured with the existing
 *     installDeviceInstrumentation wrapper from scripts/layout-baseline-harness.ts.
 */
export async function validateLayoutPrimitives(page) {
  return page.evaluate(async () => {
    const { FrameSource, Stage, Box, Text, HStack, VStack } = await import("/src/index.ts");
    try {
      const font = new FontFace(
        "Inter",
        "url(/tests/fixtures/fonts/Inter-Regular.woff2)",
      );
      await font.load();
      document.fonts.add(font);
    } catch {
      // Font already registered or environment fallback
    }
    const errors = [];
    const white = [255, 255, 255, 255],
      red = [255, 0, 0, 255],
      blue = [0, 0, 255, 255];
    // Blue 20x20 child with a 10-unit left inset: the background spans the padding, so
    // red is visible beside the child and must disappear wherever the child covers it.
    const paddedCard = (fill = "#FF0000") =>
      Box({ width: 20, height: 20, fill: "#0000FF" })
        .padding({ left: 10 })
        .background({ fill });
    const cases = [
      {
        // Background command first, child second: a flipped order would hide the child.
        name: "background-order",
        view: () => paddedCard().offset(10, 10),
        samples: [
          [15, 20, red],
          [30, 20, blue],
          [45, 20, white],
        ],
      },
      {
        // Per-primitive opacity, not an isolation boundary: the child blends over the
        // already-faded background, so the overlap is neither pure blue nor pure red.
        name: "background-opacity",
        view: () => paddedCard().opacity(0.5).offset(10, 10),
        samples: [
          [15, 20, [255, 128, 128, 255]],
          [30, 20, [128, 64, 191, 255]],
        ],
      },
      {
        // Negative scale mirrors the background paint together with the child.
        name: "background-negative-scale",
        view: () => paddedCard().scale(-1, 1, [0, 0]).offset(40, 10),
        samples: [
          [15, 20, blue],
          [35, 20, red],
          [45, 20, white],
        ],
      },
      {
        // Clip order: the background is painted inside the clip surface and trimmed to it.
        name: "background-clip",
        view: () =>
          paddedCard().frame({ width: 10, height: 10, align: "start" }).clip(),
        samples: [
          [5, 5, red],
          [15, 5, white],
          [5, 15, white],
        ],
      },
      {
        // Per-axis alignment: alignX end + alignY start inside a fixed frame.
        name: "frame-axes",
        view: () =>
          Box({ width: 20, height: 10, fill: "#FF0000" }).frame({
            width: 60,
            height: 40,
            alignX: "end",
            alignY: "start",
          }),
        samples: [
          [45, 5, red],
          [20, 5, white],
          [45, 20, white],
        ],
      },
      {
        // Directional padding: a right-only inset widens the slot, not the top/bottom.
        name: "directional-padding",
        view: () =>
          Box({ width: 20, height: 20, fill: "#FF0000" })
            .padding({ right: 10 })
            .offset(10, 10),
        samples: [
          [20, 20, red],
          [35, 20, white],
          [20, 35, white],
        ],
      },
      {
        // The declared wrapper ID must not change the painted result either: `.id()` before
        // and after `.background()` render identical pixels (one semantic target, one pose).
        name: "background-id-order",
        view: () =>
          Box({ width: 20, height: 20, fill: "#0000FF" })
            .padding({ left: 10 })
            .background({ fill: "#FF0000" })
            .id("card")
            .offset(10, 10),
        compareWith: () =>
          Box({ width: 20, height: 20, fill: "#0000FF" })
            .padding({ left: 10 })
            .id("card")
            .background({ fill: "#FF0000" })
            .offset(10, 10),
        samples: [
          [15, 20, red],
          [30, 20, blue],
          [45, 20, white],
        ],
      },
      {
        // Stroke extents use the renderer's inside-stroke convention: measured row x=0..9 is
        // byte-identical to the same Box stroke, so the band lies inside the wrapper bounds
        // (antialiased 0 and 3..4 inclusive) and the child covers everything after x=10.
        name: "background-stroke",
        view: () =>
          Box({ width: 20, height: 20, fill: "#FFFFFF" })
            .padding({ left: 10 })
            .background({ fill: "#FF0000", stroke: "#0000FF", strokeWidth: 4 }),
        samples: [
          [2, 10, blue],
          [6, 10, red],
          [15, 10, white],
          [35, 10, white],
        ],
      },
      {
        // Flex allocation: weight 1 (25 px) vs weight 3 (75 px) across width 100.
        // Backgrounds fill the assigned outer slots.
        name: "flex-allocation",
        view: () =>
          HStack(
            [
              Box({ width: 10, height: 20, fill: "#FF0000" })
                .flex(1)
                .background({ fill: "#FF0000" }),
              Box({ width: 10, height: 20, fill: "#0000FF" })
                .flex(3)
                .background({ fill: "#0000FF" }),
            ],
            { gap: 0 },
          ),
        samples: [
          [12, 10, red],
          [60, 10, blue],
          [12, 30, white],
        ],
      },
      {
        // Deficit gives flexible slot 0, and .clip() trims content to the 0 slot so no red is drawn.
        name: "flex-zero-slot-clip",
        view: () =>
          HStack(
            [
              Box({ width: 100, height: 20, fill: "#0000FF" }),
              Box({ width: 50, height: 20, fill: "#FF0000" }).flex(1).clip(),
            ],
            { gap: 0 },
          ),
        samples: [
          [50, 10, blue],
          [80, 10, blue],
          [50, 30, white],
        ],
      },
      {
        // True font Inter inside flexible slot beside a fixed button at end.
        name: "flex-inter-font",
        view: () =>
          HStack(
            [
              Text("Search", { font: "Inter", size: 16, color: "#FF0000" }).flex(1),
              Box({ width: 20, height: 20, fill: "#0000FF" }),
            ],
            { gap: 0 },
          ),
        samples: [
          [90, 10, blue],
        ],
      },
      {
        // Internal clip and background capped by slot even when padding (40) > slot (20).
        // Blue fixed 80px (0..80), flexible slot 20px (80..100).
        // Red background is capped at 20px, so it fills 80..100 without inflating or pushing.
        name: "flex-inner-clip-padding-capped",
        view: () =>
          HStack(
            [
              Box({ width: 80, height: 20, fill: "#0000FF" }),
              Box({ width: 10, height: 20, fill: "#FF0000" })
                .padding({ left: 20, right: 20 })
                .background({ fill: "#FF0000" })
                .clip()
                .flex(1),
            ],
            { gap: 0 },
          ),
        samples: [
          [50, 10, blue],
          [90, 10, red],
          [90, 30, white],
        ],
      },
      {
        // Unclipped flexible child with content exceeding slot (content 30 > slot 20):
        // Content overflow remains visible without explicit clip.
        name: "flex-overflow-unclipped",
        view: () =>
          HStack(
            [
              Box({ width: 80, height: 20, fill: "#0000FF" }),
              Box({ width: 30, height: 20, fill: "#FF0000" }).flex(1),
            ],
            { gap: 0 },
          ),
        samples: [
          [50, 10, blue],
          [90, 10, red],
          [98, 10, red],
        ],
      },
      {
        // Nested padding with clip and background:
        // Blue fixed 80px (0..80), flexible slot 20px (80..100).
        // Outer padding left: 10 leaves level budget 10 (90..100).
        // Clip and background must be capped to 10px, starting at x = 90 and ending at x = 100.
        // At x = 85 (inside outer padding before clip): white background.
        // At x = 95 (inside clip and red background): red.
        name: "flex-nested-padding-clip-contained",
        view: () =>
          HStack(
            [
              Box({ width: 80, height: 20, fill: "#0000FF" }),
              Box({ width: 20, height: 20, fill: "#00FF00" })
                .padding(10)
                .background({ fill: "#FF0000" })
                .clip()
                .padding({ left: 10 })
                .flex(1),
            ],
            { gap: 0, align: "start" },
          ),
        samples: [
          [50, 10, blue],
          [85, 10, white],
          [95, 10, red],
        ],
      },
    ];
    const project = (view) => ({
      name: "layout-primitives",
      resolution: [100, 100],
      aspectRatio: [1, 1],
      duration: 2,
      scenes: [
        {
          id: "fixture",
          name: "fixture",
          source: "fixture",
          start: 0,
          duration: 2,
          transition: { type: "cut" },
          create: () =>
            Stage(() => view(), {
              designSize: [100, 100],
              background: "#FFFFFF",
            }),
        },
      ],
    });
    const pixels = async (source) => {
      const canvas = await source.render(0.5),
        copy = new OffscreenCanvas(100, 100),
        ctx = copy.getContext("2d");
      ctx.drawImage(canvas, 0, 0);
      return ctx.getImageData(0, 0, 100, 100).data;
    };
    for (const c of cases) {
      const source = await FrameSource.create(project(c.view), {
        width: 100,
        height: 100,
        onError: (e) => errors.push(String(e)),
      });
      try {
        const rendered = await pixels(source);
        if (c.compareWith) {
          // Same declared ID placed on the other side of the background modifier paints
          // identical pixels: the wrapper target did not reorder or duplicate any paint.
          const other = await FrameSource.create(project(c.compareWith), {
            width: 100,
            height: 100,
            onError: (e) => errors.push(String(e)),
          });
          try {
            const reference = await pixels(other);
            for (let i = 0; i < rendered.length; i++)
              if (rendered[i] !== reference[i])
                throw Error(
                  `${c.name}: ID before/after background differs at byte ${i}`,
                );
          } finally {
            other.dispose();
          }
        }
        for (const [x, y, expected] of c.samples) {
          const actual = [
            ...rendered.slice((y * 100 + x) * 4, (y * 100 + x) * 4 + 4),
          ];
          if (actual.some((v, i) => Math.abs(v - expected[i]) > 3))
            throw Error(
              `${c.name} at ${x},${y}: expected ${expected}, got ${actual}`,
            );
        }
      } finally {
        source.dispose();
      }
    }
    if (errors.length) throw Error(`FrameSource errors: ${errors.join("; ")}`);

    // Pass-count parity: a background must not add an isolated surface. Both variants
    // render through ONE FrameSource so the device is shared; the existing baseline
    // harness wrapper is installed for the whole measurement so counts cannot read zero.
    const { installDeviceInstrumentation } =
      await import("/scripts/layout-baseline-harness.ts");
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw Error("No WebGPU adapter; environment blocked.");
    const device = await adapter.requestDevice();
    const counters = {
      beginRenderPasses: 0,
      renderTargetTexturesCreated: 0,
      otherTexturesCreated: 0,
    };
    const restore = installDeviceInstrumentation(device, counters);
    const variant = {
      name: "layout-primitives-passes",
      resolution: [100, 100],
      aspectRatio: [1, 1],
      duration: 2,
      scenes: [
        {
          id: "fixture",
          name: "fixture",
          source: "fixture",
          start: 0,
          duration: 2,
          transition: { type: "cut" },
          create: () =>
            Stage(
              ({ localTime }) =>
                localTime < 1
                  ? Box({ width: 20, height: 20, fill: "#0000FF" }).padding({
                      left: 10,
                    })
                  : paddedCard(),
              { designSize: [100, 100], background: "#FFFFFF" },
            ),
        },
      ],
    };
    let plainPasses, backgroundPasses, plainTextures, backgroundTextures;
    try {
      const source = await FrameSource.create(variant, {
        width: 100,
        height: 100,
        onError: (e) => errors.push(String(e)),
      });
      try {
        await source.render(0.5);
        await source.render(1.5);
        counters.beginRenderPasses = 0;
        counters.renderTargetTexturesCreated = 0;
        await source.render(0.5);
        plainPasses = counters.beginRenderPasses;
        plainTextures = counters.renderTargetTexturesCreated;
        counters.beginRenderPasses = 0;
        counters.renderTargetTexturesCreated = 0;
        await source.render(1.5);
        backgroundPasses = counters.beginRenderPasses;
        backgroundTextures = counters.renderTargetTexturesCreated;
      } finally {
        source.dispose();
      }
    } finally {
      restore();
    }
    if (!plainPasses || !backgroundPasses)
      throw Error(
        `GPU instrumentation recorded zero render passes (plain ${plainPasses}, background ${backgroundPasses}); the device wrapper was not active.`,
      );
    if (plainPasses !== backgroundPasses)
      throw Error(
        `A background changed the render pass count: ${plainPasses} without, ${backgroundPasses} with.`,
      );
    if (plainTextures !== backgroundTextures)
      throw Error(
        `A background changed render-target count: ${plainTextures} without, ${backgroundTextures} with.`,
      );
    if (errors.length) throw Error(`FrameSource errors: ${errors.join("; ")}`);

    // Shared-transition parity, proven from rendered pixels rather than matcher matrices: a
    // background and the content it decorates must travel together. Every case keeps the
    // background visible (symmetric 10-unit insets), so a split shows as the red background
    // and blue content drifting apart, and a non-animated element shows as a pinned extent.
    // The move is 50 units, so a settled mid-transition element sits near x=25.
    const { World, Shot, Group } = await import("/src/index.ts");
    // `card()` returns the draw leaf; modifiers are applied by each case so the declared ID
    // lands exactly where the case intends (`id()` binds to the node it is called on).
    const card = () => Box({ width: 20, height: 20, fill: "#0000FF" });
    const inset = (node) => node.padding({ left: 10, right: 10 });
    const paint = (node) => node.background({ fill: "#FF0000" });
    const transitionCases = {
      // Non-isolated: ID on the draw leaf, then on the background wrapper, then both.
      "leaf-id": (i) => paint(inset(card().id("hero"))).offset(i * 50, 30),
      "wrapper-id": (i) =>
        paint(inset(card()))
          .id("hero")
          .offset(i * 50, 30),
      "distinct-ids": (i) =>
        paint(inset(card().id("inner")))
          .id("outer")
          .offset(i * 50, 30),
      // Isolated clip: the surface command must be corrected as ONE unit, with its contents
      // not re-applying the pose. Both ID placements are covered.
      "clip-wrapper-id": (i) =>
        paint(inset(card()))
          .clip()
          .id("hero")
          .offset(i * 50, 30),
      "clip-leaf-id": (i) =>
        paint(inset(card().id("hero")))
          .clip()
          .offset(i * 50, 30),
      // Isolated Group: the same contract through the Group surface, and through an inner
      // leaf declaration that the Group surface does not own.
      "group-wrapper-id": (i) =>
        Group([paint(inset(card()))])
          .id("hero")
          .offset(i * 50, 30),
      "group-leaf-id": (i) =>
        Group([paint(inset(card().id("hero")))]).offset(i * 50, 30),
      // Review repro: the Group/background wrapper declares `outer` (unmatched here) while the
      // direct Group child declares `inner` (matched). Descendant suppression must follow the
      // matrix the surface actually resolves, not the presence of candidate names, or `inner`
      // pins in place on the outgoing side.
      // Exactly the review repro: `outer` is declared ONLY on the outgoing Group wrapper, so
      // the transition never matches it, while `inner` on the direct child is matched on both
      // sides. The Group surface lists `outer`; the child must still animate under `inner`.
      "group-outer-unmatched": Object.assign(
        (i) => {
          const group = Group([
            Box({ width: 100, height: 20, fill: "#FFFFFF" }),
            card().id("inner"),
          ]).background({ fill: "#FF0000" });
          return (i === 0 ? group.id("outer") : group).offset(i * 50, 30);
        },
        // The white base already covers the travel range, so this case asserts motion only.
        { insets: false },
      ),
      // The clip analogue: the clip surface lists both declarations, the content keeps its own.
      // Exactly the review repro: `outer` is declared ONLY on the outgoing clip wrapper, so
      // the transition never matches it, while `inner` on the direct child is matched on both
      // sides. The clip surface lists `outer`; the child must still animate under `inner`.
      "clip-outer-unmatched": Object.assign(
        (i) => {
          const clipped = card()
            .id("inner")
            .clip()
            .background({ fill: "#FF0000" });
          return (i === 0 ? clipped.id("outer") : clipped).offset(i * 50, 30);
        },
        { insets: false },
      ),
      // Both IDs matched on both sides: still exactly one matrix, one paint per source.
      "group-both-matched": Object.assign(
        (i) =>
          Group([
            Box({ width: 100, height: 20, fill: "#FFFFFF" }),
            card().id("inner"),
          ])
            .background({ fill: "#FF0000" })
            .id("outer")
            .offset(i * 50, 30),
        { insets: false },
      ),
      // An inner ID the transition does not match must fall back to the matched outer one
      // rather than pinning the element in place.
      "inner-unmatched": (i) =>
        (i === 0
          ? paint(inset(card().id("inner"))).id("outer")
          : paint(inset(card())).id("outer")
        ).offset(i * 50, 30),
      // A world camera must not change the outcome: correction applies in world space.
      "camera-wrapper-id": (i) =>
        paint(inset(card()))
          .id("hero")
          .offset(i * 50, 30),
    };
    const extents = (data, channel) => {
      const xs = [];
      for (let x = 0; x < 100; x++) {
        const i = (40 * 100 + x) * 4;
        const [r, , b] = [data[i], data[i + 1], data[i + 2]];
        if (channel === "red" ? r > b + 40 && r > 60 : b > r + 40 && b > 60)
          xs.push(x);
      }
      return xs.length ? [Math.min(...xs), Math.max(...xs)] : null;
    };
    const transitionChecks = [];
    for (const [order, build] of Object.entries(transitionCases)) {
      // The camera case views the same world through a static camera, proving correction is
      // applied in world space before the camera mapping.
      const camera =
        order === "camera-wrapper-id" ? { x: 50, y: 40, zoom: 1 } : undefined;
      const project = {
        name: `layout-primitives-${order}`,
        resolution: [100, 100],
        aspectRatio: [1, 1],
        duration: 3,
        scenes: [0, 1].map((i) =>
          Shot({
            id: `scene-${i}`,
            source: "fixture",
            start: i,
            duration: 2,
            world: World(() => build(i), { size: [100, 100] }),
            camera,
            transition: i ? { type: "shared", duration: 1 } : { type: "cut" },
          }),
        ),
      };
      const source = await FrameSource.create(project, {
        width: 100,
        height: 100,
        onError: (e) => errors.push(String(e)),
      });
      try {
        const scan = async (time) => {
          const canvas = await source.render(time),
            copy = new OffscreenCanvas(100, 100),
            ctx = copy.getContext("2d");
          ctx.drawImage(canvas, 0, 0);
          const data = ctx.getImageData(0, 0, 100, 100).data;
          return { red: extents(data, "red"), blue: extents(data, "blue") };
        };
        const start = await scan(1.02);
        const mid = await scan(1.5);
        const end = await scan(1.98);
        // Motion-only cases cover the background with a white base, so only the content band
        // is meaningful there; the inset cases require both paints at every sample.
        const required = build.insets === false ? ["blue"] : ["red", "blue"];
        for (const [label, sample] of [
          ["start", start],
          ["mid", mid],
          ["end", end],
        ])
          for (const channel of required)
            if (!sample[channel])
              throw Error(
                `${order} ${label}: ${channel} paint vanished (${JSON.stringify({ start, mid, end })})`,
              );
        // 1. Where the fixture insets the content symmetrically, the background and content
        //    keep that inset at every sample, so a wrapper can never drift away from its paint.
        if (build.insets !== false)
          for (const [label, sample] of [
            ["start", start],
            ["mid", mid],
            ["end", end],
          ]) {
            if (!sample.blue)
              throw Error(`${order} ${label}: content paint vanished`);
            const leftGap = sample.blue[0] - sample.red[0];
            const rightGap = sample.red[1] - sample.blue[1];
            if (Math.abs(leftGap - 10) > 6 || Math.abs(rightGap - 10) > 6)
              throw Error(
                `${order} ${label}: background and content split (left gap ${leftGap}, right gap ${rightGap}, expected about 10)`,
              );
          }
        // 2. The declared element actually animates: mid must sit strictly between the two
        // settled poses. Without this, an element pinned by an unmatched candidate or by a
        // layout-time suppression would pass the inset check alone.
        const axis = build.insets === false ? "blue" : "red";
        const animated =
          mid[axis][0] > start[axis][0] + 5 && mid[axis][0] < end[axis][0] - 5;
        if (!animated)
          throw Error(
            `${order}: element did not animate (start ${start[axis][0]}, mid ${mid[axis][0]}, end ${end[axis][0]})`,
          );
        transitionChecks.push({ order, start, mid, end });
      } finally {
        source.dispose();
      }
    }
    if (errors.length) throw Error(`FrameSource errors: ${errors.join("; ")}`);
    return {
      cases: cases.map((c) => c.name),
      passes: { plain: plainPasses, background: backgroundPasses },
      transitions: transitionChecks,
    };
  });
}
