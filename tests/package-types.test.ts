import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("packed package supports strict TypeScript consumers without allowJs", () => {
  const temporary = mkdtempSync(join(tmpdir(), "ritween-package-types-"));
  const run = (command: string, args: string[], cwd = temporary) => {
    const result = spawnSync(command, args, { cwd, encoding: "utf8" });
    assert.equal(
      result.status,
      0,
      `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`,
    );
    return result.stdout;
  };
  try {
    const packed = JSON.parse(
      run(
        process.execPath,
        [
          process.env.npm_execpath ??
            join(process.execPath, "..", "node_modules/npm/bin/npm-cli.js"),
          "pack",
          "--json",
          "--pack-destination",
          temporary,
        ],
        root,
      ),
    );
    const consumer = join(temporary, "consumer");
    const modules = join(consumer, "node_modules");
    const installed = join(modules, "ritween");
    mkdirSync(installed, { recursive: true });
    run("tar", [
      "-xzf",
      join(temporary, packed[0].filename),
      "--strip-components=1",
      "-C",
      installed,
    ]);
    const manifest = JSON.parse(
      readFileSync(join(installed, "package.json"), "utf8"),
    );
    assert.equal(manifest.exports["."].types, "./types/index.d.ts");
    assert.equal(manifest.exports["."].default, "./dist/index.js");
    assert.ok(
      !packed[0].files.some((entry: { path: string }) =>
        /^(src|cli|public)\//.test(entry.path),
      ),
    );
    run(process.execPath, [
      "--input-type=module",
      "-e",
      `import { exportVideo, exportMp4, validateProject } from ${JSON.stringify(new URL(`file://${join(installed, "dist/index.js")}`).href)}; if (exportVideo !== exportMp4 || typeof validateProject !== 'function') process.exit(1);`,
    ]);
    for (const file of [
      "dist/index.js",
      "dist/cli.js",
      "dist/studio.js",
      "dist/studio.css",
      "dist/renderer.js",
      "dist/schema.js",
      "dist/demo/manifest.js",
      "dist/index.html",
      "dist/favicon.svg",
      "types/index.d.ts",
      "types/engine/project-settings-schema.d.ts",
      "types/engine/export/formats/mp4/size-constraints.d.ts",
    ]) {
      assert.ok(
        packed[0].files.some((entry: { path: string }) => entry.path === file),
        `Missing generated declaration: ${file}`,
      );
    }
    mkdirSync(join(modules, "@webgpu"));
    symlinkSync(
      join(root, "node_modules/@webgpu/types"),
      join(modules, "@webgpu/types"),
      process.platform === "win32" ? "junction" : "dir",
    );
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    writeFileSync(
      join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          noEmit: true,
          allowJs: false,
          skipLibCheck: false,
          types: [],
        },
        include: ["consumer.ts"],
      }),
    );
    writeFileSync(
      join(consumer, "consumer.ts"),
      `import { parseProjectSettings, mergeProjectSettings, validateProject, videoClip, imageScene, audioFile, videoResource, loadVideoTexture, loadImageTexture } from "ritween";
import { Stage, StageEntry, Overlay, Text, Box, HStack, VStack, ZStack, Spacer, motion, evaluateView, Camera, evaluateCamera, fitCamera, keyframes, worldToView, viewToWorld, World, Shot, Composition, evaluateActive, Circle, Line, Group, ForEach, Image, Video, Motion, ViewNode } from "ritween";
import type { Project, ProjectSettings, StageScene, EvaluatedFrame } from "ritween";
import { INSPECTION_SCHEMA_VERSION, buildInspectionDocument, measureInspection, parseInspectionTarget, serializeInspection, FrameSource } from "ritween";
import type { InspectionDocument, InspectionDiagnostic, LayoutDiagnostic, LayoutNode, LayoutSize, Bounds, FrameInspection, SceneInspection, PaddingInsets, FrameOptions, BackgroundStyle } from "ritween";
const reusable: ViewNode = Text("Declarative", { size: 32, maxWidth: 400, tracking: 1 });
const flexibleNode: ViewNode = reusable.flex(2);
void flexibleNode;
// @ts-expect-error flex weight must be a number.
const badFlex: ViewNode = reusable.flex("large");
void badFlex;
const stage: StageScene = Stage(({ theme }) => VStack([
  reusable.opacity({ from: 0, to: 1, duration: 0.8 }), Spacer(),
  HStack([Box({ width: 100, height: 40, fill: theme.colors.accent }), reusable.flex(1)]),
  ZStack([]),
]).padding(24).frame({ width: "fill", height: "fill" }));
const evaluated: EvaluatedFrame = evaluateView(reusable, { time: 0, width: 400, height: 300, measureText: (text) => text.length * 10 });
type PublicViewOption = keyof Parameters<typeof evaluateView>[1];
const viewOptionsStayPublic: "inspectionCounter" extends PublicViewOption ? never : true = true;
void viewOptionsStayPublic;
const layoutDiagnostic: LayoutDiagnostic = {
  code: "unused-flex",
  severity: "warning",
  path: "root",
  localTime: 0,
  space: "layout",
  message: "flex has no effect outside HStack or VStack",
};
// @ts-expect-error Diagnostic codes are a closed set of stable strings.
const badCode: LayoutDiagnostic = { ...layoutDiagnostic, code: "made-up" };
// @ts-expect-error Severity is warning or error only.
const badSeverity: LayoutDiagnostic = { ...layoutDiagnostic, severity: "info" };
const frameForInspection: SceneInspection = { tree: evaluated.tree, commands: evaluated.commands, warnings: evaluated.warnings };
// Additive identity/space metadata is optional, so legacy code keeps compiling.
const identifiedNode: LayoutNode = evaluated.tree;
const optionalId: string | undefined = identifiedNode.id;
const optionalSpace: string | undefined = identifiedNode.space;
const optionalOffered: LayoutSize | undefined = identifiedNode.offeredSize;
const optionalSlot: Bounds | undefined = identifiedNode.allocatedSlot;
// @ts-expect-error A tree node cannot carry a numeric authored ID.
const badId: LayoutNode = { ...evaluated.tree, id: 7 };
void [optionalId, optionalSpace, optionalOffered, optionalSlot, badId];
const inspectionDocument: InspectionDocument = buildInspectionDocument({
  packageVersion: "0.0.0",
  project: { name: "Consumer", duration: 1, resolution: [320, 180] },
  frame: { requestedTime: 0, effectiveTime: 0, scenes: [{ id: "main", name: "Main", time: 0, localTime: 0, progress: 0, frame: frameForInspection }] } satisfies FrameInspection,
  target: parseInspectionTarget("scene:main#card"),
});
const inspectionJson: string = serializeInspection(inspectionDocument);
const measuredBytes: number = measureInspection(inspectionDocument);
void measuredBytes;
const inspectionDiagnostic: InspectionDiagnostic | undefined = inspectionDocument.diagnostics[0];
const schemaVersion: number = INSPECTION_SCHEMA_VERSION;
void [layoutDiagnostic, badCode, badSeverity, inspectionJson, inspectionDiagnostic, schemaVersion, FrameSource];
const value: number = motion({ from: 0, to: 1, duration: 1 }, 0.5);
// @ts-expect-error Unsupported easing must not silently become linear.
reusable.opacity({ from: 0, to: 1, duration: 1, ease: "unknown" });
const camera = Camera({ x: 100, zoom: keyframes([{ at: 0, value: 1 }, { at: 2, value: 0.5 }]), rotation: 0 });
const cameraStage: StageScene = Stage(() => reusable, { camera, textResolution: 2 });
const proceduralStage = Stage(() => reusable, { camera: ({ localTime, designSize }) => ({ x: designSize[0] / 2 + Math.sin(localTime) * 20 }) });
const cameraState = evaluateCamera(fitCamera({ x: 0, y: 0, width: 100, height: 100 }, [1920, 1080]), 0, [1920, 1080]);
const point = worldToView(cameraState, viewToWorld(cameraState, [0, 0]));
const world = World(() => reusable, { size: [1920, 1080] });
const nested = Composition(world, { size: [640, 360], camera, overlay: () => reusable, rate: 1, offset: 2 });
const shot = Shot({ id: "shot", source: "manifest.ts", start: 1, duration: 2, world, camera, transition: { type: "crossfade", duration: 0.5 } });
void [stage, evaluated, value, cameraStage, proceduralStage, point, nested, shot, evaluateActive];
const settings: ProjectSettings = mergeProjectSettings(undefined, parseProjectSettings({ version: 1 }));
const version: 1 = settings.version;
// @ts-expect-error The parser result must retain its declared version type.
const invalidVersion: 2 = parseProjectSettings({ version: 1 }).version;
// @ts-expect-error Merging must reject unsupported settings versions.
mergeProjectSettings({ version: 2 }, undefined);
const project: Project = {
  name: "Consumer", resolution: [320, 180], aspectRatio: [16, 9], duration: 1,
  settings, scenes: [{ id: "main", name: "Main", source: "main.ts", start: 0,
    duration: 1, transition: { type: "cut" },
    create: () => ({ setup() {}, render() {}, dispose() {} }) }],
};
project.overlay = () => Overlay(({ localTime, progress }) => Text(String(localTime + progress)).padding(20), { designSize: [320, 180], textResolution: 2 });
// @ts-expect-error Global overlay has no camera; move content inside a Composition instead.
Overlay(() => reusable, { camera });
// @ts-expect-error Global overlay cannot clear the scene with a background.
Overlay(() => reusable, { background: "#FFFFFF" });
validateProject(project);
const footage = videoResource({ id: "footage", name: "Footage", url: "/shot.mp4", start: 0, duration: 1 });
project.mediaClips = [footage];
const mediaWorld = World(() => Group([
  Video(footage, { width: 320, height: 180, fit: "cover" }),
  Image({ url: "/logo.png", width: 40, height: 40 }),
  Circle({ radius: 10, stroke: "#FFFFFF", strokeWidth: 2, trim: [0, Motion.fade()] }),
  Line({ from: [0, 0], to: [20, 20], progress: Motion.fade() }),
  HStack(ForEach([{ id: "one" }], (item) => item.id, (_item, index) => reusable.offset(0, Motion.stagger(index, 0.1, Motion.slide())))),
]), { size: [320, 180] });
const mediaShot = Shot({ id: "media", source: "manifest.ts", start: 0, duration: 1, world: mediaWorld, mediaClips: [footage], images: ["/later.png"] });
const stageEntry = StageEntry({ id: "direct", source: "manifest.ts", start: 0, duration: 1, mediaClips: [footage], view: () => Video(footage, { width: 320, height: 180 }) });
const clipped = Video(footage, { width: 100, height: 100, crop: { x: 0.7, zoom: Motion.scale({ from: 1, to: 2 }) } }).clip({ shape: "rect", radius: 20 });
// G2a primitives: directional padding, per-axis frame alignment, content background.
const directionalInsets: PaddingInsets = { top: 8, right: 12, bottom: 8, left: 12 };
const axisFrame: FrameOptions = { width: "fill", height: 40, alignX: "end", alignY: "start" };
const cardStyle: BackgroundStyle = { fill: "#FFFFFF", radius: 8, stroke: "#202B38", strokeWidth: 1 };
const card = reusable.padding(directionalInsets).frame(axisFrame).background(cardStyle);
const symmetricCard = reusable.padding(24, 8).background({ fill: "#FFFFFF" });
// @ts-expect-error A background sets no size; width must not become a layout dimension.
reusable.background({ fill: "#FFFFFF", width: 10 });
// @ts-expect-error Frame axis values are the existing Alignment union.
reusable.frame({ alignX: "middle" });
// The background wrapper's declared ID keeps one semantic shared-element target.
const identifiedCard = reusable.background({ fill: "#FFFFFF" }).id("card");
const leafIdentifiedCard = reusable.id("card").background({ fill: "#FFFFFF" });
// @ts-expect-error Padding no longer accepts the unpublished x/y spec shape.
new ViewNode({ kind: "padding", x: 12, y: 6, child: reusable });
void [card, symmetricCard, identifiedCard, leafIdentifiedCard];
const circleClip = clipped.clip({ shape: "circle" });
const pathClip = clipped.clip({ shape: "path", outline: [["M", 0, 0], ["L", 100, 0], ["L", 0, 100], ["Z"]], fillRule: "evenodd" });
const imageClip = clipped.clip({ shape: "image", url: "/mask.png", mode: "luminance" });
void [mediaShot, stageEntry, circleClip, pathClip, imageClip];
project.scenes = [videoClip({ id: "video", name: "Video", source: "manifest.ts", url: "/shot.mp4", start: 0,
  trim: { in: 0, out: 1 }, audio: { muted: false } })];
const still = imageScene({ id: "image", name: "Image", source: "manifest.ts", url: "/logo.png", start: 0, duration: 1,
  transform: ({ localTime }) => ({ opacity: localTime, rotation: 0 }) });
const music = audioFile({ url: "/bgm.wav", volume: 0.2, loop: true });
project.settings = { version: 1, audioClips: { footage: { muted: false } } };
void [version, still, music, loadVideoTexture, loadImageTexture];
`,
    );
    run(
      process.execPath,
      [
        join(root, "node_modules/typescript/bin/tsc"),
        "-p",
        join(consumer, "tsconfig.json"),
      ],
      consumer,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
