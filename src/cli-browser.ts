/** Headless command bridge. Uses the same engine as the web interface. */
import { project as sourceProject } from "virtual:ritween-project";
import { resolveMediaProject } from "./engine/media/project";
import { Renderer } from "./engine/render/renderer";
import { FrameSource } from "./engine/render/frame-source";
import { exportMp4 as exportVideo } from "./engine/export/formats/mp4/export-mp4";
import {
  resolveExportRequest,
  projectExportSettings,
  type ExportOverrides,
} from "./engine/export/project-settings";
import { validateProject } from "./engine/timeline";
import { exportFilename } from "./engine/export/filename";
import {
  applyInspectionTarget,
  buildInspectionDocument,
  serializeInspection,
  type InspectionTarget,
} from "./engine/inspect/report";
const project = resolveMediaProject(sourceProject);
validateProject(project);
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // Keep the object URL alive until Playwright has persisted the download.
}
const api = {
  metadata() {
    return {
      name: project.name,
      duration: project.duration,
      resolution: project.resolution,
      exportFps: projectExportSettings(project).fps,
      scenes: project.scenes.map(({ id, name, start, duration }) => ({
        id,
        name,
        start,
        duration,
      })),
    };
  },
  async frame({
    time,
    width,
    height,
  }: {
    time: number;
    width?: number;
    height?: number;
  }) {
    if (!Number.isFinite(time) || time < 0 || time > project.duration)
      throw Error(
        `Frame time must be between 0 and ${project.duration} seconds.`,
      );
    const canvas = new OffscreenCanvas(
      width ?? project.resolution[0],
      height ?? project.resolution[1],
    );
    let failure: Error | undefined;
    const renderer = await Renderer.create(canvas, project, (message) => {
      failure = Error(message);
    });
    try {
      await renderer.renderAsync(time);
      await renderer.device.queue.onSubmittedWorkDone();
      if (failure) throw failure;
      const blob = await canvas.convertToBlob({ type: "image/png" });
      download(blob, "frame.png");
      return {
        time,
        width: canvas.width,
        height: canvas.height,
        bytes: blob.size,
      };
    } finally {
      renderer.dispose();
    }
  },
  async inspect({
    time,
    width,
    height,
    packageVersion,
    target,
  }: {
    time: number;
    width?: number;
    height?: number;
    packageVersion: string;
    target?: InspectionTarget;
  }) {
    if (!Number.isFinite(time) || time < 0 || time > project.duration)
      throw Error(
        `Inspect time must be between 0 and ${project.duration} seconds.`,
      );
    let failure: Error | undefined;
    // Same offline lifecycle as `frame`: normal render, GPU completion, cancellation, disposal.
    const source = await FrameSource.create(project, {
      width: width ?? project.resolution[0],
      height: height ?? project.resolution[1],
      inspect: true,
      onError: (message) => {
        failure = Error(message);
      },
    });
    try {
      await source.render(time);
      if (failure) throw failure;
      // Narrow before serializing so the byte budget covers what is actually written.
      const document = applyInspectionTarget(
        buildInspectionDocument({
          packageVersion,
          project,
          frame: source.inspectFrame(),
          target,
        }),
        target,
      );
      return {
        json: serializeInspection(document),
        summary: {
          scopes: document.scenes.length,
          diagnostics: document.diagnostics.length,
          errors: document.diagnostics.filter(
            (entry) => entry.severity === "error",
          ).length,
          effectiveTime: document.time.effective,
        },
      };
    } finally {
      source.dispose();
    }
  },
  async export(options: ExportOverrides) {
    const resolved = resolveExportRequest(project, options);
    const { width, height, fps } = resolved;
    const result = await exportVideo(project, {
      ...resolved,
      onStage: (stage) => {
        void window.ritweenStage?.(stage);
      },
      onStageComplete: (stage) => {
        void window.ritweenStageComplete?.(stage);
      },
      onProgress: (done, total) => {
        void window.ritweenProgress?.({ done, total });
      },
    });
    download(result.blob, exportFilename(project.name));
    return {
      frames: result.frames,
      duration: result.duration,
      bytes: result.blob.size,
      width,
      height,
      fps,
      bitrate: result.bitrate,
      latencyMode: result.latencyMode,
      keyFrameInterval: result.keyFrameInterval,
    };
  },
};
declare global {
  interface Window {
    ritween: typeof api;
    ritweenStage?: (stage: string) => Promise<void>;
    ritweenStageComplete?: (stage: string) => Promise<void>;
    ritweenProgress?: (progress: {
      done: number;
      total: number;
    }) => Promise<void>;
  }
}
window.ritween = api;
