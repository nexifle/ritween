import { Renderer } from "./renderer";
import { MP4Muxer } from "./mp4";
import { frameCount, frameTiming } from "./timeline";
import type { Project } from "./types";
export interface ExportOptions {
  width: number;
  height: number;
  fps: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}
export async function exportVideo(project: Project, options: ExportOptions) {
  const { width, height, fps, signal, onProgress } = options;
  if (
    ![24, 30, 60].includes(fps) ||
    ![
      [640, 360],
      [1280, 720],
      [1920, 1080],
    ].some(([w, h]) => w === width && h === height)
  )
    throw Error("Unsupported export preset.");
  if (
    typeof VideoEncoder === "undefined" ||
    typeof OffscreenCanvas === "undefined"
  )
    throw Error(
      "WebCodecs or OffscreenCanvas unavailable. Use a current Chrome or Edge browser.",
    );
  const config: VideoEncoderConfig = {
    codec: "avc1.42002a",
    width,
    height,
    framerate: fps,
    bitrate: Math.round(width * height * fps * 0.22),
    latencyMode: "realtime",
    avc: { format: "avc" },
  };
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported)
    throw Error(
      `H.264 encoding is not supported for ${width}×${height} at ${fps} FPS on this browser. Try a smaller preset.`,
    );
  signal?.throwIfAborted();
  let failure: unknown;
  let encoded = 0;
  let renderer: Renderer | undefined;
  const muxer = new MP4Muxer(width, height, fps);
  const encoder = new VideoEncoder({
    output(chunk, metadata) {
      try {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        muxer.add(
          data,
          chunk.type === "key",
          metadata?.decoderConfig?.description,
        );
        encoded++;
      } catch (error) {
        failure = error;
      }
    },
    error(error) {
      failure = error;
    },
  });
  try {
    encoder.configure(support.config ?? config);
    const canvas = new OffscreenCanvas(width, height);
    renderer = await Renderer.create(canvas, project, (message) => {
      failure = Error(message);
    });
    const total = frameCount(project.duration, fps);
    for (let i = 0; i < total; i++) {
      signal?.throwIfAborted();
      if (failure) throw failure;
      renderer.render(i / fps);
      await renderer.device.queue.onSubmittedWorkDone();
      const frame = new VideoFrame(canvas, frameTiming(i, fps));
      try {
        encoder.encode(frame, { keyFrame: true });
      } finally {
        frame.close();
      }
      if (encoder.encodeQueueSize >= 4) await encoder.flush();
      onProgress?.(i + 1, total);
      // Yield to input, painting, and cancellation even on fast GPU devices.
      if (i % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await encoder.flush();
    signal?.throwIfAborted();
    if (failure) throw failure;
    if (encoded !== total)
      throw Error(`Encoder returned ${encoded} samples; expected ${total}.`);
    return { blob: muxer.finalize(), frames: encoded, duration: encoded / fps };
  } finally {
    if (encoder.state !== "closed") encoder.close();
    renderer?.dispose();
  }
}
