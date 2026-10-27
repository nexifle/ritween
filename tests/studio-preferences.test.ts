import assert from "node:assert/strict";
import test from "node:test";
import {
  createSafeStorage,
  layoutStorage,
  type PreferenceStorage,
} from "../src/preview/utils/local-storage";
import {
  defaultStudioPreferences,
  parseStudioPreferences,
  readStudioPreferences,
  saveStudioPreferences,
  STUDIO_PREFERENCES_KEY,
} from "../src/preview/state/studio-preferences";

function memoryStorage(): PreferenceStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

test("studio preferences whitelist view controls and leave playback and project data out", () => {
  const storage = memoryStorage();
  saveStudioPreferences(
    {
      theme: "light",
      volumeDb: -32,
      masterMuted: true,
      tlZoom: 0.4,
      sourceOpen: true,
      exportCollapsed: true,
    },
    storage,
  );
  saveStudioPreferences({ sourceCollapsed: true }, storage);
  assert.deepEqual(readStudioPreferences(storage), {
    version: 1,
    theme: "light",
    volumeDb: -32,
    masterMuted: true,
    tlZoom: 0.4,
    sourceOpen: true,
    exportCollapsed: true,
    sourceCollapsed: true,
  });
  const result = parseStudioPreferences({
    version: 1,
    playing: true,
    time: 12,
    exporting: true,
    result: "old.mp4",
    audioTracks: { voice: { muted: true } },
    export: { fps: 60 },
  });
  assert.deepEqual(result, defaultStudioPreferences);
});

test("invalid preferences recover with defaults and finite numbers stay in bounds", () => {
  for (const value of [
    null,
    [],
    "bad",
    { version: 2 },
    {
      version: 1,
      theme: "sepia",
      volumeDb: Infinity,
      tlZoom: NaN,
      sourceOpen: "true",
    },
  ])
    assert.deepEqual(parseStudioPreferences(value), defaultStudioPreferences);
  assert.equal(parseStudioPreferences({ version: 1, tlZoom: 999 }).tlZoom, 80);
  assert.equal(parseStudioPreferences({ version: 1, tlZoom: -2 }).tlZoom, 0.1);
  assert.equal(
    parseStudioPreferences({ version: 1, volumeDb: 12 }).volumeDb,
    0,
  );
  assert.equal(
    parseStudioPreferences({ version: 1, volumeDb: -90 }).volumeDb,
    -60,
  );
  const storage = memoryStorage();
  storage.setItem(STUDIO_PREFERENCES_KEY, "{broken");
  assert.deepEqual(readStudioPreferences(storage), defaultStudioPreferences);
});

test("legacy theme migrates and partial writes retain existing preferences", () => {
  const storage = memoryStorage();
  storage.setItem("ritween-theme", "light");
  assert.equal(readStudioPreferences(storage).theme, "light");
  saveStudioPreferences({ tlZoom: 3, sourceOpen: true }, storage);
  saveStudioPreferences({ theme: "dark" }, storage);
  assert.equal(readStudioPreferences(storage).tlZoom, 3);
  assert.equal(readStudioPreferences(storage).sourceOpen, true);
  assert.equal(readStudioPreferences(storage).theme, "dark");
});

test("blocked storage access and exhausted quota do not throw", () => {
  const denied = createSafeStorage(() => {
    throw Error("SecurityError");
  });
  assert.equal(denied.getItem("anything"), null);
  assert.doesNotThrow(() => denied.setItem("anything", "value"));
  const full: PreferenceStorage = {
    getItem: () => {
      throw Error("denied");
    },
    setItem: () => {
      throw Error("QuotaExceededError");
    },
  };
  assert.deepEqual(readStudioPreferences(full), defaultStudioPreferences);
  assert.doesNotThrow(() => saveStudioPreferences({ volumeDb: -20 }, full));
  assert.doesNotThrow(() =>
    layoutStorage(["a", "b"], full).setItem("layout", '{"a":60,"b":40}'),
  );
});

test("panel layouts retain compatible existing storage but reject corrupt sizes and IDs", () => {
  const storage = memoryStorage();
  const layouts = layoutStorage(["viewer", "timeline"], storage);
  const key = "react-resizable-panels:ritween-rows";
  for (const raw of [
    "{broken",
    "null",
    "[]",
    "{}",
    '{"viewer":50,"wrong":50}',
    '{"viewer":200,"timeline":-100}',
    '{"viewer":40,"timeline":40}',
    '{"viewer":"60","timeline":40}',
  ]) {
    storage.setItem(key, raw);
    assert.equal(layouts.getItem(key), null);
  }
  layouts.setItem(key, '{"viewer":70,"timeline":30}');
  assert.equal(layouts.getItem(key), '{"viewer":70,"timeline":30}');
  layouts.setItem(key, "broken");
  assert.equal(layouts.getItem(key), '{"viewer":70,"timeline":30}');
});
