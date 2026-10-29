import assert from "node:assert/strict";
import test from "node:test";
import { initial, reducer } from "../src/preview/state/preview-state";

const project = {
  type: "project" as const,
  duration: 12,
  total: 360,
  sceneIds: ["intro", "outro"],
  playing: false,
};

test("project replacement preserves studio controls and reconciles timeline state", () => {
  const previous = {
    ...initial,
    time: 9,
    duration: 20,
    playing: true,
    updating: true,
    compZoom: 2,
    compPanX: 45,
    compPanY: -30,
    tlZoom: 4,
    volumeDb: -18,
    sourceOpen: true,
    pinnedSourceId: "intro",
    error: "previous update failed",
    result: "old export",
    download: "blob:old",
  };
  const next = reducer(previous, { ...project, playing: true });
  assert.equal(next.time, 9);
  assert.equal(next.duration, 12);
  assert.equal(next.playing, true);
  assert.equal(next.ready, true);
  assert.equal(next.updating, false);
  for (const key of [
    "compZoom",
    "compPanX",
    "compPanY",
    "tlZoom",
    "volumeDb",
    "sourceOpen",
    "pinnedSourceId",
  ] as const)
    assert.equal(next[key], previous[key]);
  assert.equal(next.error, "");
  assert.equal(next.download, "");
  assert.equal(next.result, "");
});

test("shorter compositions clamp the playhead, stop at the end and clear removed selections", () => {
  const next = reducer(
    { ...initial, time: 15, pinnedSourceId: "removed" },
    { ...project, playing: true },
  );
  assert.equal(next.time, 12);
  assert.equal(next.playing, false);
  assert.equal(next.pinnedSourceId, null);
});

test("seek, playback and replay use the currently committed composition duration", () => {
  const state = reducer(initial, project);
  assert.equal(reducer(state, { type: "seek", time: 99 }).time, 12);
  assert.equal(reducer(state, { type: "seek", time: -1 }).time, 0);
  const shorter = reducer({ ...state, time: 9 }, { ...project, duration: 5 });
  assert.equal(reducer(shorter, { type: "toggle" }).time, 0);
  assert.equal(
    reducer({ ...shorter, time: 4 }, { type: "tick", delta: 2 }).playing,
    false,
  );
  assert.equal(reducer(shorter, { type: "sync", time: 10 }).time, 5);
});
