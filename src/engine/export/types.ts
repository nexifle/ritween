import type { EncodingOptions } from "./settings";
import type { ExportPipeline } from "./pipeline";
export type ExportStage =
  "audio-mix" | "audio-encode" | "scene-setup" | "video-encode" | "mux";
export interface ExportOptions extends EncodingOptions {
  width: number;
  height: number;
  fps: number;
  /** Audio and video overlap by default; sequential is retained for comparison. */
  pipeline?: ExportPipeline;
  mutedTrackIds?: readonly string[];
  signal?: AbortSignal;
  onStage?: (stage: ExportStage) => void;
  onStageComplete?: (stage: ExportStage) => void;
  onProgress?: (done: number, total: number) => void;
}
