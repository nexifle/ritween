import { runExportPipelines } from "../../pipeline";
import { resolveMediaProject } from "../../../media/project";
import { renderAudio, SAMPLE_RATE } from "../../../audio";
import { resolveEncodingOptions } from "../../settings";
import { assertExportSize } from "./sizes";
import { MP4Muxer } from "./muxer";
import { frameCount } from "../../../timeline";
import type { Project } from "../../../types";
import type { ExportOptions } from "../../types";
import { exportStage } from "../../stage";
import { encodeVideoTrack } from "../../codecs/h264";
import {
  encodeAac,
  AAC_PRIMING_SAMPLES,
  AAC_FRAME_SAMPLES,
  AAC_BITRATE,
} from "../../codecs/aac";

export async function exportMp4(project: Project, options: ExportOptions) {
  project = resolveMediaProject(project);
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
  const encoding = resolveEncodingOptions(width, height, fps, options);
  const config: VideoEncoderConfig = {
    codec: "avc1.42002a",
    width,
    height,
    framerate: fps,
    bitrate: encoding.bitrate,
    bitrateMode: "variable",
    latencyMode: encoding.latencyMode,
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
  const muxer = new MP4Muxer(width, height, fps, { copySamples: false });
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
  return { blob, frames: encoded, duration: encoded / fps, ...encoding };
}
