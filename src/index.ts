/// <reference types="@webgpu/types" preserve="true" />
export type {
  Scene,
  SceneInspection,
  SceneEntry,
  SharedElement,
  Transition,
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
export type {
  FrameInspection,
  InspectedScene,
  InspectedLayer,
  InspectionClock,
} from "./engine/render/renderer";
export { Renderer } from "./engine/render/renderer";
export {
  INSPECTION_SCHEMA_VERSION,
  MAX_INSPECTION_BYTES,
  InspectionReadError,
  InspectionSerializationError,
  InspectionTargetError,
  buildInspectionDocument,
  measureInspection,
  parseInspectionTarget,
  serializeInspection,
} from "./engine/inspect/report";
export type {
  InspectionBounds,
  InspectionSize,
  InspectionCapability,
  InspectionClockFields,
  InspectionCommand,
  InspectionDiagnostic,
  InspectionDocument,
  InspectionLayoutNode,
  InspectionScene,
  InspectionSeverity,
  InspectionTarget,
  InspectionTargetResult,
} from "./engine/inspect/report";
export * from "./authoring/index";
export { audioFile } from "./engine/decode/audio-file";
export type { AudioFileOptions } from "./engine/decode/audio-file";
export {
  imageScene,
  videoClip,
  videoResource,
  loadImageTexture,
  loadVideoTexture,
} from "./engine/render/visual";
export type {
  ImageTexture,
  VideoTexture,
  MediaTransform,
  VisualOptions,
} from "./engine/render/visual";
export { resolveMediaProject } from "./engine/media/project";
export {
  exportMp4,
  exportMp4 as exportVideo,
} from "./engine/export/formats/mp4/export-mp4";
export type { ExportOptions, ExportStage } from "./engine/export/types";
export type { EncodingOptions } from "./engine/export/settings";
export { resolveEncodingOptions } from "./engine/export/settings";
export {
  evaluate,
  evaluateActive,
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
