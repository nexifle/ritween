import { aacDecoderConfig } from "../codecs/aac";
import type { AudioClipSource, AudioHost } from "../types";
import { parseMp4, type Mp4Sample, type Mp4Track } from "./formats/mp4";
import { fetchAsset } from "../media/resource";

const MAX_PCM_BYTES = 128 * 2 ** 20;
const MAX_INPUT_SAMPLES = 250_000;
const MAX_DECODE_QUEUE = 16;
const MAX_OUTPUT_CHUNK_FRAMES = 8_192;
const MICROSECONDS = 1_000_000;

export interface AudioFileOptions {
  url: string;
  /** Source-media time, in seconds. */
  offset?: number;
  /** Linear amplitude multiplier. */
  volume?: number;
  loop?: boolean;
}

export interface FootageAudioOptions {
  url: string;
  /** Source-media time, in seconds. */
  offset?: number;
  /** Linear amplitude multiplier. */
  volume?: number;
}

function validateOptions(options: AudioFileOptions | FootageAudioOptions) {
  if (typeof options.url !== "string" || options.url.trim() === "")
    throw Error("Audio asset URL must be a non-empty string.");
  const offset = options.offset ?? 0;
  const volume = options.volume ?? 1;
  if (!Number.isFinite(offset) || offset < 0)
    throw Error("Audio source offset must be a finite non-negative number.");
  if (!Number.isFinite(volume) || volume < 0)
    throw Error("Audio volume must be a finite non-negative number.");
  if (
    "loop" in options &&
    options.loop !== undefined &&
    typeof options.loop !== "boolean"
  )
    throw Error("Audio loop must be a boolean.");
  return {
    offset,
    volume,
    loop: "loop" in options ? (options.loop ?? false) : false,
  };
}

function audioTrack(tracks: Mp4Track[]) {
  const track = tracks.find((item) => item.kind === "audio");
  if (!track) return null;
  if (
    !Number.isSafeInteger(track.channels) ||
    track.channels! < 1 ||
    track.channels! > 8 ||
    !Number.isSafeInteger(track.sampleRate) ||
    track.sampleRate! < 8_000 ||
    track.sampleRate! > 192_000 ||
    track.samples.length === 0
  )
    throw Error(
      "MP4 audio track has invalid channel, sample-rate, or sample metadata.",
    );
  return track;
}

function sampleBytes(bytes: ArrayBuffer, sample: Mp4Sample) {
  if (
    !Number.isSafeInteger(sample.offset) ||
    !Number.isSafeInteger(sample.size) ||
    sample.offset < 0 ||
    sample.size <= 0 ||
    sample.offset > bytes.byteLength - sample.size
  )
    throw Error("MP4 audio sample is outside the downloaded resource.");
  return new Uint8Array(bytes, sample.offset, sample.size);
}

function abortError(signal: AbortSignal) {
  return (
    signal.reason ??
    new DOMException("The operation was aborted.", "AbortError")
  );
}

async function waitFor<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return promise;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function waitForQueue(
  readQueueSize: () => number,
  subscribe: (handler: () => void) => () => void,
  failure: () => unknown,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (readQueueSize() < MAX_DECODE_QUEUE) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let unsubscribe = () => {};
    const cleanup = () => {
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError(signal!));
    };
    const check = () => {
      const error = failure();
      if (error) {
        cleanup();
        reject(error);
      } else if (readQueueSize() < MAX_DECODE_QUEUE) {
        cleanup();
        resolve();
      }
    };
    unsubscribe = subscribe(check);
    signal?.addEventListener("abort", onAbort, { once: true });
    check();
  });
}

export function audioDecodeOriginUs(firstTimestamp: number) {
  return Math.min(0, sampleTimestampUs(firstTimestamp));
}

function sampleTimestampUs(seconds: number) {
  const value = Math.round(seconds * MICROSECONDS);
  if (!Number.isSafeInteger(value))
    throw Error("MP4 audio sample timestamp is invalid.");
  return value;
}

export interface PcmClipRange {
  sampleRate: number;
  clipStartFrame: number;
  clipEndFrame: number;
  audibleStartFrame: number;
  frameCount: number;
}

/** Map clip and edit-list bounds to one nearest-sample PCM grid. */
export function pcmClipRange(
  offset: number,
  duration: number,
  presentationStart: number,
  presentationEnd: number,
  sampleRate: number,
): PcmClipRange | null {
  if (
    !Number.isFinite(offset) ||
    offset < 0 ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isFinite(presentationStart) ||
    !Number.isFinite(presentationEnd) ||
    presentationStart < 0 ||
    presentationEnd <= presentationStart ||
    !Number.isSafeInteger(sampleRate) ||
    sampleRate <= 0
  )
    throw Error("Invalid audio clip or presentation interval.");

  const clipEnd = Math.min(offset + duration, presentationEnd);
  if (!Number.isFinite(clipEnd) || clipEnd <= offset) return null;
  const clipStartFrame = Math.round(offset * sampleRate);
  const clipEndFrame = Math.max(
    clipStartFrame + 1,
    Math.round(clipEnd * sampleRate),
  );
  const audibleStartFrame = Math.round(
    Math.max(offset, presentationStart) * sampleRate,
  );
  const frameCount = clipEndFrame - clipStartFrame;
  if (
    ![clipStartFrame, clipEndFrame, audibleStartFrame, frameCount].every(
      Number.isSafeInteger,
    )
  )
    throw Error("Audio clip exceeds the safe PCM sample range.");
  return {
    sampleRate,
    clipStartFrame,
    clipEndFrame,
    audibleStartFrame,
    frameCount,
  };
}

export interface PcmChunkRange {
  sourceStart: number;
  targetStart: number;
  frameCount: number;
}

/** Map decoded PCM against parser timestamps using nearest sample-grid rounding. */
export function pcmChunkRange(
  timestampUs: number,
  chunkFrames: number,
  range: PcmClipRange,
): PcmChunkRange | null {
  if (
    !Number.isSafeInteger(timestampUs) ||
    !Number.isSafeInteger(chunkFrames) ||
    chunkFrames <= 0
  )
    throw Error(
      "Audio decoder returned an invalid PCM timestamp or frame count.",
    );
  const chunkStartFrame = Math.round(
    (timestampUs * range.sampleRate) / MICROSECONDS,
  );
  if (!Number.isSafeInteger(chunkStartFrame))
    throw Error("Audio decoder PCM timestamp exceeds the safe sample range.");
  const sourceStart = Math.max(0, range.audibleStartFrame - chunkStartFrame);
  const sourceEnd = Math.min(chunkFrames, range.clipEndFrame - chunkStartFrame);
  const targetStart = chunkStartFrame + sourceStart - range.clipStartFrame;
  const frameCount = Math.min(
    sourceEnd - sourceStart,
    range.frameCount - targetStart,
  );
  if (frameCount <= 0) return null;
  return { sourceStart, targetStart, frameCount };
}

function lastSampleBefore(track: Mp4Track, end: number) {
  let last = -1;
  for (let i = 0; i < track.samples.length; i++) {
    const sample = track.samples[i];
    if (sample.timestamp < end || sample.decodeTimestamp < end) last = i;
  }
  return last;
}

/** Decode the AAC interval [offset, offset + duration) into a managed AudioBuffer. */
export async function decodeVideoAudio(
  url: string,
  context: BaseAudioContext,
  offset: number,
  duration: number,
  signal?: AbortSignal,
): Promise<AudioBuffer | null> {
  if (!Number.isFinite(offset) || offset < 0)
    throw Error("Audio source offset must be a finite non-negative number.");
  if (!Number.isFinite(duration) || duration <= 0)
    throw Error("Audio clip duration must be a finite positive number.");
  signal?.throwIfAborted();
  const bytes = await fetchAsset(url, signal);
  signal?.throwIfAborted();
  const track = audioTrack(parseMp4(bytes).tracks);
  if (!track) return null;

  const channels = track.channels!;
  const sampleRate = track.sampleRate!;
  const range = pcmClipRange(
    offset,
    duration,
    track.presentationStart,
    track.presentationEnd,
    sampleRate,
  );
  if (!range) return null;
  const frames = range.frameCount;
  const pcmBytes = channels * frames * Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(pcmBytes) || pcmBytes > MAX_PCM_BYTES)
    throw Error("Decoded audio exceeds the 128 MiB PCM limit. Split the clip.");
  const buffer = context.createBuffer(channels, frames, sampleRate);
  if (range.audibleStartFrame >= range.clipEndFrame) return buffer;

  const clipEnd = Math.min(offset + duration, track.presentationEnd);
  const endIndex = lastSampleBefore(track, clipEnd);
  if (endIndex < 0) return buffer;
  if (endIndex + 1 > MAX_INPUT_SAMPLES)
    throw Error(
      `Audio decode exceeds the ${MAX_INPUT_SAMPLES}-sample packet limit.`,
    );
  const channelData = Array.from({ length: channels }, (_, channel) =>
    buffer.getChannelData(channel),
  );
  if (
    typeof AudioDecoder === "undefined" ||
    typeof EncodedAudioChunk === "undefined"
  )
    throw Error(
      "AudioDecoder is unavailable. Use a current browser with WebCodecs support.",
    );

  const config = aacDecoderConfig(track.description, sampleRate, channels);
  const support = await waitFor(AudioDecoder.isConfigSupported(config), signal);
  signal?.throwIfAborted();
  if (!support.supported)
    throw Error(`The browser cannot decode MP4 audio codec ${track.codec}.`);

  let failure: unknown;
  let decoder: AudioDecoder | null = null;
  let acceptingOutput = true;
  // Keep preroll timestamps non-negative; map decoded PCM back to movie time.
  const decodeOriginUs = audioDecodeOriginUs(track.samples[0].timestamp);
  try {
    decoder = new AudioDecoder({
      output(data) {
        try {
          if (!acceptingOutput) return;
          const outputChannels = data.numberOfChannels;
          const outputRate = data.sampleRate;
          const outputFrames = data.numberOfFrames;
          if (
            outputChannels !== channels ||
            outputRate !== sampleRate ||
            outputFrames <= 0 ||
            outputFrames > MAX_OUTPUT_CHUNK_FRAMES
          ) {
            failure ??= Error(
              "Audio decoder returned an unsupported PCM chunk shape.",
            );
            return;
          }
          const chunkRange = pcmChunkRange(
            data.timestamp + decodeOriginUs,
            outputFrames,
            range,
          );
          if (!chunkRange) return;
          for (let channel = 0; channel < channels; channel++) {
            const plane = new Float32Array(outputFrames);
            data.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
            channelData[channel].set(
              plane.subarray(
                chunkRange.sourceStart,
                chunkRange.sourceStart + chunkRange.frameCount,
              ),
              chunkRange.targetStart,
            );
          }
        } catch (error) {
          failure ??= error;
        } finally {
          data.close();
        }
      },
      error(error) {
        failure ??= error;
      },
    });
    decoder.configure(support.config ?? config);

    for (let index = 0; index <= endIndex; index++) {
      signal?.throwIfAborted();
      if (failure) throw failure;
      const sample = track.samples[index];
      const chunk: EncodedAudioChunkInit = {
        type: sample.key ? "key" : "delta",
        timestamp: sampleTimestampUs(sample.timestamp) - decodeOriginUs,
        duration: Math.max(1, sampleTimestampUs(sample.duration)),
        data: sampleBytes(bytes, sample),
      };
      decoder.decode(new EncodedAudioChunk(chunk));
      if (decoder.decodeQueueSize >= MAX_DECODE_QUEUE) {
        await waitForQueue(
          () => decoder!.decodeQueueSize,
          (handler) => {
            decoder!.addEventListener("dequeue", handler);
            return () => decoder!.removeEventListener("dequeue", handler);
          },
          () => failure,
          signal,
        );
      }
    }
    await waitFor(decoder.flush(), signal);
    signal?.throwIfAborted();
    if (failure) throw failure;
    return buffer;
  } finally {
    acceptingOutput = false;
    if (decoder && decoder.state !== "closed") decoder.close();
  }
}

/** Add a short attack/release envelope to a clip's linear volume control. */
export function fadeGain(
  gain: AudioParam,
  start: number,
  duration: number,
  volume: number,
) {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(duration) ||
    duration < 0 ||
    !Number.isFinite(volume) ||
    volume < 0
  )
    throw Error("Invalid audio fade range or volume.");
  const end = start + duration;
  const fade = Math.min(0.01, duration / 2);
  gain.setValueAtTime(0, start);
  if (fade > 0) gain.linearRampToValueAtTime(volume, start + fade);
  else gain.setValueAtTime(volume, start);
  if (duration > fade * 2) gain.setValueAtTime(volume, end - fade);
  if (fade > 0) gain.linearRampToValueAtTime(0, end);
  else gain.setValueAtTime(0, end);
}

type ScheduledBuffer = {
  sourceOffset: number;
  loopStart: number;
  loopEnd: number;
  playDuration: number;
  loop: boolean;
};

function scheduleBuffer(
  host: AudioHost,
  buffer: AudioBuffer,
  volume: number,
  timing: ScheduledBuffer,
) {
  const start = host.at(0);
  const end = host.at(timing.playDuration);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    throw Error("Audio host has an invalid clip time range.");
  const source = host.context.createBufferSource();
  source.buffer = buffer;
  source.loop = timing.loop;
  source.loopStart = timing.loopStart;
  source.loopEnd = timing.loopEnd;
  const gain = host.context.createGain();
  gain.gain.value = 0;
  source.connect(gain).connect(host.destination);
  fadeGain(gain.gain, start, timing.playDuration, volume);
  if (timing.loop) source.start(start, timing.sourceOffset);
  else source.start(start, timing.sourceOffset, timing.playDuration);
  source.stop(end);
}

/** Create a standalone WAV/MP3-like source decoded by Web Audio. */
export function audioFile(options: AudioFileOptions): () => AudioClipSource {
  const { offset, volume, loop } = validateOptions(options);
  return () => {
    let disposed = false;
    let cachedContext: BaseAudioContext | null = null;
    let cachedBuffer: AudioBuffer | null = null;
    let loading: Promise<AudioBuffer> | null = null;

    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        cachedContext = null;
        cachedBuffer = null;
        loading = null;
      },
      async schedule(host) {
        if (disposed) throw Error("Audio source is disposed.");
        host.signal?.throwIfAborted();
        if (host.duration <= 0) return;
        if (cachedContext !== host.context) {
          cachedContext = host.context;
          cachedBuffer = null;
          loading = null;
        }
        if (!cachedBuffer) {
          const request = (loading ??= (async () => {
            const bytes = await fetchAsset(options.url, host.signal);
            host.signal?.throwIfAborted();
            return waitFor(host.context.decodeAudioData(bytes), host.signal);
          })().then(
            (buffer) => {
              if (loading === request) {
                cachedBuffer = buffer;
                loading = null;
              }
              return buffer;
            },
            (error: unknown) => {
              if (loading === request) loading = null;
              throw error;
            },
          ));
          await request;
          if (disposed || cachedContext !== host.context) return;
        }
        host.signal?.throwIfAborted();
        if (!cachedBuffer || offset >= cachedBuffer.duration) return;
        const available = Math.min(
          host.duration,
          cachedBuffer.duration - offset,
        );
        if (available <= 0) return;
        const loopEnd = Math.min(cachedBuffer.duration, offset + host.duration);
        scheduleBuffer(host, cachedBuffer, volume, {
          sourceOffset: offset,
          loopStart: offset,
          loopEnd,
          playDuration: loop ? host.duration : available,
          loop,
        });
      },
    };
  };
}

/** Linked footage decodes MP4 AAC by parser timestamps, not decodeAudioData. */
export function footageAudio(
  options: FootageAudioOptions,
): () => AudioClipSource {
  const { offset, volume } = validateOptions(options);
  return () => {
    let disposed = false;
    let cachedContext: BaseAudioContext | null = null;
    let cachedBuffer: AudioBuffer | null = null;
    let resolved = false;
    let loading: Promise<AudioBuffer | null> | null = null;

    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        cachedContext = null;
        cachedBuffer = null;
        loading = null;
      },
      async schedule(host) {
        if (disposed) throw Error("Audio source is disposed.");
        host.signal?.throwIfAborted();
        if (host.duration <= 0) return;
        if (cachedContext !== host.context) {
          cachedContext = host.context;
          cachedBuffer = null;
          resolved = false;
          loading = null;
        }
        if (!resolved) {
          const request = (loading ??= decodeVideoAudio(
            options.url,
            host.context,
            offset,
            host.duration,
            host.signal,
          ).then(
            (buffer) => {
              if (loading === request) {
                cachedBuffer = buffer;
                resolved = true;
                loading = null;
              }
              return buffer;
            },
            (error: unknown) => {
              if (loading === request) loading = null;
              throw error;
            },
          ));
          await request;
          if (disposed || cachedContext !== host.context) return;
        }
        host.signal?.throwIfAborted();
        if (!cachedBuffer) return;
        const available = Math.min(host.duration, cachedBuffer.duration);
        if (available <= 0) return;
        scheduleBuffer(host, cachedBuffer, volume, {
          sourceOffset: 0,
          loopStart: 0,
          loopEnd: cachedBuffer.duration,
          playDuration: available,
          loop: false,
        });
      },
    };
  };
}
