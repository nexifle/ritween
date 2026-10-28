/** AAC-LC frame size. */
export const AAC_FRAME_SAMPLES = 1024;
export const AAC_BITRATE = 128_000;
export const AAC_CODEC = "mp4a.40.2";
/** Chrome AAC-LC warmup, calibrated in-browser; skipped by the MP4 edit list. */
export const AAC_PRIMING_SAMPLES = 2112;

export function aacDecoderConfig(
  description: Uint8Array,
  sampleRate: number,
  numberOfChannels: number,
): AudioDecoderConfig {
  return {
    codec: AAC_CODEC,
    sampleRate,
    numberOfChannels,
    description: description.slice(),
  };
}
