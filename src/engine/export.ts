import { runExportPipelines, type ExportPipeline } from "./export-pipeline";
import { waitForEncoderCapacity } from "./encoder-queue";
import { renderAudio, SAMPLE_RATE } from "./audio";
import { assertExportSize } from "./export-size";
import { Renderer } from "./renderer";
import { MP4Muxer } from "./mp4";
import { frameCount, frameTiming } from "./timeline";
import type { Project } from "./types";

/** AAC-LC frame size. Encoder delay is measured in the browser and applied as an edit list. */
export const AAC_FRAME_SAMPLES = 1024;
export const AAC_BITRATE = 128_000;
export const AAC_CODEC = "mp4a.40.2";
/**
 * Chrome's AAC-LC encoder emits 2112 silent warmup samples before the signal.
 * The audio edit list skips them so a note at composition time 0 stays in sync.
 */
export const AAC_PRIMING_SAMPLES = 2112;

export type ExportStage =
  "audio-mix" | "audio-encode" | "scene-setup" | "video-encode" | "mux";
export interface ExportOptions {
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
async function exportStage<T>(
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
export async function encodeAac(buffer: AudioBuffer, signal?: AbortSignal) {
  if (typeof AudioEncoder === "undefined" || typeof AudioData === "undefined")
    throw Error(
      "WebCodecs audio encoding is unavailable. Use a current Chrome or Edge browser.",
    );
  const config: AudioEncoderConfig = {
    codec: AAC_CODEC,
    sampleRate: buffer.sampleRate,
    numberOfChannels: buffer.numberOfChannels,
    bitrate: AAC_BITRATE,
  };
  const support = await AudioEncoder.isConfigSupported(config);
  if (!support.supported)
    throw Error("AAC encoding is not supported in this browser.");
  signal?.throwIfAborted();
  const chunks: Uint8Array[] = [];
  let description: Uint8Array | undefined;
  let failure: unknown;
  const codecFailure = new AbortController();
  const encoder = new AudioEncoder({
    output(chunk, metadata) {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push(data);
      const next = metadata?.decoderConfig?.description as
        ArrayBuffer | ArrayBufferView | undefined;
      if (next)
        description = (
          ArrayBuffer.isView(next)
            ? new Uint8Array(next.buffer, next.byteOffset, next.byteLength)
            : new Uint8Array(next)
        ).slice();
    },
    error(error) {
      failure = error;
      codecFailure.abort(error);
    },
  });
  try {
    encoder.configure(support.config ?? config);
    const channels = buffer.numberOfChannels;
    let lastYield = performance.now();
    for (let at = 0; at < buffer.length; at += AAC_FRAME_SAMPLES) {
      signal?.throwIfAborted();
      if (failure) throw failure;
      const count = Math.min(AAC_FRAME_SAMPLES, buffer.length - at);
      const planar = new Float32Array(AAC_FRAME_SAMPLES * channels);
      for (let c = 0; c < channels; c++)
        planar.set(
          buffer.getChannelData(c).subarray(at, at + count),
          c * AAC_FRAME_SAMPLES,
        );
      const frame = new AudioData({
        format: "f32-planar",
        sampleRate: buffer.sampleRate,
        numberOfFrames: AAC_FRAME_SAMPLES,
        numberOfChannels: channels,
        timestamp: Math.round((at / buffer.sampleRate) * 1e6),
        data: planar,
      });
      try {
        encoder.encode(frame);
      } finally {
        frame.close();
      }
      // Bound native encoder memory and let input/cancellation run during long mixes.
      if (encoder.encodeQueueSize >= 32)
        await waitForEncoderCapacity(encoder, 32, [
          signal,
          codecFailure.signal,
        ]);
      if (performance.now() - lastYield >= 8) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        lastYield = performance.now();
      }
    }
    await encoder.flush();
    signal?.throwIfAborted();
    if (failure) throw failure;
    if (!chunks.length) throw Error("AAC encoder returned no samples.");
    // AAC-LC, 48 kHz, stereo. Used when the encoder omits a description.
    description ??= new Uint8Array([0x11, 0x90]);
    return { chunks, description, sampleRate: buffer.sampleRate };
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }
}
export async function exportVideo(project: Project, options: ExportOptions) {
  const { width, height, fps, signal, onProgress } = options;
  if (![24, 30, 60].includes(fps))
    throw Error("Unsupported export frame rate.");
  assertExportSize(project, width, height);
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
  onProgress?.(0, frameCount(project.duration, fps));
  // Paint the initial status before author-supplied audio/scene setup starts.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const muxer = new MP4Muxer(width, height, fps);
  const [aac, encoded] = await runExportPipelines(
    options.pipeline ?? "parallel",
    signal,
    async (signal) => {
      const soundtrack = await exportStage(options, "audio-mix", () =>
        renderAudio(project, options.mutedTrackIds ?? [], fps, signal),
      );
      signal.throwIfAborted();
      const aac = soundtrack
        ? await exportStage(options, "audio-encode", () =>
            encodeAac(soundtrack, signal),
          )
        : null;
      if (aac && aac.sampleRate !== SAMPLE_RATE)
        throw Error("Audio mix sample rate did not match the export clock.");
      return aac;
    },
    (signal) =>
      encodeVideoTrack(
        project,
        { ...options, signal },
        support.config ?? config,
        muxer,
      ),
  );
  signal?.throwIfAborted();
  if (aac) {
    muxer.setAudioPriming(AAC_PRIMING_SAMPLES);
    for (const chunk of aac.chunks)
      muxer.addAudio(
        chunk,
        aac.description,
        aac.sampleRate,
        AAC_FRAME_SAMPLES,
        AAC_BITRATE,
      );
  }
  const blob = await exportStage(options, "mux", async () => muxer.finalize());
  return { blob, frames: encoded, duration: encoded / fps };
}

async function encodeVideoTrack(
  project: Project,
  options: ExportOptions,
  config: VideoEncoderConfig,
  muxer: MP4Muxer,
) {
  const { width, height, fps, signal, onProgress } = options;
  let failure: unknown;
  const codecFailure = new AbortController();
  let encoded = 0;
  let renderer: Renderer | undefined;
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
        codecFailure.abort(error);
      }
    },
    error(error) {
      failure = error;
      codecFailure.abort(error);
    },
  });
  try {
    signal?.throwIfAborted();
    encoder.configure(config);
    const canvas = new OffscreenCanvas(width, height);
    renderer = await exportStage(options, "scene-setup", () =>
      Renderer.create(
        canvas,
        project,
        (message) => {
          failure = Error(message);
          codecFailure.abort(failure);
        },
        signal,
      ),
    );
    const total = frameCount(project.duration, fps);
    const activeRenderer = renderer;
    await exportStage(options, "video-encode", async () => {
      for (let i = 0; i < total; i++) {
        signal?.throwIfAborted();
        if (failure) throw failure;
        activeRenderer.render(i / fps);
        await activeRenderer.device.queue.onSubmittedWorkDone();
        const frame = new VideoFrame(canvas, frameTiming(i, fps));
        try {
          encoder.encode(frame, { keyFrame: true });
        } finally {
          frame.close();
        }
        if (encoder.encodeQueueSize >= 4)
          await waitForEncoderCapacity(encoder, 4, [
            signal,
            codecFailure.signal,
          ]);
        onProgress?.(i + 1, total);
        // Yield to input, painting, and cancellation even on fast GPU devices.
        if (i % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await encoder.flush();
      signal?.throwIfAborted();
      if (failure) throw failure;
      if (encoded !== total)
        throw Error(`Encoder returned ${encoded} samples; expected ${total}.`);
    });
    return encoded;
  } finally {
    if (encoder.state !== "closed") encoder.close();
    renderer?.dispose();
  }
}
