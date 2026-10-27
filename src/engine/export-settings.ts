/** Encoding controls shared by the browser, SDK and CLI. Bitrates are bits/second. */
export interface EncodingOptions {
  /** Omit for a resolution/FPS-scaled target (6 Mbps at Full HD 60 FPS). */
  bitrate?: number;
  /** File exports favor quality; realtime is an explicit low-latency option. */
  latencyMode?: "quality" | "realtime";
  /** Maximum requested spacing in seconds; scene cuts also request keyframes. */
  keyFrameInterval?: number;
}

export function resolveEncodingOptions(
  width: number,
  height: number,
  fps: number,
  options: EncodingOptions = {},
) {
  const bitrate =
    options.bitrate ??
    Math.max(
      500_000,
      Math.round((6_000_000 * width * height * fps) / (1920 * 1080 * 60)),
    );
  if (!Number.isSafeInteger(bitrate) || bitrate < 1 || bitrate > 100_000_000)
    throw Error(
      "Video bitrate must be an integer between 1 and 100000000 bits/second.",
    );
  const latencyMode = options.latencyMode ?? "quality";
  if (latencyMode !== "quality" && latencyMode !== "realtime")
    throw Error("Video latency mode must be quality or realtime.");
  const keyFrameInterval = options.keyFrameInterval ?? 2;
  if (
    !Number.isFinite(keyFrameInterval) ||
    keyFrameInterval <= 0 ||
    keyFrameInterval > 60
  )
    throw Error(
      "Keyframe interval must be greater than 0 and at most 60 seconds.",
    );
  return { bitrate, latencyMode, keyFrameInterval };
}
