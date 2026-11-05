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
 * - authored-ID targeting, atomic --output, exit codes and cancellation.
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
import { nodeCli } from "./node-cli.mjs";

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
    paint: "unavailable",
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
