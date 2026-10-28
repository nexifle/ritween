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
import type { Project, ProjectSettings } from "ritween";
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
validateProject(project);
const footage = videoResource({ id: "footage", name: "Footage", url: "/shot.mp4", start: 0, duration: 1 });
project.mediaClips = [footage];
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
