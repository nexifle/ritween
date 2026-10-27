import { FrameSource } from "../../render/frame-source";
import { frameCount, frameTiming } from "../../timeline";
import type { Project } from "../../types";
import type { ExportOptions } from "../types";
import { exportStage } from "../stage";
import { resolveEncodingOptions } from "../settings";
import { waitForEncoderCapacity } from "../encoder-queue";

/** Encoded AVC samples; containers own their storage and muxing policy. */
export interface EncodedVideoSink {
  add(
    data: Uint8Array,
    keyFrame: boolean,
    description: AllowSharedBufferSource | undefined,
    timestamp: number,
  ): void;
}

export async function encodeVideoTrack(
  project: Project,
  options: ExportOptions,
  config: VideoEncoderConfig,
  sink: EncodedVideoSink,
) {
  const { width, height, fps, signal, onProgress } = options;
  let failure: unknown;
  const codecFailure = new AbortController();
  let encoded = 0;
  let source: FrameSource | undefined;
  const encoder = new VideoEncoder({
    output(chunk, metadata) {
      try {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        sink.add(
          data,
          chunk.type === "key",
          metadata?.decoderConfig?.description,
          chunk.timestamp,
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
    source = await exportStage(options, "scene-setup", () =>
      FrameSource.create(project, {
        width,
        height,
        signal,
        onError: (message) => {
          failure = Error(message);
          codecFailure.abort(failure);
        },
      }),
    );
    const total = frameCount(project.duration, fps);
    const { keyFrameInterval } = resolveEncodingOptions(
      width,
      height,
      fps,
      options,
    );
    const intervalFrames = Math.max(1, Math.floor(keyFrameInterval * fps));
    const cuts = new Set(
      project.scenes.map((scene) => Math.ceil(scene.start * fps)),
    );
    let lastKeyRequest = -intervalFrames;
    const activeSource = source;
    await exportStage(options, "video-encode", async () => {
      for (let i = 0; i < total; i++) {
        signal?.throwIfAborted();
        if (failure) throw failure;
        const canvas = await activeSource.render(i / fps);
        if (failure) throw failure;
        const frame = new VideoFrame(canvas, frameTiming(i, fps));
        try {
          const keyFrame = i - lastKeyRequest >= intervalFrames || cuts.has(i);
          if (keyFrame) lastKeyRequest = i;
          encoder.encode(frame, { keyFrame });
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
    source?.dispose();
  }
}
