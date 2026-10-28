/** Baseline profile, level 4.2; export size constraints must match this level. */
export const H264_CODEC = "avc1.42002a";

/** Read the profile, compatibility and level from a validated avcC payload. */
export function h264CodecString(description: Uint8Array): string {
  if (description.length < 4 || description[0] !== 1)
    throw Error("Invalid AVC configuration record.");
  return `avc1.${Array.from(description.subarray(1, 4), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

export function h264DecoderConfig(
  description: Uint8Array,
  width: number,
  height: number,
): VideoDecoderConfig {
  return {
    codec: h264CodecString(description),
    codedWidth: width,
    codedHeight: height,
    description: description.slice(),
  };
}
