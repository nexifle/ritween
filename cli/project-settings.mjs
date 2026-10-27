import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  parseProjectSettings,
  parseExportSettings,
} from "../src/engine/project-settings-schema.js";

export const settingsPath = (manifest) =>
  manifest.replace(/\.[^.\/]+$/, "") + ".settings.json";

export function readProjectSettings(manifest) {
  try {
    return parseProjectSettings(
      JSON.parse(readFileSync(settingsPath(manifest), "utf8")),
    );
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1 };
    throw error;
  }
}

/** Narrow commands keep UI mutations independent of the persisted document shape. */
export function parseSettingsCommand(value) {
  if (value?.type === "update-export-settings") {
    const patch = parseExportSettings(value.patch);
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
    return { type: value.type, patch };
  }
  if (
    !value ||
    value.type !== "set-audio-track-muted" ||
    typeof value.id !== "string" ||
    !value.id ||
    value.id.length > 512 ||
    typeof value.muted !== "boolean"
  ) {
    throw Error(
      "Expected a set-audio-track-muted command with a track ID and boolean muted.",
    );
  }
  return { type: value.type, id: value.id, muted: value.muted };
}

/** Read/modify/write a single entity; preserve unrelated and future settings. */
export async function writeSettingsCommand(manifest, input) {
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
  const settings =
    baseline === null
      ? { version: 1 }
      : parseProjectSettings(JSON.parse(baseline));
  const next =
    command.type === "update-export-settings"
      ? { ...settings, export: { ...settings.export, ...command.patch } }
      : {
          ...settings,
          audioTracks: {
            ...settings.audioTracks,
            [command.id]: {
              ...settings.audioTracks?.[command.id],
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

export function projectSettingsMiddleware(manifest, onSaved) {
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
      queue = saving.catch(() => {});
      const settings = await saving;
      onSaved(settings);
      res.end(JSON.stringify(settings));
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: error.message }));
    }
  };
}
