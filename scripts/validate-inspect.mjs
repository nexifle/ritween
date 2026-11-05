/**
 * G1b public-CLI inspection validation
 * (docs/plans/declarative-layout-hardening.md §7 Gate).
 *
 * Proves the gate through the real command, not a mock:
 * - real-font geometry from a consumer manifest (fractional Inter widths),
 *   with a FontFace proof that both 400 and 700 rasterize distinctly,
 * - both active scenes during their transition overlap,
 * - project overlay metadata with the project clock,
 * - a nested Composition publishing its own space,
 * - a raw Scene published as unavailable with a reason,
 * - transition projection published as explicitly pending G3,
 * - authored-ID targeting, atomic --output, exit codes and cancellation,
 * - a flat Box fixture proved through the same CLI, plus one FrameSource
 *   A→B→A pixel seek. G7 production counters are not measured here.
 * - a flat Text fixture through the same CLI and one FrameSource. Bounds are the
 *   texture/line-box draw quad, not glyph ink. G7 is not measured there either.
 *
 * Run after `npm run build`:
 *   node scripts/validate-inspect.mjs
 *
 * The consumer project is generated deterministically from `scripts/inspect-fixture/`
 * and the committed `tests/fixtures/fonts/`, then written under the ignored
 * `artifacts/g1b/`. Nothing outside this repository is required, and deleting
 * `artifacts/` does not affect the run.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer as createViteServer } from "vite";
import { nodeCli } from "./node-cli.mjs";

/** Must match `scripts/inspect-fixture/manifest-box.mjs`. Checked against that file before use. */
const OUTPUT = [320, 180];
const BOX_A = { x: 40, y: 30, width: 80, height: 40 };
const BOX_B = { x: 100, y: 30, width: 80, height: 40 };
const BACKGROUND_RGBA = [0x11, 0x22, 0x33, 255];
const COLOR_A_RGBA = [0xe2, 0x3d, 0x3d, 255];
const COLOR_B_RGBA = [0x2e, 0x6b, 0xff, 255];
const TIME_A = 0.25;
const TIME_B = 1.25;
const TIME_CLIP = 2.25;
const SAMPLE_A = [70, 50];
const SAMPLE_B = [150, 50];
const SAMPLE_BG = [16, 16];
const TEXT_OUTPUT = [320, 180];
const TEXT_TIME_A = 0.25;
const TEXT_TIME_B = 1.25;
const TEXT_OFFSET = 40;
const TEXT_ORIGIN_X = 80;
const TEXT_ORIGIN_Y = 72;
const TEXT_EDGE_CLEARANCE = 40;
const TEXT_ID = "ink";
const TEXT_BACKGROUND_ID = "bg-ink";
const TEXT_STAGE_ID = "flat-stage";
const TEXT_STYLE_ID = "ink-style";
const TEXT_FONT_FAMILY = "Ritween Fixture Inter";
const TEXT_SAMPLE = "H";
const TEXT_SIZE = 28;
const TEXT_WEIGHT = 700;
const TEXT_LINE_HEIGHT = 36;
const TEXT_QUAD_INSET = 2;
const TEXT_OUTSIDE_MARGIN = 2;
const TEXT_BACKGROUND = "#112233";
const TEXT_INK = "#F7F4EC";
const TEXT_BACKGROUND_RGBA = [0x11, 0x22, 0x33, 255];
const TEXT_INK_RGBA = [0xf7, 0xf4, 0xec, 255];

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = process.env.CLI_BINARY
  ? nodeCli(resolve(process.env.CLI_BINARY))
  : { command: process.execPath, args: [join(root, "bin/ritween.mjs")] };
const artifacts = join(root, "artifacts/g1b");
const consumer = join(artifacts, "consumer");
const reports = join(artifacts, "reports");
const template = join(root, "scripts/inspect-fixture");
const fonts = join(root, "tests/fixtures/fonts");
/** Both variants are real project directories so `/fonts/...` public assets resolve. */
const regularConsumer = join(artifacts, "consumer-regular");
/** A large layout variant so cancellation can be signalled during the render phase. */
const slowConsumer = join(artifacts, "consumer-slow");

let latestFontProof = null;
let renderStartedHandler = null;

const handshakeServer = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/font-proof" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        latestFontProof = JSON.parse(body);
      } catch {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (req.url === "/render-started") {
    if (renderStartedHandler) {
      renderStartedHandler();
      renderStartedHandler = null;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404);
  res.end();
});

await new Promise((resolve) => handshakeServer.listen(0, "127.0.0.1", resolve));
const handshakePort = handshakeServer.address().port;

/**
 * Write a consumer project from repository sources. Recreated every run so a stale
 * or half-deleted `artifacts/` tree cannot make the gate pass or fail.
 */
async function createConsumer(directory, manifest) {
  await rm(directory, { recursive: true, force: true });
  await mkdir(join(directory, "src/project"), { recursive: true });
  await mkdir(join(directory, "public/fonts"), { recursive: true });
  await copyFile(
    join(template, "scenes.ts"),
    join(directory, "src/project/scenes.ts"),
  );
  if (manifest === "manifest-slow.ts")
    await copyFile(
      join(template, "manifest-slow.ts"),
      join(directory, "src/project/scenes-slow.ts"),
    );
  await copyFile(
    join(template, manifest),
    join(directory, "src/project/manifest.ts"),
  );
  await writeFile(
    join(directory, "src/project/config.ts"),
    `export const HANDSHAKE_PORT = ${handshakePort};\n`,
  );
  for (const file of ["Inter-Regular.woff2", "Inter-Bold.woff2", "LICENSE.txt"])
    await copyFile(join(fonts, file), join(directory, "public/fonts", file));
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify({ name: "g1b-inspection-consumer", private: true, type: "module" }, null, 2)}\n`,
  );
}
// The proof itself is recorded by the page; this is the shape the run asserted.
const expectedFontWeights = ["400", "700"];
const boxConsumer = join(artifacts, "consumer-box");
const textConsumer = join(artifacts, "consumer-text");

function walk(node, visit) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function nodeById(root, id) {
  let found;
  walk(root, (node) => {
    if (node.id === id) found = node;
  });
  return found;
}

function idsOf(root) {
  const ids = [];
  walk(root, (node) => {
    if (node.id) ids.push(node.id);
  });
  return ids;
}

/** Paint record whose owner inspection id is the authored node's, not a path guess. */
function recordOwnedBy(records, node) {
  return records.find(
    (record) => record.inspection?.nodeId === node?.inspectionId,
  );
}

function run(args, { timeout = 180_000, cwd = root } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(cli.command, [...cli.args, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", rejectRun);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr, args });
    });
  });
}

async function inspectJson(args) {
  const result = await run(args);
  assert.equal(
    result.code,
    0,
    `inspect ${args.join(" ")} failed (${result.code})\n${result.stdout}\n${result.stderr}`,
  );
  assert.equal(
    result.stderr.includes("Ritween:"),
    false,
    `successful inspect must not log an error: ${result.stderr}`,
  );
  return { document: JSON.parse(result.stdout), raw: result.stdout, ...result };
}

/** A geometry value with a fractional part cannot come from the 10px stub measurer. */
function hasFractionalGeometry(node) {
  const values = [
    node.bounds.x,
    node.bounds.y,
    node.bounds.width,
    node.bounds.height,
    ...node.transform,
  ];
  return (
    values.some((value) => !Number.isInteger(value)) ||
    node.children.some(hasFractionalGeometry)
  );
}

function maxChannelDelta(left, right) {
  assert.equal(left.length, right.length);
  let max = 0;
  for (let i = 0; i < left.length; i++)
    max = Math.max(max, Math.abs(left[i] - right[i]));
  return max;
}

function samplePixel(frame, point) {
  const index = (point[1] * OUTPUT[0] + point[0]) * 4;
  return [frame[index], frame[index + 1], frame[index + 2], frame[index + 3]];
}

function assertNear(actual, expected, tolerance, label) {
  for (let i = 0; i < expected.length; i++)
    assert.ok(
      Math.abs(actual[i] - expected[i]) <= tolerance,
      `${label}: ${actual} expected ${expected} within ${tolerance}`,
    );
}

function assertBoxRecord(record, bounds, role) {
  assert.equal(record.kind, "box");
  assert.equal(record.provenance, "projected-box-draw-quad");
  assert.equal(record.space, "scene-target-pixels");
  assert.deepEqual([...record.resolution], [...OUTPUT]);
  assert.deepEqual(record.bounds, bounds);
  assert.equal(record.accuracy, "exact-rectangle");
  assert.equal(record.geometryVisible, true);
  assert.equal(record.paintRole, role);
  assert.equal(record.inspection.role, role);
}

/** Two float32 endpoints can each move by one ulp; the offset is staged through Math.fround. */
function float32UniformTolerance(...values) {
  let ulp = 0;
  for (const value of values) {
    const rounded = Math.fround(value);
    const magnitude = Math.abs(rounded);
    const step =
      magnitude === 0
        ? 2 ** -149
        : 2 ** (Math.floor(Math.log2(magnitude)) - 23);
    ulp = Math.max(ulp, step);
  }
  return 2 * ulp;
}

function assertFloat32Close(actual, expected, label) {
  const tolerance = float32UniformTolerance(actual, expected);
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} expected ${expected} within ${tolerance}`,
  );
}

function assertQuadEqual(left, right, label) {
  for (const key of ["x", "y", "width", "height"])
    assertFloat32Close(left[key], right[key], `${label}.${key}`);
}

function fixtureFontsPlugin() {
  const allowed = new Map([
    ["/fonts/Inter-Regular.woff2", "font/woff2"],
    ["/fonts/Inter-Bold.woff2", "font/woff2"],
    ["/fonts/LICENSE.txt", "text/plain"],
  ]);
  return {
    name: "lane-b-fixture-fonts",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split("?")[0];
        const type = allowed.get(path);
        if (!type) return next();
        readFile(join(fonts, path.slice("/fonts/".length)))
          .then((body) => {
            res.setHeader("Content-Type", type);
            res.end(body);
          })
          .catch(() => {
            res.statusCode = 404;
            res.end();
          });
      });
    },
  };
}

async function createProofServer({ port, title }) {
  const vite = await createViteServer({
    configFile: false,
    root,
    logLevel: "warn",
    optimizeDeps: { noDiscovery: true },
    resolve: { alias: { ritween: join(root, "dist/index.js") } },
    server: { host: "127.0.0.1", port, strictPort: true },
    plugins: [
      fixtureFontsPlugin(),
      {
        name: "lane-b-proof-page",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url?.split("?")[0] !== "/") return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              `<!doctype html><link rel="icon" href="data:,"><title>${title}</title>`,
            );
          });
        },
      },
    ],
  });
  await vite.listen();
  return vite;
}

async function launchProofBrowser() {
  return chromium.launch({
    channel: process.env.CHROME_CHANNEL ?? "chrome",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
}

async function openProofPage(browser, vite) {
  const page = await browser.newPage();
  page.setDefaultTimeout(90_000);
  const proofErrors = [];
  page.on("pageerror", (error) => proofErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") proofErrors.push(message.text());
  });
  await page.goto(vite.resolvedUrls.local[0]);
  page.proofErrors = proofErrors;
  return page;
}

/** Shared A-repeat then A→B→A capture. Fonts, when the fixture exports them, load before create. */
async function captureFlatSequence({ modulePath, inspect }) {
  const fixture = await import(modulePath);
  const errors = [];
  let fontsReadyBeforeCreate = false;
  let documentFacesBeforeCreate = null;
  if (fixture.fontProof) {
    const proof = fixture.fontProof;
    const family = proof.family;
    documentFacesBeforeCreate = [];
    document.fonts.forEach((face) => {
      if (face.family === family)
        documentFacesBeforeCreate.push({
          family: face.family,
          weight: String(face.weight),
          status: face.status,
        });
    });
    for (const weight of ["400", "700"]) {
      const recorded = proof.weights.find((entry) => entry.weight === weight);
      if (recorded?.status !== "loaded" || recorded.family !== family)
        throw Error(`FontFace ${weight} was not loaded before create.`);
      if (
        !documentFacesBeforeCreate.some(
          (face) =>
            face.weight === weight &&
            face.status === "loaded" &&
            face.family === family,
        )
      )
        throw Error(`document.fonts is missing loaded ${weight} before create.`);
      if (!document.fonts.check(`${weight} 20px ${family}`))
        throw Error(`document.fonts.check failed for ${weight} before create.`);
    }
    if (fixture.DRAWN_FONT && !document.fonts.check(fixture.DRAWN_FONT))
      throw Error(`Drawn font is not ready before create: ${fixture.DRAWN_FONT}`);
    fontsReadyBeforeCreate = true;
  }
  const source = await fixture.FrameSource.create(fixture.project, {
    width: fixture.OUTPUT[0],
    height: fixture.OUTPUT[1],
    inspect: Boolean(inspect),
    onError: (message) => errors.push(String(message)),
  });
  const summarize = (report) => {
    const scene = report?.scenes?.[0];
    const frame = scene?.frame;
    const nodes = [];
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (node.id)
        nodes.push({
          id: node.id,
          kind: node.kind,
          inspectionId: node.inspectionId ?? null,
        });
      for (const child of node.children ?? []) walk(child);
    };
    walk(frame?.tree);
    return {
      requestedTime: report?.requestedTime ?? null,
      effectiveTime: report?.effectiveTime ?? null,
      sceneId: scene?.id ?? null,
      unavailable: scene?.unavailable ?? null,
      nodes,
      records: (frame?.paintRecords ?? []).map((record) => ({
        kind: record.kind,
        provenance: record.provenance ?? null,
        space: record.space ?? null,
        resolution: record.resolution ? [...record.resolution] : null,
        accuracy: record.accuracy ?? null,
        geometryVisible: record.geometryVisible ?? null,
        paintRole: record.paintRole ?? null,
        bounds: record.bounds ? { ...record.bounds } : null,
        inspection: record.inspection
          ? {
              id: record.inspection.id,
              nodeId: record.inspection.nodeId,
              role: record.inspection.role,
            }
          : null,
        unsupported: record.unsupported ?? null,
      })),
    };
  };
  const decode = async (time) => {
    const canvas = await source.render(time);
    const copy = new OffscreenCanvas(canvas.width, canvas.height);
    const context = copy.getContext("2d", { willReadFrequently: true });
    context.drawImage(canvas, 0, 0);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const blob = await copy.convertToBlob({ type: "image/png" });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return {
      width: canvas.width,
      height: canvas.height,
      pixels: Array.from(image.data),
      png: btoa(binary),
      report: inspect ? summarize(source.inspectFrame()) : null,
    };
  };
  const steps = [];
  let calibration;
  let sequence;
  try {
    const first = await decode(fixture.TIME_A);
    const repeat = await decode(fixture.TIME_A);
    steps.push("calibrate-a", "calibrate-a-repeat");
    let tolerance = 0;
    for (let i = 0; i < first.pixels.length; i++)
      tolerance = Math.max(
        tolerance,
        Math.abs(first.pixels[i] - repeat.pixels[i]),
      );
    steps.push("tolerance-recorded");
    calibration = { first, repeat, tolerance };
    const seqA = await decode(fixture.TIME_A);
    const seqB = await decode(fixture.TIME_B);
    const seqA2 = await decode(fixture.TIME_A);
    steps.push("sequence-a", "sequence-b", "sequence-a");
    sequence = { seqA, seqB, seqA2 };
  } finally {
    source.dispose();
  }
  let gpu = null;
  let gpuError = null;
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    gpu = adapter?.info
      ? {
          vendor: adapter.info.vendor ?? null,
          architecture: adapter.info.architecture ?? null,
          device: adapter.info.device ?? null,
          description: adapter.info.description ?? null,
          isFallbackAdapter: adapter.info.isFallbackAdapter ?? null,
        }
      : null;
    if (!adapter) gpuError = "requestAdapter returned null";
  } catch (error) {
    gpuError = String(error);
  }
  return {
    steps,
    tolerance: calibration.tolerance,
    frames: {
      cal1: calibration.first,
      cal2: calibration.repeat,
      seqA: sequence.seqA,
      seqB: sequence.seqB,
      seqA2: sequence.seqA2,
    },
    gpu,
    gpuError,
    renderErrors: errors,
    userAgent: navigator.userAgent,
    fontProof: fixture.fontProof ?? null,
    fontsReadyBeforeCreate,
    documentFacesBeforeCreate,
  };
}

/**
 * Public CLI inspect of the flat Box fixture, then one FrameSource instance
 * seeking A → B → A. Tolerance comes from an unchanged A repeat before that seek.
 */
async function proveFlatBoxes() {
  const evidence = {
    fixture: "scripts/inspect-fixture/manifest-box.mjs",
    output: [...OUTPUT],
    boxA: BOX_A,
    boxB: BOX_B,
    samples: {
      aInterior: [...SAMPLE_A],
      bInterior: [...SAMPLE_B],
      background: [...SAMPLE_BG],
      note: "Interiors are inset from every ideal quad edge; the quad is not a pixel bound.",
    },
    g7: {
      productionCounters: "unavailable",
      renderPassReuse: "not-measured",
      textureReuse: "not-measured",
      reason:
        "G7 requires engine instrumentation. This script does not estimate passes or texture reuse.",
    },
  };
  let browser;
  let vite;
  try {
    const fixtureSource = await readFile(
      join(template, "manifest-box.mjs"),
      "utf8",
    );
    for (const needle of [
      "x: 40, y: 30, width: 80, height: 40",
      "x: 100, y: 30, width: 80, height: 40",
      "[320, 180]",
      "#112233",
      "#E23D3D",
      "#2E6BFF",
      "TIME_A = 0.25",
      "TIME_B = 1.25",
      "TIME_CLIP = 2.25",
      "[70, 50]",
      "[150, 50]",
      "[16, 16]",
    ])
      assert.ok(
        fixtureSource.includes(needle),
        `manifest-box.mjs drifted from the Lane B contract: missing ${needle}`,
      );
    await createConsumer(boxConsumer, "manifest-box.mjs");
    const inspectAt = (time, extra = []) =>
      inspectJson([
        "inspect",
        "--project",
        boxConsumer,
        "--time",
        String(time),
        ...extra,
      ]);

    const stateA = await inspectAt(TIME_A);
    const stateB = await inspectAt(TIME_B);
    for (const [label, result, id, bounds, backgroundId] of [
      ["A", stateA, "box-a", BOX_A, "bg-a"],
      ["B", stateB, "box-b", BOX_B, "bg-b"],
    ]) {
      const { document } = result;
      assert.equal(document.capability.geometry.paint, "partial", label);
      assert.equal(
        document.capability.transitions.projection,
        "unavailable",
        label,
      );
      assert.match(document.capability.transitions.reason, /G3/, label);
      assert.deepEqual([...document.project.resolution], [...OUTPUT], label);
      assert.equal(document.time.requested, label === "A" ? TIME_A : TIME_B);
      assert.equal(document.scenes.length, 1, `${label} must not overlap a transition`);
      const scene = document.scenes[0];
      assert.equal(scene.scope, "scene:flat");
      const box = nodeById(scene.tree, id);
      const background = nodeById(scene.tree, backgroundId);
      assert.ok(box?.inspectionId !== undefined, id);
      assert.ok(background?.inspectionId !== undefined, backgroundId);
      const records = scene.paintRecords ?? [];
      const boxRecord = recordOwnedBy(records, box);
      const backgroundRecord = recordOwnedBy(records, background);
      assert.ok(boxRecord, `${id} paint record`);
      assert.ok(backgroundRecord, `${backgroundId} paint record`);
      assertBoxRecord(boxRecord, bounds, "content");
      assertBoxRecord(
        backgroundRecord,
        { x: 0, y: 0, width: OUTPUT[0], height: OUTPUT[1] },
        "background",
      );
      assert.equal(boxRecord.inspection.nodeId, box.inspectionId);
      assert.equal(backgroundRecord.inspection.nodeId, background.inspectionId);
      evidence[label === "A" ? "stateA" : "stateB"] = {
        scope: scene.scope,
        box: boxRecord.bounds,
        backgroundId,
        backgroundRole: backgroundRecord.paintRole,
        provenance: boxRecord.provenance,
        space: boxRecord.space,
        resolution: boxRecord.resolution,
        ownerId: box.inspectionId,
      };
    }

    const targeted = await inspectAt(TIME_A, ["--target", "scene:flat#box-a"]);
    const keptScene = targeted.document.scenes[0];
    const keptIds = idsOf(keptScene.tree).sort();
    assert.deepEqual(keptIds, ["box-a", "flat-stage"]);
    assert.equal(targeted.document.target.id, "box-a");
    assert.equal(targeted.document.target.matches, 1);
    assert.equal(targeted.document.target.scope, "scene:flat");
    const keptRecords = keptScene.paintRecords ?? [];
    const keptBox = nodeById(keptScene.tree, "box-a");
    assert.equal(keptRecords.length, 1);
    assert.equal(keptRecords[0].inspection.nodeId, keptBox.inspectionId);
    assert.deepEqual(keptRecords[0].bounds, BOX_A);
    assert.equal(keptRecords[0].provenance, "projected-box-draw-quad");
    assert.equal(
      keptRecords.some((record) => record.paintRole === "background"),
      false,
      "targeting box-a must drop the background sibling",
    );
    assert.equal(
      (keptScene.commands ?? []).some((command) => command.matchId === "bg-a"),
      false,
    );
    evidence.target = {
      ...targeted.document.target,
      keptIds,
      droppedSibling: "bg-a",
    };

    const quiet = await run([
      "inspect",
      "--project",
      boxConsumer,
      "--time",
      String(TIME_A),
      "--fail-on",
      "error",
    ]);
    assert.equal(
      quiet.code,
      0,
      `flat boxes have no error diagnostic: ${quiet.stderr}`,
    );
    assert.equal(
      stateA.document.diagnostics.some((entry) => entry.severity === "error"),
      false,
    );

    const clip = await inspectAt(TIME_CLIP);
    const clipDiagnostics = clip.document.diagnostics.map((entry) => ({
      code: entry.code,
      severity: entry.severity,
      id: entry.id ?? null,
      space: entry.space,
      path: entry.path,
    }));
    const deficit = clip.document.diagnostics.find(
      (entry) =>
        entry.code === "fixed-allocation-deficit" && entry.id === "clip-chips",
    );
    assert.ok(
      deficit,
      `clip scene diagnostics: ${JSON.stringify(clipDiagnostics)}`,
    );
    assert.equal(deficit.severity, "error");
    assert.equal(
      clip.document.diagnostics.some((entry) => /clip/i.test(entry.code)),
      false,
      "clip must not be reported as its own diagnostic code",
    );
    assert.equal(
      clip.document.diagnostics.some(
        (entry) => entry.id === "clip-fit" || entry.id === "clipped-fit",
      ),
      false,
      "a fitting clip is not an error",
    );
    const failOn = await run([
      "inspect",
      "--project",
      boxConsumer,
      "--time",
      String(TIME_CLIP),
      "--fail-on",
      "error",
    ]);
    assert.equal(failOn.code, 1, failOn.stderr);
    assert.match(failOn.stderr, /error diagnostic/);
    const failedDocument = JSON.parse(failOn.stdout);
    assert.ok(
      failedDocument.diagnostics.some(
        (entry) =>
          entry.code === "fixed-allocation-deficit" &&
          entry.severity === "error" &&
          entry.id === "clip-chips",
      ),
    );
    evidence.clip = {
      diagnostics: clipDiagnostics,
      failOnExit: failOn.code,
      failOnReason:
        "fixed-allocation-deficit on clip-chips; clip itself has no diagnostic code",
      fittingClipDiagnostics: 0,
    };

    vite = await createProofServer({ port: 5175, title: "Lane B box pixels" });
    browser = await launchProofBrowser();
    const page = await openProofPage(browser, vite);
    const browserErrors = page.proofErrors;
    const captured = await page.evaluate(captureFlatSequence, {
      modulePath: "/scripts/inspect-fixture/manifest-box.mjs",
      inspect: false,
    });
    assert.deepEqual(captured.steps, [
      "calibrate-a",
      "calibrate-a-repeat",
      "tolerance-recorded",
      "sequence-a",
      "sequence-b",
      "sequence-a",
    ]);
    const { cal1, cal2, seqA, seqB, seqA2 } = captured.frames;
    for (const frame of [cal1, cal2, seqA, seqB, seqA2])
      assert.deepEqual([frame.width, frame.height], [...OUTPUT]);
    const tolerance = maxChannelDelta(cal1.pixels, cal2.pixels);
    assert.equal(tolerance, captured.tolerance);
    const gap = Math.min(
      maxChannelDelta(COLOR_A_RGBA, BACKGROUND_RGBA),
      maxChannelDelta(COLOR_B_RGBA, BACKGROUND_RGBA),
      maxChannelDelta(COLOR_A_RGBA, COLOR_B_RGBA),
    );
    assert.ok(
      tolerance < gap,
      `calibrated tolerance ${tolerance} cannot separate fixture colors (gap ${gap})`,
    );
    const deltas = {
      calibration: tolerance,
      sequenceAToCalibration: maxChannelDelta(seqA.pixels, cal1.pixels),
      sequenceARepeatToCalibration: maxChannelDelta(seqA2.pixels, cal1.pixels),
      sequenceAToSequenceA: maxChannelDelta(seqA.pixels, seqA2.pixels),
      sequenceAToSequenceB: maxChannelDelta(seqA.pixels, seqB.pixels),
    };
    assert.ok(deltas.sequenceAToCalibration <= tolerance);
    assert.ok(deltas.sequenceARepeatToCalibration <= tolerance);
    assert.ok(deltas.sequenceAToSequenceA <= tolerance);
    assert.ok(
      deltas.sequenceAToSequenceB > tolerance,
      "A and B must differ by more than the calibrated tolerance",
    );
    const samples = {
      cal1: {
        a: samplePixel(cal1.pixels, SAMPLE_A),
        b: samplePixel(cal1.pixels, SAMPLE_B),
        background: samplePixel(cal1.pixels, SAMPLE_BG),
      },
      cal2: {
        a: samplePixel(cal2.pixels, SAMPLE_A),
        b: samplePixel(cal2.pixels, SAMPLE_B),
      },
      seqA: {
        a: samplePixel(seqA.pixels, SAMPLE_A),
        b: samplePixel(seqA.pixels, SAMPLE_B),
      },
      seqB: {
        a: samplePixel(seqB.pixels, SAMPLE_A),
        b: samplePixel(seqB.pixels, SAMPLE_B),
      },
      seqA2: {
        a: samplePixel(seqA2.pixels, SAMPLE_A),
        b: samplePixel(seqA2.pixels, SAMPLE_B),
      },
    };
    for (const [label, frame] of [
      ["cal1", samples.cal1],
      ["cal2", samples.cal2],
      ["seqA", samples.seqA],
      ["seqA2", samples.seqA2],
    ]) {
      assertNear(frame.a, COLOR_A_RGBA, tolerance, `${label} A interior`);
      assertNear(frame.b, BACKGROUND_RGBA, tolerance, `${label} B interior`);
    }
    assertNear(samples.cal1.background, BACKGROUND_RGBA, tolerance, "background");
    assertNear(samples.seqB.a, BACKGROUND_RGBA, tolerance, "B frame A interior");
    assertNear(samples.seqB.b, COLOR_B_RGBA, tolerance, "B frame B interior");
    const pngA = join(reports, "box-a.png");
    const pngB = join(reports, "box-b.png");
    await writeFile(pngA, Buffer.from(seqA.png, "base64"));
    await writeFile(pngB, Buffer.from(seqB.png, "base64"));
    evidence.pixels = {
      browser: {
        version: browser.version(),
        userAgent: captured.userAgent,
      },
      gpu: captured.gpu,
      gpuError: captured.gpuError,
      renderErrors: captured.renderErrors,
      pageErrors: browserErrors,
      resolution: [...OUTPUT],
      tolerance,
      colorGap: gap,
      deltas,
      samples,
      captures: ["artifacts/g1b/reports/box-a.png", "artifacts/g1b/reports/box-b.png"],
      instance: "one FrameSource; calibrate A twice, then seek A → B → A",
    };
    assert.deepEqual(captured.renderErrors, []);
    assert.deepEqual(browserErrors, []);
  } finally {
    await browser?.close();
    await vite?.close();
    await writeFile(
      join(reports, "box-pixel-proof.json"),
      JSON.stringify(evidence, null, 2),
    );
  }
  return evidence;
}

function insetQuad(bounds, inset) {
  return {
    x0: Math.ceil(bounds.x + inset),
    y0: Math.ceil(bounds.y + inset),
    x1: Math.floor(bounds.x + bounds.width - inset),
    y1: Math.floor(bounds.y + bounds.height - inset),
  };
}

function textPixelDelta(frame, x, y, rgba) {
  const index = (y * TEXT_OUTPUT[0] + x) * 4;
  let max = 0;
  for (let channel = 0; channel < 4; channel++)
    max = Math.max(max, Math.abs(frame[index + channel] - rgba[channel]));
  return max;
}

function textRegionDelta(left, right, rect) {
  let max = 0;
  let count = 0;
  for (let y = rect.y0; y < rect.y1; y++) {
    for (let x = rect.x0; x < rect.x1; x++) {
      const index = (y * TEXT_OUTPUT[0] + x) * 4;
      for (let channel = 0; channel < 4; channel++)
        max = Math.max(max, Math.abs(left[index + channel] - right[index + channel]));
      count++;
    }
  }
  return { max, count };
}

function textInkHits(frame, rect, threshold) {
  const hits = [];
  for (let y = rect.y0; y < rect.y1; y++) {
    for (let x = rect.x0; x < rect.x1; x++) {
      const delta = textPixelDelta(frame, x, y, TEXT_BACKGROUND_RGBA);
      if (delta > threshold) {
        hits.push([x, y, delta]);
        if (hits.length >= 4) return hits;
      }
    }
  }
  return hits;
}

function textOutsideInk(frame, bounds, margin, threshold) {
  const x0 = Math.floor(bounds.x - margin);
  const y0 = Math.floor(bounds.y - margin);
  const x1 = Math.ceil(bounds.x + bounds.width + margin);
  const y1 = Math.ceil(bounds.y + bounds.height + margin);
  const hits = [];
  for (let y = 0; y < TEXT_OUTPUT[1]; y++) {
    for (let x = 0; x < TEXT_OUTPUT[0]; x++) {
      if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
      const delta = textPixelDelta(frame, x, y, TEXT_BACKGROUND_RGBA);
      if (delta > threshold) {
        hits.push([x, y, delta]);
        if (hits.length >= 8) return hits;
      }
    }
  }
  return hits;
}

function assertLoadedFaces(proof, label) {
  assert.equal(proof?.family, TEXT_FONT_FAMILY, label);
  for (const weight of ["400", "700"]) {
    const face = proof.weights.find((entry) => entry.weight === weight);
    assert.ok(face, `${label} ${weight}`);
    assert.equal(face.status, "loaded", `${label} ${weight}`);
    assert.equal(face.family, TEXT_FONT_FAMILY, `${label} ${weight}`);
    assert.ok(
      proof.documentFaces.some(
        (entry) =>
          entry.weight === weight &&
          entry.status === "loaded" &&
          entry.family === TEXT_FONT_FAMILY,
      ),
      `${label} document.fonts ${weight}`,
    );
  }
}

function assertTextQuad(record, node, label) {
  assert.equal(record.kind, "text", label);
  assert.equal(record.provenance, "projected-text-draw-quad", label);
  assert.equal(record.space, "scene-target-pixels", label);
  assert.deepEqual([...record.resolution], [...TEXT_OUTPUT], label);
  assert.equal(record.accuracy, "exact-rectangle", label);
  assert.equal(record.geometryVisible, true, label);
  assert.equal(record.paintRole, "content", label);
  assert.equal(record.inspection.role, "content", label);
  assert.equal(record.inspection.nodeId, node.inspectionId, label);
  for (const value of Object.values(record.bounds))
    assert.equal(Number.isFinite(value), true, `${label} bounds`);
}

/**
 * Public CLI inspect of the flat Text fixture, then one FrameSource with the
 * real measurer. Pixel proof looks for ink inside the reported line-box quad,
 * not a filled rectangle and not a guessed glyph width.
 */
async function proveFlatText() {
  const evidence = {
    fixture: "scripts/inspect-fixture/manifest-text.mjs",
    output: [...TEXT_OUTPUT],
    offset: TEXT_OFFSET,
    styleId: TEXT_STYLE_ID,
    boundsMeaning:
      "texture/line-box draw quad from the FrameSource measurer, not glyph-ink bounds",
    quadInset: TEXT_QUAD_INSET,
    outsideMargin: TEXT_OUTSIDE_MARGIN,
    outsideMarginReason:
      "explicit margin for scale-1 linear filtering and font AA; the quad is not a pixel bound",
    g7: {
      productionCounters: "unavailable",
      renderPassReuse: "not-measured",
      textureReuse: "not-measured",
      reason:
        "G7 requires engine instrumentation. This script does not estimate passes or texture reuse.",
    },
  };
  let browser;
  let vite;
  try {
    const fixtureSource = await readFile(
      join(template, "manifest-text.mjs"),
      "utf8",
    );
    for (const needle of [
      "TIME_A = 0.25",
      "TIME_B = 1.25",
      "OFFSET = 40",
      "ORIGIN_X = 80",
      "ORIGIN_Y = 72",
      "EDGE_CLEARANCE = 40",
      'TEXT_ID = "ink"',
      'BACKGROUND_ID = "bg-ink"',
      'STYLE_ID = "ink-style"',
      "[320, 180]",
      "#112233",
      "#F7F4EC",
      "SIZE = 28",
      "WEIGHT = 700",
      "LINE_HEIGHT = 36",
      'TEXT = "H"',
      "QUAD_INSET = 2",
      "OUTSIDE_MARGIN = 2",
      "/fonts/Inter-Regular.woff2",
      "/fonts/Inter-Bold.woff2",
      "fontProof = await loadFonts()",
      "Ritween Fixture Inter",
    ])
      assert.ok(
        fixtureSource.includes(needle),
        `manifest-text.mjs drifted from the Lane B contract: missing ${needle}`,
      );
    await createConsumer(textConsumer, "manifest-text.mjs");
    latestFontProof = null;
    const inspectAt = (time, extra = []) =>
      inspectJson([
        "inspect",
        "--project",
        textConsumer,
        "--time",
        String(time),
        ...extra,
      ]);
    const stateA = await inspectAt(TEXT_TIME_A);
    const cliFontProof = latestFontProof;
    const stateB = await inspectAt(TEXT_TIME_B);
    assertLoadedFaces(cliFontProof, "CLI FontFace");
    evidence.cliFontProof = cliFontProof;
    const cliQuads = {};
    for (const [label, result, time] of [
      ["A", stateA, TEXT_TIME_A],
      ["B", stateB, TEXT_TIME_B],
    ]) {
      const { document } = result;
      assert.equal(document.capability.geometry.paint, "partial", label);
      assert.deepEqual([...document.project.resolution], [...TEXT_OUTPUT], label);
      assert.equal(document.time.requested, time, label);
      assert.equal(document.scenes.length, 1, label);
      assert.equal(
        document.diagnostics.some((entry) => entry.severity === "error"),
        false,
        label,
      );
      const scene = document.scenes[0];
      assert.equal(scene.scope, "scene:flat", label);
      const text = nodeById(scene.tree, TEXT_ID);
      const background = nodeById(scene.tree, TEXT_BACKGROUND_ID);
      assert.ok(text?.inspectionId !== undefined, TEXT_ID);
      assert.ok(background?.inspectionId !== undefined, TEXT_BACKGROUND_ID);
      const textRecord = recordOwnedBy(scene.paintRecords ?? [], text);
      const backgroundRecord = recordOwnedBy(scene.paintRecords ?? [], background);
      assert.ok(textRecord, `${TEXT_ID} paint record`);
      assert.ok(backgroundRecord, `${TEXT_BACKGROUND_ID} paint record`);
      assertTextQuad(textRecord, text, label);
      assert.equal(backgroundRecord.kind, "box", label);
      assert.equal(backgroundRecord.paintRole, "background", label);
      cliQuads[label] = textRecord.bounds;
      evidence[label === "A" ? "stateA" : "stateB"] = {
        scope: scene.scope,
        text: textRecord.bounds,
        provenance: textRecord.provenance,
        space: textRecord.space,
        resolution: textRecord.resolution,
        accuracy: textRecord.accuracy,
        geometryVisible: textRecord.geometryVisible,
        ownerId: text.inspectionId,
        backgroundId: TEXT_BACKGROUND_ID,
      };
    }
    assertFloat32Close(
      cliQuads.B.x - cliQuads.A.x,
      TEXT_OFFSET,
      "CLI bounds.x shift",
    );
    for (const key of ["y", "width", "height"])
      assertFloat32Close(cliQuads.A[key], cliQuads.B[key], `CLI ${key}`);
    assert.ok(
      cliQuads.A.x + cliQuads.A.width <=
        cliQuads.B.x +
          float32UniformTolerance(cliQuads.A.x, cliQuads.A.width, cliQuads.B.x),
      "reported text quads overlap",
    );
    for (const bounds of [cliQuads.A, cliQuads.B]) {
      assert.ok(bounds.x >= TEXT_EDGE_CLEARANCE, bounds);
      assert.ok(bounds.y >= TEXT_EDGE_CLEARANCE, bounds);
      assert.ok(
        bounds.x + bounds.width <= TEXT_OUTPUT[0] - TEXT_EDGE_CLEARANCE,
        bounds,
      );
      assert.ok(
        bounds.y + bounds.height <= TEXT_OUTPUT[1] - TEXT_EDGE_CLEARANCE,
        bounds,
      );
    }
    const targeted = await inspectAt(TEXT_TIME_A, [
      "--target",
      `scene:flat#${TEXT_ID}`,
    ]);
    const keptScene = targeted.document.scenes[0];
    const keptIds = idsOf(keptScene.tree).sort();
    assert.deepEqual(keptIds, [TEXT_ID, TEXT_STAGE_ID].sort());
    assert.equal(targeted.document.target.id, TEXT_ID);
    assert.equal(targeted.document.target.matches, 1);
    assert.equal(targeted.document.target.scope, "scene:flat");
    const keptText = nodeById(keptScene.tree, TEXT_ID);
    const keptRecords = keptScene.paintRecords ?? [];
    assert.equal(keptRecords.length, 1);
    assert.equal(keptRecords[0].inspection.nodeId, keptText.inspectionId);
    assert.equal(keptRecords[0].kind, "text");
    assert.equal(keptRecords[0].provenance, "projected-text-draw-quad");
    assertFloat32Close(keptRecords[0].bounds.x, cliQuads.A.x, "target bounds.x");
    assert.equal(
      keptRecords.some((record) => record.paintRole === "background"),
      false,
      "targeting ink must drop the background sibling",
    );
    assert.equal(
      (keptScene.commands ?? []).some(
        (command) => command.matchId === TEXT_BACKGROUND_ID,
      ),
      false,
    );
    evidence.target = {
      ...targeted.document.target,
      keptIds,
      droppedSibling: TEXT_BACKGROUND_ID,
    };

    vite = await createProofServer({ port: 5176, title: "Lane B text pixels" });
    browser = await launchProofBrowser();
    const page = await openProofPage(browser, vite);
    const browserErrors = page.proofErrors;
    const captured = await page.evaluate(captureFlatSequence, {
      modulePath: "/scripts/inspect-fixture/manifest-text.mjs",
      inspect: true,
    });
    assert.equal(captured.fontsReadyBeforeCreate, true);
    assertLoadedFaces(
      {
        ...captured.fontProof,
        documentFaces: captured.documentFacesBeforeCreate,
      },
      "harness FontFace",
    );
    assert.deepEqual(captured.steps, [
      "calibrate-a",
      "calibrate-a-repeat",
      "tolerance-recorded",
      "sequence-a",
      "sequence-b",
      "sequence-a",
    ]);
    const { cal1, cal2, seqA, seqB, seqA2 } = captured.frames;
    for (const frame of [cal1, cal2, seqA, seqB, seqA2])
      assert.deepEqual([frame.width, frame.height], [...TEXT_OUTPUT]);
    const noise = maxChannelDelta(cal1.pixels, cal2.pixels);
    assert.equal(noise, captured.tolerance);
    const colorGap = maxChannelDelta(TEXT_INK_RGBA, TEXT_BACKGROUND_RGBA);
    const inkThreshold = Math.max(noise + 1, Math.min(16, Math.floor(colorGap / 8)));
    assert.ok(
      inkThreshold * 2 < colorGap,
      `ink threshold ${inkThreshold} cannot separate ink from background (gap ${colorGap})`,
    );
    assert.ok(noise < inkThreshold, `noise ${noise} is not below ink threshold`);
    const owned = (frame) => {
      const node = frame.report.nodes.find((entry) => entry.id === TEXT_ID);
      const record = frame.report.records.find(
        (entry) => entry.inspection?.nodeId === node?.inspectionId,
      );
      assert.ok(node && record, "browser text record");
      assertTextQuad(record, node, "browser");
      assert.equal(frame.report.sceneId, "flat");
      return record;
    };
    const browserA = owned(seqA);
    const browserB = owned(seqB);
    const browserA2 = owned(seqA2);
    assert.equal(seqA.report.requestedTime, TEXT_TIME_A);
    assert.equal(seqB.report.requestedTime, TEXT_TIME_B);
    assert.equal(seqA2.report.requestedTime, TEXT_TIME_A);
    assertQuadEqual(browserA.bounds, cliQuads.A, "browser/CLI A");
    assertQuadEqual(browserB.bounds, cliQuads.B, "browser/CLI B");
    assertQuadEqual(browserA2.bounds, browserA.bounds, "browser A/A");
    assertFloat32Close(
      browserB.bounds.x - browserA.bounds.x,
      TEXT_OFFSET,
      "browser bounds.x shift",
    );
    for (const key of ["y", "width", "height"])
      assertFloat32Close(
        browserA.bounds[key],
        browserB.bounds[key],
        `browser ${key}`,
      );
    const fullFrame = {
      calibration: noise,
      sequenceAToA: maxChannelDelta(seqA.pixels, seqA2.pixels),
      sequenceAToB: maxChannelDelta(seqA.pixels, seqB.pixels),
    };
    assert.ok(fullFrame.sequenceAToA <= noise);
    assert.ok(fullFrame.sequenceAToB > noise, "A and B frames must differ");
    const rectA = insetQuad(browserA.bounds, TEXT_QUAD_INSET);
    const rectB = insetQuad(browserB.bounds, TEXT_QUAD_INSET);
    for (const rect of [rectA, rectB])
      assert.ok(rect.x1 > rect.x0 && rect.y1 > rect.y0, `inset quad empty ${JSON.stringify(rect)}`);
    const inkA = textInkHits(seqA.pixels, rectA, inkThreshold);
    const inkB = textInkHits(seqB.pixels, rectB, inkThreshold);
    assert.ok(inkA.length > 0, "no ink inside reported A quad");
    assert.ok(inkB.length > 0, "no ink inside reported B quad");
    const exclusiveA = textRegionDelta(seqA.pixels, seqB.pixels, rectA);
    const exclusiveB = textRegionDelta(seqA.pixels, seqB.pixels, rectB);
    assert.ok(exclusiveA.count > 0 && exclusiveA.max > noise, exclusiveA);
    assert.ok(exclusiveB.count > 0 && exclusiveB.max > noise, exclusiveB);
    const outsideA = textOutsideInk(
      seqA.pixels,
      browserA.bounds,
      TEXT_OUTSIDE_MARGIN,
      inkThreshold,
    );
    const outsideB = textOutsideInk(
      seqB.pixels,
      browserB.bounds,
      TEXT_OUTSIDE_MARGIN,
      inkThreshold,
    );
    assert.deepEqual(outsideA, [], `ink outside A quad margin: ${JSON.stringify(outsideA)}`);
    assert.deepEqual(outsideB, [], `ink outside B quad margin: ${JSON.stringify(outsideB)}`);
    const returnA = textRegionDelta(seqA.pixels, seqA2.pixels, rectA);
    assert.ok(returnA.max <= noise, returnA);
    await writeFile(join(reports, "text-a.png"), Buffer.from(seqA.png, "base64"));
    await writeFile(join(reports, "text-b.png"), Buffer.from(seqB.png, "base64"));
    evidence.fontProof = {
      fontsReadyBeforeCreate: captured.fontsReadyBeforeCreate,
      harness: captured.fontProof,
      documentFacesBeforeCreate: captured.documentFacesBeforeCreate,
      drawnFont: `${TEXT_WEIGHT} ${TEXT_SIZE}px ${TEXT_FONT_FAMILY}`,
    };
    evidence.pixels = {
      browser: { version: browser.version(), userAgent: captured.userAgent },
      gpu: captured.gpu,
      gpuError: captured.gpuError,
      renderErrors: captured.renderErrors,
      pageErrors: browserErrors,
      resolution: [...TEXT_OUTPUT],
      noise,
      colorGap,
      inkThreshold,
      fullFrame,
      rectA,
      rectB,
      inkA,
      inkB,
      exclusiveA,
      exclusiveB,
      outsideA,
      outsideB,
      returnA,
      reports: {
        A: seqA.report,
        B: seqB.report,
        A2: seqA2.report,
      },
      captures: [
        "artifacts/g1b/reports/text-a.png",
        "artifacts/g1b/reports/text-b.png",
      ],
      instance:
        "one FrameSource; fonts loaded before create; calibrate A twice, then seek A → B → A",
    };
    assert.deepEqual(captured.renderErrors, []);
    assert.deepEqual(browserErrors, []);
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await browser?.close();
    await vite?.close();
    await writeFile(
      join(reports, "text-pixel-proof.json"),
      JSON.stringify(evidence, null, 2),
    );
  }
  return evidence;
}

const findings = {};
await mkdir(reports, { recursive: true });
await createConsumer(consumer, "manifest.ts");
await createConsumer(regularConsumer, "manifest-regular.ts");
await createConsumer(slowConsumer, "manifest-slow.ts");
try {
  // -------- 1. Real-font geometry, both overlap scenes, overlay metadata --------
  const overlap = await inspectJson([
    "inspect",
    "--project",
    consumer,
    "--time",
    "1.5",
  ]);
  const { document } = overlap;
  assert.equal(document.schemaVersion, 1);
  assert.match(document.packageVersion, /^\d+\.\d+\.\d+/);
  assert.equal(document.project.name, "G1b inspection consumer");
  assert.deepEqual(document.time, { requested: 1.5, effective: 1.5 });

  assert.deepEqual(
    document.scenes.map((scene) => scene.scope),
    ["scene:first", "scene:second", "overlay"],
    "both transition scenes and the overlay must be published",
  );
  assert.deepEqual(
    document.scenes.map((scene) => scene.clock.localTime),
    [1.5, 0.5, 1.5],
    "scene-local and project clocks must stay distinct",
  );
  assert.deepEqual(
    document.scenes.map((scene) => scene.clock.progress),
    [0.75, 0.25, 0.375],
  );

  const first = document.scenes[0];
  for (const scene of document.scenes) {
    assert.equal(scene.inspection, "available", scene.scope);
    assert.ok(
      hasFractionalGeometry(scene.tree),
      `${scene.scope} geometry must come from the real Inter font, not the integer stub`,
    );
    // Published spaces are the ones the tree actually uses, not a fixed guess.
    const used = new Set();
    const collect = (node) => {
      used.add(node.space ?? "layout");
      node.children.forEach(collect);
    };
    collect(scene.tree);
    assert.deepEqual([...scene.spaces].sort(), [...used].sort(), scene.scope);
  }

  // The first scene embeds a Composition, so it must publish a second, scoped space.
  const firstSpaces = first.spaces;
  assert.equal(firstSpaces.length, 2, `nested space missing: ${firstSpaces}`);
  assert.equal(firstSpaces[0], "layout");
  assert.match(
    firstSpaces[1],
    /\/world$/,
    "the nested space extends the composition path",
  );
  findings.nestedSpaces = firstSpaces;

  // Nested authored IDs are targetable by ID, and their diagnostics resolve in-space.
  const nested = await inspectJson([
    "inspect",
    "--project",
    consumer,
    "--time",
    "1.5",
    "--target",
    "scene:first#world-stack",
  ]);
  assert.equal(nested.document.target.id, "world-stack");
  findings.nestedTargetPath = nested.document.target.path;

  const title = first.tree.children[0].children[0].children[0].children[0];
  assert.equal(title.kind, "hstack");
  const titleText = title.children[0];
  assert.equal(titleText.path.split("/").at(-1), "title");
  assert.equal(titleText.kind, "text");
  findings.realFontTitleWidth = titleText.bounds.width;
  assert.ok(
    titleText.bounds.width > 100 && titleText.bounds.width < 220,
    `title width ${titleText.bounds.width} must be real Inter geometry`,
  );

  // Render the identical text at weight 400 through the real CLI. Distinct widths
  // prove both fixture faces are loaded rather than a single fallback face.
  const regular = await inspectJson([
    "inspect",
    "--project",
    regularConsumer,
    "--time",
    "1.5",
  ]);
  const regularTitle =
    regular.document.scenes[0].tree.children[0].children[0].children[0]
      .children[0].children[0];
  assert.equal(regularTitle.id, "title");

  // Verify FontFace status and identity for 400 and 700:
  assert.ok(
    latestFontProof,
    "FontFace proof must be received from browser runtime",
  );
  assert.equal(latestFontProof.family, "Ritween Fixture Inter");
  const face400 = latestFontProof.weights.find((w) => w.weight === "400");
  const face700 = latestFontProof.weights.find((w) => w.weight === "700");
  assert.ok(face400, "FontFace 400 must be recorded");
  assert.ok(face700, "FontFace 700 must be recorded");
  assert.equal(face400.status, "loaded", "FontFace 400 status must be loaded");
  assert.equal(
    face400.family,
    "Ritween Fixture Inter",
    "FontFace 400 family must match",
  );
  assert.equal(face700.status, "loaded", "FontFace 700 status must be loaded");
  assert.equal(
    face700.family,
    "Ritween Fixture Inter",
    "FontFace 700 family must match",
  );

  assert.ok(
    latestFontProof.documentFaces.some(
      (f) =>
        f.weight === "400" &&
        f.status === "loaded" &&
        f.family === "Ritween Fixture Inter",
    ),
    "document.fonts must contain loaded 400 face",
  );
  assert.ok(
    latestFontProof.documentFaces.some(
      (f) =>
        f.weight === "700" &&
        f.status === "loaded" &&
        f.family === "Ritween Fixture Inter",
    ),
    "document.fonts must contain loaded 700 face",
  );

  // Same text and same maxWidth, so different metrics can only come from the face:
  // bold is wide enough to wrap onto a second line, regular is not. A width-only
  // comparison would pass on wrapping alone, so both extents are asserted.
  const bold = titleText.bounds;
  const regularBounds = regularTitle.bounds;
  assert.notDeepEqual(
    [bold.width, bold.height],
    [regularBounds.width, regularBounds.height],
    "weight 400 and 700 must measure differently, proving both faces loaded",
  );
  assert.ok(
    bold.height !== regularBounds.height,
    `bold must wrap and regular must not: bold h=${bold.height}, regular h=${regularBounds.height}`,
  );
  findings.fontProof = {
    weight700: {
      width: bold.width,
      height: bold.height,
      status: face700.status,
      family: face700.family,
    },
    weight400: {
      width: regularBounds.width,
      height: regularBounds.height,
      status: face400.status,
      family: face400.family,
    },
    documentFaces: latestFontProof.documentFaces,
  };
  findings.boxProof = await proveFlatBoxes();
  findings.textProof = await proveFlatText();

  // Legacy paths stay unqualified; the scope carries the qualification.
  for (const scene of document.scenes)
    assert.ok(!scene.tree.path.includes(":"), scene.scope);

  // -------- 2. Diagnostics: structured, scoped, numeric, no parse of warnings --------
  assert.ok(document.diagnostics.length > 0);
  for (const diagnostic of document.diagnostics) {
    assert.ok(
      document.scenes.some((scene) => scene.scope === diagnostic.scope),
      diagnostic.scope,
    );
    assert.equal(diagnostic.space, "layout");
    assert.equal(typeof diagnostic.clock.project, "number");
    assert.equal(typeof diagnostic.clock.local, "number");
  }
  const deficit = document.diagnostics.find(
    (entry) => entry.code === "fixed-allocation-deficit",
  );
  assert.ok(deficit, "the fixture must author a fixed-allocation deficit");
  assert.equal(deficit.severity, "error");
  assert.equal(deficit.id, "chips");
  assert.ok(deficit.deficit > 0, String(deficit.deficit));
  assert.equal(deficit.path.includes(deficit.scope), false);

  const overflow = document.diagnostics.find(
    (entry) => entry.code === "offered-size-overflow",
  );
  assert.ok(overflow && overflow.excess.width > 0);
  assert.equal(overflow.severity, "warning");

  // The legacy warning strings survive untouched next to the structured entries.
  assert.ok(
    first.warnings.some((w) => /content exceeds offered bounds/.test(w)),
  );
  assert.deepEqual(first.commands[0].kind, "text");
  const json = overlap.raw;
  for (const forbidden of [
    '"source"',
    "http://",
    "https://",
    "ImageBitmap",
    '"frame":{',
  ])
    assert.equal(
      json.includes(forbidden),
      false,
      `whitelisted output must not contain ${forbidden}`,
    );
  assert.equal(/NaN|Infinity/.test(json), false, "no non-finite geometry");
  findings.overlapDiagnostics = document.diagnostics.length;

  // -------- 3. Raw scene unavailable, capability honesty --------
  const rawInspection = await inspectJson([
    "inspect",
    "--project",
    consumer,
    "--time",
    "3.5",
  ]);
  const rawScene = rawInspection.document.scenes[0];
  assert.equal(rawScene.scope, "scene:raw");
  assert.equal(rawScene.inspection, "unavailable");
  assert.equal(rawScene.tree, undefined, "a raw scene is never an empty tree");
  assert.match(rawScene.unavailable, /does not implement/);
  assert.equal(
    rawInspection.document.diagnostics[0].code,
    "unavailable-inspection",
  );
  assert.deepEqual(rawInspection.document.capability.geometry, {
    layout: "exact-rectangle",
    paint: "partial",
  });
  assert.equal(
    rawInspection.document.capability.transitions.projection,
    "unavailable",
  );
  assert.match(
    rawInspection.document.capability.transitions.reason,
    /G3/,
    "transition projection must name its pending gate",
  );
  findings.rawUnavailableReason = rawScene.unavailable;

  // -------- 4. --fail-on error only changes the code when selected --------
  const failOn = await run([
    "inspect",
    "--project",
    consumer,
    "--time",
    "1.5",
    "--fail-on",
    "error",
  ]);
  assert.equal(failOn.code, 1, "an error diagnostic must fail --fail-on error");
  assert.match(failOn.stderr, /error diagnostic/);
  assert.doesNotThrow(
    () => JSON.parse(failOn.stdout),
    "--fail-on still publishes the full document",
  );
  const withoutFailOn = await run([
    "inspect",
    "--project",
    consumer,
    "--time",
    "1.5",
  ]);
  assert.equal(withoutFailOn.code, 0, "plain diagnostics keep exit 0");

  // -------- 5. --target keeps ancestor and space context, fails on bad targets --------
  const targeted = await inspectJson([
    "inspect",
    "--project",
    consumer,
    "--time",
    "1.5",
    "--target",
    "scene:first#chips",
  ]);
  assert.equal(targeted.document.scenes.length, 1);
  assert.equal(targeted.document.scenes[0].scope, "scene:first");
  assert.deepEqual(targeted.document.scenes[0].clock, first.clock);
  assert.deepEqual(targeted.document.scenes[0].spaces, ["layout"]);
  assert.deepEqual(targeted.document.time, document.time);
  assert.deepEqual(targeted.document.target, {
    scope: "scene:first",
    id: "chips",
    path: "window/padding/card/frame[2]/chips",
    matches: 1,
  });
  assert.ok(
    targeted.document.scenes[0].tree.path.startsWith("window"),
    "ancestors above the target are retained",
  );
  assert.ok(
    targeted.raw.length < overlap.raw.length,
    "targeting must reduce the payload",
  );
  assert.ok(
    targeted.document.scenes[0].commands.length <
      overlap.document.scenes[0].commands.length,
    "sibling draw commands must not survive a target",
  );
  assert.ok(
    targeted.document.diagnostics.every(
      (entry) => entry.scope === "scene:first",
    ),
    "diagnostics from other scopes must be dropped",
  );
  for (const args of [
    ["--target", "scene:first#missing"],
    ["--target", "scene:missing#chips"],
    ["--target", "chips"],
  ]) {
    const bad = await run([
      "inspect",
      "--project",
      consumer,
      "--time",
      "1.5",
      ...args,
    ]);
    const expected = args[1] === "chips" ? 2 : 1;
    assert.equal(bad.code, expected, `${args.join(" ")} -> ${bad.stderr}`);
    assert.equal(bad.stdout, "", "a failed target writes nothing to stdout");
  }
  findings.targetedBytes = targeted.raw.length;
  findings.fullBytes = overlap.raw.length;

  // -------- 6. Output file: atomic, non-destructive, --force overwrite --------
  const reportPath = join(reports, "inspect.json");
  await rm(reportPath, { force: true });
  const written = await run([
    "inspect",
    "--project",
    consumer,
    "--time",
    "1.5",
    "-o",
    reportPath,
  ]);
  assert.equal(written.code, 0, written.stderr);
  assert.equal(written.stdout, "", "--output keeps stdout clean");
  const savedBytes = (await readFile(reportPath, "utf8")).length;
  assert.deepEqual(
    JSON.parse(await readFile(reportPath, "utf8")),
    document,
    "the file must match stdout content",
  );
  const before = await stat(reportPath);
  const refused = await run([
    "inspect",
    "--project",
    consumer,
    "--time",
    "2.5",
    "-o",
    reportPath,
  ]);
  assert.equal(refused.code, 1, "an existing file needs --force");
  assert.match(refused.stderr, /Output exists/);
  assert.deepEqual(
    (await stat(reportPath)).size,
    before.size,
    "the refused write must not touch the existing file",
  );
  // A runtime failure under --force must also preserve the previous file.
  const failedForce = await run([
    "inspect",
    "--project",
    consumer,
    "--time",
    "99",
    "-o",
    reportPath,
    "--force",
  ]);
  assert.equal(failedForce.code, 1);
  assert.deepEqual(
    (await stat(reportPath)).size,
    before.size,
    "a failed --force write must not destroy the existing file",
  );
  const forced = await run([
    "inspect",
    "--project",
    consumer,
    "--time",
    "2.5",
    "-o",
    reportPath,
    "--force",
  ]);
  assert.equal(forced.code, 0, forced.stderr);
  assert.notEqual(
    (await stat(reportPath)).size,
    before.size,
    "--force must actually replace the file",
  );
  const leftovers = (await readFile(reportPath, "utf8")).length;
  assert.equal(leftovers > 0, true);
  findings.fileBytes = savedBytes;

  // -------- 7. Exit codes and cancellation --------
  for (const [args, expected, label] of [
    [["inspect", "--project", consumer], 2, "missing --time"],
    [["inspect", "--project", consumer, "--time", "99"], 1, "out of range"],
    [
      ["inspect", "--project", consumer, "--time", "1", "-o", "x.png"],
      2,
      "bad extension",
    ],
    [
      ["inspect", "--project", consumer, "--frame", "120", "--fps", "30"],
      1,
      "frame index at the duration endpoint",
    ],
  ]) {
    const result = await run(args);
    assert.equal(result.code, expected, `${label}: ${result.stderr}`);
    assert.equal(result.stdout, "", `${label} must not write to stdout`);
  }
  // Discovery parity with every other command: no --project means "here".
  const discovered = await run(["inspect", "--time", "1.5"], {
    cwd: consumer,
  });
  assert.equal(
    discovered.code,
    0,
    `inspect must reuse existing project discovery: ${discovered.stderr}`,
  );
  assert.equal(
    JSON.parse(discovered.stdout).project.name,
    "G1b inspection consumer",
  );
  findings.discovery = "current directory, matching frame/export";

  // Cancellation while the browser is starting up: no output at all.
  const cancelledEarly = await run([
    "inspect",
    "--project",
    consumer,
    "--time",
    "1.5",
    "--timeout",
    "0.05",
  ]);
  assert.equal(cancelledEarly.code, 1, "a cancelled run must fail");
  assert.equal(cancelledEarly.stdout, "", "a cancelled run publishes no JSON");
  assert.match(cancelledEarly.stderr, /timed out|Cancelled/);

  // Cancellation during the render phase: proved deterministically by waiting for the
  // explicit handshake indicating the fixture has entered render evaluation before SIGINT
  // is sent (no 900ms startup guess). The run must exit 130, create no output file and strand no temp file.
  {
    const path = join(reports, "cancel-mid-render.json");
    await rm(path, { force: true });

    let renderStarted = false;
    const renderStartedPromise = new Promise((resolve) => {
      renderStartedHandler = () => {
        renderStarted = true;
        resolve();
      };
    });

    const child = spawn(
      cli.command,
      [
        ...cli.args,
        "inspect",
        "--project",
        slowConsumer,
        "--time",
        "1.5",
        "-o",
        path,
      ],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const finished = new Promise((done) => child.on("close", done));

    // Wait until the fixture explicitly handshakes that it has entered render evaluation
    await Promise.race([
      renderStartedPromise,
      finished.then((code) => {
        throw Error(
          `Process exited early with code ${code} before render handshake arrived: ${stderr}`,
        );
      }),
    ]);

    assert.equal(
      renderStarted,
      true,
      "render evaluation handshake must have fired before SIGINT",
    );
    assert.equal(
      child.exitCode,
      null,
      "the slow fixture must still be running when the signal is sent",
    );
    child.kill("SIGINT");
    const code = await finished;
    assert.equal(
      code,
      130,
      `mid-render cancel: expected exit 130, got ${code}`,
    );
    await assert.rejects(
      stat(path),
      /ENOENT/,
      "a cancelled render must not create the output file",
    );
    const stranded = (await readdir(reports)).filter((name) =>
      name.includes(".tmp"),
    );
    assert.deepEqual(stranded, [], "no temp file may survive cancellation");
    findings.cancelMidRender = {
      code,
      stderr: stderr.trim(),
      handshake: "explicit-render-evaluation",
    };
  }

  // -------- 8. The published budget is 64 MiB and this fixture is far below it --------
  const fullBytes = Buffer.byteLength(overlap.raw, "utf8");
  assert.equal(
    fullBytes,
    findings.fullBytes,
    "stdout byte length must match the serialized document",
  );
  assert.ok(
    fullBytes < 64 * 1024 * 1024,
    `the fixture must stay well under the 64 MiB budget, measured ${fullBytes}`,
  );

  const report = {
    command: "inspect",
    executable: cli.command,
    fixture: "artifacts/g1b/consumer",
    font: "tests/fixtures/fonts/Inter-*.woff2 (SIL OFL 1.1)",
    ...findings,
    passed: [
      "real-font geometry from a consumer manifest",
      "400 and 700 fixture faces both rasterize (widths differ)",
      "both active scenes during crossfade overlap",
      "project overlay metadata with the project clock",
      "raw scene unavailable with a reason",
      "capability states pending transition projection (G3)",
      "structured diagnostics with scoped ids and numeric excess/deficit",
      "legacy warning strings preserved",
      "media and private objects excluded from output",
      "--target narrowing with ancestor and space context",
      "--target drops sibling commands and keeps retained-subtree errors",
      "nested Composition publishes its own scoped space",
      "atomic non-destructive output and --force overwrite",
      "--fail-on error and exit codes 0/1/2",
      "cancellation publishes no partial JSON",
      "cancellation during render leaves no output and no temp file",
      "output stays inside the 64 MiB budget",
      "flat Box CLI: partial paint, projected-box-draw-quad, scene-target-pixels, 320x180",
      "target keeps box owner and drops the background sibling",
      "transition projection unavailable at the non-overlapping sample",
      "one FrameSource A→B→A pixels within calibration tolerance",
      "clip --fail-on error follows fixed-allocation-deficit, not a clip code",
      "G7 counters left unavailable",
      "flat Text CLI: partial paint, projected-text-draw-quad, scene-target-pixels, 320x180",
      "text bounds.x shifts by the fixture offset within float32 tolerance",
      "target keeps the text owner and drops the background sibling",
      "FontFace 400 and 700 loaded and registered before FrameSource.create",
      "one FrameSource text A→B→A ink inside the reported quad, not a filled rect",
      "text G7 counters left unavailable",
    ],
  };
  await writeFile(
    join(reports, "inspect-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  handshakeServer.close();
  // Keep the fixture and report; only transient captures are cleaned.
  await copyFile(
    join(consumer, "public/fonts/LICENSE.txt"),
    join(reports, "font-license.txt"),
  ).catch(() => {});
}
