import { h264DecoderConfig } from "../codecs/h264";
import { parseMp4, type Mp4Sample, type Mp4Track } from "./formats/mp4";
import { fetchAsset } from "../media/resource";
import { openByteSource } from "../media/byte-source";
import { createSampleIndex } from "./sample-index";
import { SequentialVideo } from "./sequential-video";

const MAX_GOP_SAMPLES = 2_048;
const MAX_DECODE_QUEUE = 12;
const MICROSECONDS = 1_000_000;

export interface OpenVideoResource {
  width: number;
  height: number;
  duration: number;
  /** Caller owns the returned frame and should close it immediately after upload/draw. */
  frameAt(time: number, signal?: AbortSignal): Promise<VideoFrame>;
  dispose(): void;
}

function timestampUs(seconds: number, description: string) {
  const value = Math.round(seconds * MICROSECONDS);
  if (!Number.isSafeInteger(value))
    throw Error(`Invalid video ${description}.`);
  return value;
}

function sampleBytes(bytes: ArrayBuffer, sample: Mp4Sample) {
  if (
    !Number.isSafeInteger(sample.offset) ||
    !Number.isSafeInteger(sample.size) ||
    sample.offset < 0 ||
    sample.size <= 0 ||
    sample.offset > bytes.byteLength - sample.size
  )
    throw Error("MP4 video sample is outside the downloaded resource.");
  return new Uint8Array(bytes, sample.offset, sample.size);
}

/** Whether a decoded frame overlaps the visible edit interval and is not from the future. */
export function frameOverlapsPresentation(
  timestampUs: number,
  durationUs: number,
  presentationStartUs: number,
  presentationEndUs: number,
  targetUs: number,
) {
  return (
    Number.isFinite(timestampUs) &&
    Number.isFinite(durationUs) &&
    durationUs > 0 &&
    timestampUs <= targetUs &&
    timestampUs < presentationEndUs &&
    timestampUs + durationUs > presentationStartUs
  );
}

/** Forward cancellation and return one disposer for all registered listeners. */
export function forwardAbortSignals(
  sources: readonly (AbortSignal | undefined)[],
  destination: AbortController,
) {
  const removers: (() => void)[] = [];
  for (const source of sources) {
    if (!source) continue;
    const forward = () => destination.abort(source.reason);
    if (source.aborted) destination.abort(source.reason);
    else {
      source.addEventListener("abort", forward, { once: true });
      removers.push(() => source.removeEventListener("abort", forward));
    }
  }
  return () => {
    for (const remove of removers) remove();
  };
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

function waitForDecodeCapacity(
  decoder: VideoDecoder,
  failure: () => unknown,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (decoder.decodeQueueSize < MAX_DECODE_QUEUE && !failure())
    return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      decoder.removeEventListener("dequeue", check);
      signal?.removeEventListener("abort", abort);
    };
    const check = () => {
      const error = failure();
      if (error) {
        cleanup();
        reject(error);
      } else if (decoder.decodeQueueSize < MAX_DECODE_QUEUE) {
        cleanup();
        resolve();
      }
    };
    const abort = () => {
      cleanup();
      reject(abortError(signal!));
    };
    decoder.addEventListener("dequeue", check);
    signal?.addEventListener("abort", abort, { once: true });
    check();
  });
}

function videoTrack(tracks: Mp4Track[]) {
  const track = tracks.find((item) => item.kind === "video");
  if (!track) throw Error("MP4 asset has no video track.");
  if (
    !track.width ||
    !Number.isSafeInteger(track.width) ||
    !track.height ||
    !Number.isSafeInteger(track.height) ||
    track.width <= 0 ||
    track.height <= 0 ||
    !Number.isFinite(track.presentationStart) ||
    !Number.isFinite(track.presentationEnd) ||
    track.presentationStart < 0 ||
    track.presentationEnd <= track.presentationStart ||
    track.samples.length === 0
  )
    throw Error("MP4 video track has invalid dimensions or no samples.");
  return track;
}

/** Open a same-origin MP4 resource for deterministic, random-access frame decoding. */
export async function openVideo(
  url: string,
  signal?: AbortSignal,
): Promise<OpenVideoResource> {
  const rangeEnabled =
    (globalThis as typeof globalThis & { __ritweenRangeVideo?: boolean })
      .__ritweenRangeVideo === true;
  const source = rangeEnabled ? await openByteSource(url, signal) : null;
  let bytes: ArrayBuffer | null = source ? null : await fetchAsset(url, signal);
  let input;
  let track;
  try {
    signal?.throwIfAborted();
    input = source ? source.parse() : parseMp4(bytes!);
    track = videoTrack(input.tracks);
  } catch (error) {
    source?.dispose();
    throw error;
  }
  const readSample = async (sample: Mp4Sample, decodeSignal: AbortSignal) => {
    const data = source
      ? await waitFor(
          source.read(sample.offset, sample.offset + sample.size, decodeSignal),
          decodeSignal,
        )
      : sampleBytes(bytes!, sample);
    decodeSignal.throwIfAborted();
    return data;
  };
  const width = track.width!;
  const height = track.height!;
  let index: ReturnType<typeof createSampleIndex> | null = createSampleIndex(
    track.samples,
  );
  const firstVisibleTimestamp = timestampUs(
    track.presentationStart,
    "presentation start",
  );
  const lastVisibleTimestamp = timestampUs(
    track.presentationEnd,
    "presentation end",
  );
  const visibleFrameDurations = new Map<number, number>();
  for (const sample of track.samples) {
    const pts = timestampUs(sample.timestamp, "sample timestamp");
    const duration = Math.max(
      1,
      timestampUs(sample.duration, "sample duration"),
    );
    if (
      frameOverlapsPresentation(
        pts,
        duration,
        firstVisibleTimestamp,
        lastVisibleTimestamp,
        lastVisibleTimestamp,
      )
    )
      visibleFrameDurations.set(pts, duration);
  }
  let sequential: SequentialVideo | null = null;
  // Internal opt-out supports reference comparisons; reordered/large tracks stay random-access.
  let sequentialEnabled =
    (globalThis as typeof globalThis & { __ritweenSequentialVideo?: boolean })
      .__ritweenSequentialVideo !== false &&
    width * height * 4 * 12 <= 96 * 2 ** 20 &&
    track.samples.every(
      (sample, i, samples) =>
        i === 0 ||
        timestampUs(sample.timestamp, "PTS") >
          timestampUs(samples[i - 1].timestamp, "PTS"),
    );
  let disposed = false;
  let currentFrame: VideoFrame | null = null;
  let activeController: AbortController | null = null;
  let busy = false;

  const releasePayload = () => {
    source?.dispose();
    bytes = null;
    index = null;
    visibleFrameDurations.clear();
    for (const item of input.tracks) {
      item.samples = [];
      item.description = new Uint8Array();
    }
    input.tracks = [];
  };

  const closeCurrent = () => {
    currentFrame?.close();
    currentFrame = null;
  };

  return {
    width,
    height,
    duration: input.duration,
    async frameAt(time, frameSignal) {
      if (disposed) throw Error("Video resource is disposed.");
      if (busy) throw Error("A video frame request is already in progress.");
      if (!Number.isFinite(time))
        throw Error("Video frame time must be finite.");
      closeCurrent();
      busy = true;

      const controller = new AbortController();
      const removeAbortForwarders = forwardAbortSignals(
        [signal, frameSignal],
        controller,
      );
      activeController = controller;
      const decodeSignal = controller.signal;
      let acceptingOutput = true;
      let failure: unknown;
      const candidate: { frame: VideoFrame | null } = { frame: null };
      let candidateTimestamp = Number.NEGATIVE_INFINITY;
      let outputCount = 0;
      let decoder: VideoDecoder | null = null;

      try {
        decodeSignal.throwIfAborted();
        if (
          typeof VideoDecoder === "undefined" ||
          typeof EncodedVideoChunk === "undefined"
        )
          throw Error(
            "VideoDecoder is unavailable. Use a current browser with WebCodecs support.",
          );
        const sourceTime = Math.max(0, Math.min(time, input.duration));
        if (sourceTime < track.presentationStart)
          throw Error(
            "No visible MP4 video frame exists at or before the requested time.",
          );
        const targetTime = Math.min(sourceTime, track.presentationEnd);
        const targetTimestamp = timestampUs(targetTime, "frame time");
        const { start, end } = index!.range(targetTime);
        if (end - start + 1 > MAX_GOP_SAMPLES)
          throw Error(
            `Video GOP exceeds the ${MAX_GOP_SAMPLES}-sample seek limit.`,
          );
        const config = h264DecoderConfig(track.description, width, height);
        const support = await waitFor(
          VideoDecoder.isConfigSupported(config),
          decodeSignal,
        );
        decodeSignal.throwIfAborted();
        if (!support.supported)
          throw Error(
            `The browser cannot decode MP4 video codec ${track.codec}.`,
          );

        if (sequentialEnabled) {
          sequential ??= new SequentialVideo(support.config ?? config);
          try {
            const frame = await sequential.read(
              targetTime,
              start,
              end,
              track.samples.length,
              timestampUs(track.samples[end].timestamp, "sample timestamp"),
              async (i) => {
                const sample = track.samples[i];
                return new EncodedVideoChunk({
                  type: sample.key ? "key" : "delta",
                  timestamp: timestampUs(sample.timestamp, "sample timestamp"),
                  duration: Math.max(
                    1,
                    timestampUs(sample.duration, "sample duration"),
                  ),
                  data: await readSample(sample, decodeSignal),
                });
              },
              decodeSignal,
            );
            const duration = visibleFrameDurations.get(frame.timestamp);
            if (
              duration === undefined ||
              !frameOverlapsPresentation(
                frame.timestamp,
                duration,
                firstVisibleTimestamp,
                lastVisibleTimestamp,
                targetTimestamp,
              )
            ) {
              frame.close();
              throw Error(
                "Sequential video frame is outside its presentation interval.",
              );
            }
            return frame;
          } catch {
            decodeSignal.throwIfAborted();
            sequential.dispose();
            sequential = null;
            sequentialEnabled = false;
          }
        }

        decoder = new VideoDecoder({
          output(frame) {
            if (!acceptingOutput) {
              frame.close();
              return;
            }
            if (++outputCount > MAX_GOP_SAMPLES) {
              frame.close();
              failure ??= Error(
                `Video decoder exceeded the ${MAX_GOP_SAMPLES}-frame GOP limit.`,
              );
              return;
            }
            const timestamp = frame.timestamp;
            if (!Number.isFinite(timestamp)) {
              frame.close();
              failure ??= Error(
                "Video decoder returned a frame with an invalid timestamp.",
              );
              return;
            }
            const duration = visibleFrameDurations.get(timestamp);
            if (
              duration !== undefined &&
              frameOverlapsPresentation(
                timestamp,
                duration,
                firstVisibleTimestamp,
                lastVisibleTimestamp,
                targetTimestamp,
              ) &&
              timestamp > candidateTimestamp
            ) {
              candidate.frame?.close();
              candidate.frame = frame;
              candidateTimestamp = timestamp;
            } else frame.close();
          },
          error(error) {
            failure ??= error;
          },
        });
        decoder.configure(support.config ?? config);

        for (let index = start; index <= end; index++) {
          decodeSignal.throwIfAborted();
          if (failure) throw failure;
          const sample = track.samples[index];
          const chunk: EncodedVideoChunkInit = {
            type: sample.key ? "key" : "delta",
            timestamp: timestampUs(sample.timestamp, "sample timestamp"),
            duration: Math.max(
              1,
              timestampUs(sample.duration, "sample duration"),
            ),
            data: await readSample(sample, decodeSignal),
          };
          decoder.decode(new EncodedVideoChunk(chunk));
          if (decoder.decodeQueueSize >= MAX_DECODE_QUEUE)
            await waitForDecodeCapacity(decoder, () => failure, decodeSignal);
        }
        await waitFor(decoder.flush(), decodeSignal);
        decodeSignal.throwIfAborted();
        if (failure) throw failure;
        if (!candidate.frame)
          throw Error(
            "MP4 video has no decoded frame at or before the requested time.",
          );

        const result = candidate.frame;
        candidate.frame = null;
        currentFrame = result;
        return result;
      } catch (error) {
        decodeSignal.throwIfAborted();
        throw error;
      } finally {
        acceptingOutput = false;
        candidate.frame?.close();
        if (decoder && decoder.state !== "closed") decoder.close();
        removeAbortForwarders();
        if (activeController === controller) activeController = null;
        busy = false;
        if (disposed) releasePayload();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      activeController?.abort(
        new DOMException("Video resource disposed.", "AbortError"),
      );
      activeController = null;
      closeCurrent();
      sequential?.dispose();
      sequential = null;
      if (!busy) releasePayload();
    },
  };
}
