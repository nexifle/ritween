export type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

/** Access may throw in private/embedded contexts, or when storage is full. */
export function createSafeStorage(
  resolve: () => PreferenceStorage = () => globalThis.localStorage,
): PreferenceStorage {
  return {
    getItem(key) {
      try {
        return resolve().getItem(key);
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      try {
        resolve().setItem(key, value);
      } catch {
        /* Preferences are optional; keep the current in-memory controls usable. */
      }
    },
  };
}
export const browserStorage = createSafeStorage();

/** Layout values from react-resizable-panels are percentages keyed by panel ID. */
export function layoutStorage(
  panelIds: readonly string[],
  storage: PreferenceStorage = browserStorage,
): PreferenceStorage {
  const safe = createSafeStorage(() => storage);
  const valid = (raw: string | null) => {
    if (raw === null) return null;
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
      const ids = Object.keys(value);
      if (
        ids.length !== panelIds.length ||
        !panelIds.every((id) => Object.hasOwn(value, id))
      )
        return null;
      const sizes = panelIds.map((id) => value[id]);
      if (
        !sizes.every(
          (size) =>
            typeof size === "number" &&
            Number.isFinite(size) &&
            size >= 0 &&
            size <= 100,
        )
      )
        return null;
      if (Math.abs(sizes.reduce((sum, size) => sum + size, 0) - 100) > 1)
        return null;
      return raw;
    } catch {
      return null;
    }
  };
  return {
    getItem: (key) => valid(safe.getItem(key)),
    setItem: (key, value) => {
      if (valid(value)) safe.setItem(key, value);
    },
  };
}
