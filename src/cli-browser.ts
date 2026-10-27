/** Headless command bridge. Uses the same engine as the web interface. */
import { project } from "virtual:ritween-project";
import { Renderer } from "./engine/renderer";
import { exportVideo, type ExportOptions } from "./engine/export";
import { defaultExportSize } from "./engine/export-size";
import { validateProject } from "./engine/timeline";
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
      renderer.render(time);
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
  async export(
    options: Omit<ExportOptions, "width" | "height"> & {
      width?: number;
      height?: number;
    },
  ) {
    let { width, height } = options;
    if (width === undefined && height === undefined) {
      const size = defaultExportSize(project.resolution);
      if (!size)
        throw Error(
          "No export size keeps this project aspect within H.264 Level 4.2.",
        );
      width = size.width;
      height = size.height;
    }
    if (width === undefined || height === undefined)
      throw Error("Export width and height must be passed together.");
    const result = await exportVideo(project, {
      ...options,
      width,
      height,
      onStage: (stage) => {
        void window.ritweenStage?.(stage);
      },
      onProgress: (done, total) => {
        void window.ritweenProgress?.({ done, total });
      },
    });
    download(result.blob, "video.mp4");
    return {
      frames: result.frames,
      duration: result.duration,
      bytes: result.blob.size,
      width,
      height,
      fps: options.fps,
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
    ritweenProgress?: (progress: {
      done: number;
      total: number;
    }) => Promise<void>;
  }
}
window.ritween = api;
