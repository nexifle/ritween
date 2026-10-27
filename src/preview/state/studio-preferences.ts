import { PREVIEW_VOLUME_DB } from "../../engine/audio";
import { TL_ZOOM_MIN, TL_ZOOM_MAX, clamp } from "../utils/view-utils";
import {
  browserStorage,
  createSafeStorage,
  type PreferenceStorage,
} from "../utils/local-storage";

export const STUDIO_PREFERENCES_KEY = "ritween-studio-preferences";
export type StudioPreferences = {
  version: 1;
  theme: "light" | "dark";
  tlZoom: number;
  volumeDb: number;
  masterMuted: boolean;
  sourceOpen: boolean;
  exportCollapsed: boolean;
  sourceCollapsed: boolean;
};
export const defaultStudioPreferences: StudioPreferences = {
  version: 1,
  theme: "dark",
  tlZoom: 1,
  volumeDb: PREVIEW_VOLUME_DB,
  masterMuted: false,
  sourceOpen: false,
  exportCollapsed: false,
  sourceCollapsed: false,
};

/** A whitelist prevents playback, render settings, or track mute leaking into preferences. */
export function parseStudioPreferences(value: unknown): StudioPreferences {
  const result = { ...defaultStudioPreferences };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return result;
  const data = value as Record<string, unknown>;
  if (data.version !== 1) return result;
  if (data.theme === "light" || data.theme === "dark")
    result.theme = data.theme;
  if (typeof data.tlZoom === "number" && Number.isFinite(data.tlZoom))
    result.tlZoom = clamp(data.tlZoom, TL_ZOOM_MIN, TL_ZOOM_MAX);
  if (typeof data.volumeDb === "number" && Number.isFinite(data.volumeDb))
    result.volumeDb = clamp(data.volumeDb, -60, 0);
  for (const key of [
    "masterMuted",
    "sourceOpen",
    "exportCollapsed",
    "sourceCollapsed",
  ] as const) {
    if (typeof data[key] === "boolean") result[key] = data[key];
  }
  return result;
}

export function readStudioPreferences(
  storage: PreferenceStorage = browserStorage,
): StudioPreferences {
  const safe = createSafeStorage(() => storage);
  const raw = safe.getItem(STUDIO_PREFERENCES_KEY);
  try {
    if (raw !== null) return parseStudioPreferences(JSON.parse(raw));
  } catch {
    /* Fall back to defaults, including the previous theme key. */
  }
  const legacyTheme = safe.getItem("ritween-theme");
  return {
    ...defaultStudioPreferences,
    theme: legacyTheme === "light" ? "light" : "dark",
  };
}

/** Merge with the latest stored values so theme and studio controls do not overwrite each other. */
export function saveStudioPreferences(
  patch: Partial<Omit<StudioPreferences, "version">>,
  storage: PreferenceStorage = browserStorage,
) {
  const preferences = parseStudioPreferences({
    ...readStudioPreferences(storage),
    ...patch,
    version: 1,
  });
  createSafeStorage(() => storage).setItem(
    STUDIO_PREFERENCES_KEY,
    JSON.stringify(preferences),
  );
}
