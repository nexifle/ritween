import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseProjectSettings,
  mergeProjectSettings,
  audibleAudioTracks,
  mutedAudioClipIds,
} from "../src/engine/project-settings";
import { renderAudio } from "../src/engine/audio";
import type { Project } from "../src/engine/types";
import {
  settingsPath,
  readProjectSettings,
  writeSettingsCommand,
  parseSettingsCommand,
} from "../cli/project-settings.mjs";

const project: Project = {
  name: "Settings",
  duration: 1,
  resolution: [100, 100],
  aspectRatio: [1, 1],
  scenes: [
    {
      id: "scene",
      name: "Scene",
      source: "scene.ts",
      start: 0,
      duration: 1,
      transition: { type: "cut" },
      create: () => {
        throw Error("unused");
      },
    },
  ],
  audioTracks: ["voice", "music"].map((id) => ({
    id,
    name: id,
    clips: [
      {
        id,
        name: id,
        start: 0,
        duration: 1,
        create: () => {
          throw Error("Muted source must never be constructed");
        },
      },
    ],
  })),
};

test("entity settings override authored defaults per property and keep stable IDs", () => {
  const settings = mergeProjectSettings(
    {
      version: 1,
      audioTracks: { voice: { muted: true }, music: { muted: true } },
      audioClips: { voice: { muted: true }, music: { muted: true } },
    },
    {
      version: 1,
      audioTracks: { voice: { muted: false } },
      audioClips: { voice: { muted: false } },
    },
  );
  const effective = { ...project, settings };
  assert.deepEqual(mutedAudioClipIds(effective), ["music"]);
  assert.deepEqual(
    audibleAudioTracks(effective).map((track) => track.id),
    ["voice"],
  );
  assert.deepEqual(
    audibleAudioTracks({
      ...effective,
      audioTracks: [...project.audioTracks!].reverse(),
    }).map((track) => track.id),
    ["voice"],
  );
  assert.deepEqual(audibleAudioTracks(effective, ["voice"]), []);
  assert.deepEqual(
    audibleAudioTracks(project).map((track) => track.id),
    ["voice", "music"],
  );
});

test("clip mute resolves saved settings over authored defaults while track mute gates every clip", () => {
  const source = project.audioTracks![0].clips[0];
  const clips = [
    { ...source, id: "authored-muted", muted: true },
    { ...source, id: "saved-muted", muted: false },
    { ...source, id: "saved-unmuted", muted: true },
  ];
  const effective = {
    ...project,
    audioTracks: [{ id: "footage", name: "Footage", clips }],
    settings: {
      version: 1 as const,
      audioTracks: { footage: { muted: true } },
      audioClips: {
        "saved-muted": { muted: true },
        "saved-unmuted": { muted: false },
      },
    },
  };
  assert.deepEqual(mutedAudioClipIds(effective), [
    "authored-muted",
    "saved-muted",
  ]);
  assert.deepEqual(audibleAudioTracks(effective), []);
  assert.deepEqual(
    audibleAudioTracks({
      ...effective,
      settings: {
        ...effective.settings,
        audioTracks: { footage: { muted: false } },
      },
    }).map((track) => track.id),
    ["footage"],
  );
});

test("all-muted exports omit the soundtrack without constructing audio sources or a context", async () => {
  const muted = {
    ...project,
    settings: {
      version: 1 as const,
      audioTracks: { voice: { muted: true }, music: { muted: true } },
    },
  };
  assert.equal(await renderAudio(muted, [], 30), null);
  assert.equal(
    await renderAudio(
      {
        ...project,
        settings: {
          version: 1,
          audioClips: {
            voice: { muted: true },
            music: { muted: true },
          },
        },
      },
      [],
      30,
    ),
    null,
  );
  assert.equal(
    await renderAudio(
      {
        ...project,
        audioTracks: [],
        mediaClips: [
          {
            id: "footage",
            name: "Footage",
            url: "./footage.mp4",
            start: 0,
            duration: 1,
            muted: true,
          },
        ],
      },
      [],
      30,
    ),
    null,
  );
});

test("schema rejects malformed or unsupported data and commands", () => {
  for (const value of [
    null,
    [],
    { version: 2 },
    { version: 1, audioTracks: [] },
    { version: 1, audioTracks: { voice: { muted: "yes" } } },
    { version: 1, audioClips: [] },
    { version: 1, audioClips: { voice: { muted: "yes" } } },
  ])
    assert.throws(() => parseProjectSettings(value));
  for (const value of [
    {},
    { type: "set-audio-track-muted", id: "", muted: true },
    { type: "set-audio-track-muted", id: "a", muted: 1 },
    { type: "set-audio-clip-muted", id: "", muted: true },
    { type: "set-audio-clip-muted", id: "clip", muted: 1 },
  ])
    assert.throws(() => parseSettingsCommand(value));
});

test("save and reload preserve unrelated fields, explicit unmute and authored source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ritween-settings-"));
  try {
    const manifest = join(directory, "manifest.ts");
    await writeFile(manifest, "export default {};\n");
    assert.deepEqual(readProjectSettings(manifest), { version: 1 });
    await writeFile(
      settingsPath(manifest),
      JSON.stringify({
        version: 1,
        scenes: { intro: { visible: false } },
        audioTracks: { music: { muted: true, gain: 0.5 } },
        audioClips: { footage: { muted: false, note: "preserve" } },
      }),
    );
    await writeSettingsCommand(manifest, {
      type: "set-audio-track-muted",
      id: "voice",
      muted: true,
    });
    await writeSettingsCommand(manifest, {
      type: "set-audio-track-muted",
      id: "voice",
      muted: false,
    });
    await writeSettingsCommand(manifest, {
      type: "set-audio-clip-muted",
      id: "footage",
      muted: true,
    });
    const data = JSON.parse(await readFile(settingsPath(manifest), "utf8"));
    assert.deepEqual(data.audioTracks, {
      music: { muted: true, gain: 0.5 },
      voice: { muted: false },
    });
    assert.deepEqual(data.audioClips, {
      footage: { muted: true, note: "preserve" },
    });
    assert.deepEqual(data.scenes, { intro: { visible: false } });
    assert.equal(await readFile(manifest, "utf8"), "export default {};\n");
    assert.equal(readProjectSettings(manifest).audioTracks?.voice.muted, false);
    assert.equal(readProjectSettings(manifest).audioClips?.footage.muted, true);
    await writeFile(settingsPath(manifest), '{"version":1}');
    await writeSettingsCommand(manifest, {
      type: "set-audio-track-muted",
      id: "voice",
      muted: true,
    });
    assert.equal(readProjectSettings(manifest).audioTracks?.voice.muted, true);
    await writeFile(settingsPath(manifest), "broken json");
    await assert.rejects(
      writeSettingsCommand(manifest, {
        type: "set-audio-track-muted",
        id: "voice",
        muted: true,
      }),
    );
    assert.equal(await readFile(settingsPath(manifest), "utf8"), "broken json");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("settings writes cannot follow a symlink to a different file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ritween-settings-"));
  try {
    const manifest = join(directory, "manifest.ts");
    const outside = join(directory, "other.json");
    await writeFile(outside, '{"version":1}');
    try {
      await symlink(outside, settingsPath(manifest));
    } catch (error) {
      if (
        process.platform !== "win32" ||
        (error as NodeJS.ErrnoException).code !== "EPERM"
      )
        throw error;
      t.skip(
        "File symlinks require Windows Developer Mode or elevated privileges.",
      );
      return;
    }
    await assert.rejects(
      writeSettingsCommand(manifest, {
        type: "set-audio-track-muted",
        id: "voice",
        muted: true,
      }),
      /regular file/,
    );
    assert.equal(await readFile(outside, "utf8"), '{"version":1}');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("settings endpoint serializes concurrent edits and rejects cross-origin writes", async () => {
  const { createServer } = await import("node:http");
  const { projectSettingsMiddleware } =
    await import("../cli/project-settings.mjs");
  const directory = await mkdtemp(join(tmpdir(), "ritween-settings-http-"));
  const manifest = join(directory, "manifest.ts");
  const middleware = projectSettingsMiddleware(manifest, () => {});
  const server = createServer((req, res) =>
    middleware(req, res, () => {
      res.statusCode = 404;
      res.end();
    }),
  );
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/__ritween/settings`;
    const patch = (id: string, origin?: string) =>
      fetch(url, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(origin ? { Origin: origin } : {}),
        },
        body: JSON.stringify({
          type: "set-audio-track-muted",
          id,
          muted: true,
        }),
      });
    const responses = await Promise.all([patch("voice"), patch("music")]);
    assert.ok(responses.every((response) => response.ok));
    const data = readProjectSettings(manifest);
    assert.equal(data.audioTracks?.voice.muted, true);
    assert.equal(data.audioTracks?.music.muted, true);
    assert.equal(
      (await patch("other", "https://unrelated.example")).status,
      403,
    );
    assert.equal(readProjectSettings(manifest).audioTracks?.other, undefined);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("export patches merge per field and preserve audio and authored defaults", async () => {
  const authored = {
    version: 1 as const,
    export: { fps: 60 as const, bitrate: 4000000 },
    audioTracks: { voice: { muted: true } },
  };
  const merged = mergeProjectSettings(authored, {
    version: 1,
    export: { bitrate: "auto", keyFrameInterval: 4 },
  });
  assert.deepEqual(merged.export, {
    fps: 60,
    bitrate: "auto",
    keyFrameInterval: 4,
  });
  assert.equal(merged.audioTracks?.voice.muted, true);
  const directory = await mkdtemp(join(tmpdir(), "ritween-export-settings-"));
  try {
    const manifest = join(directory, "manifest.ts");
    await writeSettingsCommand(manifest, {
      type: "set-audio-track-muted",
      id: "voice",
      muted: true,
    });
    await writeSettingsCommand(manifest, {
      type: "update-export-settings",
      patch: { fps: 24, bitrate: 2000000 },
    });
    await writeSettingsCommand(manifest, {
      type: "update-export-settings",
      patch: { bitrate: "auto" },
    });
    const saved = readProjectSettings(manifest);
    assert.deepEqual(saved.export, { fps: 24, bitrate: "auto" });
    assert.equal(saved.audioTracks?.voice.muted, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid export settings and patch fields are rejected", () => {
  for (const patch of [
    null,
    [],
    { fps: 25 },
    { bitrate: 0 },
    { bitrate: "automatic" },
    { latencyMode: "fast" },
    { keyFrameInterval: 0 },
    { keyFrameInterval: 61 },
    { resolution: [63, 64] },
    { resolution: [1920] },
    { resolution: [8192, 8192] },
    { unknown: true },
    {},
  ]) {
    assert.throws(() =>
      parseSettingsCommand({ type: "update-export-settings", patch }),
    );
  }
  assert.throws(() =>
    parseProjectSettings({ version: 1, export: { fps: 25 } }),
  );
});

test("CLI export flags override persisted settings only when explicitly provided", async () => {
  const { parseOptions } = await import("../cli/options.mjs");
  const { resolveExportRequest } =
    await import("../src/engine/export/project-settings");
  const effective = {
    ...project,
    settings: {
      version: 1 as const,
      export: {
        resolution: [64, 64] as const,
        fps: 24 as const,
        bitrate: 4000000,
        latencyMode: "realtime" as const,
        keyFrameInterval: 4,
      },
    },
  };
  assert.deepEqual(parseOptions(["export"]).exportOverrides, {});
  assert.deepEqual(
    resolveExportRequest(effective, parseOptions(["export"]).exportOverrides),
    {
      width: 64,
      height: 64,
      fps: 24,
      bitrate: 4000000,
      latencyMode: "realtime",
      keyFrameInterval: 4,
    },
  );
  const options = parseOptions([
    "export",
    "--fps",
    "60",
    "--bitrate",
    "auto",
    "--latency-mode",
    "quality",
    "--keyframe-interval",
    "1",
  ]);
  assert.deepEqual(
    resolveExportRequest(effective, {
      ...options.exportOverrides,
      width: 100,
      height: 100,
    }),
    {
      width: 100,
      height: 100,
      fps: 60,
      bitrate: undefined,
      latencyMode: "quality",
      keyFrameInterval: 1,
    },
  );
  assert.throws(
    () => resolveExportRequest(effective, { width: 64 }),
    /together/,
  );
  assert.throws(
    () => resolveExportRequest(effective, { width: 64, height: 32 }),
    /aspect/,
  );
});
