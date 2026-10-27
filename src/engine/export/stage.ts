import type { ExportOptions, ExportStage } from "./types";
export async function exportStage<T>(
  options: ExportOptions,
  stage: ExportStage,
  job: () => Promise<T>,
) {
  options.onStage?.(stage);
  try {
    return await job();
  } finally {
    options.onStageComplete?.(stage);
  }
}
