import {
  AdtsOutputFormat,
  AudioSample,
  AudioSampleSource,
  NullTarget,
  Output,
} from "mediabunny";
import { registerAacEncoder } from "@mediabunny/aac-encoder";
import { AAC_BITRATE } from "../../codecs/aac";

/** Lazy-loaded AAC-LC fallback for platforms without native AAC encoding. */
export async function encodeAacSoftware(
  buffer: AudioBuffer,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  registerAacEncoder();
  const chunks: Uint8Array[] = [];
  let description: Uint8Array | undefined;
  let primingSamples = 0;
  const source = new AudioSampleSource({
    codec: "aac",
    bitrate: AAC_BITRATE,
    onEncodedPacket(packet, metadata) {
      if (!chunks.length)
        primingSamples = Math.max(
          0,
          Math.round(-packet.timestamp * buffer.sampleRate),
        );
      chunks.push(packet.data.slice());
      const next = metadata?.decoderConfig?.description;
      if (next)
        description = (
          ArrayBuffer.isView(next)
            ? new Uint8Array(next.buffer, next.byteOffset, next.byteLength)
            : new Uint8Array(next)
        ).slice();
    },
  });
  // Discard the container; our MP4 muxer consumes the raw AAC packets above.
  const output = new Output({
    format: new AdtsOutputFormat(),
    target: new NullTarget(),
  });
  output.addAudioTrack(source);
  let finalized = false;
  try {
    await output.start();
    const channels = buffer.numberOfChannels;
    for (let at = 0; at < buffer.length; at += 16384) {
      signal?.throwIfAborted();
      const count = Math.min(16384, buffer.length - at);
      const data = new Float32Array(count * channels);
      for (let channel = 0; channel < channels; channel++)
        data.set(
          buffer.getChannelData(channel).subarray(at, at + count),
          channel * count,
        );
      const sample = new AudioSample({
        data,
        format: "f32-planar",
        numberOfChannels: channels,
        sampleRate: buffer.sampleRate,
        timestamp: at / buffer.sampleRate,
      });
      try {
        await source.add(sample);
      } finally {
        sample.close();
      }
    }
    signal?.throwIfAborted();
    await output.finalize();
    finalized = true;
    signal?.throwIfAborted();
    if (!chunks.length || !description)
      throw Error(
        "Software AAC encoder returned no samples or decoder configuration.",
      );
    return {
      chunks,
      description,
      sampleRate: buffer.sampleRate,
      primingSamples,
    };
  } finally {
    if (!finalized) await output.cancel();
  }
}
