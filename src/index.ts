/// <reference types="@webgpu/types" preserve="true" />
export type {
  Scene,
  SceneEntry,
  FramePreparationContext,
  MediaClip,
  Project,
  SetupContext,
  RenderContext,
  Compositor,
  AudioHost,
  AudioClip,
  AudioClipSource,
  AudioTrack,
  AudioTrackSettings,
  ProjectSettings,
  ProjectExportSettings,
} from "./engine/types";
export { Renderer } from "./engine/render/renderer";
export { audioFile } from "./engine/media/audio-file";
export type { AudioFileOptions } from "./engine/media/audio-file";
export {
  imageScene,
  videoClip,
  videoResource,
  loadImageTexture,
  loadVideoTexture,
} from "./engine/media/visual";
export type {
  ImageTexture,
  VideoTexture,
  MediaTransform,
  VisualOptions,
} from "./engine/media/visual";
export { resolveMediaProject } from "./engine/media/project";
export { exportVideo, exportMp4 } from "./engine/export";
export type { ExportOptions, ExportStage } from "./engine/export";
export type { EncodingOptions } from "./engine/export/settings";
export { resolveEncodingOptions } from "./engine/export/settings";
export {
  evaluate,
  validateProject,
  frameCount,
  frameTiming,
} from "./engine/timeline";

export { FrameSource } from "./engine/render/frame-source";
export type { FrameSourceOptions } from "./engine/render/frame-source";

export {
  audibleAudioTracks,
  mutedAudioTrackIds,
  mutedAudioClipIds,
  isAudioClipMuted,
  mergeProjectSettings,
  parseProjectSettings,
} from "./engine/project-settings";

export {
  projectExportSettings,
  resolveExportRequest,
} from "./engine/export/project-settings";
export type { ExportOverrides } from "./engine/export/project-settings";
