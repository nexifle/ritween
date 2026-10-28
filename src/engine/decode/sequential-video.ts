const MAX_FRAMES = 12;
const MAX_BYTES = 96 * 2 ** 20;
const READ_AHEAD = 8;

/** Restricted to strictly increasing PTS; reordered tracks use random access. */
export class SequentialVideo {
  private decoder: VideoDecoder | null = null;
  private frames = new Map<number, VideoFrame>();
  private bytes = 0;
  private next = 0;
  private lastTime = -Infinity;
  private failure: unknown;
  private ended = false;
  private peakFrames = 0;
  private peakBytes = 0;
  private wake: (() => void) | null = null;

  constructor(private readonly config: VideoDecoderConfig) {}

  /** Engine-owned estimates only; excludes decoder internals and caller clones. */
  get usage() {
    return {
      frames: this.frames.size,
      bytes: this.bytes,
      peakFrames: this.peakFrames,
      peakBytes: this.peakBytes,
    };
  }

  dispose() {
    const decoder = this.decoder;
    this.decoder = null;
    if (decoder && decoder.state !== "closed") decoder.close();
    for (const frame of this.frames.values()) frame.close();
    this.frames.clear();
    this.bytes = 0;
    this.lastTime = -Infinity;
    this.wake?.();
  }

  async read(
    time: number,
    start: number,
    end: number,
    count: number,
    timestamp: number,
    chunk: (index: number) => EncodedVideoChunk,
    signal: AbortSignal,
  ): Promise<VideoFrame> {
    signal.throwIfAborted();
    if (
      !this.decoder ||
      time < this.lastTime ||
      start > this.next ||
      (this.ended && !this.frames.has(timestamp))
    ) {
      this.dispose();
      this.failure = undefined;
      this.ended = false;
      this.next = start;
      const decoder = new VideoDecoder({
        output: (frame) => {
          if (this.decoder !== decoder) {
            frame.close();
            return;
          }
          const bytes = frame.codedWidth * frame.codedHeight * 4;
          if (
            !Number.isSafeInteger(bytes) ||
            bytes <= 0 ||
            this.frames.size >= MAX_FRAMES ||
            this.bytes + bytes > MAX_BYTES ||
            this.frames.has(frame.timestamp)
          ) {
            frame.close();
            this.failure = Error("Sequential video frame budget exceeded.");
          } else {
            this.frames.set(frame.timestamp, frame);
            this.bytes += bytes;
            this.peakFrames = Math.max(this.peakFrames, this.frames.size);
            this.peakBytes = Math.max(this.peakBytes, this.bytes);
          }
          this.wake?.();
        },
        error: (error) => {
          if (this.decoder !== decoder) return;
          this.failure = error;
          this.wake?.();
        },
      });
      this.decoder = decoder;
      decoder.configure({ ...this.config, optimizeForLatency: true });
    }
    const decoder = this.decoder;
    const discard = () => {
      for (const [pts, frame] of this.frames) {
        if (pts >= timestamp) continue;
        this.bytes -= frame.codedWidth * frame.codedHeight * 4;
        this.frames.delete(pts);
        frame.close();
      }
    };
    const abort = () => this.dispose();
    signal.addEventListener("abort", abort, { once: true });
    const deadline = performance.now() + 2000;
    try {
      discard();
      while (!this.frames.has(timestamp)) {
        signal.throwIfAborted();
        if (this.failure) throw this.failure;
        if (this.decoder !== decoder) throw Error("Video session ended.");
        if (performance.now() >= deadline)
          throw Error("Sequential decoder output timed out.");
        discard();
        if (
          this.next < count &&
          this.next <= end + READ_AHEAD &&
          decoder.decodeQueueSize < 4 &&
          this.frames.size < MAX_FRAMES - 4
        ) {
          decoder.decode(chunk(this.next++));
          continue;
        }
        if (this.next === count && !this.ended) {
          this.ended = true;
          const flushed = decoder.flush();
          let timer: ReturnType<typeof setTimeout> | undefined;
          let aborted: (() => void) | undefined;
          try {
            await new Promise<void>((resolve, reject) => {
              aborted = () =>
                reject(
                  signal.reason ?? new DOMException("Aborted", "AbortError"),
                );
              signal.addEventListener("abort", aborted, { once: true });
              timer = setTimeout(
                () => reject(Error("Sequential decoder flush timed out.")),
                Math.max(0, deadline - performance.now()),
              );
              flushed.then(resolve, reject);
              if (signal.aborted) aborted();
            });
          } finally {
            clearTimeout(timer);
            if (aborted) signal.removeEventListener("abort", aborted);
          }
          continue;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            this.wake = null;
            resolve();
          }, 5);
          this.wake = () => {
            clearTimeout(timer);
            this.wake = null;
            resolve();
          };
        });
      }
      signal.throwIfAborted();
      if (this.failure) throw this.failure;
      this.lastTime = time;
      return this.frames.get(timestamp)!.clone();
    } catch (error) {
      this.dispose();
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
}
