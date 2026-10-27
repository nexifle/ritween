/// <reference types="@webgpu/types" />
export type {
  Scene,
  SceneEntry,
  Project,
  SetupContext,
  RenderContext,
  Compositor,
  AudioHost,
  AudioClip,
  AudioClipSource,
  AudioTrack,
} from "./engine/types";
export { Renderer } from "./engine/render/renderer";
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
