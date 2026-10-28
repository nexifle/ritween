import type { Connect } from "vite";
import type { ProjectSettings } from "../src/engine/types";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  parseProjectSettings,
  parseExportSettings,
} from "../src/engine/project-settings-schema.ts";

export const settingsPath = (manifest: string) =>
  manifest.replace(/\.[^.\/]+$/, "") + ".settings.json";

export function readProjectSettings(manifest: string): ProjectSettings {
  try {
    return parseProjectSettings(
      JSON.parse(readFileSync(settingsPath(manifest), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 1 };
    throw error;
  }
}

/** Narrow commands keep UI mutations independent of the persisted document shape. */
export function parseSettingsCommand(value: unknown):
  | {
      type: "update-export-settings";
      patch: ReturnType<typeof parseExportSettings>;
    }
  | {
      type: "set-audio-track-muted" | "set-audio-clip-muted";
      id: string;
      muted: boolean;
    } {
  if (!value || typeof value !== "object")
    throw Error("Expected a settings command.");
  const command = value as Record<string, unknown>;
  if (command.type === "update-export-settings") {
    const patch = parseExportSettings(command.patch);
    if (
      Object.keys(patch).some(
        (key) =>
          ![
            "resolution",
            "fps",
            "bitrate",
            "latencyMode",
            "keyFrameInterval",
          ].includes(key),
      ) ||
      !Object.keys(patch).length
    )
      throw Error("Expected supported export settings fields.");
    return { type: "update-export-settings", patch } as const;
  }
  if (
    (command.type !== "set-audio-track-muted" &&
      command.type !== "set-audio-clip-muted") ||
    typeof command.id !== "string" ||
    !command.id ||
    command.id.length > 512 ||
    typeof command.muted !== "boolean"
  ) {
    throw Error(
      "Expected a set-audio-track-muted or set-audio-clip-muted command with an ID and boolean muted.",
    );
  }
  return { type: command.type, id: command.id, muted: command.muted };
}

/** Read/modify/write a single entity; preserve unrelated and future settings. */
export async function writeSettingsCommand(manifest: string, input: unknown) {
  const command = parseSettingsCommand(input);
  const path = settingsPath(manifest);
  const existing = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing?.isSymbolicLink())
    throw Error("Project settings must be a regular file.");
  const baseline = await readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const settings: ProjectSettings =
    baseline === null
      ? { version: 1 }
      : parseProjectSettings(JSON.parse(baseline));
  const next =
    command.type === "update-export-settings"
      ? { ...settings, export: { ...settings.export, ...command.patch } }
      : command.type === "set-audio-track-muted"
        ? {
            ...settings,
            audioTracks: {
              ...settings.audioTracks,
              [command.id]: {
                ...settings.audioTracks?.[command.id],
                muted: command.muted,
              },
            },
          }
        : {
            ...settings,
            audioClips: {
              ...settings.audioClips,
              [command.id]: {
                ...settings.audioClips?.[command.id],
                muted: command.muted,
              },
            },
          };
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", {
      flag: "wx",
      mode: existing ? existing.mode & 0o777 : 0o644,
    });
    // Avoid silently overwriting an external editor's intervening update.
    const current = await readFile(path, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (current !== baseline) {
      throw Error("Project settings changed while saving. Please retry.");
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return next;
}

export function projectSettingsMiddleware(
  manifest: string,
  onSaved: (settings: ProjectSettings) => void,
): Connect.NextHandleFunction {
  let queue = Promise.resolve();
  return async (req, res, next) => {
    if (req.url?.split("?")[0] !== "/__ritween/settings") return next();
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    // Never grant cross-origin filesystem writes, including from a LAN client.
    if (
      req.headers.origin &&
      req.headers.origin !== `http://${req.headers.host}` &&
      req.headers.origin !== `https://${req.headers.host}`
    ) {
      res.statusCode = 403;
      return res.end(
        JSON.stringify({
          error: "Project settings require a same-origin request.",
        }),
      );
    }
    try {
      if (req.method === "GET")
        return res.end(JSON.stringify(readProjectSettings(manifest)));
      if (req.method !== "PATCH") {
        res.statusCode = 405;
        res.setHeader("Allow", "GET, PATCH");
        return res.end(
          JSON.stringify({ error: "Use PATCH to update project settings." }),
        );
      }
      if (!req.headers["content-type"]?.startsWith("application/json"))
        throw Error("Expected application/json.");
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 8192) throw Error("Settings command is too large.");
      }
      const command = parseSettingsCommand(JSON.parse(body));
      const saving = queue.then(() => writeSettingsCommand(manifest, command));
      queue = saving.then(
        () => {},
        () => {},
      );
      const settings = await saving;
      onSaved(settings);
      res.end(JSON.stringify(settings));
    } catch (error) {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };
}
