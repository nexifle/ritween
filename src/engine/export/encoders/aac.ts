import { waitForEncoderCapacity } from "../encoder-queue";
import { AAC_FRAME_SAMPLES, AAC_BITRATE, AAC_CODEC } from "../../codecs/aac";

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
