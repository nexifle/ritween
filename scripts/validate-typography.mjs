import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const out = `${root}artifacts/g5`;
await mkdir(out, { recursive: true });
const server = await createServer({
  root,
  configFile: false,
  logLevel: "error",
  optimizeDeps: { noDiscovery: true },
  resolve: { alias: { ritween: `${root}src/index.ts` } },
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "typography-page",
      configureServer(s) {
        s.middlewares.use((req, res, next) => {
          if (req.url !== "/") return next();
          res.setHeader("Content-Type", "text/html");
          res.end("<!doctype html><title>Typography</title>");
        });
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL ?? "chrome",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage();
  let delayedRequests = 0;
  let readinessBarrier;
  let barrierPassed = false;
  await page.route("**/*g5-delay*", async (route) => {
    delayedRequests++;
    // Hold bytes until the browser proves public creation has not completed.
    readinessBarrier = await page.evaluate(() => ({
      started: globalThis.g5CreationStarted,
      completed: globalThis.g5CreationCompleted === true,
    }));
    assert.equal(readinessBarrier.started, true);
    assert.equal(readinessBarrier.completed, false);
    barrierPassed = true;
    await route.fulfill({
      contentType: "font/woff2",
      body: await readFile(`${root}tests/fixtures/fonts/Inter-Bold.woff2`),
    });
  });
  await page.goto(server.resolvedUrls.local[0]);
  const report = await page.evaluate(async () => {
    const { FrameSource } = await import("/src/index.ts");
    const fixture =
      await import("/scripts/inspect-fixture/manifest-typography.mjs");
    globalThis.g5CreationStarted = true;
    // Reproduce the old readiness contract with a CSS face absent from time zero.
    const missingStyle = document.createElement("style");
    missingStyle.textContent = `@font-face { font-family: "G5 Late CSS"; src: url("${fixture.fonts[2].source}"); font-weight: 700; }`;
    document.head.append(missingStyle);
    const api = await import("/src/index.ts");
    const oldProject = {
      ...fixture.project,
      scenes: [
        {
          ...fixture.project.scenes[0],
          create: () =>
            api.Stage(
              ({ time }) =>
                api.Text("Late", {
                  font: time >= 1 ? '"G5 Late CSS"' : "monospace",
                  weight: 700,
                }),
              { designSize: [640, 480] },
            ),
        },
      ],
    };
    const oldSource = await FrameSource.create(oldProject, {
      width: 640,
      height: 480,
    });
    let oldReadinessRejected = false;
    try {
      await oldSource.render(1.25);
    } catch (error) {
      oldReadinessRejected = String(error).includes("Font is not ready");
    } finally {
      oldSource.dispose();
      missingStyle.remove();
    }
    if (!oldReadinessRejected)
      throw Error("Old conditional readiness failure was not reproduced");
    const fontLifecycle = [];
    const projectFor = (source) => ({
      ...fixture.project,
      overlay: () =>
        api.Overlay(
          () => api.Text("WWW iii", { font: '"G5 Shared"', weight: 400 }),
          { fonts: [{ family: "G5 Shared", source }] },
        ),
      scenes: [
        {
          ...fixture.project.scenes[0],
          create: () =>
            api.Stage(
              () => api.Text("WWW iii", { font: '"G5 Shared"', weight: 400 }),
              {
                fonts: [
                  { family: "G5 Shared", source: fixture.fonts[0].source },
                ],
              },
            ),
        },
      ],
    });
    // Both scene and overlay remain alive: conflicting descriptors must fail at the boundary.
    let conflictRejected = false;
    try {
      const conflicting = await FrameSource.create(
        projectFor(fixture.fonts[1].source),
        { width: 640, height: 480 },
      );
      conflicting.dispose();
    } catch (error) {
      conflictRejected = String(error).includes(
        "Conflicting active Stage font",
      );
    }
    if (!conflictRejected)
      throw Error("Simultaneous scene/overlay conflict accepted");
    if ([...document.fonts].some((f) => f.family.includes("G5 Shared")))
      throw Error("Failed conflict retained faces");
    for (let attempt = 0; attempt < 2; attempt++) {
      const shared = await FrameSource.create(
        projectFor(fixture.fonts[0].source),
        { width: 640, height: 480 },
      );
      for (const time of [0, 1.25, 0]) await shared.render(time);
      const count = [...document.fonts].filter((f) =>
        f.family.includes("G5 Shared"),
      ).length;
      if (count !== 2)
        throw Error(`Expected scene and overlay owners: ${count}`);
      shared.dispose();
      if ([...document.fonts].some((f) => f.family.includes("G5 Shared")))
        throw Error("Shared disposal retained faces");
      fontLifecycle.push({
        attempt,
        owners: count,
        times: [0, 1.25, 0],
        disposed: true,
      });
    }
    let styleRejected = false;
    try {
      api.Stage(() => api.Text("x"), {
        fonts: [{ ...fixture.fonts[0], style: "italic" }],
      });
    } catch (error) {
      styleRejected = String(error).includes("only normal style");
    }
    if (!styleRejected) throw Error("Unsupported style accepted");
    // New scene caches must not retain the previous source's glyphs under identical TextRun keys.
    const sequential = [];
    for (const fontSource of [
      fixture.fonts[0].source,
      fixture.fonts[1].source,
      fixture.fonts[0].source,
    ]) {
      const project = {
        ...fixture.project,
        scenes: [
          {
            ...fixture.project.scenes[0],
            create: () =>
              api.Stage(
                () =>
                  api.Text("WWW iii", {
                    font: '"G5 Reused"',
                    size: 40,
                    weight: 400,
                    color: "#ffffff",
                  }),
                {
                  background: "#000000",
                  fonts: [{ family: "G5 Reused", source: fontSource }],
                },
              ),
          },
        ],
      };
      const instance = await FrameSource.create(project, {
        width: 640,
        height: 480,
        inspect: true,
      });
      await instance.render(0);
      const probe = new OffscreenCanvas(640, 480),
        p = probe.getContext("2d");
      p.drawImage(instance.canvas, 0, 0);
      const bytes = new Uint8Array(
        await (await probe.convertToBlob()).arrayBuffer(),
      );
      sequential.push({
        source: fontSource,
        pixels: Array.from(bytes).join(","),
        geometry: JSON.stringify(instance.inspectFrame()),
      });
      instance.dispose();
    }
    if (
      sequential[0].pixels !== sequential[2].pixels ||
      sequential[0].geometry !== sequential[2].geometry ||
      sequential[0].pixels === sequential[1].pixels ||
      sequential[0].geometry === sequential[1].geometry
    )
      throw Error("Source replacement cache ABA failed");
    const source = await FrameSource.create(fixture.project, {
      width: 640,
      height: 480,
      inspect: true,
    });
    globalThis.g5CreationCompleted = true;
    const check = (value, message) => {
      if (!value) throw Error(message);
    };
    const canvas = new OffscreenCanvas(640, 480),
      ctx = canvas.getContext("2d");
    const capture = async (time) => {
      await source.render(time);
      ctx.clearRect(0, 0, 640, 480);
      ctx.drawImage(source.canvas, 0, 0);
      const pixels = Array.from(ctx.getImageData(0, 0, 640, 480).data);
      const blob = await canvas.convertToBlob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return {
        time,
        pixels,
        png: btoa(binary),
        geometry: JSON.stringify(source.inspectFrame()),
        frame: source.inspectFrame(),
      };
    };
    try {
      const faces = [...document.fonts].filter((face) =>
        face.family.includes("Ritween G5"),
      );
      check(
        faces.length === 3 && faces.every((f) => f.status === "loaded"),
        "Missing intended faces",
      );
      const probes = fixture.fonts.map((spec) => {
        ctx.font = `${spec.weight} 24px "${spec.family}"`;
        const width = ctx.measureText("WWW iii").width;
        ctx.font = `${spec.weight} 24px monospace`;
        const fallback = ctx.measureText("WWW iii").width;
        check(width !== fallback, "Silent primary fallback");
        const face = faces.find(
          (f) =>
            f.family.replaceAll('"', "") === spec.family &&
            f.weight === spec.weight,
        );
        check(
          face && document.fonts.has(face),
          "Intended face missing from FontFaceSet",
        );
        return {
          ...spec,
          width,
          fallback,
          membership: document.fonts.has(face),
          actualFamily: face.family,
          actualWeight: face.weight,
          loaded: true,
        };
      });
      // Calibration precedes all state and candidate comparisons.
      const calibration = [
        await capture(0),
        await capture(0),
        await capture(0),
      ];
      check(
        calibration.every(
          (c) =>
            c.png === calibration[0].png &&
            c.geometry === calibration[0].geometry,
        ),
        "Calibration drift",
      );
      const samples = [];
      const conditional = [];
      for (const time of [0, 1.25, 0, 0.125, 0.5, 1.875, 2.75, 0]) {
        samples.push(await capture(time));
        const text = fixture.activeScene
          .inspect()
          .commands.find(
            (c) =>
              c.kind === "text" &&
              c.text.size === 24 &&
              c.text.lines[0].includes(time >= 1 ? "Conditional" : "Initial"),
          ).text;
        ctx.font = `${time >= 1 ? 700 : 400} 24px ${time >= 1 ? fixture.delayedFamily : fixture.family}`;
        ctx.letterSpacing = "0px";
        const expected = ctx.measureText(
          time >= 1 ? "Conditional WWW" : "Initial iii",
        ).width;
        check(
          text.widths[0] === expected,
          `Stale conditional geometry at ${time}`,
        );
        conditional.push({
          time,
          font: text.font,
          measured: text.widths[0],
          expected,
        });
      }
      check(
        samples[0].png === samples[2].png &&
          samples[0].geometry === samples[2].geometry,
        "ABA mismatch",
      );
      check(
        samples[0].png !== samples[1].png &&
          samples[0].geometry !== samples[1].geometry,
        "A/B not distinct",
      );
      // Stage inspection is available through the public engine snapshot; find display lists recursively.
      const commands = [];
      function visit(value) {
        if (!value || typeof value !== "object") return;
        if (value.kind === "text" && value.text?.lines) commands.push(value);
        for (const [key, child] of Object.entries(value))
          if (key !== "text") {
            if (Array.isArray(child)) child.forEach(visit);
            else visit(child);
          }
      }
      visit(samples[0].frame);
      // Read the same scene owned and prepared by the public FrameSource, not a replacement renderer.
      const adapter = await navigator.gpu.requestAdapter();
      const oracles = [];
      {
        const frame = fixture.activeScene.inspect();
        for (const spec of fixture.cases) {
          const command = frame.commands.find(
            (c) => c.kind === "text" &&
              c.text.font.includes(`${spec.size}px`) &&
              c.text.lineHeight === spec.lineHeight &&
              c.text.tracking === spec.tracking,
          );
          check(command, `Missing command ${spec.id}`);
          const t = command.text;
          ctx.font = `${spec.weight ?? 400} ${spec.size}px ${fixture.family}`;
          ctx.letterSpacing = `${spec.tracking}px`;
          // Controlled fixtures: no general-purpose wrapping implementation is reused.
          let expectedLines;
          if (spec.id === "long") {
            const capacity = Math.floor(spec.width / ctx.measureText("W").width);
            check(ctx.measureText("W".repeat(capacity)).width <= spec.width &&
              ctx.measureText("W".repeat(capacity + 1)).width > spec.width,
              "Analytical repeated-glyph capacity");
            expectedLines = Array.from({ length: Math.ceil(spec.text.length / capacity) },
              (_, i) => spec.text.slice(i * capacity, (i + 1) * capacity));
          } else if (spec.id === "newlines") expectedLines = ["Alpha", "", "Beta"];
          else if (spec.id === "combining") expectedLines = ["e\u0301 A\u030a n\u0303"];
          else expectedLines = [spec.text];
          const exact = (lines) => JSON.stringify(lines) === JSON.stringify(expectedLines);
          check(exact(t.lines), `${spec.id}: complete independent line array mismatch`);
          const corrupt = [...expectedLines];
          if (corrupt.length > 1) corrupt[corrupt.length - 1] += "W";
          else corrupt[0] += " ";
          check(!exact(corrupt), `${spec.id}: later-line/whitespace mutation accepted`);
          if (expectedLines.some((line) => line.includes(" ")))
            check(!exact(expectedLines.map((line) => line.replace(" ", ""))),
              `${spec.id}: missing whitespace mutation accepted`);
          const widths = expectedLines.map((line) => ctx.measureText(line).width);
          check(
            widths.every((w, i) => Math.abs(w - t.widths[i]) < 1e-6),
            `${spec.id}: width mismatch`,
          );
          check(
            command.bounds.height === t.lines.length * spec.lineHeight,
            `${spec.id}: line box mismatch`,
          );
          if (spec.id === "newlines")
            check(
              JSON.stringify(t.lines) === JSON.stringify(["Alpha", "", "Beta"]),
              "Newline oracle",
            );
          if (spec.id === "empty")
            check(t.lines.length === 1 && t.widths[0] === 0, "Empty oracle");
          if (spec.id === "long") {
            const count = Math.floor(spec.width / ctx.measureText("W").width);
            check(
              t.lines[0] === "W".repeat(count),
              "Independent repeated glyph wrapping oracle",
            );
          }
          // Independent Canvas2D ink oracle, constrained to the documented texture quad.
          const raster = new OffscreenCanvas(
            Math.max(1, Math.ceil(command.bounds.width)),
            Math.max(1, Math.ceil(command.bounds.height)),
          );
          const p = raster.getContext("2d");
          p.font = ctx.font;
          p.letterSpacing = `${spec.tracking}px`;
          p.fillStyle = "white";
          p.textBaseline = "alphabetic";
          const metric = p.measureText("Mg");
          expectedLines.forEach((line, i) =>
            p.fillText(
              line,
              0,
              i * spec.lineHeight +
                (spec.lineHeight -
                  metric.fontBoundingBoxAscent -
                  metric.fontBoundingBoxDescent) /
                  2 +
                metric.fontBoundingBoxAscent,
            ),
          );
          let clippedInk = 0;
          if (spec.id === "tight") {
            const expanded = new OffscreenCanvas(
              raster.width + 64,
              raster.height + 64,
            );
            const e = expanded.getContext("2d");
            e.font = p.font;
            e.letterSpacing = p.letterSpacing;
            e.fillStyle = "white";
            e.textBaseline = "alphabetic";
            e.fillText(
              spec.text,
              32,
              32 +
                (spec.lineHeight -
                  metric.fontBoundingBoxAscent -
                  metric.fontBoundingBoxDescent) /
                  2 +
                metric.fontBoundingBoxAscent,
            );
            const expandedPixels = e.getImageData(
              0,
              0,
              expanded.width,
              expanded.height,
            ).data;
            for (let y = 0; y < expanded.height; y++)
              for (let x = 0; x < expanded.width; x++)
                if (
                  (x < 32 ||
                    x >= 32 + raster.width ||
                    y < 32 ||
                    y >= 32 + raster.height) &&
                  expandedPixels[(y * expanded.width + x) * 4 + 3]
                )
                  clippedInk++;
            check(
              clippedInk > 0,
              "Tight case did not exercise intentional quad clipping",
            );
          }
          const sampled = new OffscreenCanvas(raster.width, raster.height);
          const sampledContext = sampled.getContext("2d");
          sampledContext.drawImage(
            raster,
            0,
            0,
            raster.width,
            raster.height,
            0,
            0,
            command.bounds.width,
            command.bounds.height,
          );
          const reference = sampledContext.getImageData(
            0,
            0,
            raster.width,
            raster.height,
          ).data;
          const texels = p.getImageData(0, 0, raster.width, raster.height).data;
          let maxPredictionError = 0;
          let missingInk = 0,
            channelFailures = 0,
            sensitivityFailures = 0;
          let expectedInk = 0,
            actualInk = 0,
            maxChannelError = 0,
            mismatches = 0,
            unsupportedInk = 0;
          for (let y = 0; y < raster.height; y++)
            for (let x = 0; x < raster.width; x++) {
              // Pixel centers mapped to the actual fractional quad, clamp-to-edge linear sampler.
              const sx =
                command.bounds.width > 0
                  ? ((x + 0.5) * raster.width) / command.bounds.width - 0.5
                  : 0;
              const left = Math.floor(sx),
                fraction = sx - left;
              const texel = (column, channel) =>
                texels[
                  (y * raster.width +
                    Math.max(0, Math.min(raster.width - 1, column))) *
                    4 +
                    channel
                ];
              const alpha =
                ((1 - fraction) * texel(left, 3) +
                  fraction * texel(left + 1, 3)) /
                255;
              const expected = reference[(y * raster.width + x) * 4 + 3];
              const caseIndex = fixture.cases.indexOf(spec);
              const actual =
                samples[0].pixels[
                  ((12 + Math.floor(caseIndex / 3) * 160 + y) * 640 +
                    (12 + (caseIndex % 3) * 200) +
                    x) *
                    4
                ];
              // copyExternalImageToTexture uses straight RGBA; shader alpha blends over black.
              // Two UNORM roundings plus linear interpolation precision: at most two channel units.
              for (let channel = 0; channel < 3; channel++) {
                const rgb =
                  (1 - fraction) * texel(left, channel) +
                  fraction * texel(left + 1, channel);
                const predicted = rgb * alpha;
                const observed =
                  samples[0].pixels[
                    ((12 + Math.floor(caseIndex / 3) * 160 + y) * 640 +
                      12 +
                      (caseIndex % 3) * 200 +
                      x) *
                      4 +
                      channel
                  ];
                maxPredictionError = Math.max(
                  maxPredictionError,
                  Math.abs(predicted - observed),
                );
                if (Math.abs(predicted - observed) > 2) channelFailures++;
                if (predicted > 2 && observed === 0) missingInk++;
                // Deliberate partial rendering: erase the right half. Must be rejected by this oracle.
                if (x >= raster.width / 2 && predicted > 2)
                  sensitivityFailures++;
              }
              if (expected) expectedInk++;
              if (actual) {
                actualInk++;
                let support = false;
                // Canvas and GPU sampling use different interpolation precision; a linear
                // sample can only depend on neighboring source texels, not arbitrary slack.
                const sourceX =
                  ((x + 0.5) * raster.width) / command.bounds.width - 0.5;
                for (const sx of [Math.floor(sourceX), Math.ceil(sourceX)])
                  if (
                    sx >= 0 &&
                    sx < raster.width &&
                    p.getImageData(sx, y, 1, 1).data[3]
                  )
                    support = true;
                if (!support) unsupportedInk++;
              }
              const error = Math.abs(expected - actual);
              maxChannelError = Math.max(maxChannelError, error);
              if (error) mismatches++;
            }
          // RGB is premultiplied white over black; GPU linear sampling of a fractional-width
          // texture quad is not a one-to-one texel copy. Record that error, never infer ink
          // alignment from the line box or relax viewport leakage checks.
          check(
            spec.id === "empty"
              ? actualInk === 0
              : actualInk > 0 && expectedInk > 0,
            `${spec.id}: absent raster ink`,
          );
          check(
            unsupportedInk === 0,
            `${spec.id}: GPU ink outside independent bilinear support: ${unsupportedInk}`,
          );
          check(
            channelFailures === 0 && missingInk === 0,
            `${spec.id}: two-way raster discrepancy channels=${channelFailures} missing=${missingInk}`,
          );
          check(
            spec.id === "empty" || sensitivityFailures > 0,
            `${spec.id}: missing-half mutation was not detected`,
          );
          oracles.push({
            id: spec.id,
            lines: t.lines,
            expectedLines,
            exactLineArray: true,
            negativeLineMutationRejected: true,
            widths,
            bounds: command.bounds,
            lineHeight: spec.lineHeight,
            font: t.font,
            tracking: t.tracking,
            raster: {
              expectedInk,
              clippedInk,
              actualInk,
              unsupportedInk,
              missingInk,
              maxPredictionError,
              channelFailures,
              sensitivityFailures,
              maxChannelError,
              mismatches,
              quad: command.bounds,
              accuracy:
                "Canvas ink versus GPU sampled texture; not exact ink-bound equality",
            },
          });
        }
      }
      const scroll = samples.map((sample) => {
        let leaked = 0,
          ink = 0;
        for (let y = 350; y < 430; y++)
          for (let x = 0; x < 270; x++) {
            const i = (y * 640 + x) * 4;
            const painted =
              sample.pixels[i] || sample.pixels[i + 1] || sample.pixels[i + 2];
            if (painted) {
              if (x < 12 || x >= 252 || y < 370 || y >= 417) leaked++;
              else ink++;
            }
          }
        check(leaked === 0 && ink > 0, `Scroll leak ${sample.time}: ${leaked}`);
        return { time: sample.time, viewport: [12, 370, 240, 47], leaked, ink };
      });
      let negativeLeak = 0,
        negativeInk = 0;
      for (let y = 418; y < 465; y++)
        for (let x = 280; x < 480; x++) {
          const i = (y * 640 + x) * 4;
          if (
            (samples[0].pixels[i] ||
              samples[0].pixels[i + 1] ||
              samples[0].pixels[i + 2]) &&
            (x < 300 || x >= 470 || y < 425 || y >= 457)
          )
            negativeLeak++;
        }
      for (let y = 425; y < 457; y++)
        for (let x = 300; x < 470; x++) {
          const i = (y * 640 + x) * 4;
          if (
            samples[0].pixels[i] ||
            samples[0].pixels[i + 1] ||
            samples[0].pixels[i + 2]
          )
            negativeInk++;
        }
      check(
        negativeLeak === 0 && negativeInk > 0,
        "Negative-scale text leaked clip or had no ink",
      );
      let strokePixels = 0,
        strokeLeak = 0,
        zeroInk = 0;
      for (let y = 430; y < 475; y++)
        for (let x = 0; x < 110; x++) {
          const i = (y * 640 + x) * 4;
          if (samples[0].pixels[i] > 0) {
            strokePixels++;
            if (x < 12 || x >= 92 || y < 435 || y >= 465) strokeLeak++;
          }
        }
      for (let y = 425; y < 475; y++)
        for (let x = 530; x < 640; x++) {
          const i = (y * 640 + x) * 4;
          if (
            samples[0].pixels[i] ||
            samples[0].pixels[i + 1] ||
            samples[0].pixels[i + 2]
          )
            zeroInk++;
        }
      check(
        strokePixels > 0 && strokeLeak === 0 && zeroInk === 0,
        "Stroke or zero-scale extent failed",
      );
      return {
        oldReadinessRejected,
        fontLifecycle,
        sourceReplacementABA: {
          pixelsEqual: true,
          geometryEqual: true,
          distinctB: true,
          sources: sequential.map((s) => s.source),
        },
        conflictRejected,
        styleRejected,
        stroke: {
          convention: "inward within quad",
          quad: [12, 435, 80, 30],
          strokeWidth: 4,
          strokePixels,
          strokeLeak,
        },
        zeroScale: { ink: zeroInk },
        negativeScale: {
          clip: [300, 425, 170, 32],
          leaked: negativeLeak,
          ink: negativeInk,
        },
        probes,
        conditional,
        oracles,
        scroll,
        calibration: {
          renders: 3,
          changedPixels: 0,
          allowedChangedPixels: 0,
          reason:
            "Three unchanged native captures and geometry identical before comparisons",
        },
        aba: {
          times: [0, 1.25, 0],
          pixelsEqual: true,
          geometryEqual: true,
          distinctB: true,
        },
        environment: {
          browser: navigator.userAgent,
          gpu: Object.fromEntries(
            [
              "vendor",
              "architecture",
              "device",
              "description",
              "isFallbackAdapter",
            ].map((key) => [key, adapter.info[key]]),
          ),
          output: [640, 480],
        },
        captures: samples.map(({ time, png }) => ({ time, png })),
        reviewerStatus: "not-reviewed",
        emoji:
          "Intentional system emoji fallback; Inter is the primary Latin face, not an emoji coverage claim",
      };
    } finally {
      source.dispose();
      if (
        [...document.fonts].some((face) => face.family.includes("Ritween G5"))
      )
        throw Error("Disposed source retained owned fonts");
    }
  });
  report.delayedRequests = delayedRequests;
  report.readinessBarrier = { ...readinessBarrier, barrierPassed };
  assert.ok(delayedRequests > 0);
  for (const [i, capture] of report.captures.entries()) {
    const path = `${out}/typography-${i}-${capture.time}.png`;
    await writeFile(path, Buffer.from(capture.png, "base64"));
    report.captures[i] = { time: capture.time, path };
  }
  await writeFile(`${out}/typography.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
