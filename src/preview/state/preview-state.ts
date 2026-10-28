import { readStudioPreferences } from "./studio-preferences";
import { PREVIEW_VOLUME_DB } from "../../engine/render/audio";
import { projectExportSettings } from "../../engine/export/project-settings";
import { frameCount } from "../../engine/timeline";
import { project } from "virtual:ritween-project";
import {
  clamp,
  COMP_ZOOM_MAX,
  COMP_ZOOM_MIN,
  TL_ZOOM_MIN,
  TL_ZOOM_MAX,
} from "../utils/view-utils";

export type State = {
  time: number;
  playing: boolean;
  ready: boolean;
  error: string;
  exporting: boolean;
  exportStage: string;
  done: number;
  total: number;
  result: string;
  download: string;
  volumeDb: number;
  masterMuted: boolean;
  compZoom: number;
  compPanX: number;
  compPanY: number;
  tlZoom: number;
  pinnedSourceId: string | null;
  sourceOpen: boolean;
  exportCollapsed: boolean;
  sourceCollapsed: boolean;
};

export const initial: State = {
  time: 0,
  playing: false,
  ready: false,
  error: "",
  exporting: false,
  exportStage: "",
  done: 0,
  total: frameCount(project.duration, projectExportSettings(project).fps),
  result: "",
  download: "",
  volumeDb: PREVIEW_VOLUME_DB,
  masterMuted: false,
  compZoom: 1,
  compPanX: 0,
  compPanY: 0,
  tlZoom: 1,
  pinnedSourceId: null,
  sourceOpen: false,
  exportCollapsed: false,
  sourceCollapsed: false,
};

/** Restore only studio controls; playback and export jobs always start idle. */
export function createInitialState(): State {
  const {
    tlZoom,
    volumeDb,
    masterMuted,
    sourceOpen,
    exportCollapsed,
    sourceCollapsed,
  } = readStudioPreferences();
  return {
    ...initial,
    tlZoom,
    volumeDb,
    masterMuted,
    sourceOpen,
    exportCollapsed,
    sourceCollapsed,
  };
}

export type Action =
  | { type: "patch"; value: Partial<State> }
  | { type: "seek"; time: number }
  | { type: "tick"; delta: number }
  | { type: "sync"; time: number }
  | { type: "toggle" }
  | { type: "pause" }
  | { type: "toggleMasterMute" }
  | { type: "setVolume"; volumeDb: number }
  | { type: "compView"; zoom: number; panX: number; panY: number }
  | { type: "tlZoom"; zoom: number }
  | { type: "pinSource"; id: string }
  | { type: "followSource" }
  | { type: "setSourceOpen"; open: boolean };

export function reducer(s: State, a: Action): State {
  if (a.type === "patch") return { ...s, ...a.value };
  if (a.type === "pause") return { ...s, playing: false };
  if (a.type === "toggle")
    return {
      ...s,
      playing: !s.playing,
      time: s.time >= project.duration ? 0 : s.time,
    };
  if (a.type === "toggleMasterMute")
    return { ...s, masterMuted: !s.masterMuted };
  if (a.type === "setVolume")
    return { ...s, volumeDb: Math.max(-60, Math.min(0, a.volumeDb)) };
  if (a.type === "compView")
    return {
      ...s,
      compZoom: clamp(a.zoom, COMP_ZOOM_MIN, COMP_ZOOM_MAX),
      compPanX: a.panX,
      compPanY: a.panY,
    };
  if (a.type === "tlZoom")
    return { ...s, tlZoom: clamp(a.zoom, TL_ZOOM_MIN, TL_ZOOM_MAX) };
  if (a.type === "pinSource") return { ...s, pinnedSourceId: a.id };
  if (a.type === "followSource") return { ...s, pinnedSourceId: null };
  if (a.type === "setSourceOpen") return { ...s, sourceOpen: a.open };
  if (a.type === "seek" || a.type === "sync") {
    const time = Math.max(0, Math.min(project.duration, a.time));
    return {
      ...s,
      time,
      playing: a.type === "sync" ? time < project.duration : s.playing,
    };
  }
  const time = Math.min(project.duration, s.time + a.delta);
  return { ...s, time, playing: time < project.duration };
}
