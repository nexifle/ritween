import { fitsH264Level42 } from "./export/formats/mp4/size-constraints.js";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** @param {unknown} value @returns {import("./types").ProjectExportSettings} */
export function parseExportSettings(value) {
  if (!record(value)) throw Error("Export settings must be an object.");
  const { resolution, fps, bitrate, latencyMode, keyFrameInterval } = value;
  if (
    resolution !== undefined &&
    (!Array.isArray(resolution) ||
      resolution.length !== 2 ||
      !fitsH264Level42(resolution[0], resolution[1]))
  )
    throw Error(
      "Export resolution must be even dimensions within H.264 Level 4.2.",
    );
  if (fps !== undefined && fps !== 24 && fps !== 30 && fps !== 60)
    throw Error("Export FPS must be 24, 30 or 60.");
  if (
    bitrate !== undefined &&
    bitrate !== "auto" &&
    (typeof bitrate !== "number" ||
      !Number.isSafeInteger(bitrate) ||
      bitrate < 1 ||
      bitrate > 100000000)
  )
    throw Error(
      "Export bitrate must be auto or an integer between 1 and 100000000.",
    );
  if (
    latencyMode !== undefined &&
    latencyMode !== "quality" &&
    latencyMode !== "realtime"
  )
    throw Error("Export latency mode must be quality or realtime.");
  if (
    keyFrameInterval !== undefined &&
    (typeof keyFrameInterval !== "number" ||
      !Number.isFinite(keyFrameInterval) ||
      keyFrameInterval <= 0 ||
      keyFrameInterval > 60)
  )
    throw Error(
      "Export keyframe interval must be greater than 0 and at most 60 seconds.",
    );
  return {
    ...value,
    ...(resolution !== undefined
      ? { resolution: /** @type {[number, number]} */ ([...resolution]) }
      : {}),
    ...(fps !== undefined ? { fps } : {}),
    ...(bitrate !== undefined ? { bitrate } : {}),
    ...(latencyMode !== undefined ? { latencyMode } : {}),
    ...(keyFrameInterval !== undefined ? { keyFrameInterval } : {}),
  };
}

/** Validate persisted data without dropping fields belonging to future controls.
 * @param {unknown} value
 * @returns {import("./types").ProjectSettings}
 */
export function parseProjectSettings(value) {
  if (!record(value) || value.version !== 1)
    throw Error("Unsupported project settings version (expected 1).");
  if (value.audioTracks !== undefined && !record(value.audioTracks))
    throw Error("audioTracks settings must be an object keyed by track ID.");
  if (value.audioClips !== undefined && !record(value.audioClips))
    throw Error("audioClips settings must be an object keyed by clip ID.");
  /** @type {Record<string, import("./types").AudioTrackSettings>} */
  const audioTracks = Object.create(null);
  for (const [id, settings] of Object.entries(value.audioTracks ?? {})) {
    if (
      !id ||
      !record(settings) ||
      (settings.muted !== undefined && typeof settings.muted !== "boolean")
    )
      throw Error(`Invalid audio track settings: ${id}`);
    audioTracks[id] = { ...settings };
  }
  /** @type {Record<string, { muted?: boolean }>} */
  const audioClips = Object.create(null);
  for (const [id, settings] of Object.entries(value.audioClips ?? {})) {
    if (
      !id ||
      !record(settings) ||
      (settings.muted !== undefined && typeof settings.muted !== "boolean")
    )
      throw Error(`Invalid audio clip settings: ${id}`);
    audioClips[id] = { ...settings };
  }
  return {
    ...value,
    version: 1,
    audioTracks,
    audioClips,
    ...(value.export !== undefined
      ? { export: parseExportSettings(value.export) }
      : {}),
  };
}

/** Sidecar values override authored defaults per entity and per property.
 * @param {import("./types").ProjectSettings | undefined} authored
 * @param {import("./types").ProjectSettings | undefined} saved
 * @returns {import("./types").ProjectSettings}
 */
export function mergeProjectSettings(authored, saved) {
  const base = parseProjectSettings(authored ?? { version: 1 });
  const overrides = parseProjectSettings(saved ?? { version: 1 });
  const audioTracks = Object.assign(Object.create(null), base.audioTracks);
  for (const [id, settings] of Object.entries(overrides.audioTracks ?? {})) {
    audioTracks[id] = { ...audioTracks[id], ...settings };
  }
  const audioClips = Object.assign(Object.create(null), base.audioClips);
  for (const [id, settings] of Object.entries(overrides.audioClips ?? {})) {
    audioClips[id] = { ...audioClips[id], ...settings };
  }
  return {
    ...base,
    ...overrides,
    version: 1,
    audioTracks,
    audioClips,
    ...(base.export || overrides.export
      ? { export: { ...base.export, ...overrides.export } }
      : {}),
  };
}
